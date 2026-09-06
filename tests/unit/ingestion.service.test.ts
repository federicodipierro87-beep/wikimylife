import {
  CardStatus,
  DEDUP_COSINE_THRESHOLD,
  RecordingStatus,
  deterministicUnitVector,
  embeddingInput,
  type ExtractionContract,
} from "@wikimylife/shared";
import { buildExtractionContract } from "@wikimylife/shared/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createLogger, type Logger } from "../../apps/api/src/logger.js";
import {
  FakeEmbeddingProvider,
  FakeExtractionProvider,
  FakeStorageProvider,
  FakeTranscriptionProvider,
} from "../../apps/api/src/providers/fake/index.js";
import {
  IngestionError,
  MAX_EXTRACTION_ATTEMPTS,
  MAX_INGESTION_ATTEMPTS,
  createIngestionService,
  type IngestionService,
} from "../../apps/api/src/services/ingestion.service.js";
import type { RecordingDetail } from "../../apps/api/src/services/ports/RecordingRepository.js";
import { FixedClock } from "../support/FixedClock.js";
import { InMemoryRecordingRepository } from "../support/InMemoryRecordingRepository.js";

/**
 * La pipeline, senza database, senza rete e senza chiavi API.
 *
 * E' il file che dimostra le sei promesse della fase 2 — l'audio non si perde
 * mai, la trascrizione si conserva, `rawExtraction` e' integrale, il retry e'
 * uno solo, il duplicato non crea una scheda — e ognuna e' verificata
 * guardando lo stato in cui resta la riga, non solo il valore restituito.
 * Il valore serve al worker per il log; lo stato e' cio' che decide se domani
 * l'utente ritrovera' la sua registrazione.
 */

const USER = "user-1";
const START = new Date("2026-03-01T12:00:00.000Z");

function silentLogger(): Logger {
  return createLogger({
    level: "error",
    write: () => undefined,
    writeError: () => undefined,
  });
}

interface Harness {
  readonly repo: InMemoryRecordingRepository;
  readonly transcription: FakeTranscriptionProvider;
  readonly extraction: FakeExtractionProvider;
  readonly storage: FakeStorageProvider;
  readonly embedding: FakeEmbeddingProvider;
  readonly clock: FixedClock;
  readonly service: IngestionService;
}

function harness(): Harness {
  const repo = new InMemoryRecordingRepository();
  const transcription = new FakeTranscriptionProvider();
  const extraction = new FakeExtractionProvider();
  const storage = new FakeStorageProvider();
  const embedding = new FakeEmbeddingProvider();
  const clock = new FixedClock(START);

  return {
    repo,
    transcription,
    extraction,
    storage,
    embedding,
    clock,
    service: createIngestionService({
      repo,
      transcription,
      extraction,
      storage,
      embedding,
      clock,
      logger: silentLogger(),
    }),
  };
}

let h: Harness;

beforeEach(() => {
  h = harness();
});

/** Registrazione in coda con il suo audio davvero presente nello storage. */
async function seedConAudio(overrides: Partial<RecordingDetail> = {}): Promise<string> {
  const recording = h.repo.seedRecording({ userId: USER, ...overrides });
  await h.storage.put({
    key: recording.audioUrl,
    data: new Uint8Array([1, 2, 3, 4]),
    mimeType: recording.mimeType,
  });
  return recording.id;
}

/** Il vettore che la pipeline calcolera' per questo contratto. */
function vettoreDi(contract: ExtractionContract): number[] {
  return deterministicUnitVector(
    embeddingInput({
      titolo: contract.titolo ?? "",
      trigger: contract.trigger,
      tag: contract.tag,
    }),
    new FakeEmbeddingProvider().dimensions,
  );
}

