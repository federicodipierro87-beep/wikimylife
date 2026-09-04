import { CardStatus, Scope, Visibility } from "@wikimylife/shared";
import type {
  AddExecutionData,
  ListProceduresFilter,
  ProcedureDetailRow,
  ProcedurePage,
  ProcedureRepository,
  ProcedureSummaryRow,
  ScoredProcedureId,
  UpdateProcedureData,
} from "../../apps/api/src/services/ports/ProcedureRepository.js";

/**
 * `ProcedureRepository` in memoria.
 *
 * Riproduce solo cio' che il servizio puo' davvero osservare: la proprieta'
 * della riga, l'esclusione delle archiviate quando non si chiede uno stato,
 * l'incremento di `volteEseguita`, la sostituzione integrale degli array figli.
 *
 * I due canali di ricerca NON tentano di imitare `ts_rank_cd` ne' la distanza
 * coseno: restituiscono le liste che il test ha programmato con
 * `stubFullText`/`stubSemantic`. Imitare Postgres qui vorrebbe dire provare
 * l'imitazione — che i due canali funzionino davvero e' compito dei test di
 * integrazione, dove c'e' l'indice vero.
 */

let sequenza = 0;

function nextId(): string {
  sequenza += 1;
  return `proc-${String(sequenza)}`;
}

export interface SeedProcedure {
  readonly userId: string;
  readonly id?: string;
  readonly titolo?: string;
  readonly trigger?: string | null;
  readonly esito?: string | null;
  readonly scope?: Scope;
  readonly visibility?: Visibility;
  readonly status?: CardStatus;
  readonly contieneDatiSensibili?: boolean;
  readonly ultimaVerifica?: Date | null;
  readonly volteEseguita?: number;
  readonly tag?: readonly string[];
  readonly steps?: ProcedureDetailRow["steps"];
}

export class InMemoryProcedureRepository implements ProcedureRepository {
  readonly #rows = new Map<string, ProcedureDetailRow>();
  readonly #owners = new Map<string, string>();

  /** Liste che i due canali restituiranno, programmate dal test. */
  fullTextResult: readonly ScoredProcedureId[] = [];
  semanticResult: readonly ScoredProcedureId[] = [];
  /** Gli argomenti dell'ultima chiamata, per asserire il moltiplicatore. */
  lastFullTextOptions: { limit: number; scope?: Scope | undefined } | null = null;
  lastSemanticOptions: { limit: number; scope?: Scope | undefined } | null = null;

  seed(input: SeedProcedure): ProcedureDetailRow {
    const id = input.id ?? nextId();
    const at = new Date("2026-01-01T00:00:00.000Z");
    const row: ProcedureDetailRow = {
      id,
      titolo: input.titolo ?? "Richiedere il casellario giudiziale",
      trigger: input.trigger ?? null,
      esito: input.esito ?? null,
      scope: input.scope ?? Scope.PERSONALE,
      clientLabel: null,
      visibility: input.visibility ?? Visibility.PRIVATA,
      status: input.status ?? CardStatus.COMPLETA,
      durataStimataMin: null,
      costoTotaleCent: null,
      luogoNome: null,
      ultimaVerifica: input.ultimaVerifica ?? null,
      volteEseguita: input.volteEseguita ?? 1,
      contieneDatiSensibili: input.contieneDatiSensibili ?? false,
      numeroPassi: input.steps?.length ?? 0,
      tag: input.tag ?? [],
      createdAt: at,
      updatedAt: at,
      validitaEsito: null,
      luogoDettaglio: null,
      latitude: null,
      longitude: null,
      forkedFromId: null,
      steps: input.steps ?? [],
      prereqs: [],
      pitfalls: [],
      costs: [],
      refs: [],
      attachments: [],
      executions: [],
      recordings: [],
    };
    this.#rows.set(id, row);
    this.#owners.set(id, input.userId);
    return row;
  }

  snapshot(id: string): ProcedureDetailRow {
    const row = this.#rows.get(id);
    if (row === undefined) {
      throw new Error(`InMemoryProcedureRepository: scheda assente ${id}`);
    }
    return row;
  }

  /** L'ultimo `UpdateProcedureData` ricevuto: e' li' che il servizio decide. */
  lastUpdate: UpdateProcedureData | null = null;

