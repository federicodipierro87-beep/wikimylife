import type {
  CardStatus,
  ExtractionContract,
  RecordingStatus,
  Scope,
} from "@wikimylife/shared";

/**
 * Tutto cio' che la pipeline di ingestione ha bisogno di chiedere al database.
 *
 * Esiste per la stessa ragione di `AuthRepository`: `ingestion.service.ts`
 * orchestra cinque stadi e prende decisioni che vanno provate una per una
 * (l'estrazione si ritenta esattamente una volta? un duplicato NON crea la
 * scheda? un errore di rete lascia il Recording riprocessabile?). Con Prisma
 * dentro il servizio, ognuna di quelle prove richiederebbe un Postgres acceso;
 * dietro questa interfaccia bastano un oggetto in memoria e nessun container.
 *
 * Le firme portano `userId` come primo parametro ovunque il dato sia di
 * qualcuno: e' la regola di ownership del README applicata al tipo, cosi' il
 * WHERE non puo' dimenticarsene.
 */

/** Lo stretto necessario per elaborare: niente campi che la pipeline non legge. */
export interface RecordingJob {
  readonly id: string;
  readonly userId: string;
  readonly audioUrl: string;
  readonly mimeType: string;
  readonly recordedAt: Date;
  readonly deviceLocale: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly placeLabel: string | null;
  readonly retryCount: number;
}

/** La riga intera, per `GET /api/recordings/:id`. */
export interface RecordingDetail extends RecordingJob {
  readonly status: RecordingStatus;
  readonly durationMs: number;
  readonly sizeBytes: number | null;
  readonly capturedOffline: boolean;
  readonly transcript: string | null;
  readonly transcriptSource: string | null;
  readonly rawExtraction: unknown;
  readonly extractionModel: string | null;
  readonly procedureId: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly lastErrorAt: Date | null;
  /** Quando il worker ci riprovera' da solo. `null`: subito, o mai piu'. */
  readonly nextAttemptAt: Date | null;
  readonly duplicateOfId: string | null;
  readonly duplicateOfTitolo: string | null;
  readonly duplicateSimilarity: number | null;
  readonly updatedAt: Date;
}

export interface CreateRecordingInput {
  readonly userId: string;
  readonly audioUrl: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly durationMs: number;
  readonly recordedAt: Date;
  readonly capturedOffline: boolean;
  readonly deviceLocale: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly placeLabel: string | null;
}

/** Il blocco "CONTESTO DISPONIBILE" del prompt §4.2, per un dato utente. */
export interface UserVocabulary {
  readonly scopes: readonly Scope[];
  readonly tags: readonly string[];
}

export interface SimilarProcedure {
  readonly procedureId: string;
  readonly titolo: string;
  /** Coseno in [-1, 1]; la §5 confronta con 0.85. */
  readonly similarity: number;
}

export interface PersistProcedureInput {
  readonly recordingId: string;
  readonly userId: string;
  /** Contratto gia' validato e con i passi rinumerati. */
  readonly contract: ExtractionContract;
  readonly cardStatus: typeof CardStatus.COMPLETA | typeof CardStatus.DA_RIVEDERE;
  /**
   * Diventa `Execution.eseguitaIl` e `Procedure.ultimaVerifica`: la §6 dichiara
   * `volteEseguita @default(1)`, quindi la registrazione stessa vale come prima
   * esecuzione riuscita. Senza questa Execution l'invariante
   * `volteEseguita = count(executions)` nascerebbe gia' rotta.
   */
  readonly recordedAt: Date;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly embedding: readonly number[];
}

export interface RecordingFailure {
  readonly status: typeof RecordingStatus.BOZZA_AUDIO | typeof RecordingStatus.ESTRAZIONE_FALLITA;
  readonly code: string;
  readonly message: string;
  readonly at: Date;
  /**
   * Da quando la riga torna prendibile. `null` significa subito.
   *
   * Lo decide il servizio e non il repository: e' una regola di prodotto —
   * quanto vale la pena aspettare prima di ripagare una chiamata a un modello —
   * e sta dove si puo' provare senza un database.
   */
  readonly nextAttemptAt: Date | null;
}

export interface RecordingRepository {
  create(input: CreateRecordingInput): Promise<RecordingDetail>;

  /**
   * Porta il Recording a IN_ELABORAZIONE e lo restituisce, oppure `null` se
   * qualcun altro e' arrivato prima.
   *
   * E' un compare-and-swap: `UPDATE ... WHERE id = ? AND status IN (...)` e si
   * guarda quante righe ha toccato. Due worker che partono insieme non possono
   * elaborare la stessa registrazione due volte, e non serve ne' Redis ne' un
   * `SELECT FOR UPDATE` tenuto aperto per il minuto buono che dura una
   * trascrizione.
   */
  claim(id: string, at: Date): Promise<RecordingJob | null>;

  /**
   * Come `claim`, ma sceglie da solo il piu' vecchio in attesa.
   *
   * «In attesa» esclude chi ha un `nextAttemptAt` nel futuro rispetto ad `at`:
   * e' quella condizione a rendere il backoff un'attesa e non un suggerimento.
   * Senza, il ritardo sarebbe scritto in una colonna che nessuno legge.
   */
  claimNext(at: Date): Promise<RecordingJob | null>;

  saveTranscript(
    id: string,
    input: { readonly text: string; readonly source: string; readonly at: Date },
  ): Promise<void>;

  /**
   * §"`rawExtraction` contiene l'output integrale dell'LLM, non solo i campi
   * usati": si scrive anche quando la validazione poi rifiuta, perche' e'
   * l'unica traccia di cosa aveva risposto il modello.
   */
  saveExtraction(
    id: string,
    input: { readonly raw: unknown; readonly model: string; readonly at: Date },
  ): Promise<void>;

  vocabularyOf(userId: string): Promise<UserVocabulary>;

  /** La procedura piu' vicina dell'utente, o `null` se non ne ha nessuna con embedding. */
  findMostSimilar(userId: string, embedding: readonly number[]): Promise<SimilarProcedure | null>;

  markDuplicate(
    id: string,
    input: {
      readonly procedureId: string;
      readonly similarity: number;
      readonly at: Date;
    },
  ): Promise<void>;

  /**
   * Crea Procedure, figli, tag, Execution ed embedding e collega il Recording,
   * tutto in una transazione. Restituisce l'id della scheda.
   */
  persistProcedure(input: PersistProcedureInput): Promise<string>;

  markFailed(id: string, failure: RecordingFailure): Promise<void>;

  findForUser(userId: string, id: string): Promise<RecordingDetail | null>;

  /**
   * Rimette in coda: torna a BOZZA_AUDIO, azzera l'errore, incrementa
   * `retryCount`. `null` se la registrazione non e' dell'utente, non esiste, o
   * e' gia' in elaborazione.
   */
  requeue(userId: string, id: string, at: Date): Promise<RecordingDetail | null>;
}