describe("percorso felice", () => {
  it("porta la registrazione a ESTRATTO e crea la scheda", async () => {
    const contract = buildExtractionContract();
    h.extraction.enqueue(contract);
    const id = await seedConAudio();

    const outcome = await h.service.processRecording(id);

    expect(outcome.kind).toBe("ESTRATTO");
    const dopo = h.repo.snapshot(id);
    expect(dopo.status).toBe(RecordingStatus.ESTRATTO);
    expect(dopo.procedureId).not.toBeNull();
    expect(h.repo.persisted).toHaveLength(1);
    expect(h.repo.persisted[0]?.cardStatus).toBe(CardStatus.COMPLETA);
    expect(h.repo.persisted[0]?.contract.titolo).toBe(contract.titolo);
  });

  it("conserva la trascrizione anche quando l'estrazione riesce", async () => {
    // Requisito esplicito: la trascrizione grezza si conserva SEMPRE. E' l'unico
    // dato che non si puo' piu' riottenere se l'audio si perde.
    h.transcription.enqueue("Oggi sono andato in Procura a ritirare il casellario.");
    h.extraction.enqueue(buildExtractionContract());
    const id = await seedConAudio();

    await h.service.processRecording(id);

    const dopo = h.repo.snapshot(id);
    expect(dopo.transcript).toBe("Oggi sono andato in Procura a ritirare il casellario.");
    expect(dopo.transcriptSource).toBe("fake");
  });

  it("salva rawExtraction integrale, non i soli campi che finiscono in scheda", async () => {
    // `campiIncerti` e `domandeSuggerite` non hanno una colonna: se qui si
    // salvasse solo cio' che serve a scrivere la Procedure, sparirebbero.
    const base = buildExtractionContract();
    const contract = buildExtractionContract({
      _meta: {
        ...base._meta,
        campiIncerti: ["costi"],
        domandeSuggerite: ["Quanto hai pagato in tutto?"],
      },
    });
    h.extraction.enqueue(contract);
    const id = await seedConAudio();

    await h.service.processRecording(id);

    expect(h.repo.snapshot(id).rawExtraction).toEqual(contract);
  });

  it("registra il modello e la versione del prompt in extractionModel", async () => {
    // §6: per riprocessare lo storico serve sapere quale coppia modello/prompt
    // ha prodotto una scheda.
    h.extraction.enqueue(buildExtractionContract());
    const id = await seedConAudio();

    await h.service.processRecording(id);

    expect(h.repo.snapshot(id).extractionModel).toBe("fake-extraction-v1 (extraction.v1)");
  });

  it("passa alla scheda la data della registrazione, non quella di elaborazione", async () => {
    // `Execution.eseguitaIl` e `ultimaVerifica` devono dire quando l'utente ha
    // fatto la cosa, non quando il worker l'ha vista.
    const recordedAt = new Date("2026-02-14T08:30:00.000Z");
    h.extraction.enqueue(buildExtractionContract());
    const id = await seedConAudio({ recordedAt });
    h.clock.advanceDays(3);

    await h.service.processRecording(id);

    expect(h.repo.persisted[0]?.recordedAt).toEqual(recordedAt);
  });

  it("rinumera i passi prima di scriverli", async () => {
    // `@@unique([procedureId, ordine])` rifiuterebbe 1, 1, 4: rinumerare salva
    // il contenuto, che e' la parte non riproducibile.
    h.extraction.enqueue(
      buildExtractionContract({
        passi: [
          { ordine: 1, azione: "primo", dettaglio: null, durataStimataMin: null },
          { ordine: 1, azione: "secondo", dettaglio: null, durataStimataMin: null },
          { ordine: 4, azione: "terzo", dettaglio: null, durataStimataMin: null },
        ],
      }),
    );
    const id = await seedConAudio();

    const outcome = await h.service.processRecording(id);

    expect(h.repo.persisted[0]?.contract.passi.map((p) => [p.ordine, p.azione])).toEqual([
      [1, "primo"],
      [2, "secondo"],
      [3, "terzo"],
    ]);
    // Il problema resta segnalato: rinumerare non vuol dire far finta di niente.
    expect(outcome.kind === "ESTRATTO" && outcome.issues.length).toBe(1);
    expect(h.repo.persisted[0]?.cardStatus).toBe(CardStatus.DA_RIVEDERE);
  });

  it("fa nascere in DA_RIVEDERE una scheda con rilievi", async () => {
    h.extraction.enqueue(buildExtractionContract({ passi: [] }));
    const id = await seedConAudio();

    await h.service.processRecording(id);

    expect(h.repo.persisted[0]?.cardStatus).toBe(CardStatus.DA_RIVEDERE);
    expect(h.repo.snapshot(id).status).toBe(RecordingStatus.ESTRATTO);
  });

  it("passa al modello il vocabolario gia' usato dall'utente", async () => {
    // Serve alla regola del prompt "usa i tag esistenti quando calzano":
    // senza contesto il modello inventa un tag quasi identico ogni volta.
    h.repo.vocabulary = { scopes: ["PERSONALE"], tags: ["burocrazia", "certificati"] };
    h.extraction.enqueue(buildExtractionContract());
    const id = await seedConAudio({ placeLabel: "Torino, Corso Vittorio" });

    await h.service.processRecording(id);

    expect(h.extraction.lastInput?.context).toEqual({
      recordedAt: h.repo.snapshot(id).recordedAt.toISOString(),
      placeLabel: "Torino, Corso Vittorio",
      existingScopes: ["PERSONALE"],
      existingTags: ["burocrazia", "certificati"],
    });
  });
});

