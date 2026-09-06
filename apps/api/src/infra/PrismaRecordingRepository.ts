import {
  RecordingStatus,
  Scope,
  Visibility,
  searchText,
  type ExtractionContract,
} from "@wikimylife/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  CreateRecordingInput,
  PersistProcedureInput,
  RecordingDetail,
  RecordingFailure,
  RecordingJob,
  RecordingRepository,
  SimilarProcedure,
  UserVocabulary,
} from "../services/ports/RecordingRepository.js";

/**
 * Implementazione Prisma della porta delle registrazioni.
 *
 * Traduce fra righe e record. Le uniche due cose non meccaniche sono qui
 * dentro per forza, non per scelta: il compare-and-swap che assegna un job (si
 * fa con `updateMany`, l'unico modo di sapere quante righe si sono toccate) e
 * le due query su `embedding`, che essendo una colonna `Unsupported` non esiste
 * nel client tipizzato e si raggiunge solo in SQL grezzo.
 */

/** Gli stati da cui si puo' iniziare un'elaborazione. */
const CLAIMABLE = [RecordingStatus.BOZZA_AUDIO, RecordingStatus.ESTRAZIONE_FALLITA] as const;

interface RecordingRow {
  id: string;
  userId: string;
  audioUrl: string;
  mimeType: string;
  sizeBytes: number | null;
  durationMs: number;
  recordedAt: Date;
  capturedOffline: boolean;
  deviceLocale: string | null;
  latitude: number | null;
  longitude: number | null;
  placeLabel: string | null;
  status: string;
  transcript: string | null;
  transcriptSource: string | null;
  rawExtraction: Prisma.JsonValue | null;
  extractionModel: string | null;
  procedureId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: Date | null;
  nextAttemptAt: Date | null;
  duplicateOfId: string | null;
  duplicateSimilarity: number | null;
  retryCount: number;
  updatedAt: Date;
  duplicateOf: { titolo: string } | null;
}

const WITH_DUPLICATE = { duplicateOf: { select: { titolo: true } } } as const;

function toDetail(row: RecordingRow): RecordingDetail {
  return {
    id: row.id,
    userId: row.userId,
    audioUrl: row.audioUrl,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    durationMs: row.durationMs,
    recordedAt: row.recordedAt,
    capturedOffline: row.capturedOffline,
    deviceLocale: row.deviceLocale,
    latitude: row.latitude,
    longitude: row.longitude,
    placeLabel: row.placeLabel,
    status: row.status as RecordingDetail["status"],
    transcript: row.transcript,
    transcriptSource: row.transcriptSource,
    rawExtraction: row.rawExtraction,
    extractionModel: row.extractionModel,
    procedureId: row.procedureId,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    lastErrorAt: row.lastErrorAt,
    nextAttemptAt: row.nextAttemptAt,
    duplicateOfId: row.duplicateOfId,
    duplicateOfTitolo: row.duplicateOf?.titolo ?? null,
    duplicateSimilarity: row.duplicateSimilarity,
    retryCount: row.retryCount,
    updatedAt: row.updatedAt,
  };
}

function toJob(detail: RecordingDetail): RecordingJob {
  return {
    id: detail.id,
    userId: detail.userId,
    audioUrl: detail.audioUrl,
    mimeType: detail.mimeType,
    recordedAt: detail.recordedAt,
    deviceLocale: detail.deviceLocale,
    latitude: detail.latitude,
    longitude: detail.longitude,
    placeLabel: detail.placeLabel,
    retryCount: detail.retryCount,
  };
}

/** `[0.1,0.2,...]`: la sintassi che pgvector accetta in input. */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function sumCosti(contract: ExtractionContract): number | null {
  if (contract.costi.length === 0) {
    return null;
  }
  // Calcolato, mai preso dal modello: `costoTotaleCent` e' una somma, e una
  // somma che non torna e' peggio di un campo vuoto.
  return contract.costi.reduce((total, costo) => total + costo.importoCent, 0);
}

