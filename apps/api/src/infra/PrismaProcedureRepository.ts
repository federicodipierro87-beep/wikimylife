import {
  CardStatus,
  SEARCH_MIN_SIMILARITY,
  toVectorLiteral,
  type Scope,
} from "@wikimylife/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AddExecutionData,
  ListProceduresFilter,
  ProcedureDetailRow,
  ProcedurePage,
  ProcedureRepository,
  ProcedureSummaryRow,
  ScoredProcedureId,
  UpdateProcedureData,
} from "../services/ports/ProcedureRepository.js";

/**
 * Implementazione Prisma della porta delle schede.
 *
 * Tre cose meritano attenzione, e sono tutte conseguenza di scelte fatte prima:
 *
 *  1. le due query di ricerca sono SQL grezzo, perche' `embedding` e
 *     `searchVector` sono colonne `Unsupported` e non esistono nel client
 *     tipizzato;
 *  2. l'`UPDATE` sostituisce le righe figlie cancellandole e ricreandole, il che
 *     e' brutale ma e' l'unica semantica senza casi limite (vedi
 *     `updateProcedureBodySchema`);
 *  3. ogni WHERE porta `userId`. Non c'e' un `findUnique` seguito da un `if` in
 *     tutto il file: la riga di un altro utente non arriva mai in memoria, e la
 *     rotta non ha modo di trasformare un 404 in un 403 per distrazione.
 */

// ---------------------------------------------------------------------------
// Selezione
// ---------------------------------------------------------------------------

const SUMMARY_SELECT = {
  id: true,
  titolo: true,
  trigger: true,
  esito: true,
  scope: true,
  clientLabel: true,
  visibility: true,
  status: true,
  durataStimataMin: true,
  costoTotaleCent: true,
  luogoNome: true,
  ultimaVerifica: true,
  volteEseguita: true,
  contieneDatiSensibili: true,
  createdAt: true,
  updatedAt: true,
  tags: { select: { tag: { select: { nome: true } } } },
  _count: { select: { steps: true } },
} satisfies Prisma.ProcedureSelect;

const DETAIL_SELECT = {
  ...SUMMARY_SELECT,
  validitaEsito: true,
  luogoDettaglio: true,
  latitude: true,
  longitude: true,
  forkedFromId: true,
  steps: {
    select: { id: true, ordine: true, azione: true, dettaglio: true, durataStimataMin: true },
    orderBy: { ordine: "asc" },
  },
  prereqs: { select: { id: true, descrizione: true, tipo: true, obbligatorio: true } },
  pitfalls: { select: { id: true, descrizione: true, gravita: true } },
  costs: { select: { id: true, descrizione: true, importoCent: true, valuta: true } },
  refs: { select: { id: true, tipo: true, valore: true } },
  attachments: { select: { id: true, url: true, mimeType: true, didascalia: true } },
  executions: {
    select: { id: true, eseguitaIl: true, esito: true, nota: true },
    // Dalla piu' recente: la storia si legge dall'alto, e la prima riga e' quella
    // che dice se la scheda funziona ancora.
    orderBy: { eseguitaIl: "desc" },
  },
  recordings: {
    select: { id: true, recordedAt: true, durationMs: true, transcript: true },
    orderBy: { recordedAt: "asc" },
  },
} satisfies Prisma.ProcedureSelect;

type SummaryPayload = Prisma.ProcedureGetPayload<{ select: typeof SUMMARY_SELECT }>;
type DetailPayload = Prisma.ProcedureGetPayload<{ select: typeof DETAIL_SELECT }>;

