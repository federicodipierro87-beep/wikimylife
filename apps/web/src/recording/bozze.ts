import type {
  RecordingDraft,
  RecordingDraftAdapter,
  RecordingPiece,
  UploadQueueAdapter,
} from "@wikimylife/shared";

/**
 * Cosa fare, all'avvio, delle registrazioni che non sono mai arrivate allo stop.
 *
 * ## Il caso
 *
 * Si accende il registratore, si mette il telefono in tasca e si parla per venti
 * minuti. Lo schermo si blocca, il sistema sospende la pagina e, sotto pressione
 * di memoria, la scarica. Fino a qui l'intero racconto stava in un array dentro
 * `MediaRecorderAdapter`, e si riaccendeva lo schermo per non trovare niente,
 * senza un errore. Adesso ogni secondo finisce in una bozza appena arriva, e
 * questo modulo e' cio' che ne fa una registrazione al giro successivo.
 *
 * ## Da solo, senza chiedere
 *
 * Una bozza recuperata va in coda come un vocale qualsiasi, e da li' diventa una
 * scheda. Non si chiede conferma: chi ha registrato voleva quel racconto, e un
 * pulsante «recupera» premuto dopo giorni, o mai, sarebbe la stessa perdita di
 * prima con un passaggio in piu'. Chi non lo vuole lo elimina come ogni altro
 * vocale.
 *
 * ## Cosa non si sa di una bozza
 *
 * La posizione, che arriva in memoria qualche secondo dopo l'inizio e non e'
 * scritta da nessuna parte: si recupera senza. Se fosse stata registrata senza
 * rete, anche: `capturedOffline` resta `false`. E la durata e' quella fra il
 * primo istante e l'ultimo pezzo, cioe' quella dell'audio che c'e' davvero.
 */

/**
 * Dopo quanto silenzio una bozza e' di una registrazione morta.
 *
 * Una registrazione viva scrive un pezzo al secondo, quindi la soglia separa
 * «questa scheda e' stata scaricata» da «un'altra scheda sta registrando
 * adesso»: senza, aprire l'app in una seconda scheda mentre la prima registra
 * metterebbe in coda meta' racconto, e allo stop ne arriverebbe un secondo
 * intero. Mezzo minuto e non cinque secondi perche' un browser che rallenta i
 * timer di una scheda in secondo piano puo' consegnare i pezzi a raffiche; e
 * non dieci minuti perche' chi riapre l'app subito dopo averla persa deve
 * ritrovare il vocale subito, non al giro dopo.
 */
export const SILENZIO_BOZZA_MS = 30_000;

/** Chi scrive la bozza di una registrazione in corso. */
export interface ScrittoreBozza {
  readonly id: string;
  /** Mette in fila la scrittura di un pezzo. Non lancia, e dopo la chiusura non fa niente. */
  pezzo(pezzo: RecordingPiece): void;
  /** Smette di scrivere e lascia la bozza dov'e': e' l'unica copia su disco. */
  chiudi(): void;
  /** Smette di scrivere e butta la bozza, dopo le scritture gia' in fila. */
  butta(): Promise<void>;
}

/**
 * Le scritture di una registrazione, in fila.
 *
 * ## Perche' in fila, e perche' la cancellazione in fondo
 *
 * L'ultimo pezzo arriva dal registratore quando i suoi byte sono pronti, e puo'
 * essere *dopo* che lo stop ha messo in coda la registrazione intera e chiesto
 * di buttare la bozza. Se la sua scrittura finisse dopo la cancellazione,
 * resterebbe una bozza di un secondo — senza l'intestazione del file, che sta
 * nel primo — e mezzo minuto dopo il recupero la metterebbe in coda come un
 * vocale illeggibile. In fila, con la cancellazione per ultima e i pezzi
 * successivi ignorati, quel caso non esiste.
 *
 * La fila serve anche all'ordine delle scritture, ma non e' quello a tenerlo
 * insieme: i pezzi portano il loro numero, e il recupero li rimette in ordine
 * per numero qualunque sia stato l'ordine in cui sono arrivati su disco.
 */
