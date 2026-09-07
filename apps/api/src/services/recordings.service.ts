import { randomUUID } from "node:crypto";
import {
  MAX_PENDING_RECORDINGS,
  extractionContractSchema,
  type CaptureMetadata,
  type ExtractionIssue,
  type RecordingState,
  type StorageProvider,
} from "@wikimylife/shared";
import { AppError } from "../errors/AppError.js";
import type { Clock } from "./ports/Clock.js";
import type { RecordingDetail, RecordingRepository } from "./ports/RecordingRepository.js";
import { validateExtraction } from "./validation/extractionValidation.js";

/**
 * Il lato sincrono delle registrazioni: caricare, guardare, rimettere in coda.
 *
 * Fa poco di proposito. L'unica decisione vera e' l'ordine delle due operazioni
 * di `createRecording`, e non e' negoziabile: prima i byte nello storage, poi
 * la riga nel database. Se il database cade dopo il `put`, resta un oggetto
 * orfano — qualche kilobyte da raccogliere; se l'ordine fosse invertito e
 * cadesse lo storage, resterebbe una riga che punta a un audio che non esiste,
 * e la registrazione dell'utente sarebbe persa per sempre. Il brief lo dice in
 * una riga: "l'audio si salva prima di ogni altra cosa".
 */

/**
 * Estensione del file salvato.
 *
 * Non e' cosmesi: Whisper decide il decoder dall'estensione del nome che riceve
 * nel multipart, e un blob chiamato "audio" senza estensione viene rifiutato.
 * Sconosciuto -> `.bin`, che almeno non mente.
 */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/m4a": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/flac": ".flac",
};

export function audioExtension(mimeType: string): string {
  const base = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return EXTENSION_BY_MIME[base] ?? ".bin";
}

/**
 * Ricostruisce gli `issues` della §5 dal JSON conservato.
 *
 * Sono derivati, non memorizzati: `rawExtraction` e' il dato, gli issues sono
 * cio' che le regole dicono di quel dato. Una colonna li congelerebbe alla
 * versione delle regole in vigore il giorno dell'estrazione, e alla prima
 * modifica della §5 mostreremmo all'utente un verdetto che il codice non
 * emetterebbe piu'.
 */
function issuesOf(raw: unknown): {
  issues: readonly ExtractionIssue[];
  extraction: RecordingState["extraction"];
} {
  if (raw === null || raw === undefined) {
    return { issues: [], extraction: null };
  }
  const verdict = validateExtraction(raw);
  const parsed = extractionContractSchema.safeParse(raw);
  return {
    issues: verdict.issues,
    extraction: parsed.success ? parsed.data : null,
  };
}

export function toRecordingState(detail: RecordingDetail): RecordingState {
  const { issues, extraction } = issuesOf(detail.rawExtraction);

  return {
    id: detail.id,
    status: detail.status,
    recordedAt: detail.recordedAt.toISOString(),
    durationMs: detail.durationMs,
    mimeType: detail.mimeType,
    sizeBytes: detail.sizeBytes,
    capturedOffline: detail.capturedOffline,
    placeLabel: detail.placeLabel,
    transcript: detail.transcript,
    transcriptSource: detail.transcriptSource,
    procedureId: detail.procedureId,
    retryCount: detail.retryCount,
    lastError:
      detail.lastErrorCode === null
        ? null
        : {
            code: detail.lastErrorCode,
            message: detail.lastErrorMessage ?? "",
            at: (detail.lastErrorAt ?? detail.updatedAt).toISOString(),
          },
    nextAttemptAt: detail.nextAttemptAt?.toISOString() ?? null,
    duplicate:
      detail.duplicateOfId === null
        ? null
        : {
            procedureId: detail.duplicateOfId,
            titolo: detail.duplicateOfTitolo ?? "",
            similarity: detail.duplicateSimilarity ?? 0,
          },
    extraction,
    issues: [...issues],
    updatedAt: detail.updatedAt.toISOString(),
  };
}