/**
 * Regola trasversale del brief: una procedura di ambito CLIENTE non puo' essere
 * PUBBLICA. Qui e' quasi tautologica — ogni scheda nasce PRIVATA — ma la
 * funzione esiste perche' la regola vive nel codice e non nella UI, e perche'
 * quando la Fase 3 aggiungera' la modifica dell'ambito il punto da chiamare
 * sara' gia' scritto.
 */
export function visibilitaConsentita(
  scope: (typeof Scope)[keyof typeof Scope],
  desiderata: (typeof Visibility)[keyof typeof Visibility],
): (typeof Visibility)[keyof typeof Visibility] {
  if (scope === Scope.CLIENTE && desiderata === Visibility.PUBBLICA) {
    return Visibility.PRIVATA;
  }
  return desiderata;
}

export class PrismaRecordingRepository implements RecordingRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async create(input: CreateRecordingInput): Promise<RecordingDetail> {
    const row = await this.#prisma.recording.create({
      data: {
        userId: input.userId,
        audioUrl: input.audioUrl,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        durationMs: input.durationMs,
        recordedAt: input.recordedAt,
        capturedOffline: input.capturedOffline,
        deviceLocale: input.deviceLocale,
        latitude: input.latitude,
        longitude: input.longitude,
        placeLabel: input.placeLabel,
        status: RecordingStatus.BOZZA_AUDIO,
      },
      include: WITH_DUPLICATE,
    });
    return toDetail(row);
  }

  async claim(id: string, at: Date): Promise<RecordingJob | null> {
    const claimed = await this.#prisma.recording.updateMany({
      where: { id, status: { in: [...CLAIMABLE] } },
      // `nextAttemptAt` si azzera prendendo la riga: descrive un'attesa, e
      // l'attesa e' finita. Lasciarlo scritto significherebbe che una riga
      // ripresa a mano prima della scadenza continua a dichiarare un'ora che e'
      // gia' passata mentre viene elaborata.
      data: { status: RecordingStatus.IN_ELABORAZIONE, lastErrorAt: at, nextAttemptAt: null },
    });
    if (claimed.count === 0) {
      return null;
    }
    const row = await this.#prisma.recording.findUnique({
      where: { id },
      include: WITH_DUPLICATE,
    });
    return row === null ? null : toJob(toDetail(row));
  }

  async claimNext(at: Date): Promise<RecordingJob | null> {
    // Solo BOZZA_AUDIO: una ESTRAZIONE_FALLITA si riprende su richiesta
    // esplicita (`/retry`), altrimenti il worker riproverebbe all'infinito una
    // trascrizione che il modello non sa strutturare, bruciando token a ogni
    // giro senza che nessuno se ne accorga.
    //
    // E fra le BOZZA_AUDIO, solo quelle scadute. `null` e' "mai fallita, quindi
    // subito": va tenuto esplicitamente perche' in SQL `NULL <= now()` non e'
    // vero, e' sconosciuto — un `WHERE nextAttemptAt <= $1` da solo escluderebbe
    // tutte le registrazioni nuove, cioe' fermerebbe la pipeline.
    const candidate = await this.#prisma.recording.findFirst({
      where: {
        status: RecordingStatus.BOZZA_AUDIO,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: at } }],
      },
      orderBy: { recordedAt: "asc" },
      select: { id: true },
    });
    if (candidate === null) {
      return null;
    }
    return this.claim(candidate.id, at);
  }

  async saveTranscript(
    id: string,
    input: { text: string; source: string; at: Date },
  ): Promise<void> {
    await this.#prisma.recording.update({
      where: { id },
      data: { transcript: input.text, transcriptSource: input.source, transcribedAt: input.at },
    });
  }

  async saveExtraction(
    id: string,
    input: { raw: unknown; model: string; at: Date },
  ): Promise<void> {
    await this.#prisma.recording.update({
      where: { id },
      data: {
        // `?? Prisma.JsonNull`: se il modello ha risposto `null`, quello e' il
        // dato. `undefined` in Prisma significa "non toccare la colonna", che
        // qui cancellerebbe la distinzione fra "non ha risposto" e "ha risposto
        // null".
        rawExtraction: (input.raw ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        extractionModel: input.model,
        extractedAt: input.at,
      },
    });
  }

  async vocabularyOf(userId: string): Promise<UserVocabulary> {
    const [scopes, tags] = await Promise.all([
      this.#prisma.procedure.findMany({
        where: { userId },
        distinct: ["scope"],
        select: { scope: true },
      }),
      this.#prisma.tag.findMany({
        where: { userId },
        orderBy: { nome: "asc" },
        select: { nome: true },
        // Il prompt e' un contesto, non un dizionario: oltre un centinaio di
        // tag la lista costerebbe token senza aiutare a sceglierne uno.
        take: 100,
      }),
    ]);

    return {
      scopes: scopes.map((s) => s.scope as (typeof Scope)[keyof typeof Scope]),
      tags: tags.map((t) => t.nome),
    };
  }

  async findMostSimilar(
    userId: string,
    embedding: readonly number[],
  ): Promise<SimilarProcedure | null> {
    const literal = toVectorLiteral(embedding);
    // `<=>` e' la distanza coseno di pgvector, quindi la similarita' e' 1 meno
    // quella. L'ORDER BY usa l'operatore e non l'espressione calcolata: e'
    // l'unica forma che l'indice HNSW sa servire.
    const rows = await this.#prisma.$queryRaw<
      { id: string; titolo: string; similarity: number }[]
    >`
      SELECT p."id", p."titolo", 1 - (p."embedding" <=> ${literal}::vector) AS "similarity"
      FROM "Procedure" p
      WHERE p."userId" = ${userId}
        AND p."embedding" IS NOT NULL
        AND p."status" <> 'ARCHIVIATA'::"CardStatus"
      ORDER BY p."embedding" <=> ${literal}::vector
      LIMIT 1
    `;

    const best = rows[0];
    return best === undefined
      ? null
      : { procedureId: best.id, titolo: best.titolo, similarity: best.similarity };
  }

  async markDuplicate(
    id: string,
    input: { procedureId: string; similarity: number; at: Date },
  ): Promise<void> {
    await this.#prisma.recording.update({
      where: { id },
      data: {
        status: RecordingStatus.DUPLICATO_SOSPETTO,
        duplicateOfId: input.procedureId,
        duplicateSimilarity: input.similarity,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        extractedAt: input.at,
      },
    });
  }

  async persistProcedure(input: PersistProcedureInput): Promise<string> {
    const { contract } = input;
    const titolo = contract.titolo?.trim() ?? "";
    const scope = (contract.ambitoSuggerito ?? Scope.PERSONALE) as (typeof Scope)[keyof typeof Scope];

    return this.#prisma.$transaction(async (tx) => {
      const tagIds: string[] = [];
      for (const nome of contract.tag) {
        const pulito = nome.trim();
        if (pulito === "") {
          continue;
        }
        const tag = await tx.tag.upsert({
          where: { userId_nome: { userId: input.userId, nome: pulito } },
          update: {},
          create: { userId: input.userId, nome: pulito },
        });
        tagIds.push(tag.id);
      }

      const procedure = await tx.procedure.create({
        data: {
          userId: input.userId,
          titolo,
          trigger: contract.trigger,
          esito: contract.esito,
          validitaEsito: contract.validitaEsito,
          durataStimataMin: contract.durataTotaleStimataMin,
          costoTotaleCent: sumCosti(contract),
          luogoNome: contract.luogo.nome,
          luogoDettaglio: contract.luogo.dettaglio,
          latitude: input.latitude,
          longitude: input.longitude,
          scope,
          visibility: visibilitaConsentita(scope, Visibility.PRIVATA),
          status: input.cardStatus,
          // La registrazione stessa e' la prima esecuzione riuscita: e' il
          // significato di `volteEseguita @default(1)` nella §6.
          ultimaVerifica: input.recordedAt,
          volteEseguita: 1,
          contieneDatiSensibili: contract._meta.contieneDatiSensibili,
          // [D10] La colonna che alimenta il `tsvector` generato. Si scrive qui
          // e non con un secondo UPDATE perche' il testo si conosce gia' tutto:
          // i figli vengono creati nella stessa istruzione, dagli stessi dati.
          searchText: searchText({
            titolo,
            trigger: contract.trigger,
            esito: contract.esito,
            steps: contract.passi,
            prereqs: contract.prerequisiti,
            pitfalls: contract.trappole,
            tag: contract.tag,
          }),
          steps: {
            create: contract.passi.map((passo) => ({
              ordine: passo.ordine,
              azione: passo.azione,
              dettaglio: passo.dettaglio,
              durataStimataMin: passo.durataStimataMin,
            })),
          },
          prereqs: {
            create: contract.prerequisiti.map((p) => ({
              descrizione: p.descrizione,
              tipo: p.tipo,
              obbligatorio: p.obbligatorio,
            })),
          },
          pitfalls: {
            create: contract.trappole.map((t) => ({
              descrizione: t.descrizione,
              gravita: t.gravita,
            })),
          },
          costs: {
            create: contract.costi.map((c) => ({
              descrizione: c.descrizione,
              importoCent: c.importoCent,
              valuta: c.valuta,
            })),
          },
          refs: {
            create: contract.riferimenti.map((r) => ({ tipo: r.tipo, valore: r.valore })),
          },
          executions: {
            create: [{ eseguitaIl: input.recordedAt, esito: "FUNZIONATO" }],
          },
          tags: { create: tagIds.map((tagId) => ({ tagId })) },
        },
        select: { id: true },
      });

      const literal = toVectorLiteral(input.embedding);
      await tx.$executeRaw`UPDATE "Procedure" SET embedding = ${literal}::vector WHERE id = ${procedure.id}`;

      await tx.recording.update({
        where: { id: input.recordingId },
        data: {
          status: RecordingStatus.ESTRATTO,
          procedureId: procedure.id,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastErrorAt: null,
        },
      });

      return procedure.id;
    });
  }

  async markFailed(id: string, failure: RecordingFailure): Promise<void> {
    await this.#prisma.recording.update({
      where: { id },
      data: {
        status: failure.status,
        lastErrorCode: failure.code,
        // Troncato: un messaggio di errore di un SDK puo' contenere il corpo
        // intero di una risposta HTTP, e questa colonna non e' un log.
        lastErrorMessage: failure.message.slice(0, 2000),
        lastErrorAt: failure.at,
        nextAttemptAt: failure.nextAttemptAt,
        retryCount: { increment: 1 },
      },
    });
  }

  async findForUser(userId: string, id: string): Promise<RecordingDetail | null> {
    // WHERE composto, non `findUnique` seguito da un `if`: la riga di un altro
    // utente non deve nemmeno arrivare in memoria.
    const row = await this.#prisma.recording.findFirst({
      where: { id, userId },
      include: WITH_DUPLICATE,
    });
    return row === null ? null : toDetail(row);
  }

  async requeue(userId: string, id: string, at: Date): Promise<RecordingDetail | null> {
    // Non si rimette in coda cio' che e' gia' in volo (IN_ELABORAZIONE) ne' cio'
    // che ha gia' prodotto una scheda (ESTRATTO): nel primo caso avremmo due
    // elaborazioni sulla stessa riga, nel secondo una seconda scheda identica.
    const updated = await this.#prisma.recording.updateMany({
      where: {
        id,
        userId,
        status: {
          in: [
            RecordingStatus.BOZZA_AUDIO,
            RecordingStatus.ESTRAZIONE_FALLITA,
            RecordingStatus.DUPLICATO_SOSPETTO,
          ],
        },
      },
      data: {
        status: RecordingStatus.BOZZA_AUDIO,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: at,
        // Chi chiede un retry lo chiede adesso. Il backoff protegge dal ciclo
        // automatico, e un ciclo automatico non preme un pulsante.
        nextAttemptAt: null,
        duplicateOfId: null,
        duplicateSimilarity: null,
        retryCount: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      return null;
    }
    return this.findForUser(userId, id);
  }
}
