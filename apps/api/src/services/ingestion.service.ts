import {
  CardStatus,
  DEDUP_COSINE_THRESHOLD,
  RecordingStatus,
  embeddingInput,
  type EmbeddingProvider,
  type ExtractionContract,
  type ExtractionIssue,
  type ExtractionProvider,
  type StorageProvider,
  type TranscriptionProvider,
} from "@wikimylife/shared";
import type { Logger } from "../logger.js";
import type { Clock } from "./ports/Clock.js";
import type { RecordingJob, RecordingRepository } from "./ports/RecordingRepository.js";
import { normalizeSteps, validateExtraction } from "./validation/extractionValidation.js";

/**
 * La pipeline: trascrizione -> estrazione -> validazione -> deduplicazione ->
 * persistenza.
 *
 * Nessun import di express, di prisma o di un SDK: entrano quattro provider e
 * un repository, tutti dietro interfaccia. E' quello che permette di provare
 * "l'estrazione si ritenta esattamente una volta" o "un duplicato non crea la
 * scheda" con un test unitario da millisecondi invece che con un container e
 * una chiave API.
 *
 * Due princìpi governano tutto il file.
 *
 * PRIMO: lo stadio 1 non fallisce mai. L'audio e' gia' al sicuro prima che
 * questa funzione venga chiamata; qualunque cosa vada storta qui, il Recording
 * torna in `BOZZA_AUDIO` con l'errore scritto sopra e resta riprocessabile. Si
 * finisce in `ESTRAZIONE_FALLITA` in due casi soltanto: quello previsto dalla
 * §5 — due estrazioni di fila che non producono un JSON conforme — e
 * l'esaurimento di `MAX_INGESTION_ATTEMPTS`, che ferma il ciclo automatico
 * senza togliere niente al retry chiesto da un umano.
 *
 * SECONDO: si conserva tutto quello che e' costato una chiamata a un modello.
 * La trascrizione si salva appena esiste, anche se l'estrazione poi riesce e la
 * scheda la rende apparentemente inutile; `rawExtraction` si salva integrale,
 * anche quando la validazione lo rifiuta. Sono gli unici due dati non
 * riproducibili a costo zero.
 */

/** Codici in `Recording.lastErrorCode`. Stabili: la UI puo' farci sopra branching. */
export const IngestionError = {
  audioNonLeggibile: "audio.non_leggibile",
  trascrizioneFallita: "trascrizione.fallita",
  trascrizioneVuota: "trascrizione.vuota",
  estrazioneFallita: "estrazione.fallita",
  embeddingFallito: "embedding.fallito",
  contrattoNonConforme: "contratto.non_conforme",
  persistenzaFallita: "persistenza.fallita",
} as const;

/**
 * §5: "un solo retry poi `ESTRAZIONE_FALLITA`". Due tentativi in tutto, non
 * tre: con temperatura 0 un terzo giro darebbe quasi certamente la stessa
 * risposta, quindi costerebbe soldi e latenza senza cambiare l'esito.
 */
export const MAX_EXTRACTION_ATTEMPTS = 2;

/**
 * Quante volte una registrazione puo' tornare in coda DA SOLA.
 *
 * Senza questo tetto il ritorno a `BOZZA_AUDIO` e' un ciclo caldo, non una
 * seconda possibilita': la riga torna in coda, `claimNext` prende la piu'
 * vecchia in attesa, e la piu' vecchia in attesa e' di nuovo quella. Il worker
 * ne fa dieci per giro ogni cinque secondi, e ogni giro e' una chiamata a
 * Whisper pagata per riottenere lo stesso errore. Un audio corrotto costa
 * finche' qualcuno non se ne accorge; l'API di OpenAI che risponde 429 fa
 * entrare nel ciclo TUTTA la coda insieme.
 *
 * Tre e non uno perche' i fallimenti che tornano in coda sono quasi tutti
 * transitori — lo storage che non risponde, un timeout, un 503 del modello — e
 * un solo tentativo trasformerebbe un singhiozzo di rete in una registrazione
 * ferma. Tre e non dieci perche' oltre il terzo la causa non e' piu'
 * transitoria, e continuare significa solo pagare.
 *
 * Non e' un tetto al retry manuale: `POST /retry` resta sempre possibile e
 * concede esattamente un tentativo in piu' per ogni volta che un umano lo
 * chiede. E' la differenza fra una decisione e un ciclo.
 */