describe("estrazione non conforme — un solo retry", () => {
  it("ritenta esattamente una volta e poi si arrende", async () => {
    // §5: "un solo retry poi stato ESTRAZIONE_FALLITA". Due chiamate in tutto.
    h.extraction.enqueue({ non: "conforme" }).enqueue({ ancora: "no" });
    const id = await seedConAudio();

    const outcome = await h.service.processRecording(id);

    expect(h.extraction.calls).toBe(MAX_EXTRACTION_ATTEMPTS);
    expect(outcome).toMatchObject({
      kind: "FALLITO",
      code: IngestionError.contrattoNonConforme,
      status: RecordingStatus.ESTRAZIONE_FALLITA,
    });
    const dopo = h.repo.snapshot(id);
    expect(dopo.status).toBe(RecordingStatus.ESTRAZIONE_FALLITA);
    expect(dopo.lastErrorCode).toBe(IngestionError.contrattoNonConforme);
    expect(dopo.retryCount).toBe(1);
    expect(h.repo.persisted).toEqual([]);
  });

  it("non ritenta quando la prima risposta e' gia' buona", async () => {
    h.extraction.enqueue(buildExtractionContract());
    const id = await seedConAudio();

    await h.service.processRecording(id);

    expect(h.extraction.calls).toBe(1);
  });

  it("accetta il secondo tentativo se il primo era malformato", async () => {
    h.extraction.enqueue("non è JSON").enqueue(buildExtractionContract());
    const id = await seedConAudio();

    const outcome = await h.service.processRecording(id);

    expect(h.extraction.calls).toBe(2);
    expect(outcome.kind).toBe("ESTRATTO");
    expect(h.repo.snapshot(id).status).toBe(RecordingStatus.ESTRATTO);
  });

  it("conserva l'ultima risposta anche quando la rifiuta", async () => {
    // Senza questo, di due chiamate pagate al modello non resterebbe traccia e
    // nessuno potrebbe capire perche' l'estrazione non passava.
    h.extraction.enqueue({ tentativo: 1 }).enqueue({ tentativo: 2 });
    const id = await seedConAudio();

    await h.service.processRecording(id);

    expect(h.repo.snapshot(id).rawExtraction).toEqual({ tentativo: 2 });
  });

  it("riporta gli issue dell'ultimo tentativo", async () => {
    h.extraction
      .enqueue(buildExtractionContract({ titolo: null }))
      .enqueue(buildExtractionContract({ titolo: "   " }));
    const id = await seedConAudio();

    const outcome = await h.service.processRecording(id);

    expect(outcome.kind === "FALLITO" && outcome.issues.map((i) => i.rule)).toEqual([
      "titolo.mancante",
    ]);
  });

  it("resta riprocessabile: ESTRAZIONE_FALLITA e' reclamabile a mano", async () => {
    h.extraction.enqueue({}).enqueue({});
    const id = await seedConAudio();
    await h.service.processRecording(id);
    expect(h.repo.snapshot(id).status).toBe(RecordingStatus.ESTRAZIONE_FALLITA);

    h.extraction.enqueue(buildExtractionContract());
    const secondo = await h.service.processRecording(id);

    expect(secondo.kind).toBe("ESTRATTO");
  });
});

