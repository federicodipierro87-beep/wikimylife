import type {
  CardStatus,
  CostInput,
  Outcome,
  PitfallInput,
  PrereqInput,
  PrereqType,
  RefType,
  ReferenceInput,
  Scope,
  Severity,
  StepInput,
  Visibility,
} from "@wikimylife/shared";

/**
 * Tutto cio' che la lettura, la modifica e la ricerca delle schede hanno bisogno
 * di chiedere al database.
 *
 * Come per `RecordingRepository`, `userId` e' il primo parametro ovunque: la
 * regola di ownership del README applicata al tipo. Nessun metodo accetta un id
 * senza il proprietario, quindi non esiste una firma con cui scrivere per
 * sbaglio una query che legge la riga di un altro.
 *
 * Le date restano `Date` e non stringhe ISO: la conversione al contratto HTTP
 * e' compito del servizio, e il flag di obsolescenza si calcola con un `Clock`
 * iniettato — un repository che restituisse gia' stringhe renderebbe
 * impossibile provare la soglia dell'anno senza fake timers.
 */

// ---------------------------------------------------------------------------
// Righe lette
// ---------------------------------------------------------------------------

export interface ProcedureSummaryRow {
  readonly id: string;
  readonly titolo: string;
  readonly trigger: string | null;
  readonly esito: string | null;

  readonly scope: Scope;
  readonly clientLabel: string | null;
  readonly visibility: Visibility;
  readonly status: CardStatus;

  readonly durataStimataMin: number | null;
  readonly costoTotaleCent: number | null;
  readonly luogoNome: string | null;

  readonly ultimaVerifica: Date | null;
  readonly volteEseguita: number;
  readonly contieneDatiSensibili: boolean;