export interface UploadedAudio {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface RecordingsService {
  create(
    userId: string,
    input: { readonly audio: UploadedAudio; readonly metadata: CaptureMetadata },
  ): Promise<RecordingState>;
  find(userId: string, id: string): Promise<RecordingState>;
  /** Cio' che e' stato raccontato e non e' ancora una scheda. */
  pending(userId: string): Promise<readonly RecordingState[]>;
  retry(userId: string, id: string): Promise<RecordingState>;
  /** I byte originali, per il player in fondo alla scheda (§ Fase 4). */
  audio(userId: string, id: string): Promise<UploadedAudio>;
  /** Cancella riga e audio. Rifiuta finche' un worker la sta elaborando. */
  remove(userId: string, id: string): Promise<void>;
}

export interface RecordingsServiceDeps {
  readonly repo: RecordingRepository;
  readonly storage: StorageProvider;
  readonly clock: Clock;
  /**
   * Chiamata dopo la creazione e dopo il retry. In produzione e' un no-op — e'
   * il worker a fare polling — ma nei test end-to-end permette di eseguire la
   * pipeline in-process, senza un secondo processo da avviare e da aspettare.
   */
  readonly onEnqueued?: ((recordingId: string) => void) | undefined;
  /**
   * L'oggetto e' rimasto nel bucket dopo che la riga era gia' sparita.
   *
   * Serve perche' `remove` non propaga quell'errore — per l'utente la
   * cancellazione e' avvenuta — e senza questo la perdita sarebbe invisibile:
   * un bucket che cresce di file che nessuna riga nomina piu', scoperto dalla
   * fattura.
   */
  readonly onOrphanedAudio?: ((info: { key: string; error: unknown }) => void) | undefined;
}

export function createRecordingsService(deps: RecordingsServiceDeps): RecordingsService {
  const { repo, clock } = deps;

  return {
    async create(
      userId: string,
      input: { audio: UploadedAudio; metadata: CaptureMetadata },
    ): Promise<RecordingState> {
      const { metadata } = input;
      // La chiave e' casuale e non derivata dall'id della riga, perche' la riga
      // non esiste ancora: e' il prezzo di salvare i byte per primi.
      const key = `${userId}/${randomUUID()}${audioExtension(input.audio.mimeType)}`;

      const stored = await deps.storage.put({
        key,
        data: input.audio.bytes,
        mimeType: input.audio.mimeType,
      });

      const detail = await repo.create({
        userId,
        // La chiave e non `stored.url`: e' cio' che si ripassa a
        // `storage.get`. Il nome del campo viene dalla §6; un URL firmato,
        // quando arrivera', lo costruira' il provider a partire da qui.
        audioUrl: stored.key,
        mimeType: input.audio.mimeType,
        sizeBytes: stored.sizeBytes,
        durationMs: metadata.durationMs,
        recordedAt: new Date(metadata.recordedAt),
        capturedOffline: metadata.capturedOffline,
        deviceLocale: metadata.deviceLocale,
        latitude: metadata.latitude,
        longitude: metadata.longitude,
        placeLabel: metadata.placeLabel,
      });

      deps.onEnqueued?.(detail.id);
      return toRecordingState(detail);
    },

    async find(userId: string, id: string): Promise<RecordingState> {
      const detail = await repo.findForUser(userId, id);
      if (detail === null) {
        // 404 anche quando la riga esiste ma e' di un altro: un 403
        // confermerebbe che quell'id e' stato assegnato a qualcuno.
        throw AppError.notFound("Registrazione non trovata");
      }
      return toRecordingState(detail);
    },

    async pending(userId: string): Promise<readonly RecordingState[]> {
      const details = await repo.listPending(userId, MAX_PENDING_RECORDINGS);
      return details.map(toRecordingState);
    },

    async retry(userId: string, id: string): Promise<RecordingState> {
      const detail = await repo.requeue(userId, id, clock.now());
      if (detail === null) {
        throw AppError.notFound("Registrazione non trovata o non riprocessabile");
      }
      deps.onEnqueued?.(detail.id);
      return toRecordingState(detail);
    },

    async audio(userId: string, id: string): Promise<UploadedAudio> {
      const detail = await repo.findForUser(userId, id);
      if (detail === null) {
        throw AppError.notFound("Registrazione non trovata");
      }

      // L'oggetto puo' mancare: `create` scrive i byte prima della riga, quindi
      // un database ripristinato da un backup piu' recente dello storage lascia
      // righe senza audio. E' un 404 e non un 500 — la risorsa non c'e', e il
      // client deve mostrare la scheda senza player invece di un errore.
      let bytes: Uint8Array;
      try {
        bytes = await deps.storage.get(detail.audioUrl);
      } catch {
        throw AppError.notFound("Audio non disponibile");
      }

      return { bytes, mimeType: detail.mimeType };
    },

    /**
     * L'ordine e' l'opposto di `create`, e per la stessa ragione.
     *
     * Alla creazione i byte vanno per primi perche' l'audio e' il dato non
     * riproducibile: se cade il database resta un oggetto orfano, che e' poco.
     * Alla cancellazione la riga va per prima perche' e' lei a essere condivisa
     * con il worker: togliere l'oggetto per primo lascerebbe, per il tempo di
     * una chiamata di rete, una riga reclamabile che punta a un audio che non
     * c'e' — e il worker che la prendesse in quell'istante fallirebbe la
     * trascrizione e la marcherebbe ESTRAZIONE_FALLITA, mostrando all'utente un
     * errore per una cosa che aveva chiesto lui.
     *
     * Cadendo dopo il DELETE resta un oggetto che nessuno riferisce piu': la
     * stessa perdita della creazione interrotta, e la stessa raccolta che
     * ancora non c'e'.
     */
    async remove(userId: string, id: string): Promise<void> {
      const esito = await repo.deleteForUser(userId, id);

      if (esito.kind === "ASSENTE") {
        throw AppError.notFound("Registrazione non trovata");
      }
      if (esito.kind === "IN_LAVORAZIONE") {
        // 409 e non 404: qui la registrazione esiste, e' dell'utente, e il
        // rifiuto e' temporaneo. Dirgli «non trovata» lo manderebbe a cercare
        // un errore suo invece di riprovare fra un minuto.
        throw AppError.conflict(
          "Registrazione in elaborazione: riprova quando ha finito",
        );
      }

      // Un fallimento qui non si propaga all'utente. La riga non c'e' piu',
      // quindi per lui la registrazione e' cancellata: un 500 lo spingerebbe a
      // ripetere una DELETE che ormai non puo' che dare 404. Resta un file che
      // nessuno sa piu' raggiungere — un problema di pulizia, non suo, e per
      // questo va segnalato a chi tiene il bucket invece che a chi ha premuto.
      try {
        await deps.storage.delete(esito.audioUrl);
      } catch (error: unknown) {
        deps.onOrphanedAudio?.({ key: esito.audioUrl, error });
      }
    },
  };
}
