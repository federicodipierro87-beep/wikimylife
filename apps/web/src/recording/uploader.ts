import type { ApiClient, CaptureMetadataInput, QueuedRecording, UploadQueueAdapter } from "@wikimylife/shared";

/**
 * Lo svuotamento della coda di upload.
 *
 * E' il pezzo che rende vera la promessa della §2: premuto stop, l'audio e' su
 * disco e l'app si puo' chiudere. Da qui in poi il caricamento e' un dettaglio
 * che riguarda solo questo file, e puo' fallire quante volte vuole.
 *
 * Sta separato da React di proposito — nessun hook, nessuno stato di
 * componente: cosi' si prova con una coda in memoria e un client finto, senza
 * montare niente. E' anche il motivo per cui la coda e' un'interfaccia di
 * `packages/shared` invece che IndexedDB direttamente.
 *
 * ## Tre regole, e il perche'
 *
 * **Un solo svuotamento alla volta.** L'evento `online` e il pulsante «riprova»
 * possono arrivare insieme: senza il promise condiviso partirebbero due giri e
 * lo stesso audio verrebbe caricato due volte, cioe' produrrebbe due schede
 * gemelle che la deduplicazione poi segnalerebbe come duplicati. Meglio non
 * crearle.
 *
 * **Un elemento che fallisce non ferma gli altri.** Un audio troppo grande in
 * testa alla coda bloccherebbe per sempre tutti quelli dietro.
 *
 * **Dopo `maxAttempts` si smette di provare, ma non si cancella niente.** Un
 * file che il server rifiuta non diventa buono al decimo tentativo, e continuare
 * consuma batteria e dati. Ma l'audio resta in coda e visibile: e' l'unica cosa
 * che l'utente non puo' rifare, e la decisione di buttarlo e' sua.
 */

/** Oltre questa soglia si smette di riprovare da soli. */
const MAX_ATTEMPTS = 5;

export interface DrainReport {
  /** Id delle registrazioni create dal server, in ordine di caricamento. */
  readonly uploaded: readonly string[];
  /** Elementi che hanno fallito in questo giro. */
  readonly failed: number;
  /** Elementi ancora in coda alla fine, esausti compresi. */
  readonly remaining: number;
  /** Elementi che hanno esaurito i tentativi e non verranno piu' ritentati. */
  readonly exhausted: number;
}

export interface Uploader {
  /**
   * Prova a caricare tutto quello che c'e'. Non lancia mai: un guasto di rete
   * non e' un'eccezione da gestire, e' lo stato normale di questa coda.
   */
  drain(): Promise<DrainReport>;
  /** Se c'e' gia' uno svuotamento in corso, questo e' il suo promise. */
  inFlight(): Promise<DrainReport> | null;
}

export interface UploaderDeps {
  readonly queue: UploadQueueAdapter;
  readonly client: Pick<ApiClient, "createRecording">;
  /** Iniettabile perche' `navigator.onLine` non esiste fuori dal browser. */
  readonly isOnline: () => boolean;
  readonly maxAttempts?: number | undefined;
  /** Chiamata dopo ogni elemento, per aggiornare l'indicatore senza attese. */
  readonly onChange?: (() => void) | undefined;
}

export function isExhausted(item: QueuedRecording, maxAttempts = MAX_ATTEMPTS): boolean {
  return item.attempts >= maxAttempts;
}

/** I metadati della §2 ricostruiti da cio' che la coda ha conservato. */
export function metadataOf(item: QueuedRecording): CaptureMetadataInput {
  return {
    recordedAt: item.recordedAt,
    durationMs: item.durationMs,
    mimeType: item.mimeType,
    capturedOffline: item.capturedOffline,
    deviceLocale: item.deviceLocale,
    latitude: item.latitude,
    longitude: item.longitude,
    placeLabel: item.placeLabel,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createUploader(deps: UploaderDeps): Uploader {
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  let running: Promise<DrainReport> | null = null;

  async function runOnce(): Promise<DrainReport> {
    const uploaded: string[] = [];
    let failed = 0;

    if (deps.isOnline()) {
      // Una fotografia della coda presa adesso: gli elementi accodati durante
      // il giro li prendera' il giro dopo. Rileggerla a ogni iterazione
      // significherebbe non finire mai finche' l'utente continua a registrare.
      const items = await deps.queue.list();

      for (const item of items) {
        if (isExhausted(item, maxAttempts)) {
          continue;
        }
        try {
          const state = await deps.client.createRecording({
            audio: new Blob([new Uint8Array(item.audio)], { type: item.mimeType }),
            metadata: metadataOf(item),
            filename: `${item.id}`,
          });
          await deps.queue.remove(item.id);
          uploaded.push(state.id);
        } catch (error) {
          await deps.queue.markFailed(item.id, messageOf(error));
          failed += 1;
          // Se la rete e' caduta a meta' giro, insistere sugli altri e' inutile
          // e costoso: si riprende al prossimo evento `online`.
          if (!deps.isOnline()) {
            break;
          }
        }
        deps.onChange?.();
      }
    }

    const rimasti = await deps.queue.list();
    return {
      uploaded,
      failed,
      remaining: rimasti.length,
      exhausted: rimasti.filter((i) => isExhausted(i, maxAttempts)).length,
    };
  }

  return {
    drain(): Promise<DrainReport> {
      if (running !== null) {
        return running;
      }
      running = runOnce().finally(() => {
        running = null;
        deps.onChange?.();
      });
      return running;
    },

    inFlight(): Promise<DrainReport> | null {
      return running;
    },
  };
}
