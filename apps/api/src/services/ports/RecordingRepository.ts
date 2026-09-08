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

/**
 * Cosa e' successo alla riga, per chi deve decidere se cancellare l'oggetto.
 *
 * Un `boolean` non basterebbe: chi chiama deve distinguere «non c'era» da «non
 * si poteva» — sono un 404 e un 409 — e nel caso riuscito ha bisogno della
 * chiave dell'audio, che dopo il DELETE non e' piu' leggibile da nessuna parte.
 * Restituirla insieme all'esito e' l'unico modo di non doverla rileggere prima,
 * sperando che nel frattempo non cambi.
 *
 * `schedaArchiviata` e' l'id della scheda portata via insieme, e `null` copre
 * tre casi che al chiamante non servono distinti: non era stato chiesto, quella
 * registrazione non aveva prodotto niente, o la scheda non c'era piu'. Non e'
 * un valore su cui decidere — la risposta HTTP e' 204 in tutti e quattro i
 * casi — ma e' l'unico punto in cui quell'id passa ancora, e un registro che
 * dice *quale* scheda e' finita nel cestino e' l'unica traccia che resta di una
 * richiesta che ha toccato due tabelle.
 */
export type DeleteRecordingOutcome =
  | {
      readonly kind: "CANCELLATA";
      readonly audioUrl: string;
      readonly schedaArchiviata: string | null;
    }
  | { readonly kind: "ASSENTE" }
  | { readonly kind: "IN_LAVORAZIONE" };

/** Cosa fare della scheda nata da questa registrazione. */
export interface DeleteRecordingOptions {
  readonly archiviaLaScheda: boolean;
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
   * Le registrazioni dell'utente che non sono ancora diventate una scheda,
   * dalla piu' recente.
   *
   * "Non ancora" e' tutto cio' che non e' `ESTRATTO`: quelle estratte hanno gia'
   * una scheda, e comparirebbero due volte nella stessa lista dicendo la stessa
   * cosa. Le altre — in attesa, in lavorazione, fallite, sospette duplicate —
   * esistono solo qui, e senza questa query non esistono affatto per l'utente.
   */
  listPending(userId: string, limit: number): Promise<readonly RecordingDetail[]>;

  /**
   * Rimette in coda: torna a BOZZA_AUDIO, azzera l'errore, incrementa
   * `retryCount`. `null` se la registrazione non e' dell'utente, non esiste, o
   * e' gia' in elaborazione.
   */
  requeue(userId: string, id: string, at: Date): Promise<RecordingDetail | null>;

  /**
   * Cancella la riga per davvero, e dice quale oggetto resta da togliere.
   *
   * E' l'unica cancellazione dura del progetto: la scheda si archivia, perche'
   * e' un testo che si puo' sempre riscrivere e che qualcuno potrebbe rivolere;
   * la registrazione no. Chi chiede di cancellare un audio sta chiedendo che la
   * propria voce sparisca, e uno stato `CANCELLATA` con i byte ancora nel bucket
   * sarebbe la risposta sbagliata a quella domanda.
   *
   * Rifiuta mentre e' IN_ELABORAZIONE, e non e' prudenza: il worker in quel
   * momento sta leggendo `audioUrl` e scrivera' `saveTranscript` su un id che
   * non esiste piu'. Gli altri stati si cancellano tutti, ESTRATTO compreso —
   * la scheda derivata sopravvive, ed e' proprio il caso di chi vuole tenere la
   * procedura e non l'audio.
   *
   * Con `archiviaLaScheda` sopravvive nel cestino invece che nella lista: la
   * scheda passa ad ARCHIVIATA **nella stessa transazione** della cancellazione.
   * Insieme e non in fila, e la ragione e' che le due operazioni non sono
   * annullabili allo stesso modo. In fila esisterebbe sempre un ordine
   * sbagliato: cancellare prima e archiviare poi lascia, se la seconda fallisce,
   * una voce persa per sempre e una scheda che l'utente credeva via; archiviare
   * prima e cancellare poi lascia, se la seconda fallisce con il 409 del worker,
   * una scheda finita nel cestino per una richiesta che ha risposto errore.
   * Nella stessa transazione non c'e' un ordine sbagliato perche' non c'e' un
   * mezzo risultato.
   *
   * Se la registrazione non ha prodotto nessuna scheda l'opzione non fa niente,
   * e non e' un caso da segnalare: e' la risposta esatta a «togli anche cio' che
   * ne e' derivato» quando non ne e' derivato niente.
   */
  deleteForUser(
    userId: string,
    id: string,
    opzioni: DeleteRecordingOptions,
  ): Promise<DeleteRecordingOutcome>;

  /**
   * Quali di queste chiavi sono ancora nominate da una riga.
   *
   * L'unica query del progetto che non porta un `userId`, e va detto perche':
   * chi la usa non sta guardando i dati di qualcuno, sta guardando un bucket. La
   * domanda e' «questo oggetto appartiene a qualcuno?», e restringerla a un
   * utente darebbe la risposta sbagliata proprio per gli oggetti che
   * interessano — quelli il cui proprietario non si sa piu' quale fosse.
   *
   * Restituisce cio' che c'e' e non cio' che manca, perche' l'insieme delle
   * chiavi mandate lo conosce gia' chi chiama: invertirlo qui vorrebbe dire
   * fidarsi che il repository abbia ricevuto l'elenco intero, e una risposta
   * troncata diventerebbe una lista di cose da cancellare.
   */
  findExistingAudioKeys(keys: readonly string[]): Promise<ReadonlySet<string>>;
}
