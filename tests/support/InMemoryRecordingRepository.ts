import { RecordingStatus } from "@wikimylife/shared";
import type {
  CreateRecordingInput,
  DeleteRecordingOutcome,
  PersistProcedureInput,
  RecordingDetail,
  RecordingFailure,
  RecordingJob,
  RecordingRepository,
  SimilarProcedure,
  UserVocabulary,
} from "../../apps/api/src/services/ports/RecordingRepository.js";

/**
 * `RecordingRepository` in memoria.
 *
 * Riproduce i tre vincoli del database che la pipeline puo' davvero
 * osservare — e nessun altro, perche' riprodurre Postgres a mano finirebbe per
 * testare la copia invece dell'originale:
 *
 *  1. `claim` e' un compare-and-swap: si riesce solo dagli stati reclamabili,
 *     e una seconda chiamata sullo stesso id fallisce. E' cio' che permette al
 *     test "due worker non elaborano la stessa riga" di esistere senza thread.
 *  2. la similarita' e' un coseno vero, calcolato sui vettori registrati con
 *     `seedProcedure`: la soglia 0.85 si prova con numeri, non con un mock che
 *     risponde "si'".
 *  3. `persistProcedure` conserva l'input integrale, cosi' un test puo'
 *     asserire che i passi arrivino rinumerati e che la scheda nasca nello
 *     stato deciso dalla §5.
 */

interface SeededProcedure {
  readonly id: string;
  readonly userId: string;
  readonly titolo: string;
  readonly embedding: readonly number[];
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const CLAIMABLE: readonly string[] = [
  RecordingStatus.BOZZA_AUDIO,
  RecordingStatus.ESTRAZIONE_FALLITA,
];

export class InMemoryRecordingRepository implements RecordingRepository {
  readonly #recordings = new Map<string, RecordingDetail>();
  readonly #procedures: SeededProcedure[] = [];
  #sequence = 0;

  /** Tutte le chiamate riuscite a `persistProcedure`, in ordine. */
  readonly persisted: PersistProcedureInput[] = [];
  /** Impostabile dal test per far fallire la persistenza. */
  persistFailure: Error | null = null;
  vocabulary: UserVocabulary = { scopes: [], tags: [] };

  #nextId(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${String(this.#sequence)}`;
  }