export const MAX_INGESTION_ATTEMPTS = 3;

/**
 * Quanto si aspetta prima di riprovare, dopo il primo, il secondo, il terzo
 * fallimento.
 *
 * Il tetto da solo conta i tentativi ma non li distanzia, e senza distanza tre
 * tentativi non sono tre occasioni: il worker gira ogni cinque secondi, quindi
 * un 503 di OpenAI che dura mezzo minuto se li mangia tutti e tre prima di
 * finire. La registrazione esce dalla coda per un guasto che si era gia'
 * risolto da solo, e l'unico modo di riprenderla e' che qualcuno apra l'app e
 * prema «riprova» — cioe' esattamente la manutenzione volontaria che questo
 * progetto e' fatto per non chiedere.
 *
 * Un minuto, dieci, un'ora. Il primo salto copre i singhiozzi (un timeout, un
 * riavvio, una connessione persa); il secondo copre i rate limit, che si
 * misurano in minuti; il terzo copre i guasti veri di un fornitore, che si
 * misurano in ore. Ogni scaglione e' dieci volte il precedente perche' l'unica
 * informazione che si ha e' «non ha funzionato di nuovo», e raddoppiare
 * significherebbe fare molti piu' tentativi per coprire la stessa finestra.
 *
 * Sono fissi e non casuali: il jitter serve a spargere client indipendenti che
 * ripartono insieme, e qui i tentativi sono gia' sparsi dai loro `lastErrorAt`,
 * che sono i momenti in cui sono falliti.
 */
export const RITARDI_RITENTATIVO = [60_000, 600_000, 3_600_000] as const;

/**
 * Il ritardo per il tentativo appena fallito, in millisecondi.
 *
 * Oltre l'ultimo scaglione resta l'ultimo scaglione. Non e' un caso che possa
 * accadere con `MAX_INGESTION_ATTEMPTS = 3` — ci si arriva solo attraverso i
 * riscatti manuali, che alzano `retryCount` senza limite — ma la funzione deve
 * dare una risposta comunque, e «un'ora» e' meglio di `undefined`.
 */
export function ritardoDopo(attempt: number): number {
  const indice = Math.min(Math.max(attempt, 1), RITARDI_RITENTATIVO.length) - 1;
  return RITARDI_RITENTATIVO[indice] ?? 0;
}

export type IngestionOutcome =
  /** Nessun lavoro fatto: un altro worker aveva gia' preso questa riga. */
  | { readonly kind: "SALTATO"; readonly recordingId: string }
  | {
      readonly kind: "ESTRATTO";
      readonly recordingId: string;
      readonly procedureId: string;
      readonly issues: readonly ExtractionIssue[];
    }
  | {
      readonly kind: "DUPLICATO";
      readonly recordingId: string;
      readonly procedureId: string;
      readonly similarity: number;
    }
  | {
      readonly kind: "FALLITO";
      readonly recordingId: string;
      readonly code: string;
      readonly status: typeof RecordingStatus.BOZZA_AUDIO | typeof RecordingStatus.ESTRAZIONE_FALLITA;
      readonly issues: readonly ExtractionIssue[];
    };