describe("fallimenti che lasciano tutto riprocessabile", () => {
  it("una trascrizione fallita riporta la riga in BOZZA_AUDIO", async () => {
    // Requisito 1 della fase: se STT fallisce, la registrazione resta in coda
    // con l'errore scritto sopra. Nessuna chiamata all'estrazione.
    h.transcription.failNext();
    const id = await seedConAudio();

    const outcome = await h.service.processRecording(id);

    expect(outcome).toMatchObject({
      kind: "FALLITO",
      code: IngestionError.trascrizioneFallita,
      status: RecordingStatus.BOZZA_AUDIO,
    });
    const dopo = h.repo.snapshot(id);
    expect(dopo.status).toBe(RecordingStatus.BOZZA_AUDIO);
    expect(dopo.lastErrorMessage).toContain("fallimento simulato");
    expect(dopo.transcript).toBeNull();
    expect(h.extraction.calls).toBe(0);
  });

  it("un audio non recuperabile non consuma nessun modello", async () => {
    // Nessun `storage.put`: la chiave non esiste.
    const recording = h.repo.seedRecording({ userId: USER });

    const outcome = await h.service.processRecording(recording.id);

    expect(outcome).toMatchObject({
      kind: "FALLITO",
      code: IngestionError.audioNonLeggibile,
      status: RecordingStatus.BOZZA_AUDIO,
    });
    expect(h.transcription.calls).toBe(0);
    expect(h.extraction.calls).toBe(0);
  });

  it("una trascrizione vuota torna in coda invece di fallire l'estrazione", async () => {
    // Un audio muto non e' un JSON sbagliato: un secondo tentativo puo' andare
    // diversamente, quindi BOZZA_AUDIO e non ESTRAZIONE_FALLITA.
    h.transcription.enqueue("   \n  ");
    const id = await seedConAudio();

    const outcome = await h.service.processRecording(id);

    expect(outcome).toMatchObject({
      kind: "FALLITO",
      code: IngestionError.trascrizioneVuota,
      status: RecordingStatus.BOZZA_AUDIO,
    });
    expect(h.extraction.calls).toBe(0);
  });

  it("un errore di trasporto dell'estrazione non brucia il tentativo", async () => {
    // Distinzione che vale soldi: un timeout non e' "il modello ha risposto
    // male". La §5 concede il retry al secondo caso; qui si torna in coda.
    h.extraction.failNext();
    const id = await seedConAudio();

    const outcome = await h.service.processRecording(id);

    expect(h.extraction.calls).toBe(1);
    expect(outcome).toMatchObject({
      kind: "FALLITO",
      code: IngestionError.estrazioneFallita,
      status: RecordingStatus.BOZZA_AUDIO,
    });
    expect(h.repo.snapshot(id).status).toBe(RecordingStatus.BOZZA_AUDIO);
  });

  it("una persistenza fallita conserva trascrizione ed estrazione", async () => {
    // La transazione ha fatto rollback: non esiste mezza scheda. Il prossimo
    // giro riparte da qui senza ripagare i due modelli.
    h.transcription.enqueue("Racconto completo della procedura.");
    h.extraction.enqueue(buildExtractionContract());
    h.repo.persistFailure = new Error("deadlock detected");
    const id = await seedConAudio();

    const outcome = await h.service.processRecording(id);

    expect(outcome).toMatchObject({
      kind: "FALLITO",
      code: IngestionError.persistenzaFallita,
      status: RecordingStatus.BOZZA_AUDIO,
    });
    const dopo = h.repo.snapshot(id);
    expect(dopo.status).toBe(RecordingStatus.BOZZA_AUDIO);
    expect(dopo.transcript).toBe("Racconto completo della procedura.");
    expect(dopo.rawExtraction).not.toBeNull();
    expect(dopo.procedureId).toBeNull();
  });

  it("non lancia mai: l'esito e' sempre un valore", async () => {
    // Il worker gira in un ciclo: un'eccezione che sfugge fermerebbe la coda
    // intera per colpa di una riga sola.
    h.transcription.failNext();
    const id = await seedConAudio();

    await expect(h.service.processRecording(id)).resolves.toMatchObject({ kind: "FALLITO" });
  });

  it("conta i tentativi falliti", async () => {
    const id = await seedConAudio();
    h.transcription.failNext();
    await h.service.processRecording(id);
    h.transcription.failNext();
    await h.service.processRecording(id);

    expect(h.repo.snapshot(id).retryCount).toBe(2);
  });
});