  #put(detail: RecordingDetail): RecordingDetail {
    this.#recordings.set(detail.id, detail);
    return detail;
  }

  #require(id: string): RecordingDetail {
    const found = this.#recordings.get(id);
    if (found === undefined) {
      throw new Error(`InMemoryRecordingRepository: registrazione assente ${id}`);
    }
    return found;
  }

  /** Registrazione gia' pronta da elaborare, senza passare dalla rotta. */
  seedRecording(input: Partial<RecordingDetail> & { userId: string }): RecordingDetail {
    const id = input.id ?? this.#nextId("rec");
    return this.#put({
      id,
      userId: input.userId,
      audioUrl: input.audioUrl ?? `${input.userId}/${id}.webm`,
      mimeType: input.mimeType ?? "audio/webm",
      sizeBytes: input.sizeBytes ?? 1024,
      durationMs: input.durationMs ?? 30_000,
      recordedAt: input.recordedAt ?? new Date("2026-03-01T10:00:00.000Z"),
      capturedOffline: input.capturedOffline ?? false,
      deviceLocale: input.deviceLocale ?? "it-IT",
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      placeLabel: input.placeLabel ?? null,
      status: input.status ?? RecordingStatus.BOZZA_AUDIO,
      transcript: input.transcript ?? null,
      transcriptSource: input.transcriptSource ?? null,
      rawExtraction: input.rawExtraction ?? null,
      extractionModel: input.extractionModel ?? null,
      procedureId: input.procedureId ?? null,
      lastErrorCode: input.lastErrorCode ?? null,
      lastErrorMessage: input.lastErrorMessage ?? null,
      lastErrorAt: input.lastErrorAt ?? null,
      nextAttemptAt: input.nextAttemptAt ?? null,
      duplicateOfId: input.duplicateOfId ?? null,
      duplicateOfTitolo: input.duplicateOfTitolo ?? null,
      duplicateSimilarity: input.duplicateSimilarity ?? null,
      retryCount: input.retryCount ?? 0,
      updatedAt: input.updatedAt ?? new Date("2026-03-01T10:00:00.000Z"),
    });
  }

  /** Procedura preesistente con il suo vettore: e' cio' contro cui si deduplica. */
  seedProcedure(input: {
    readonly userId: string;
    readonly titolo: string;
    readonly embedding: readonly number[];
    readonly id?: string;
  }): SeededProcedure {
    const procedure: SeededProcedure = {
      id: input.id ?? this.#nextId("proc"),
      userId: input.userId,
      titolo: input.titolo,
      embedding: input.embedding,
    };
    this.#procedures.push(procedure);
    return procedure;
  }

  snapshot(id: string): RecordingDetail {
    return this.#require(id);
  }

  async create(input: CreateRecordingInput): Promise<RecordingDetail> {
    return this.seedRecording({ ...input, id: this.#nextId("rec") });
  }

  async claim(id: string, at: Date): Promise<RecordingJob | null> {
    const row = this.#recordings.get(id);
    if (row === undefined || !CLAIMABLE.includes(row.status)) {
      return null;
    }
    const claimed = this.#put({
      ...row,
      status: RecordingStatus.IN_ELABORAZIONE,
      nextAttemptAt: null,
      updatedAt: at,
    });
    return {
      id: claimed.id,
      userId: claimed.userId,
      audioUrl: claimed.audioUrl,
      mimeType: claimed.mimeType,
      recordedAt: claimed.recordedAt,
      deviceLocale: claimed.deviceLocale,
      latitude: claimed.latitude,
      longitude: claimed.longitude,
      placeLabel: claimed.placeLabel,
      retryCount: claimed.retryCount,
    };
  }

  async claimNext(at: Date): Promise<RecordingJob | null> {
    const candidate = [...this.#recordings.values()]
      .filter(
        (r) =>
          r.status === RecordingStatus.BOZZA_AUDIO &&
          // `null` e' "subito". Il confronto e' `<=` come in SQL: una riga la
          // cui attesa scade esattamente adesso e' scaduta.
          (r.nextAttemptAt === null || r.nextAttemptAt.getTime() <= at.getTime()),
      )
      .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())[0];
    return candidate === undefined ? null : this.claim(candidate.id, at);
  }

  async saveTranscript(
    id: string,
    input: { text: string; source: string; at: Date },
  ): Promise<void> {
    const row = this.#require(id);
    this.#put({
      ...row,
      transcript: input.text,
      transcriptSource: input.source,
      updatedAt: input.at,
    });
  }

  async saveExtraction(
    id: string,
    input: { raw: unknown; model: string; at: Date },
  ): Promise<void> {
    const row = this.#require(id);
    this.#put({
      ...row,
      rawExtraction: input.raw,
      extractionModel: input.model,
      updatedAt: input.at,
    });
  }

  async vocabularyOf(_userId: string): Promise<UserVocabulary> {
    return this.vocabulary;
  }

  async findMostSimilar(
    userId: string,
    embedding: readonly number[],
  ): Promise<SimilarProcedure | null> {
    const scored = this.#procedures
      .filter((p) => p.userId === userId)
      .map((p) => ({
        procedureId: p.id,
        titolo: p.titolo,
        similarity: cosine(p.embedding, embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity);
    return scored[0] ?? null;
  }

  async markDuplicate(
    id: string,
    input: { procedureId: string; similarity: number; at: Date },
  ): Promise<void> {
    const row = this.#require(id);
    const target = this.#procedures.find((p) => p.id === input.procedureId);
    this.#put({
      ...row,
      status: RecordingStatus.DUPLICATO_SOSPETTO,
      duplicateOfId: input.procedureId,
      duplicateOfTitolo: target?.titolo ?? null,
      duplicateSimilarity: input.similarity,
      updatedAt: input.at,
    });
  }

  async persistProcedure(input: PersistProcedureInput): Promise<string> {
    if (this.persistFailure !== null) {
      throw this.persistFailure;
    }
    this.persisted.push(input);
    const procedure = this.seedProcedure({
      userId: input.userId,
      titolo: input.contract.titolo ?? "",
      embedding: input.embedding,
    });
    const row = this.#require(input.recordingId);
    this.#put({
      ...row,
      status: RecordingStatus.ESTRATTO,
      procedureId: procedure.id,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorAt: null,
    });
    return procedure.id;
  }

  async markFailed(id: string, failure: RecordingFailure): Promise<void> {
    const row = this.#require(id);
    this.#put({
      ...row,
      status: failure.status,
      lastErrorCode: failure.code,
      lastErrorMessage: failure.message,
      lastErrorAt: failure.at,
      nextAttemptAt: failure.nextAttemptAt,
      retryCount: row.retryCount + 1,
      updatedAt: failure.at,
    });
  }

  async findForUser(userId: string, id: string): Promise<RecordingDetail | null> {
    const row = this.#recordings.get(id);
    return row === undefined || row.userId !== userId ? null : row;
  }

  async listPending(userId: string, limit: number): Promise<readonly RecordingDetail[]> {
    return [...this.#recordings.values()]
      .filter((r) => r.userId === userId && r.status !== RecordingStatus.ESTRATTO)
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
      .slice(0, limit);
  }

  async requeue(userId: string, id: string, at: Date): Promise<RecordingDetail | null> {
    const row = this.#recordings.get(id);
    if (
      row === undefined ||
      row.userId !== userId ||
      row.status === RecordingStatus.IN_ELABORAZIONE ||
      row.status === RecordingStatus.ESTRATTO
    ) {
      return null;
    }
    return this.#put({
      ...row,
      status: RecordingStatus.BOZZA_AUDIO,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorAt: at,
      // Il riscatto manuale non eredita l'attesa: e' il gesto di qualcuno, non
      // un giro del ciclo.
      nextAttemptAt: null,
      duplicateOfId: null,
      duplicateOfTitolo: null,
      duplicateSimilarity: null,
      retryCount: row.retryCount + 1,
      updatedAt: at,
    });
  }

  async deleteForUser(userId: string, id: string): Promise<DeleteRecordingOutcome> {
    const row = this.#recordings.get(id);
    if (row === undefined || row.userId !== userId) {
      return { kind: "ASSENTE" };
    }
    if (row.status === RecordingStatus.IN_ELABORAZIONE) {
      return { kind: "IN_LAVORAZIONE" };
    }
    this.#recordings.delete(id);
    // La procedura eventualmente derivata resta dov'e': la riga cancellata la
    // nominava, non la possedeva. Se qui la togliessimo anche da `#procedures`
    // il test "la scheda sopravvive" passerebbe contro una finzione compiacente.
    return { kind: "CANCELLATA", audioUrl: row.audioUrl };
  }
}
