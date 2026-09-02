import {
  CardStatus,
  DEDUP_COSINE_THRESHOLD,
  MAX_AUDIO_BYTES,
  RecordingStatus,
  Scope,
  Visibility,
  authSessionSchema,
  errorBodySchema,
  recordingStateSchema,
  type CaptureMetadataInput,
  type ExtractionContract,
  type RecordingState,
} from "@wikimylife/shared";
import { buildExtractionContract } from "@wikimylife/shared/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeExtractionProvider,
  FakeStorageProvider,
  FakeTranscriptionProvider,
} from "../../apps/api/src/providers/fake/index.js";
import {
  IngestionError,
  MAX_EXTRACTION_ATTEMPTS,
  type IngestionOutcome,
} from "../../apps/api/src/services/ingestion.service.js";
import { disconnectTestPrisma, resetDatabase } from "./helpers/db.js";
import { call, startTestServer, uploadRecording, type TestServer } from "./helpers/server.js";

/**
 * La pipeline di ingestione dall'HTTP al database, senza mock.
 *
 * `ingestion.service.test.ts` copre gia' le stesse decisioni con un repository
 * in memoria, e in millisecondi. Questo file esiste per le tre cose che quel
 * repository non puo' provare, perche' non sono logica ma infrastruttura:
 *
 *  1. **Il multipart.** `Response.formData()` al posto di `multer` e' una scelta
 *     che si giustifica solo se funziona su un corpo vero, prodotto da un client
 *     vero, con un boundary che non abbiamo scritto noi.
 *
 *  2. **pgvector.** La deduplicazione della §5 e' un `<=>` dentro una query
 *     grezza su una colonna `Unsupported`, servita da un indice HNSW. Un coseno
 *     calcolato in TypeScript prova la soglia; solo Postgres prova che la
 *     colonna esiste, che il cast `::vector` e' scritto giusto e che l'indice
 *     non e' stato cancellato da una migration.
 *
 *  3. **I vincoli dello schema.** `@@unique([procedureId, ordine])` e' il motivo
 *     per cui i passi si rinumerano prima di scrivere. In memoria la
 *     rinumerazione e' cosmesi; qui e' cio' che separa una scheda salvata da una
 *     transazione in rollback.
 */

const PASSWORD = "password-di-prova-lunga";
const RECORDED_AT = "2026-03-01T09:30:00.000Z";

let server: TestServer;
let stt: FakeTranscriptionProvider;
let llm: FakeExtractionProvider;
let blob: FakeStorageProvider;

beforeAll(async () => {
  server = await startTestServer();

  const { transcription, extraction, storage } = server.composition.providers;
  if (
    !(transcription instanceof FakeTranscriptionProvider) ||
    !(extraction instanceof FakeExtractionProvider) ||
    !(storage instanceof FakeStorageProvider)
  ) {
    // Se un giorno i default di `loadConfig` cambiassero, questi test
    // chiamerebbero OpenAI e Anthropic con una chiave assente. Meglio fermarsi.
    throw new Error("I test end-to-end richiedono i provider finti.");
  }

  stt = transcription;
  llm = extraction;
  blob = storage;
});

afterAll(async () => {
  await server.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase();
  stt.reset();
  llm.reset();
});

// ---------------------------------------------------------------------------
// Attrezzi
// ---------------------------------------------------------------------------

let contatore = 0;