export function creaScrittoreBozza(deps: {
  readonly bozze: RecordingDraftAdapter;
  readonly id: string;
  readonly startedAt: number;
}): ScrittoreBozza {
  let fila: Promise<void> = Promise.resolve();
  let chiusa = false;

  function inFila(lavoro: () => Promise<void>): Promise<void> {
    // Un anello che fallisce non deve spezzare la fila: la scrittura dopo, o la
    // cancellazione, partono lo stesso.
    fila = fila.then(lavoro).catch(() => undefined);
    return fila;
  }

  return {
    id: deps.id,
    pezzo(pezzo: RecordingPiece): void {
      if (chiusa) {
        return;
      }
      void inFila(() =>
        deps.bozze.append({ ...pezzo, draftId: deps.id, startedAt: deps.startedAt }),
      );
    },
    chiudi(): void {
      chiusa = true;
    },
    butta(): Promise<void> {
      chiusa = true;
      return inFila(() => deps.bozze.discard(deps.id));
    },
  };
}

/** I pezzi, uno dopo l'altro, in un solo blocco di byte. */
export function concatena(pezzi: readonly Uint8Array[]): Uint8Array {
  const totale = pezzi.reduce((somma, p) => somma + p.byteLength, 0);
  const out = new Uint8Array(totale);
  let offset = 0;
  for (const pezzo of pezzi) {
    out.set(pezzo, offset);
    offset += pezzo.byteLength;
  }
  return out;
}

function morta(bozza: RecordingDraft, adesso: number): boolean {
  return adesso - bozza.lastPieceAt >= SILENZIO_BOZZA_MS;
}

/**
 * Mette in coda le bozze abbandonate e restituisce quante.
 *
 * L'id in coda e' quello della bozza, e non uno nuovo: se la scheda muore fra
 * l'`enqueue` e la `discard`, il recupero successivo riscrive la stessa riga
 * invece di aggiungerne una seconda.
 *
 * Non lancia. Una bozza che la coda rifiuta resta dov'e' e si riprova al
 * prossimo avvio; una che non si riesce nemmeno a leggere — IndexedDB negato,
 * Firefox in navigazione privata — vuol dire che non ce n'erano.
 */
export async function recuperaBozze(deps: {
  readonly bozze: RecordingDraftAdapter;
  readonly coda: UploadQueueAdapter;
  readonly adesso: number;
  readonly lingua: string | null;
}): Promise<number> {
  let elenco: readonly RecordingDraft[];
  try {
    elenco = await deps.bozze.list();
  } catch {
    return 0;
  }

  let recuperate = 0;
  for (const bozza of elenco) {
    if (!morta(bozza, deps.adesso)) {
      continue;
    }
    try {
      if (bozza.pieces.length > 0) {
        await deps.coda.enqueue({
          id: bozza.id,
          audio: concatena(bozza.pieces),
          mimeType: bozza.mimeType,
          durationMs: Math.max(0, bozza.lastPieceAt - bozza.startedAt),
          // L'ultimo istante di cui si ha l'audio, come per una registrazione
          // fermata a mano, dove `recordedAt` e' l'ora dello stop.
          recordedAt: new Date(bozza.lastPieceAt).toISOString(),
          latitude: null,
          longitude: null,
          placeLabel: null,
          deviceLocale: deps.lingua,
          capturedOffline: false,
        });
        recuperate += 1;
      }
      await deps.bozze.discard(bozza.id);
    } catch {
      // La coda piena o il disco che rifiuta: la bozza resta, e con lei
      // l'audio. Buttarla adesso sarebbe la perdita che questo modulo esiste
      // per evitare.
    }
  }
  return recuperate;
}
