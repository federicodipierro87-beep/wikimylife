import { randomUUID } from "node:crypto";
import {
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
  retry(userId: string, id: string): Promise<RecordingState>;
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

    async retry(userId: string, id: string): Promise<RecordingState> {
      const detail = await repo.requeue(userId, id, clock.now());
      if (detail === null) {
        throw AppError.notFound("Registrazione non trovata o non riprocessabile");
      }
      deps.onEnqueued?.(detail.id);
      return toRecordingState(detail);
    },
  };
}