  #own(userId: string, id: string): ProcedureDetailRow | null {
    const row = this.#rows.get(id);
    if (row === undefined || this.#owners.get(id) !== userId) {
      return null;
    }
    return row;
  }

  async list(userId: string, filter: ListProceduresFilter): Promise<ProcedurePage> {
    const tutte = [...this.#rows.values()]
      .filter((r) => this.#owners.get(r.id) === userId)
      .filter((r) =>
        filter.status === undefined
          ? r.status !== CardStatus.ARCHIVIATA
          : r.status === filter.status,
      )
      .filter((r) => filter.scope === undefined || r.scope === filter.scope)
      .filter((r) => filter.tag === undefined || r.tag.includes(filter.tag))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    const items: ProcedureSummaryRow[] = tutte.slice(filter.offset, filter.offset + filter.limit);
    return { items, total: tutte.length };
  }

  async findById(userId: string, id: string): Promise<ProcedureDetailRow | null> {
    return this.#own(userId, id);
  }

  async update(
    userId: string,
    id: string,
    data: UpdateProcedureData,
  ): Promise<ProcedureDetailRow | null> {
    const row = this.#own(userId, id);
    if (row === null) {
      return null;
    }
    this.lastUpdate = data;

    const steps = data.steps?.map((s, index) => ({
      id: `${id}-step-${String(index + 1)}`,
      ordine: index + 1,
      azione: s.azione,
      dettaglio: s.dettaglio ?? null,
      durataStimataMin: s.durataStimataMin ?? null,
    }));

    const aggiornata: ProcedureDetailRow = {
      ...row,
      ...omitUndefined(data.scalars),
      ...(data.tag === undefined ? {} : { tag: [...data.tag] }),
      ...(steps === undefined ? {} : { steps, numeroPassi: steps.length }),
      ...(data.costs === undefined
        ? {}
        : { costoTotaleCent: data.costs.reduce((sum, c) => sum + c.importoCent, 0) }),
      updatedAt: new Date(row.updatedAt.getTime() + 1000),
    };
    this.#rows.set(id, aggiornata);
    return aggiornata;
  }

  async archive(userId: string, id: string): Promise<ProcedureDetailRow | null> {
    const row = this.#own(userId, id);
    if (row === null) {
      return null;
    }
    const archiviata = { ...row, status: CardStatus.ARCHIVIATA };
    this.#rows.set(id, archiviata);
    return archiviata;
  }

  async addExecution(
    userId: string,
    id: string,
    data: AddExecutionData,
  ): Promise<ProcedureDetailRow | null> {
    const row = this.#own(userId, id);
    if (row === null) {
      return null;
    }
    const aggiornata: ProcedureDetailRow = {
      ...row,
      volteEseguita: row.volteEseguita + 1,
      ...(data.ultimaVerifica === undefined ? {} : { ultimaVerifica: data.ultimaVerifica }),
      ...(data.status === undefined ? {} : { status: data.status }),
      executions: [
        ...row.executions,
        {
          id: `${id}-exec-${String(row.executions.length + 1)}`,
          eseguitaIl: data.eseguitaIl,
          esito: data.esito,
          nota: data.nota,
        },
      ],
    };
    this.#rows.set(id, aggiornata);
    return aggiornata;
  }

  async searchFullText(
    _userId: string,
    _query: string,
    options: { limit: number; scope?: Scope | undefined },
  ): Promise<readonly ScoredProcedureId[]> {
    this.lastFullTextOptions = options;
    return this.fullTextResult;
  }

  async searchSemantic(
    _userId: string,
    _embedding: readonly number[],
    options: { limit: number; scope?: Scope | undefined },
  ): Promise<readonly ScoredProcedureId[]> {
    this.lastSemanticOptions = options;
    return this.semanticResult;
  }

  async summariesByIds(
    userId: string,
    ids: readonly string[],
  ): Promise<readonly ProcedureSummaryRow[]> {
    // Ordine arbitrario di proposito, come in SQL: e' il servizio a doverlo
    // ristabilire, e un test che passasse solo perche' qui l'ordine e' quello
    // giusto non proverebbe niente.
    return [...ids]
      .reverse()
      .flatMap((id) => {
        const row = this.#own(userId, id);
        return row === null ? [] : [row];
      });
  }
}

/** Come nell'implementazione Prisma: `undefined` significa «non toccare». */
function omitUndefined<T extends object>(
  source: T,
): Partial<{ [K in keyof T]-?: Exclude<T[K], undefined> }> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as Partial<{ [K in keyof T]-?: Exclude<T[K], undefined> }>;
}