  readonly numeroPassi: number;
  readonly tag: readonly string[];

  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProcedureDetailRow extends ProcedureSummaryRow {
  readonly validitaEsito: string | null;
  readonly luogoDettaglio: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly forkedFromId: string | null;

  readonly steps: readonly {
    readonly id: string;
    readonly ordine: number;
    readonly azione: string;
    readonly dettaglio: string | null;
    readonly durataStimataMin: number | null;
  }[];
  readonly prereqs: readonly {
    readonly id: string;
    readonly descrizione: string;
    readonly tipo: PrereqType;
    readonly obbligatorio: boolean;
  }[];
  readonly pitfalls: readonly {
    readonly id: string;
    readonly descrizione: string;
    readonly gravita: Severity;
  }[];
  readonly costs: readonly {
    readonly id: string;
    readonly descrizione: string;
    readonly importoCent: number;
    readonly valuta: string;
  }[];
  readonly refs: readonly {
    readonly id: string;
    readonly tipo: RefType;
    readonly valore: string;
  }[];
  readonly attachments: readonly {
    readonly id: string;
    readonly url: string;
    readonly mimeType: string;
    readonly didascalia: string | null;
  }[];
  readonly executions: readonly {
    readonly id: string;
    readonly eseguitaIl: Date;
    readonly esito: Outcome;
    readonly nota: string | null;
  }[];
  readonly recordings: readonly {
    readonly id: string;
    readonly recordedAt: Date;
    readonly durationMs: number;
    readonly transcript: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

export interface ListProceduresFilter {
  readonly scope?: Scope | undefined;
  /**
   * Assente significa «tutte tranne le ARCHIVIATE». Non e' un default
   * arbitrario: e' cio' che rende il soft delete indistinguibile da una
   * cancellazione per chi usa l'app, senza distruggere niente.
   */
  readonly status?: CardStatus | undefined;
  readonly tag?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface ProcedurePage {
  readonly items: readonly ProcedureSummaryRow[];
  /** Quante righe soddisfano i filtri in tutto, non quante ne sono tornate. */
  readonly total: number;
}

// ---------------------------------------------------------------------------
// Modifica
// ---------------------------------------------------------------------------

/**
 * Solo i campi che il chiamante ha davvero mandato.
 *
 * `undefined` significa «non toccare», `null` significa «azzera». Sono la stessa
 * convenzione di Prisma, ed e' voluto: qualunque altra scelta obbligherebbe
 * l'implementazione a tradurre, e una traduzione fra due sfumature di «vuoto» e'
 * il posto ideale per un bug che cancella dati.
 */
export interface ProcedureScalarPatch {
  readonly titolo?: string | undefined;
  readonly trigger?: string | null | undefined;
  readonly esito?: string | null | undefined;
  readonly validitaEsito?: string | null | undefined;
  readonly durataStimataMin?: number | null | undefined;
  readonly luogoNome?: string | null | undefined;
  readonly luogoDettaglio?: string | null | undefined;
  readonly latitude?: number | null | undefined;
  readonly longitude?: number | null | undefined;
  readonly scope?: Scope | undefined;
  readonly clientLabel?: string | null | undefined;
  readonly visibility?: Visibility | undefined;
  readonly status?: CardStatus | undefined;
  readonly contieneDatiSensibili?: boolean | undefined;
}

/**
 * Cio' che il servizio ha gia' deciso, pronto da scrivere.
 *
 * `searchText` ed `embedding` arrivano calcolati da fuori e non si ricavano qui
 * dentro: il primo perche' la funzione che lo compone vive in
 * `packages/shared`, il secondo perche' calcolarlo significa chiamare un
 * provider — e un repository che chiama un provider e' un repository che nei
 * test ha bisogno di una chiave API.
 *
 * `embedding` assente significa «i campi che lo determinano non sono cambiati,
 * lascia il vettore com'e'». Ricalcolarlo a ogni `PATCH` costerebbe una chiamata
 * di rete per correggere un refuso in una trappola.
 */
export interface UpdateProcedureData {
  readonly scalars: ProcedureScalarPatch;
  /** Sostituzione integrale. Assente = non toccare. */
  readonly tag?: readonly string[] | undefined;
  readonly steps?: readonly StepInput[] | undefined;
  readonly prereqs?: readonly PrereqInput[] | undefined;
  readonly pitfalls?: readonly PitfallInput[] | undefined;
  /** Quando c'e', `costoTotaleCent` si ricalcola come somma. */
  readonly costs?: readonly CostInput[] | undefined;
  readonly refs?: readonly ReferenceInput[] | undefined;

  readonly searchText: string;
  readonly embedding?: readonly number[] | undefined;
}

/**
 * Le conseguenze della §8, gia' decise dal servizio.
 *
 * `volteEseguita` non c'e' perche' non si passa: si incrementa in SQL. Sono due
 * cose diverse — un valore calcolato in JavaScript e riscritto perderebbe le
 * esecuzioni registrate nel frattempo da un altro dispositivo, un `increment`
 * no.
 */
export interface AddExecutionData {
  readonly eseguitaIl: Date;
  readonly esito: Outcome;
  readonly nota: string | null;
  /** Assente = l'esecuzione non conta come verifica (esito != FUNZIONATO). */
  readonly ultimaVerifica?: Date | undefined;
  /** Assente = lo stato non cambia. */
  readonly status?: CardStatus | undefined;
}

// ---------------------------------------------------------------------------
// Ricerca
// ---------------------------------------------------------------------------

/**
 * Un id e il punteggio del canale che l'ha trovato.
 *
 * I due canali restituiscono *solo* questo, non le righe intere: i punteggi di
 * `ts_rank_cd` e della distanza coseno non sono confrontabili fra loro, quindi
 * quello che conta e' la POSIZIONE in ciascuna lista. La fusione lavora su
 * rank, e le righe si leggono una volta sola alla fine, per gli id
 * sopravvissuti.
 */
export interface ScoredProcedureId {
  readonly id: string;
  readonly score: number;
}

export interface ProcedureRepository {
  list(userId: string, filter: ListProceduresFilter): Promise<ProcedurePage>;

  findById(userId: string, id: string): Promise<ProcedureDetailRow | null>;

  /** `null` se la scheda non esiste o non e' dell'utente: il chiamante fa 404. */
  update(userId: string, id: string, data: UpdateProcedureData): Promise<ProcedureDetailRow | null>;

  /** Soft delete: `status = ARCHIVIATA`. Idempotente. */
  archive(userId: string, id: string): Promise<ProcedureDetailRow | null>;

  addExecution(
    userId: string,
    id: string,
    data: AddExecutionData,
  ): Promise<ProcedureDetailRow | null>;

  /**
   * Full-text italiano sull'indice GIN. La query dell'utente si converte con
   * `websearch_to_tsquery`, che non solleva eccezioni su input arbitrario —
   * `to_tsquery` invece muore su una parentesi spaiata, e le query le scrivono
   * le persone.
   */
  searchFullText(
    userId: string,
    query: string,
    options: { readonly limit: number; readonly scope?: Scope | undefined },
  ): Promise<readonly ScoredProcedureId[]>;

  /** Distanza coseno sull'indice HNSW. */
  searchSemantic(
    userId: string,
    embedding: readonly number[],
    options: { readonly limit: number; readonly scope?: Scope | undefined },
  ): Promise<readonly ScoredProcedureId[]>;

  /** Le righe corte per gli id sopravvissuti alla fusione, in ordine arbitrario. */
  summariesByIds(userId: string, ids: readonly string[]): Promise<readonly ProcedureSummaryRow[]>;
}