async function signup(): Promise<{ token: string; userId: string }> {
  contatore += 1;
  const res = await call(server, "POST", "/api/auth/signup", {
    body: { email: `utente-${String(contatore)}@wikimylife.test`, password: PASSWORD },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const session = authSessionSchema.parse(res.body);
  return { token: session.tokens.accessToken, userId: session.user.id };
}

function metadata(overrides: Partial<CaptureMetadataInput> = {}): CaptureMetadataInput {
  return {
    recordedAt: RECORDED_AT,
    durationMs: 42_000,
    mimeType: "audio/webm;codecs=opus",
    capturedOffline: false,
    deviceLocale: "it-IT",
    latitude: 45.0703,
    longitude: 7.6869,
    placeLabel: "Procura della Repubblica di Torino",
    ...overrides,
  };
}

async function carica(
  token: string,
  init: { metadata?: unknown; audio?: Uint8Array } = {},
): Promise<RecordingState> {
  const res = await uploadRecording(server, {
    accessToken: token,
    metadata: init.metadata ?? metadata(),
    ...(init.audio === undefined ? {} : { audio: init.audio }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return recordingStateSchema.parse(res.body);
}

/** Un giro di worker, in-process. */
async function elabora(): Promise<IngestionOutcome> {
  const outcome = await server.composition.ingestionService.processNext();
  if (outcome === null) {
    throw new Error("La coda e' vuota: nessuna registrazione in BOZZA_AUDIO.");
  }
  return outcome;
}

async function stato(token: string, id: string): Promise<RecordingState> {
  const res = await call(server, "GET", `/api/recordings/${id}`, { accessToken: token });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return recordingStateSchema.parse(res.body);
}

function errorCode(body: unknown): string {
  return errorBodySchema.parse(body).error.code;
}

/** La scheda con tutti i figli, come sta davvero su Postgres. */
async function scheda(procedureId: string) {
  const row = await server.prisma.procedure.findUnique({
    where: { id: procedureId },
    include: {
      steps: { orderBy: { ordine: "asc" } },
      prereqs: true,
      pitfalls: true,
      costs: true,
      refs: true,
      executions: true,
      tags: { include: { tag: true } },
    },
  });
  if (row === null) {
    throw new Error(`Scheda inesistente: ${procedureId}`);
  }
  return row;
}

function procedureIdDi(outcome: IngestionOutcome): string {
  if (outcome.kind !== "ESTRATTO") {
    throw new Error(`Atteso ESTRATTO, ottenuto ${outcome.kind}: ${JSON.stringify(outcome)}`);
  }
  return outcome.procedureId;
}

// ---------------------------------------------------------------------------
// §1 — caricamento
// ---------------------------------------------------------------------------

describe("POST /api/recordings", () => {
  it("risponde 202 con una registrazione in BOZZA_AUDIO", async () => {
    const { token } = await signup();
    const audio = new Uint8Array(1234).fill(7);

    const state = await carica(token, { audio });

    expect(state.status).toBe(RecordingStatus.BOZZA_AUDIO);
    expect(state.procedureId).toBeNull();
    expect(state.transcript).toBeNull();
    expect(state.extraction).toBeNull();
    expect(state.issues).toEqual([]);
    expect(state.retryCount).toBe(0);
    expect(state.lastError).toBeNull();
    expect(state.duplicate).toBeNull();
    // 202 e non 201: la scheda non esiste ancora, e potrebbe non esistere mai.
  });

  it("misura i byte invece di credere al client", async () => {
    const { token } = await signup();
    const audio = new Uint8Array(1234).fill(7);

    const state = await carica(token, { audio });

    // `sizeBytes` non e' fra i metadati di §2 di proposito.
    expect(state.sizeBytes).toBe(1234);
  });

  it("salva i byte prima della riga, e la riga punta a quei byte", async () => {
    const { token, userId } = await signup();
    const audio = new Uint8Array([9, 8, 7, 6, 5]);

    const state = await carica(token, { audio });

    const row = await server.prisma.recording.findUniqueOrThrow({ where: { id: state.id } });
    expect(row.audioUrl.startsWith(`${userId}/`)).toBe(true);
    // L'estensione la vuole Whisper, che sceglie il decoder dal nome.
    expect(row.audioUrl.endsWith(".webm")).toBe(true);
    expect(await blob.exists(row.audioUrl)).toBe(true);
    expect(Array.from(await blob.get(row.audioUrl))).toEqual([9, 8, 7, 6, 5]);
  });

  it("conserva i metadati di cattura della §2", async () => {
    const { token } = await signup();

    const state = await carica(token, {
      metadata: metadata({ capturedOffline: true, deviceLocale: "it-IT" }),
    });

    const row = await server.prisma.recording.findUniqueOrThrow({ where: { id: state.id } });
    expect(row.recordedAt.toISOString()).toBe(RECORDED_AT);
    expect(row.durationMs).toBe(42_000);
    expect(row.mimeType).toBe("audio/webm;codecs=opus");
    expect(row.capturedOffline).toBe(true);
    expect(row.deviceLocale).toBe("it-IT");
    expect(row.latitude).toBeCloseTo(45.0703, 4);
    expect(row.longitude).toBeCloseTo(7.6869, 4);
    expect(row.placeLabel).toBe("Procura della Repubblica di Torino");
  });

  it("accetta i valori assenti della §2 senza inventarli", async () => {
    const { token } = await signup();

    const state = await carica(token, {
      metadata: {
        recordedAt: RECORDED_AT,
        durationMs: 1000,
        mimeType: "audio/mp4",
      },
    });

    const row = await server.prisma.recording.findUniqueOrThrow({ where: { id: state.id } });
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
    expect(row.placeLabel).toBeNull();
    expect(row.deviceLocale).toBeNull();
    expect(row.capturedOffline).toBe(false);
    expect(row.audioUrl.endsWith(".m4a")).toBe(true);
  });

  it("rifiuta chi non ha il token", async () => {
    const res = await uploadRecording(server, { metadata: metadata() });

    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("UNAUTHORIZED");
    expect(await server.prisma.recording.count()).toBe(0);
  });

  it("rifiuta un corpo che non e' multipart", async () => {
    const { token } = await signup();

    const res = await call(server, "POST", "/api/recordings", {
      accessToken: token,
      body: { metadata: metadata() },
    });

    // 415 e non 400: il rimedio non e' correggere un campo, e' cambiare formato.
    expect(res.status).toBe(415);
    expect(errorCode(res.body)).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rifiuta un formato audio che lo stadio 2 non saprebbe leggere", async () => {
    const { token } = await signup();
    const prima = blob.size;

    const res = await uploadRecording(server, {
      accessToken: token,
      metadata: metadata({ mimeType: "audio/aiff" }),
    });

    expect(res.status).toBe(415);
    expect(errorCode(res.body)).toBe("UNSUPPORTED_MEDIA_TYPE");
    // Ne' riga ne' byte: il rifiuto avviene prima dello storage.
    expect(await server.prisma.recording.count()).toBe(0);
    expect(blob.size).toBe(prima);
  });

  it("rifiuta un multipart senza la parte audio", async () => {
    const { token } = await signup();

    const res = await uploadRecording(server, {
      accessToken: token,
      metadata: metadata(),
      omitAudio: true,
    });

    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
    expect(await server.prisma.recording.count()).toBe(0);
  });

  it("rifiuta metadati che non sono JSON", async () => {
    const { token } = await signup();

    const res = await uploadRecording(server, {
      accessToken: token,
      metadata: "{ questo non e' json",
    });

    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
  });

  it("rifiuta metadati con un campo di troppo", async () => {
    const { token } = await signup();

    const res = await uploadRecording(server, {
      accessToken: token,
      // `.strict()`: un campo sconosciuto e' quasi sempre un campo scritto male.
      metadata: { ...metadata(), sizeBytes: 999 },
    });

    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
  });

  it("rifiuta un audio oltre il limite di Whisper", async () => {
    const { token } = await signup();

    const res = await uploadRecording(server, {
      accessToken: token,
      metadata: metadata(),
      audio: new Uint8Array(MAX_AUDIO_BYTES + 1),
    });

    expect(res.status).toBe(413);
    expect(errorCode(res.body)).toBe("PAYLOAD_TOO_LARGE");
    expect(await server.prisma.recording.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// La pipeline intera
// ---------------------------------------------------------------------------

describe("dalla registrazione alla scheda", () => {
  const TRASCRIZIONE =
    "Allora, per il casellario giudiziale sono andato in Procura. Prima ho comprato la marca da bollo.";

  it("porta la registrazione in ESTRATTO con la scheda collegata", async () => {
    const { token } = await signup();
    stt.enqueue(TRASCRIZIONE);
    llm.enqueue(buildExtractionContract());

    const state = await carica(token);
    const outcome = await elabora();

    expect(outcome.kind).toBe("ESTRATTO");
    const dopo = await stato(token, state.id);
    expect(dopo.status).toBe(RecordingStatus.ESTRATTO);
    expect(dopo.procedureId).toBe(procedureIdDi(outcome));
    expect(dopo.lastError).toBeNull();
    expect(dopo.issues).toEqual([]);
  });

  it("scrive la scheda con tutto il contenuto del contratto", async () => {
    const { token, userId } = await signup();
    stt.enqueue(TRASCRIZIONE);
    llm.enqueue(buildExtractionContract());

    await carica(token);
    const p = await scheda(procedureIdDi(await elabora()));

    expect(p.userId).toBe(userId);
    expect(p.titolo).toBe("Richiedere il casellario giudiziale");
    expect(p.esito).toBe("Certificato rilasciato allo sportello");
    expect(p.validitaEsito).toBe("6 mesi");
    expect(p.durataStimataMin).toBe(40);
    expect(p.luogoNome).toBe("Procura della Repubblica di Torino");
    expect(p.luogoDettaglio).toBe("Ufficio casellario, piano terra");
    expect(p.scope).toBe(Scope.PERSONALE);
    expect(p.status).toBe(CardStatus.COMPLETA);
    expect(p.contieneDatiSensibili).toBe(false);

    expect(p.steps.map((s) => [s.ordine, s.azione])).toEqual([
      [1, "Comprare la marca da bollo da 16 euro"],
      [2, "Consegnare il modulo allo sportello"],
    ]);
    expect(p.prereqs.map((x) => x.tipo)).toEqual(["DOCUMENTO"]);
    expect(p.pitfalls.map((x) => x.gravita)).toEqual(["BLOCCANTE"]);
    expect(p.costs.map((x) => x.importoCent)).toEqual([1600]);
    expect(p.refs.map((x) => x.tipo)).toEqual(["UFFICIO"]);
    expect(p.tags.map((t) => t.tag.nome).sort()).toEqual(["burocrazia", "certificati"]);
  });

  it("calcola il costo totale invece di chiederlo al modello", async () => {
    const { token } = await signup();
    stt.enqueue(TRASCRIZIONE);
    llm.enqueue(
      buildExtractionContract({
        costi: [
          { descrizione: "Marca da bollo", importoCent: 1600, valuta: "EUR" },
          { descrizione: "Diritti di segreteria", importoCent: 380, valuta: "EUR" },
        ],
      }),
    );

    await carica(token);
    const p = await scheda(procedureIdDi(await elabora()));

    // Una somma che non torna e' peggio di un campo vuoto.
    expect(p.costoTotaleCent).toBe(1980);
  });

  it("prende la posizione dai metadati di cattura, non dal modello", async () => {
    const { token } = await signup();
    stt.enqueue(TRASCRIZIONE);
    llm.enqueue(buildExtractionContract());

    await carica(token);
    const p = await scheda(procedureIdDi(await elabora()));

    expect(p.latitude).toBeCloseTo(45.0703, 4);
    expect(p.longitude).toBeCloseTo(7.6869, 4);
  });

  it("conta la registrazione stessa come prima esecuzione riuscita", async () => {
    const { token } = await signup();
    stt.enqueue(TRASCRIZIONE);
    llm.enqueue(buildExtractionContract());

    await carica(token);
    const p = await scheda(procedureIdDi(await elabora()));

    // E' il significato di `volteEseguita @default(1)` nella §6: senza questa
    // Execution l'invariante "volteEseguita = count(executions)" nascerebbe
    // gia' rotta, e la §8 non avrebbe da dove far ripartire la freschezza.
    expect(p.volteEseguita).toBe(1);
    expect(p.executions).toHaveLength(1);
    expect(p.executions[0]?.esito).toBe("FUNZIONATO");
    expect(p.executions[0]?.eseguitaIl.toISOString()).toBe(RECORDED_AT);
    expect(p.ultimaVerifica?.toISOString()).toBe(RECORDED_AT);
  });

  it("conserva la trascrizione anche quando l'estrazione riesce", async () => {
    const { token } = await signup();
    stt.enqueue(TRASCRIZIONE);
    llm.enqueue(buildExtractionContract());

    const state = await carica(token);
    await elabora();

    // §3: la trascrizione grezza si conserva sempre. E' l'unico dato che
    // costa una chiamata a un modello e non si puo' ricostruire.
    const dopo = await stato(token, state.id);
    expect(dopo.transcript).toBe(TRASCRIZIONE);
    expect(dopo.transcriptSource).toBe("fake");
  });

  it("conserva l'estrazione integrale, non solo i campi usati", async () => {
    const { token } = await signup();
    const contratto = buildExtractionContract({
      _meta: {
        confidenzaGlobale: 0.77,
        // Nessuna colonna li accoglie: esistono solo dentro `rawExtraction`.
        campiIncerti: ["costi[0].importoCent"],
        domandeSuggerite: ["Quanto costava esattamente la marca da bollo?"],
        contieneDatiSensibili: false,
        tipoRilevato: "PROCEDURA",
      },
    });
    stt.enqueue(TRASCRIZIONE);
    llm.enqueue(contratto);

    const state = await carica(token);
    await elabora();

    const row = await server.prisma.recording.findUniqueOrThrow({ where: { id: state.id } });
    expect(row.rawExtraction).toEqual(contratto);
    expect(row.extractionModel).toBe("fake-extraction-v1 (extraction.v1)");
  });

  it("rinumera i passi che il modello ha numerato male", async () => {
    const { token } = await signup();
    stt.enqueue(TRASCRIZIONE);
    llm.enqueue(
      buildExtractionContract({
        passi: [
          { ordine: 1, azione: "Primo", dettaglio: null, durataStimataMin: null },
          { ordine: 1, azione: "Secondo", dettaglio: null, durataStimataMin: null },
          { ordine: 4, azione: "Terzo", dettaglio: null, durataStimataMin: null },
        ],
      }),
    );

    const state = await carica(token);
    const p = await scheda(procedureIdDi(await elabora()));

    // `@@unique([procedureId, ordine])` avrebbe rifiutato 1, 1, 4: senza la
    // rinumerazione la transazione andrebbe in rollback e il contenuto sarebbe
    // perso per un difetto di forma.
    expect(p.steps.map((s) => [s.ordine, s.azione])).toEqual([
      [1, "Primo"],
      [2, "Secondo"],
      [3, "Terzo"],
    ]);

    // Ma la scheda non e' COMPLETA: il testo si salva, il giudizio resta.
    expect(p.status).toBe(CardStatus.DA_RIVEDERE);
    const dopo = await stato(token, state.id);
    expect(dopo.issues.map((i) => i.rule)).toContain("passi.ordine_non_contiguo");
  });

  it("apre in DA_RIVEDERE quando la §5 ha qualcosa da dire", async () => {
    const { token } = await signup();
    stt.enqueue(TRASCRIZIONE);
    llm.enqueue(
      buildExtractionContract({
        _meta: {
          confidenzaGlobale: 0.3,
          campiIncerti: ["passi"],
          domandeSuggerite: [],
          contieneDatiSensibili: true,
          tipoRilevato: "PROCEDURA",
        },
      }),
    );

    await carica(token);
    const p = await scheda(procedureIdDi(await elabora()));

    expect(p.status).toBe(CardStatus.DA_RIVEDERE);
    expect(p.contieneDatiSensibili).toBe(true);
  });

  it("non fa mai nascere pubblica una scheda di ambito CLIENTE", async () => {
    const { token } = await signup();
    stt.enqueue(TRASCRIZIONE);
    llm.enqueue(buildExtractionContract({ ambitoSuggerito: Scope.CLIENTE }));

    await carica(token);
    const p = await scheda(procedureIdDi(await elabora()));

    expect(p.scope).toBe(Scope.CLIENTE);
    expect(p.visibility).toBe(Visibility.PRIVATA);
  });

  it("riusa il tag esistente invece di crearne un secondo", async () => {
    const { token } = await signup();
    stt.enqueue("prima").enqueue("seconda");
    llm.enqueue(buildExtractionContract({ tag: ["burocrazia"] }));
    llm.enqueue(buildExtractionContract({ titolo: "Rinnovare il passaporto", tag: ["burocrazia"] }));

    await carica(token);
    await elabora();
    await carica(token);
    await elabora();

    // L'upsert e' su `userId_nome`: due schede, un tag, due legami.
    expect(await server.prisma.tag.count()).toBe(1);
    expect(await server.prisma.tagOnProcedure.count()).toBe(2);
  });

  it("fa arrivare il vocabolario dell'utente nel prompt", async () => {
    const { token } = await signup();
    stt.enqueue("prima").enqueue("seconda");
    llm.enqueue(buildExtractionContract({ ambitoSuggerito: Scope.LAVORO }));
    llm.enqueue(buildExtractionContract({ titolo: "Rinnovare il passaporto" }));

    await carica(token);
    await elabora();
    await carica(token);
    await elabora();

    // Regola 8 della §4.2: "riusa gli ambiti e i tag gia' esistenti".
    const context = llm.lastInput?.context;
    expect(context?.existingScopes).toEqual([Scope.LAVORO]);
    expect(context?.existingTags).toEqual(["burocrazia", "certificati"]);
    expect(context?.placeLabel).toBe("Procura della Repubblica di Torino");
    expect(context?.recordedAt).toBe(RECORDED_AT);
  });

  it("scrive l'embedding sulla colonna vector", async () => {
    const { token } = await signup();
    stt.enqueue(TRASCRIZIONE);
    llm.enqueue(buildExtractionContract());

    await carica(token);
    const procedureId = procedureIdDi(await elabora());

    const rows = await server.prisma.$queryRaw<{ dims: number; norma: number }[]>`
      SELECT vector_dims(p."embedding")::int AS "dims",
             (p."embedding" <#> p."embedding") * -1 AS "norma"
      FROM "Procedure" p
      WHERE p."id" = ${procedureId}
    `;

    // 1536 e' accoppiato a `vector(1536)` nella migration: se un giorno il
    // provider cambiasse modello, l'INSERT fallirebbe e questo test lo direbbe.
    expect(rows[0]?.dims).toBe(1536);
    // Prodotto interno di un versore con se stesso: la norma e' 1.
    expect(rows[0]?.norma).toBeCloseTo(1, 5);
  });
});

// ---------------------------------------------------------------------------
// §5 — deduplicazione, su pgvector vero
// ---------------------------------------------------------------------------

describe("deduplicazione", () => {
  /** Stesso titolo, stesso trigger, stessi tag: stesso vettore. */
  function gemella(): ExtractionContract {
    return buildExtractionContract();
  }

  it("non crea una seconda scheda per la stessa procedura", async () => {
    const { token } = await signup();
    stt.enqueue("prima").enqueue("seconda");
    llm.enqueue(gemella()).enqueue(gemella());

    await carica(token);
    const primo = await elabora();
    const secondo = await carica(token);
    const outcome = await elabora();

    expect(outcome.kind).toBe("DUPLICATO");
    expect(await server.prisma.procedure.count()).toBe(1);

    const dopo = await stato(token, secondo.id);
    expect(dopo.status).toBe(RecordingStatus.DUPLICATO_SOSPETTO);
    expect(dopo.procedureId).toBeNull();
    expect(dopo.duplicate?.procedureId).toBe(procedureIdDi(primo));
    expect(dopo.duplicate?.titolo).toBe("Richiedere il casellario giudiziale");
    expect(dopo.duplicate?.similarity).toBeGreaterThan(DEDUP_COSINE_THRESHOLD);
  });

  it("mostra comunque l'estrazione, perche' e' l'utente a decidere", async () => {
    const { token } = await signup();
    stt.enqueue("prima").enqueue("seconda");
    llm.enqueue(gemella()).enqueue(gemella());

    await carica(token);
    await elabora();
    const secondo = await carica(token);
    await elabora();

    // "Restituisci un suggerimento di aggiornamento e lascia decidere
    // all'utente": senza vedere la scheda proposta sarebbe una domanda a
    // scatola chiusa.
    const dopo = await stato(token, secondo.id);
    expect(dopo.extraction?.titolo).toBe("Richiedere il casellario giudiziale");
    expect(dopo.transcript).toBe("seconda");
    expect(dopo.lastError).toBeNull();
  });

  it("non considera duplicata una procedura diversa", async () => {
    const { token } = await signup();
    stt.enqueue("prima").enqueue("seconda");
    llm.enqueue(gemella());
    llm.enqueue(
      buildExtractionContract({
        titolo: "Ripristinare la VPN aziendale dopo il cambio password",
        trigger: "La VPN ha smesso di connettersi dopo la scadenza della password",
        tag: ["vpn", "lavoro"],
      }),
    );

    await carica(token);
    await elabora();
    await carica(token);
    const outcome = await elabora();

    expect(outcome.kind).toBe("ESTRATTO");
    expect(await server.prisma.procedure.count()).toBe(2);
  });

  it("non guarda le procedure di un altro utente", async () => {
    const a = await signup();
    const b = await signup();
    stt.enqueue("prima").enqueue("seconda");
    llm.enqueue(gemella()).enqueue(gemella());

    await carica(a.token);
    await elabora();
    await carica(b.token);
    const outcome = await elabora();

    // La query filtra su `userId`: identiche ma di due persone diverse.
    expect(outcome.kind).toBe("ESTRATTO");
    expect(await server.prisma.procedure.count()).toBe(2);
  });

  it("il retry cancella il suggerimento e rimette in coda", async () => {
    const { token } = await signup();
    stt.enqueue("prima").enqueue("seconda").enqueue("terza");
    llm.enqueue(gemella()).enqueue(gemella()).enqueue(gemella());

    await carica(token);
    await elabora();
    const secondo = await carica(token);
    await elabora();

    const res = await call(server, "POST", `/api/recordings/${secondo.id}/retry`, {
      accessToken: token,
    });

    expect(res.status).toBe(202);
    const rimesso = recordingStateSchema.parse(res.body);
    expect(rimesso.status).toBe(RecordingStatus.BOZZA_AUDIO);
    // Il suggerimento sparisce: e' una domanda gia' posta, non un errore.
    expect(rimesso.duplicate).toBeNull();
    expect(rimesso.retryCount).toBe(1);

    // Ed e' di nuovo elaborabile: la deduplicazione e' deterministica, quindi
    // ricade nello stesso verdetto finche' l'utente non cambia qualcosa.
    expect((await elabora()).kind).toBe("DUPLICATO");
  });
});

// ---------------------------------------------------------------------------
// §1 — "l'audio si salva prima di ogni altra cosa"
// ---------------------------------------------------------------------------

describe("fallimenti", () => {
  it("lo STT che cade lascia la registrazione riprocessabile", async () => {
    const { token } = await signup();
    stt.failNext();

    const state = await carica(token);
    const outcome = await elabora();

    expect(outcome.kind).toBe("FALLITO");
    const dopo = await stato(token, state.id);
    expect(dopo.status).toBe(RecordingStatus.BOZZA_AUDIO);
    expect(dopo.lastError?.code).toBe(IngestionError.trascrizioneFallita);
    expect(dopo.retryCount).toBe(1);
    expect(dopo.procedureId).toBeNull();
    expect(await server.prisma.procedure.count()).toBe(0);

    // Il worker la ripesca da solo al giro successivo, senza che l'utente
    // debba fare niente: e' il senso di "resta riprocessabile".
    stt.enqueue("al secondo tentativo si sente");
    llm.enqueue(buildExtractionContract());
    expect((await elabora()).kind).toBe("ESTRATTO");
    expect((await stato(token, state.id)).status).toBe(RecordingStatus.ESTRATTO);
  });

  it("due estrazioni non conformi fermano la registrazione in ESTRAZIONE_FALLITA", async () => {
    const { token } = await signup();
    stt.enqueue("Un vocale che il modello non sa strutturare.");
    llm.enqueue("non e' nemmeno un oggetto").enqueue({ titolo: "manca tutto il resto" });

    const state = await carica(token);
    const outcome = await elabora();

    expect(outcome.kind).toBe("FALLITO");
    // §5: "un solo retry se il JSON non e' conforme, poi ESTRAZIONE_FALLITA".
    expect(llm.calls).toBe(MAX_EXTRACTION_ATTEMPTS);

    const dopo = await stato(token, state.id);
    expect(dopo.status).toBe(RecordingStatus.ESTRAZIONE_FALLITA);
    expect(dopo.lastError?.code).toBe(IngestionError.contrattoNonConforme);
    expect(dopo.procedureId).toBeNull();
    expect(await server.prisma.procedure.count()).toBe(0);

    // La trascrizione e l'ultima risposta del modello restano: sono gia' state
    // pagate, e sono l'unica prova di cosa aveva risposto.
    expect(dopo.transcript).toBe("Un vocale che il modello non sa strutturare.");
    expect(dopo.extraction).toBeNull();
    expect(dopo.issues.some((i) => i.blocking)).toBe(true);
  });

  it("una ESTRAZIONE_FALLITA non torna in coda da sola", async () => {
    const { token } = await signup();
    stt.enqueue("qualcosa");
    llm.enqueue("storto").enqueue("storto");

    await carica(token);
    await elabora();

    // Altrimenti il worker ripagherebbe due estrazioni a ogni giro di polling,
    // per sempre, senza che nessuno se ne accorga.
    expect(await server.composition.ingestionService.processNext()).toBeNull();
  });

  it("ma /retry la rimette in coda, ed e' poi elaborabile", async () => {
    const { token } = await signup();
    stt.enqueue("qualcosa").enqueue("qualcosa di meglio");
    llm.enqueue("storto").enqueue("storto").enqueue(buildExtractionContract());

    const state = await carica(token);
    await elabora();

    const res = await call(server, "POST", `/api/recordings/${state.id}/retry`, {
      accessToken: token,
    });
    expect(res.status).toBe(202);
    expect(recordingStateSchema.parse(res.body).status).toBe(RecordingStatus.BOZZA_AUDIO);

    expect((await elabora()).kind).toBe("ESTRATTO");
    expect((await stato(token, state.id)).lastError).toBeNull();
  });

  it("non si puo' riprocessare cio' che ha gia' prodotto una scheda", async () => {
    const { token } = await signup();
    stt.enqueue("qualcosa");
    llm.enqueue(buildExtractionContract());

    const state = await carica(token);
    await elabora();

    const res = await call(server, "POST", `/api/recordings/${state.id}/retry`, {
      accessToken: token,
    });

    // Un secondo giro creerebbe una seconda scheda identica.
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe("NOT_FOUND");
    expect(await server.prisma.procedure.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Proprieta': 404 e non 403
// ---------------------------------------------------------------------------

describe("proprieta'", () => {
  it("la registrazione di un altro utente non esiste", async () => {
    const a = await signup();
    const b = await signup();
    const state = await carica(a.token);

    const res = await call(server, "GET", `/api/recordings/${state.id}`, {
      accessToken: b.token,
    });

    // 403 confermerebbe che quell'id e' stato assegnato a qualcuno.
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe("NOT_FOUND");
  });

  it("nemmeno per riprocessarla", async () => {
    const a = await signup();
    const b = await signup();
    const state = await carica(a.token);

    const res = await call(server, "POST", `/api/recordings/${state.id}/retry`, {
      accessToken: b.token,
    });

    expect(res.status).toBe(404);
    const row = await server.prisma.recording.findUniqueOrThrow({ where: { id: state.id } });
    expect(row.retryCount).toBe(0);
  });

  it("un id inesistente e la registrazione altrui danno la stessa risposta", async () => {
    const a = await signup();
    const b = await signup();
    const state = await carica(a.token);

    const altrui = await call(server, "GET", `/api/recordings/${state.id}`, {
      accessToken: b.token,
    });
    const inesistente = await call(server, "GET", "/api/recordings/cixxxxxxxxxxxxxxxxxxxxxxx", {
      accessToken: b.token,
    });

    expect(inesistente.status).toBe(altrui.status);
    expect(errorCode(inesistente.body)).toBe(errorCode(altrui.body));
  });

  it("senza token non si legge niente", async () => {
    const { token } = await signup();
    const state = await carica(token);

    const res = await call(server, "GET", `/api/recordings/${state.id}`);

    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("UNAUTHORIZED");
  });
});