function toSummary(row: SummaryPayload): ProcedureSummaryRow {
  return {
    id: row.id,
    titolo: row.titolo,
    trigger: row.trigger,
    esito: row.esito,
    scope: row.scope,
    clientLabel: row.clientLabel,
    visibility: row.visibility,
    status: row.status,
    durataStimataMin: row.durataStimataMin,
    costoTotaleCent: row.costoTotaleCent,
    luogoNome: row.luogoNome,
    ultimaVerifica: row.ultimaVerifica,
    volteEseguita: row.volteEseguita,
    contieneDatiSensibili: row.contieneDatiSensibili,
    numeroPassi: row._count.steps,
    tag: row.tags.map((t) => t.tag.nome).sort(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDetail(row: DetailPayload): ProcedureDetailRow {
  return {
    ...toSummary(row),
    validitaEsito: row.validitaEsito,
    luogoDettaglio: row.luogoDettaglio,
    latitude: row.latitude,
    longitude: row.longitude,
    forkedFromId: row.forkedFromId,
    steps: row.steps,
    prereqs: row.prereqs,
    pitfalls: row.pitfalls,
    costs: row.costs,
    refs: row.refs,
    attachments: row.attachments,
    executions: row.executions,
    recordings: row.recordings,
  };
}

type Defined<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };

/**
 * Toglie le chiavi che valgono `undefined`.
 *
 * Serve per `exactOptionalPropertyTypes`. I tipi di input di Prisma dichiarano
 * `titolo?: string`, senza `| undefined`: la chiave puo' mancare, ma se c'e' non
 * puo' valere `undefined`. Il nostro patch fa il contrario, perche' nasce da
 * `z.infer` di uno schema con `.optional()`.
 *
 * A runtime i due significati coincidono — Prisma ignora le chiavi `undefined`
 * esattamente come le chiavi assenti — quindi qui non si perde niente. La
 * conversione e' l'unica del file, e sta in tre righe invece che sparsa in
 * quindici `...(x === undefined ? {} : { x })`.
 */
function omitUndefined<T extends object>(source: T): Partial<Defined<T>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as Partial<Defined<T>>;
}

/**
 * Il filtro di ownership, in un posto solo.
 *
 * `status` assente non significa «tutti gli stati»: significa «tutti tranne
 * ARCHIVIATA». Chiedere esplicitamente `status=ARCHIVIATA` resta possibile, ed
 * e' il cestino.
 */
function whereFor(userId: string, filter: ListProceduresFilter): Prisma.ProcedureWhereInput {
  return {
    userId,
    ...(filter.scope === undefined ? {} : { scope: filter.scope }),
    ...(filter.status === undefined
      ? { status: { not: CardStatus.ARCHIVIATA } }
      : { status: filter.status }),
    ...(filter.tag === undefined ? {} : { tags: { some: { tag: { nome: filter.tag } } } }),
  };
}

export class PrismaProcedureRepository implements ProcedureRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async list(userId: string, filter: ListProceduresFilter): Promise<ProcedurePage> {
    const where = whereFor(userId, filter);

    const [rows, total] = await this.#prisma.$transaction([
      this.#prisma.procedure.findMany({
        where,
        select: SUMMARY_SELECT,
        // `updatedAt desc` e' servito dall'indice `[userId, updatedAt]`, ed e'
        // l'ordine giusto per una lista senza query: l'ultima cosa toccata e'
        // quasi sempre quella che si cercava.
        orderBy: { updatedAt: "desc" },
        take: filter.limit,
        skip: filter.offset,
      }),
      this.#prisma.procedure.count({ where }),
    ]);

    return { items: rows.map(toSummary), total };
  }

  async findById(userId: string, id: string): Promise<ProcedureDetailRow | null> {
    const row = await this.#prisma.procedure.findFirst({
      where: { id, userId },
      select: DETAIL_SELECT,
    });
    return row === null ? null : toDetail(row);
  }

  async update(
    userId: string,
    id: string,
    data: UpdateProcedureData,
  ): Promise<ProcedureDetailRow | null> {
    const owned = await this.#prisma.procedure.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (owned === null) {
      return null;
    }

    await this.#prisma.$transaction(async (tx) => {
      if (data.tag !== undefined) {
        const tagIds: string[] = [];
        for (const nome of data.tag) {
          const tag = await tx.tag.upsert({
            where: { userId_nome: { userId, nome } },
            update: {},
            create: { userId, nome },
          });
          tagIds.push(tag.id);
        }
        // I `Tag` orfani restano: sono il vocabolario dell'utente, e il prompt
        // §4.2 li usa come contesto. Cancellarli perche' nessuna scheda li porta
        // piu' significherebbe far dimenticare all'assistente una parola che
        // l'utente usa.
        await tx.tagOnProcedure.deleteMany({ where: { procedureId: id } });
        await tx.tagOnProcedure.createMany({
          data: tagIds.map((tagId) => ({ procedureId: id, tagId })),
        });
      }

      if (data.steps !== undefined) {
        await tx.step.deleteMany({ where: { procedureId: id } });
        await tx.step.createMany({
          data: data.steps.map((s, index) => ({
            procedureId: id,
            // Rinumerati qui: la §5 pretende ordini contigui a partire da 1, e
            // `@@unique([procedureId, ordine])` non perdona un buco lasciato da
            // un client distratto.
            ordine: index + 1,
            azione: s.azione,
            dettaglio: s.dettaglio,
            durataStimataMin: s.durataStimataMin,
          })),
        });
      }

      if (data.prereqs !== undefined) {
        await tx.prerequisite.deleteMany({ where: { procedureId: id } });
        await tx.prerequisite.createMany({
          data: data.prereqs.map((p) => ({ procedureId: id, ...p })),
        });
      }

      if (data.pitfalls !== undefined) {
        await tx.pitfall.deleteMany({ where: { procedureId: id } });
        await tx.pitfall.createMany({
          data: data.pitfalls.map((p) => ({ procedureId: id, ...p })),
        });
      }

      if (data.refs !== undefined) {
        await tx.reference.deleteMany({ where: { procedureId: id } });
        await tx.reference.createMany({
          data: data.refs.map((r) => ({ procedureId: id, ...r })),
        });
      }

      let costoTotaleCent: number | undefined;
      if (data.costs !== undefined) {
        await tx.cost.deleteMany({ where: { procedureId: id } });
        await tx.cost.createMany({
          data: data.costs.map((c) => ({ procedureId: id, ...c })),
        });
        // Derivato, sempre: `costoTotaleCent` e' una somma, e una somma che non
        // torna e' peggio di un campo vuoto.
        costoTotaleCent = data.costs.reduce((total, c) => total + c.importoCent, 0);
      }

      await tx.procedure.update({
        where: { id },
        data: {
          ...omitUndefined(data.scalars),
          ...(costoTotaleCent === undefined ? {} : { costoTotaleCent }),
          searchText: data.searchText,
        },
      });

      if (data.embedding !== undefined) {
        const literal = toVectorLiteral(data.embedding);
        await tx.$executeRaw`UPDATE "Procedure" SET embedding = ${literal}::vector WHERE id = ${id}`;
      }
    });

    return this.findById(userId, id);
  }

  async archive(userId: string, id: string): Promise<ProcedureDetailRow | null> {
    const updated = await this.#prisma.procedure.updateMany({
      where: { id, userId },
      data: { status: CardStatus.ARCHIVIATA },
    });
    if (updated.count === 0) {
      return null;
    }
    return this.findById(userId, id);
  }

  async addExecution(
    userId: string,
    id: string,
    data: AddExecutionData,
  ): Promise<ProcedureDetailRow | null> {
    const owned = await this.#prisma.procedure.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (owned === null) {
      return null;
    }

    await this.#prisma.$transaction([
      this.#prisma.execution.create({
        data: {
          procedureId: id,
          eseguitaIl: data.eseguitaIl,
          esito: data.esito,
          nota: data.nota,
        },
      }),
      this.#prisma.procedure.update({
        where: { id },
        data: {
          // `increment` e non un valore letto e riscritto: due dispositivi che
          // registrano un'esecuzione nello stesso momento devono contarne due.
          volteEseguita: { increment: 1 },
          ...(data.ultimaVerifica === undefined ? {} : { ultimaVerifica: data.ultimaVerifica }),
          ...(data.status === undefined ? {} : { status: data.status }),
        },
      }),
    ]);

    return this.findById(userId, id);
  }

  async searchFullText(
    userId: string,
    query: string,
    options: { limit: number; scope?: Scope | undefined },
  ): Promise<readonly ScoredProcedureId[]> {
    // `websearch_to_tsquery` e non `to_tsquery`: accetta qualunque stringa
    // scritta da una persona (virgolette, `or`, un meno davanti a una parola) e
    // non solleva mai. `to_tsquery` muore con un errore SQL su una parentesi
    // spaiata, cioe' trasforma una ricerca sfortunata in un 500.
    //
    // `ts_rank_cd` e non `ts_rank`: tiene conto della vicinanza fra i termini,
    // che su testi lunghi come `searchText` e' cio' che distingue una scheda
    // che parla dell'argomento da una che nomina le stesse parole in due punti
    // scollegati.
    const scopeFilter =
      options.scope === undefined
        ? Prisma.empty
        : Prisma.sql`AND p."scope" = ${options.scope}::"Scope"`;

    return this.#prisma.$queryRaw<ScoredProcedureId[]>`
      SELECT p."id", ts_rank_cd(p."searchVector", q) AS "score"
      FROM "Procedure" p, websearch_to_tsquery('italian', ${query}) q
      WHERE p."userId" = ${userId}
        AND p."status" <> 'ARCHIVIATA'::"CardStatus"
        AND p."searchVector" @@ q
        ${scopeFilter}
      ORDER BY "score" DESC, p."updatedAt" DESC
      LIMIT ${options.limit}
    `;
  }

  async searchSemantic(
    userId: string,
    embedding: readonly number[],
    options: { limit: number; scope?: Scope | undefined },
  ): Promise<readonly ScoredProcedureId[]> {
    const literal = toVectorLiteral(embedding);
    const scopeFilter =
      options.scope === undefined
        ? Prisma.empty
        : Prisma.sql`AND p."scope" = ${options.scope}::"Scope"`;

    // Il pavimento e' scritto come distanza e non come similarita' per la stessa
    // ragione dell'ORDER BY: `<=> <= costante` e' una condizione che l'indice sa
    // servire, `1 - (...) >= costante` no.
    const maxDistance = 1 - SEARCH_MIN_SIMILARITY;

    // L'ORDER BY usa l'operatore `<=>` e non l'espressione calcolata: e' l'unica
    // forma che l'indice HNSW sa servire. Con `ORDER BY "score" DESC` il planner
    // ricadrebbe in una scansione sequenziale, corretta e lentissima.
    return this.#prisma.$queryRaw<ScoredProcedureId[]>`
      SELECT p."id", 1 - (p."embedding" <=> ${literal}::vector) AS "score"
      FROM "Procedure" p
      WHERE p."userId" = ${userId}
        AND p."status" <> 'ARCHIVIATA'::"CardStatus"
        AND p."embedding" IS NOT NULL
        AND p."embedding" <=> ${literal}::vector <= ${maxDistance}
        ${scopeFilter}
      ORDER BY p."embedding" <=> ${literal}::vector
      LIMIT ${options.limit}
    `;
  }

  async summariesByIds(
    userId: string,
    ids: readonly string[],
  ): Promise<readonly ProcedureSummaryRow[]> {
    if (ids.length === 0) {
      return [];
    }
    // `userId` nel WHERE anche se gli id vengono da due query che gia' lo
    // filtravano. Ridondante di proposito: e' l'ultima riga prima della
    // risposta HTTP, ed e' il posto dove una regressione altrove diventerebbe
    // una fuga di dati.
    const rows = await this.#prisma.procedure.findMany({
      where: { userId, id: { in: [...ids] } },
      select: SUMMARY_SELECT,
    });
    return rows.map(toSummary);
  }
}