describe("il tetto ai tentativi automatici", () => {
  /** Fa fallire la trascrizione tante volte quante richiesto. */
  async function falliscePerVolte(id: string, volte: number): Promise<void> {
    for (let i = 0; i < volte; i += 1) {
      h.transcription.failNext();
      await h.service.processRecording(id);
    }
  }

  it("sotto il tetto la riga resta in coda", async () => {
    const id = await seedConAudio();

    await falliscePerVolte(id, MAX_INGESTION_ATTEMPTS - 1);

    expect(h.repo.snapshot(id).status).toBe(RecordingStatus.BOZZA_AUDIO);
  });

  it("al tetto esce dalla coda invece di ripartire", async () => {
    // Senza questo, tornare in BOZZA_AUDIO non e' una seconda occasione ma un
    // ciclo: `claimNext` prende la piu' vecchia in attesa, e la piu' vecchia in
    // attesa e' di nuovo questa. Ogni giro e' una chiamata Whisper pagata.
    const id = await seedConAudio();

    await falliscePerVolte(id, MAX_INGESTION_ATTEMPTS);

    const dopo = h.repo.snapshot(id);
    expect(dopo.status).toBe(RecordingStatus.ESTRAZIONE_FALLITA);
    expect(dopo.retryCount).toBe(MAX_INGESTION_ATTEMPTS);
  });

  it("una volta fermata, la coda non la ripesca piu'", async () => {
    const id = await seedConAudio();
    await falliscePerVolte(id, MAX_INGESTION_ATTEMPTS);

    expect(await h.repo.claimNext(h.clock.now())).toBeNull();
  });

  it("l'audio e' ancora li': non si e' perso niente", async () => {
    // ESTRAZIONE_FALLITA e' un capolinea per la coda, non per l'utente. Il
    // riscatto manuale riparte da qui, ed e' l'unica cosa che rende
    // accettabile fermarsi.
    const id = await seedConAudio();
    await falliscePerVolte(id, MAX_INGESTION_ATTEMPTS);

    const dopo = h.repo.snapshot(id);
    expect(dopo.audioUrl).not.toBe("");
    expect(await h.storage.exists(dopo.audioUrl)).toBe(true);
  });

  it("il messaggio dice che si e' smesso, e non solo cosa e' andato storto", async () => {
    // «Trascrizione fallita» al terzo giro sembra il primo giro. Chi guarda la
    // scheda deve capire che nessuno riprovera' al posto suo.
    const id = await seedConAudio();
    await falliscePerVolte(id, MAX_INGESTION_ATTEMPTS);

    const messaggio = h.repo.snapshot(id).lastErrorMessage ?? "";
    expect(messaggio).toContain("fallimento simulato");
    expect(messaggio).toContain("tentativi");
  });

  it("il riscatto manuale ricompra esattamente un tentativo", async () => {
    // `requeue` incrementa `retryCount`, quindi il tentativo successivo e' gia'
    // oltre il tetto e il primo fallimento richiude. Non e' un limite
    // aggirabile: e' una decisione presa una volta, non un ciclo.
    const id = await seedConAudio();
    await falliscePerVolte(id, MAX_INGESTION_ATTEMPTS);

    await h.repo.requeue(USER, id, h.clock.now());
    expect(h.repo.snapshot(id).status).toBe(RecordingStatus.BOZZA_AUDIO);

    await falliscePerVolte(id, 1);
    expect(h.repo.snapshot(id).status).toBe(RecordingStatus.ESTRAZIONE_FALLITA);
  });

  it("il percorso felice non conosce nessun tetto", async () => {
    // Una riga che ha gia' fallito piu' del tetto e viene rimessa in coda deve
    // poter arrivare a ESTRATTO: il conteggio non e' una condanna.
    h.extraction.enqueue(buildExtractionContract());
    const id = await seedConAudio({ retryCount: 12 });

    expect(await h.service.processRecording(id)).toMatchObject({ kind: "ESTRATTO" });
  });
});