export interface IngestionDeps {
  readonly repo: RecordingRepository;
  readonly transcription: TranscriptionProvider;
  readonly extraction: ExtractionProvider;
  readonly storage: StorageProvider;
  readonly embedding: EmbeddingProvider;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface IngestionService {
  /** Elabora una registrazione specifica. Non lancia mai: l'esito e' il valore. */
  processRecording(recordingId: string): Promise<IngestionOutcome>;
  /** Prende la prossima in attesa. `null` se la coda e' vuota. */
  processNext(): Promise<IngestionOutcome | null>;
}

/**
 * Interrompe la pipeline con un codice gia' deciso.
 *
 * Serve perche' gli stadi sono cinque e ognuno puo' fallire per ragioni sue: un
 * `return` a ogni livello vorrebbe dire ripetere cinque volte la scrittura
 * dell'errore e il logging. Cosi' la gestione sta in un posto solo, in fondo.
 */
class StageFailure extends Error {
  readonly code: string;
  readonly status: typeof RecordingStatus.BOZZA_AUDIO | typeof RecordingStatus.ESTRAZIONE_FALLITA;
  readonly issues: readonly ExtractionIssue[];

  constructor(params: {
    code: string;
    message: string;
    status: typeof RecordingStatus.BOZZA_AUDIO | typeof RecordingStatus.ESTRAZIONE_FALLITA;
    issues?: readonly ExtractionIssue[];
  }) {
    super(params.message);
    this.name = "StageFailure";
    this.code = params.code;
    this.status = params.status;
    this.issues = params.issues ?? [];
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * §3: "vocabolario di contesto" passato allo STT.
 *
 * Sono i termini che un modello generalista sbaglia sistematicamente perche'
 * sono acronimi italiani o gergo di mestiere: "SPID" diventa "s pid", "F24"
 * diventa "effe ventiquattro". Elencarli non insegna niente al modello, gli
 * dice solo quali stringhe preferire quando il suono e' ambiguo.
 */
export const TRANSCRIPTION_VOCABULARY = [
  "SPID",
  "CIE",
  "casellario",
  "marca da bollo",
  "PEC",
  "F24",
  "ASL",
  "staff augmentation",
  "deploy",
  "VPN",
  "ticket",
] as const;

export function createIngestionService(deps: IngestionDeps): IngestionService {
  const { repo, clock, logger } = deps;

  async function transcribe(job: RecordingJob): Promise<string> {
    let audio: Uint8Array;
    try {
      audio = await deps.storage.get(job.audioUrl);
    } catch (error) {
      throw new StageFailure({
        code: IngestionError.audioNonLeggibile,
        message: `Audio non recuperabile dallo storage: ${describe(error)}`,
        status: RecordingStatus.BOZZA_AUDIO,
      });
    }

    let result;
    try {
      result = await deps.transcription.transcribe({
        audio,
        mimeType: job.mimeType,
        languageHint: job.deviceLocale ?? undefined,
        vocabulary: TRANSCRIPTION_VOCABULARY,
      });
    } catch (error) {
      throw new StageFailure({
        code: IngestionError.trascrizioneFallita,
        message: describe(error),
        status: RecordingStatus.BOZZA_AUDIO,
      });
    }

    const text = result.text.trim();
    if (text === "") {
      // Un audio muto non e' un errore del sistema, ma non c'e' niente da
      // estrarre. BOZZA_AUDIO e non ESTRAZIONE_FALLITA: se l'utente ha parlato
      // e lo STT non ha sentito, un secondo tentativo puo' andare diversamente.
      throw new StageFailure({
        code: IngestionError.trascrizioneVuota,
        message: "La trascrizione e' vuota: nessun parlato riconosciuto.",
        status: RecordingStatus.BOZZA_AUDIO,
      });
    }

    // Prima di ogni altra cosa, e prima di sapere se l'estrazione riuscira'.
    await repo.saveTranscript(job.id, {
      text: result.text,
      source: result.source,
      at: clock.now(),
    });

    return text;
  }

  async function extract(
    job: RecordingJob,
    transcript: string,
  ): Promise<{
    contract: ExtractionContract;
    cardStatus: typeof CardStatus.COMPLETA | typeof CardStatus.DA_RIVEDERE;
    issues: readonly ExtractionIssue[];
  }> {
    const vocabulary = await repo.vocabularyOf(job.userId);
    const context = {
      recordedAt: job.recordedAt.toISOString(),
      placeLabel: job.placeLabel,
      existingScopes: vocabulary.scopes,
      existingTags: vocabulary.tags,
    };

    let lastIssues: readonly ExtractionIssue[] = [];

    for (let attempt = 1; attempt <= MAX_EXTRACTION_ATTEMPTS; attempt += 1) {
      let result;
      try {
        result = await deps.extraction.extract({ transcript, context });
      } catch (error) {
        // Un errore di trasporto non e' "JSON non conforme": la §5 concede il
        // retry al secondo caso, non al primo. Qui non si e' saputo nulla del
        // modello, quindi si torna in coda invece di bruciare il tentativo.
        throw new StageFailure({
          code: IngestionError.estrazioneFallita,
          message: describe(error),
          status: RecordingStatus.BOZZA_AUDIO,
        });
      }

      // Integrale e subito: se la validazione rifiuta, questa e' l'unica prova
      // di cosa aveva risposto il modello.
      await repo.saveExtraction(job.id, {
        raw: result.raw,
        model: `${result.model} (${result.promptVersion})`,
        at: clock.now(),
      });

      const verdict = validateExtraction(result.raw);
      if (verdict.outcome === "ACCETTATA") {
        return {
          contract: verdict.contract,
          cardStatus: verdict.cardStatus,
          issues: verdict.issues,
        };
      }

      lastIssues = verdict.issues;
      logger.warn("estrazione non conforme", {
        recordingId: job.id,
        attempt,
        issues: verdict.issues.map((i) => `${i.rule}@${i.path}`),
      });
    }

    throw new StageFailure({
      code: IngestionError.contrattoNonConforme,
      message: `Estrazione non conforme al contratto dopo ${String(MAX_EXTRACTION_ATTEMPTS)} tentativi.`,
      status: RecordingStatus.ESTRAZIONE_FALLITA,
      issues: lastIssues,
    });
  }

  async function run(job: RecordingJob): Promise<IngestionOutcome> {
    const transcript = await transcribe(job);
    const { contract, cardStatus, issues } = await extract(job, transcript);

    // I passi si rinumerano PRIMA di scrivere: `@@unique([procedureId, ordine])`
    // rifiuterebbe un'estrazione che numera 1, 1, 3, e perderemmo il contenuto
    // per un difetto di forma. L'issue resta negli `issues`, il testo si salva.
    const normalized: ExtractionContract = {
      ...contract,
      passi: normalizeSteps(contract.passi),
    };

    let vector: number[];
    try {
      vector = await deps.embedding.embed(
        embeddingInput({
          titolo: normalized.titolo ?? "",
          trigger: normalized.trigger,
          tag: normalized.tag,
        }),
      );
    } catch (error) {
      throw new StageFailure({
        code: IngestionError.embeddingFallito,
        message: describe(error),
        status: RecordingStatus.BOZZA_AUDIO,
      });
    }

    // §5: "se supera 0.85 con una procedura esistente dello stesso utente, non
    // creare un duplicato — restituisci un suggerimento di aggiornamento e
    // lascia decidere all'utente".
    const similar = await repo.findMostSimilar(job.userId, vector);
    if (similar !== null && similar.similarity > DEDUP_COSINE_THRESHOLD) {
      await repo.markDuplicate(job.id, {
        procedureId: similar.procedureId,
        similarity: similar.similarity,
        at: clock.now(),
      });
      logger.info("duplicato sospetto", {
        recordingId: job.id,
        procedureId: similar.procedureId,
        similarity: similar.similarity,
      });
      return {
        kind: "DUPLICATO",
        recordingId: job.id,
        procedureId: similar.procedureId,
        similarity: similar.similarity,
      };
    }

    // Rete di sicurezza, non un secondo giudizio: `cardStatus` resta quello
    // deciso sull'estrazione ORIGINALE. Rinumerare i passi cancella l'issue di
    // contiguita', e prendere il verdetto da qui farebbe nascere COMPLETA una
    // scheda che il controllo aveva bocciato — un controllo senza conseguenze
    // non e' un controllo.
    const verdict = validateExtraction(normalized);
    /* c8 ignore next 8 -- rinumerare non puo' invalidare cio' che era valido */
    if (verdict.outcome !== "ACCETTATA") {
      throw new StageFailure({
        code: IngestionError.contrattoNonConforme,
        message: "Il contratto e' diventato non valido dopo la normalizzazione.",
        status: RecordingStatus.ESTRAZIONE_FALLITA,
        issues: verdict.issues,
      });
    }

    let procedureId: string;
    try {
      procedureId = await repo.persistProcedure({
        recordingId: job.id,
        userId: job.userId,
        contract: normalized,
        cardStatus,
        recordedAt: job.recordedAt,
        latitude: job.latitude,
        longitude: job.longitude,
        embedding: vector,
      });
    } catch (error) {
      // La transazione ha gia' fatto rollback: non esiste mezza scheda. Il
      // Recording torna in coda con trascrizione ed estrazione conservate, e
      // il prossimo giro ripartira' da li' senza ripagare i due modelli.
      throw new StageFailure({
        code: IngestionError.persistenzaFallita,
        message: describe(error),
        status: RecordingStatus.BOZZA_AUDIO,
      });
    }

    logger.info("scheda creata", {
      recordingId: job.id,
      procedureId,
      cardStatus,
      issues: issues.length,
    });

    return { kind: "ESTRATTO", recordingId: job.id, procedureId, issues };
  }

  async function process(job: RecordingJob): Promise<IngestionOutcome> {
    try {
      return await run(job);
    } catch (error) {
      const failure =
        error instanceof StageFailure
          ? error
          : /* Un errore non previsto non deve poter bloccare il worker né
               perdere l'audio: si registra come gli altri e la riga torna in
               coda. */
            new StageFailure({
              code: IngestionError.estrazioneFallita,
              message: describe(error),
              status: RecordingStatus.BOZZA_AUDIO,
            });

      // `retryCount` e' quello con cui la riga e' stata presa: questo tentativo
      // non e' ancora stato contato, e lo contera' `markFailed`.
      const attempt = job.retryCount + 1;
      const esaurita =
        failure.status === RecordingStatus.BOZZA_AUDIO && attempt >= MAX_INGESTION_ATTEMPTS;

      // Il codice resta quello vero: la UI deve poter dire *cosa* e' andato
      // storto, non solo che si e' smesso di provare. Cambia solo lo stato, ed
      // e' cio' che toglie la riga dalla coda.
      const status = esaurita ? RecordingStatus.ESTRAZIONE_FALLITA : failure.status;
      const message = esaurita
        ? `${failure.message} Interrotto dopo ${String(attempt)} tentativi: riprovare dalla scheda della registrazione.`
        : failure.message;

      const adesso = clock.now();
      // Solo chi torna in coda ha un prossimo tentativo. Per gli altri stati la
      // colonna resta `null`, che e' anche cio' che `claimNext` legge come
      // "prendibile subito": una riga rimessa in coda a mano non deve ereditare
      // l'attesa decisa per il ciclo automatico.
      const nextAttemptAt =
        status === RecordingStatus.BOZZA_AUDIO
          ? new Date(adesso.getTime() + ritardoDopo(attempt))
          : null;

      await repo.markFailed(job.id, {
        status,
        code: failure.code,
        message,
        at: adesso,
        nextAttemptAt,
      });

      logger.error("elaborazione fallita", {
        recordingId: job.id,
        code: failure.code,
        status,
        attempt,
        esaurita,
        nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
        message: failure.message,
      });

      return {
        kind: "FALLITO",
        recordingId: job.id,
        code: failure.code,
        status,
        issues: failure.issues,
      };
    }
  }

  return {
    async processRecording(recordingId: string): Promise<IngestionOutcome> {
      const job = await repo.claim(recordingId, clock.now());
      if (job === null) {
        return { kind: "SALTATO", recordingId };
      }
      return process(job);
    },

    async processNext(): Promise<IngestionOutcome | null> {
      const job = await repo.claimNext(clock.now());
      if (job === null) {
        return null;
      }
      return process(job);
    },
  };
}