describe("deduplicazione per similarita' coseno", () => {
  it("non crea la scheda quando supera la soglia", async () => {
    // §5: "se supera 0.85 con una procedura esistente dello stesso utente, non
    // creare un duplicato — restituisci un suggerimento di aggiornamento".
    const contract = buildExtractionContract();
    const esistente = h.repo.seedProcedure({
      userId: USER,
      titolo: "Richiedere il casellario giudiziale",
      embedding: vettoreDi(contract),
    });
    h.extraction.enqueue(contract);
    const id = await seedConAudio();

    const outcome = await h.service.processRecording(id);

    expect(outcome).toMatchObject({ kind: "DUPLICATO", procedureId: esistente.id });
    expect(h.repo.persisted).toEqual([]);

    const dopo = h.repo.snapshot(id);
    expect(dopo.status).toBe(RecordingStatus.DUPLICATO_SOSPETTO);
    expect(dopo.procedureId).toBeNull();
    expect(dopo.duplicateOfId).toBe(esistente.id);
    expect(dopo.duplicateOfTitolo).toBe("Richiedere il casellario giudiziale");
    expect(dopo.duplicateSimilarity ?? 0).toBeGreaterThan(DEDUP_COSINE_THRESHOLD);
  });

  it("crea la scheda quando la procedura esistente parla d'altro", async () => {
    h.repo.seedProcedure({
      userId: USER,
      titolo: "Ripristinare la VPN aziendale dopo il cambio password",
      embedding: vettoreDi(
        buildExtractionContract({
          titolo: "Ripristinare la VPN aziendale dopo il cambio password",
          trigger: "Il client non si collega piu'",
          tag: ["vpn", "lavoro"],
        }),
      ),
    });
    h.extraction.enqueue(buildExtractionContract());
    const id = await seedConAudio();

    const outcome = await h.service.processRecording(id);

    expect(outcome.kind).toBe("ESTRATTO");
    expect(h.repo.persisted).toHaveLength(1);
  });

  it("non guarda le procedure di un altro utente", async () => {
    // La deduplicazione e' per utente: due persone possono avere la stessa
    // procedura, e nessuna delle due deve vedere l'altra.
    const contract = buildExtractionContract();
    h.repo.seedProcedure({
      userId: "altro-utente",
      titolo: contract.titolo ?? "",
      embedding: vettoreDi(contract),
    });
    h.extraction.enqueue(contract);
    const id = await seedConAudio();

    const outcome = await h.service.processRecording(id);

    expect(outcome.kind).toBe("ESTRATTO");
  });

  it("una seconda registrazione identica viene riconosciuta dalla prima", async () => {
    // Il caso vero: l'utente racconta due volte la stessa cosa. La prima crea
    // la scheda, la seconda deve fermarsi.
    const contract = buildExtractionContract();
    h.extraction.enqueue(contract).enqueue(contract);

    const primo = await seedConAudio();
    expect((await h.service.processRecording(primo)).kind).toBe("ESTRATTO");

    const secondo = await seedConAudio();
    const outcome = await h.service.processRecording(secondo);

    expect(outcome.kind).toBe("DUPLICATO");
    expect(h.repo.persisted).toHaveLength(1);
    expect(h.repo.snapshot(secondo).duplicateOfId).toBe(h.repo.snapshot(primo).procedureId);
  });
});

describe("la coda", () => {
  it("due worker non elaborano la stessa riga", async () => {
    // `claim` e' un compare-and-swap: chi arriva secondo trova la riga gia'
    // IN_ELABORAZIONE e riceve SALTATO invece di rifare il lavoro.
    const id = await seedConAudio({ status: RecordingStatus.IN_ELABORAZIONE });

    const outcome = await h.service.processRecording(id);

    expect(outcome).toEqual({ kind: "SALTATO", recordingId: id });
    expect(h.transcription.calls).toBe(0);
  });

  it("una registrazione gia' ESTRATTA non si rielabora", async () => {
    const id = await seedConAudio({ status: RecordingStatus.ESTRATTO });

    expect((await h.service.processRecording(id)).kind).toBe("SALTATO");
  });

  it("processNext restituisce null a coda vuota", async () => {
    expect(await h.service.processNext()).toBeNull();
  });

  it("processNext prende la registrazione piu' vecchia", async () => {
    h.extraction.enqueue(buildExtractionContract());
    const recente = await seedConAudio({ recordedAt: new Date("2026-03-01T11:00:00.000Z") });
    const vecchia = await seedConAudio({ recordedAt: new Date("2026-02-20T09:00:00.000Z") });

    const outcome = await h.service.processNext();

    expect(outcome?.recordingId).toBe(vecchia);
    expect(h.repo.snapshot(recente).status).toBe(RecordingStatus.BOZZA_AUDIO);
  });

  it("processNext ignora le estrazioni fallite", async () => {
    // Un'estrazione che ha gia' fallito due volte tornerebbe a fallire: il
    // polling la ripescherebbe per sempre, bruciando token a ogni giro. Si
    // riprende solo su richiesta esplicita dell'utente.
    await seedConAudio({ status: RecordingStatus.ESTRAZIONE_FALLITA });

    expect(await h.service.processNext()).toBeNull();
  });

  it("svuota la coda un elemento alla volta", async () => {
    h.extraction.enqueue(buildExtractionContract({ titolo: "Prima procedura" }));
    h.extraction.enqueue(buildExtractionContract({ titolo: "Seconda procedura" }));
    await seedConAudio({ recordedAt: new Date("2026-02-01T09:00:00.000Z") });
    await seedConAudio({ recordedAt: new Date("2026-02-02T09:00:00.000Z") });

    expect((await h.service.processNext())?.kind).toBe("ESTRATTO");
    expect((await h.service.processNext())?.kind).toBe("ESTRATTO");
    expect(await h.service.processNext()).toBeNull();
    expect(h.repo.persisted).toHaveLength(2);
  });
});
