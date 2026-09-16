import {
  CardStatus,
  EMPTY_TRASH_BATCH_SIZE,
  Outcome,
  RecordingStatus,
  Scope,
  Severity,
  Visibility,
  authSessionSchema,
  emptyTrashResultSchema,
  errorBodySchema,
  procedureDetailSchema,
  procedureListSchema,
  recordingStateSchema,
  redactionReportSchema,
  searchResultSchema,
  type ProcedureDetail,
} from "@wikimylife/shared";
import { buildExtractionContract } from "@wikimylife/shared/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeExtractionProvider,
  FakeStorageProvider,
  FakeTranscriptionProvider,
} from "../../apps/api/src/providers/fake/index.js";
import { disconnectTestPrisma, resetDatabase } from "./helpers/db.js";
import { call, startTestServer, uploadRecording, type TestServer } from "./helpers/server.js";

/**
 * Le rotte di lettura e modifica su Postgres vero.
 *
 * `procedures.service.test.ts` prova gia' le stesse regole in memoria e in
 * millisecondi. Qui si prova cio' che un repository in memoria non puo':
 *
 *  1. che la `PATCH` sugli array figli sia davvero una sostituzione integrale
 *     dentro una transazione, e che la rinumerazione dei passi non violi
 *     `@@unique([procedureId, ordine])`;
 *  2. che `costoTotaleCent` sia ricalcolato dal database e non creduto sulla
 *     parola del client;
 *  3. che `volteEseguita` cresca con un `increment` SQL — l'unico modo di non
 *     perdere un'esecuzione registrata nel frattempo da un altro dispositivo;
 *  4. che dopo una redazione (§9) la scheda sparisca davvero dai risultati di
 *     ricerca per il dato che le e' stato tolto. Qui c'e' l'indice vero: in
 *     memoria si puo' solo guardare la stringa che il servizio ha calcolato.
 */

const PASSWORD = "password-di-prova-lunga";

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

async function signup(): Promise<string> {
  contatore += 1;
  const res = await call(server, "POST", "/api/auth/signup", {
    body: { email: `scheda-${String(contatore)}@wikimylife.test`, password: PASSWORD },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return authSessionSchema.parse(res.body).tokens.accessToken;
}

/**
 * Una scheda creata dalla pipeline vera.
 *
 * Inserirla con `prisma.procedure.create` sarebbe piu' corto, ma scriverebbe a
 * mano `searchText` e l'embedding: il test passerebbe anche il giorno in cui
 * l'ingestione smettesse di popolarli.
 */
async function creaScheda(
  token: string,
  overrides: Parameters<typeof buildExtractionContract>[0] = {},
): Promise<ProcedureDetail> {
  llm.enqueue(buildExtractionContract(overrides));
  const upload = await uploadRecording(server, {
    accessToken: token,
    metadata: {
      recordedAt: "2026-03-01T09:30:00.000Z",
      durationMs: 42_000,
      mimeType: "audio/webm",
      capturedOffline: false,
      deviceLocale: "it-IT",
    },
  });
  expect(upload.status, JSON.stringify(upload.body)).toBe(202);

  const outcome = await server.composition.ingestionService.processNext();
  if (outcome === null || outcome.kind !== "ESTRATTO") {
    throw new Error(`Attesa una scheda, ottenuto ${JSON.stringify(outcome)}`);
  }

  return leggi(token, outcome.procedureId);
}

async function leggi(token: string, id: string): Promise<ProcedureDetail> {
  const res = await call(server, "GET", `/api/procedures/${id}`, { accessToken: token });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return procedureDetailSchema.parse(res.body);
}

function errorCode(body: unknown): string {
  return errorBodySchema.parse(body).error.code;
}

// ---------------------------------------------------------------------------
// GET /api/procedures
// ---------------------------------------------------------------------------

describe("GET /api/procedures", () => {
  it("richiede l'autenticazione", async () => {
    const res = await call(server, "GET", "/api/procedures");

    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("UNAUTHORIZED");
  });

  it("restituisce le schede dell'utente con il totale", async () => {
    const token = await signup();
    await creaScheda(token, { titolo: "Prima scheda" });
    await creaScheda(token, { titolo: "Seconda scheda" });

    const res = await call(server, "GET", "/api/procedures", { accessToken: token });

    expect(res.status).toBe(200);
    const page = procedureListSchema.parse(res.body);
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.limit).toBe(20);
  });

  it("non mostra le schede di un altro utente", async () => {
    const mio = await signup();
    const altrui = await signup();
    await creaScheda(altrui, { titolo: "Scheda di un altro" });

    const res = await call(server, "GET", "/api/procedures", { accessToken: mio });

    expect(procedureListSchema.parse(res.body).total).toBe(0);
  });

  it("filtra per ambito e per tag", async () => {
    const token = await signup();
    await creaScheda(token, {
      titolo: "Ripristinare la VPN aziendale",
      ambitoSuggerito: Scope.LAVORO,
      tag: ["it", "vpn"],
    });
    await creaScheda(token, { titolo: "Richiedere il casellario", tag: ["burocrazia"] });

    const perAmbito = await call(server, "GET", "/api/procedures?scope=LAVORO", {
      accessToken: token,
    });
    const perTag = await call(server, "GET", "/api/procedures?tag=burocrazia", {
      accessToken: token,
    });

    expect(procedureListSchema.parse(perAmbito.body).items.map((i) => i.titolo)).toEqual([
      "Ripristinare la VPN aziendale",
    ]);
    expect(procedureListSchema.parse(perTag.body).items.map((i) => i.titolo)).toEqual([
      "Richiedere il casellario",
    ]);
  });

  it("pagina, e il totale resta quello dei filtri", async () => {
    const token = await signup();
    for (let i = 0; i < 3; i += 1) {
      await creaScheda(token, { titolo: `Scheda ${String(i + 1)}` });
    }

    const res = await call(server, "GET", "/api/procedures?limit=2&offset=2", {
      accessToken: token,
    });

    const page = procedureListSchema.parse(res.body);
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
    expect(page.offset).toBe(2);
  });

  it("rifiuta un parametro sconosciuto invece di ignorarlo", async () => {
    // `?limti=5` deve dare 400: silenziosamente venti risultati sarebbe un bug
    // che il client non ha modo di vedere.
    const token = await signup();

    const res = await call(server, "GET", "/api/procedures?limti=5", { accessToken: token });

    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
  });

  it("rifiuta un limite oltre il massimo", async () => {
    const token = await signup();

    const res = await call(server, "GET", "/api/procedures?limit=5000", { accessToken: token });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/procedures/:id
// ---------------------------------------------------------------------------

describe("GET /api/procedures/:id", () => {
  it("restituisce la scheda con tutte le relazioni", async () => {
    const token = await signup();
    const creata = await creaScheda(token);

    expect(creata.steps).toHaveLength(2);
    expect(creata.prereqs).toHaveLength(1);
    expect(creata.pitfalls).toHaveLength(1);
    expect(creata.costs).toHaveLength(1);
    expect(creata.refs).toHaveLength(1);
    expect(creata.recordings).toHaveLength(1);
    expect(creata.tag).toEqual(expect.arrayContaining(["burocrazia", "certificati"]));
  });

  it("risponde 404, non 403, sulla scheda di un altro", async () => {
    const mio = await signup();
    const altrui = await signup();
    const sua = await creaScheda(altrui);

    const res = await call(server, "GET", `/api/procedures/${sua.id}`, { accessToken: mio });

    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe("NOT_FOUND");
  });

  it("risponde 404 su un id inesistente", async () => {
    const token = await signup();

    const res = await call(server, "GET", "/api/procedures/inesistente", { accessToken: token });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/procedures/:id
// ---------------------------------------------------------------------------

describe("PATCH /api/procedures/:id", () => {
  it("modifica i campi scalari e lascia il resto com'era", async () => {
    const token = await signup();
    const creata = await creaScheda(token);

    const res = await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: { titolo: "Titolo corretto a mano", status: CardStatus.COMPLETA },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const aggiornata = procedureDetailSchema.parse(res.body);
    expect(aggiornata.titolo).toBe("Titolo corretto a mano");
    expect(aggiornata.status).toBe(CardStatus.COMPLETA);
    expect(aggiornata.steps).toHaveLength(2);
  });

  it("sostituisce i passi per intero e li rinumera contigui", async () => {
    // Il server rinumera perche' `@@unique([procedureId, ordine])` esiste: un
    // client che manda 1, 5, 9 non deve poter creare buchi ne' collisioni.
    const token = await signup();
    const creata = await creaScheda(token);

    const res = await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: {
        steps: [
          { azione: "Nuovo primo passo", dettaglio: null, durataStimataMin: null },
          { azione: "Nuovo secondo passo", dettaglio: "con dettaglio", durataStimataMin: 5 },
          { azione: "Nuovo terzo passo", dettaglio: null, durataStimataMin: null },
        ],
      },
    });

    const aggiornata = procedureDetailSchema.parse(res.body);
    expect(aggiornata.steps.map((s) => s.ordine)).toEqual([1, 2, 3]);
    expect(aggiornata.steps.map((s) => s.azione)).toEqual([
      "Nuovo primo passo",
      "Nuovo secondo passo",
      "Nuovo terzo passo",
    ]);
    expect(aggiornata.numeroPassi).toBe(3);
  });

  it("svuota un array figlio quando arriva vuoto", async () => {
    const token = await signup();
    const creata = await creaScheda(token);

    const res = await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: { pitfalls: [] },
    });

    expect(procedureDetailSchema.parse(res.body).pitfalls).toEqual([]);
  });

  it("ricalcola costoTotaleCent dalla somma dei costi", async () => {
    // Non e' un campo modificabile: e' una somma. Accettarlo dal client
    // significherebbe permettere a una scheda di mentire su se stessa.
    const token = await signup();
    const creata = await creaScheda(token);

    const res = await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: {
        costs: [
          { descrizione: "Marca da bollo", importoCent: 1600, valuta: "EUR" },
          { descrizione: "Diritti di segreteria", importoCent: 380, valuta: "EUR" },
        ],
      },
    });

    expect(procedureDetailSchema.parse(res.body).costoTotaleCent).toBe(1980);
  });

  it("aggiorna il testo indicizzabile insieme alla scheda", async () => {
    const token = await signup();
    const creata = await creaScheda(token);

    await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: {
        pitfalls: [{ descrizione: "Il parcheggio interno e' riservato", gravita: Severity.NOTA }],
      },
    });

    const [row] = await server.prisma.$queryRaw<{ searchText: string }[]>`
      SELECT "searchText" FROM "Procedure" WHERE "id" = ${creata.id}`;
    expect(row?.searchText).toContain("parcheggio interno");
  });

  it("rifiuta un corpo vuoto", async () => {
    const token = await signup();
    const creata = await creaScheda(token);

    const res = await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: {},
    });

    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
  });

  it("rifiuta un campo derivato", async () => {
    // `volteEseguita` si conta, non si dichiara.
    const token = await signup();
    const creata = await creaScheda(token);

    const res = await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: { volteEseguita: 99 },
    });

    expect(res.status).toBe(400);
  });

  it("vieta di pubblicare una scheda di ambito CLIENTE", async () => {
    const token = await signup();
    const creata = await creaScheda(token);
    await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: { scope: Scope.CLIENTE, clientLabel: "Studio Rossi" },
    });

    const res = await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: { visibility: Visibility.PUBBLICA },
    });

    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe("CONFLICT");
    expect((await leggi(token, creata.id)).visibility).toBe(Visibility.PRIVATA);
  });

  it("vieta di pubblicare una scheda con dati sensibili", async () => {
    const token = await signup();
    const creata = await creaScheda(token, {
      _meta: {
        ...buildExtractionContract()._meta,
        contieneDatiSensibili: true,
      },
    });
    expect(creata.contieneDatiSensibili).toBe(true);

    const res = await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: { visibility: Visibility.PUBBLICA },
    });

    expect(res.status).toBe(409);
  });

  it("una patch con la categoria ripetuta non fa cadere il salvataggio", async () => {
    // Il difetto vero e' qui e non in memoria: due nomi uguali si risolvono
    // nello stesso `Tag`, e la seconda riga di `TagOnProcedure` viola
    // `@@id([procedureId, tagId])`. Senza dedup questa chiamata risponde 500.
    const token = await signup();
    const creata = await creaScheda(token);

    const res = await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: { tag: ["casa", "casa"] },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("e la scheda risponde con quella categoria una volta sola", async () => {
    const token = await signup();
    const creata = await creaScheda(token);

    await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: { tag: ["casa", "casa", "ufficio"] },
    });

    // Non solo «non e' caduta»: il legame scritto e' uno, e le altre categorie
    // mandate nella stessa patch sono arrivate tutte.
    expect((await leggi(token, creata.id)).tag).toEqual(["casa", "ufficio"]);
    expect(
      await server.prisma.tagOnProcedure.count({ where: { procedureId: creata.id } }),
    ).toBe(2);
  });

  it("non lascia modificare la scheda di un altro", async () => {
    const mio = await signup();
    const altrui = await signup();
    const sua = await creaScheda(altrui, { titolo: "Sua" });

    const res = await call(server, "PATCH", `/api/procedures/${sua.id}`, {
      accessToken: mio,
      body: { titolo: "Mia" },
    });

    expect(res.status).toBe(404);
    expect((await leggi(altrui, sua.id)).titolo).toBe("Sua");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/procedures/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/procedures/:id", () => {
  it("archivia invece di cancellare, e la riga resta", async () => {
    const token = await signup();
    const creata = await creaScheda(token);

    const res = await call(server, "DELETE", `/api/procedures/${creata.id}`, {
      accessToken: token,
    });

    expect(res.status).toBe(200);
    expect(procedureDetailSchema.parse(res.body).status).toBe(CardStatus.ARCHIVIATA);
    expect(await server.prisma.procedure.count({ where: { id: creata.id } })).toBe(1);
  });

  it("la fa sparire dalla lista, ma la lascia nel cestino", async () => {
    const token = await signup();
    const creata = await creaScheda(token);
    await call(server, "DELETE", `/api/procedures/${creata.id}`, { accessToken: token });

    const lista = await call(server, "GET", "/api/procedures", { accessToken: token });
    const cestino = await call(server, "GET", "/api/procedures?status=ARCHIVIATA", {
      accessToken: token,
    });

    expect(procedureListSchema.parse(lista.body).total).toBe(0);
    expect(procedureListSchema.parse(cestino.body).items.map((i) => i.id)).toEqual([creata.id]);
  });

  it("e' idempotente", async () => {
    const token = await signup();
    const creata = await creaScheda(token);

    await call(server, "DELETE", `/api/procedures/${creata.id}`, { accessToken: token });
    const secondo = await call(server, "DELETE", `/api/procedures/${creata.id}`, {
      accessToken: token,
    });

    expect(secondo.status).toBe(200);
  });

  it("non lascia archiviare la scheda di un altro", async () => {
    const mio = await signup();
    const altrui = await signup();
    const sua = await creaScheda(altrui);

    const res = await call(server, "DELETE", `/api/procedures/${sua.id}`, { accessToken: mio });

    expect(res.status).toBe(404);
    expect((await leggi(altrui, sua.id)).status).not.toBe(CardStatus.ARCHIVIATA);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/procedures/:id?definitivo=1
// ---------------------------------------------------------------------------

/**
 * Il secondo giro, quello che non si annulla.
 *
 * `procedures.service.test.ts` prova gia' le tre risposte — 204, 409, 404 — con
 * un repository in memoria. Quello che non puo' provare e' l'unica cosa che qui
 * fa danno: cosa resta nel database dopo. La cancellazione vera si appoggia a
 * due comportamenti che stanno nello schema e non nel codice, e che in memoria
 * non esistono affatto. I figli della scheda spariscono per `onDelete: Cascade`,
 * cioe' per una riga di `schema.prisma` che nessuna funzione TypeScript nomina.
 * I due `Recording.procedureId` e `Recording.duplicateOfId` invece sono
 * `SET NULL`: la riga resta, e resta con un buco.
 *
 * E' quel buco il motivo di questa sezione. Un vocale a cui e' stato azzerato
 * `procedureId` non e' un vocale libero — e' un `ESTRATTO` che nessuna
 * schermata mostra piu', perche' `listPending` filtra proprio gli `ESTRATTO` e
 * la scheda da cui lo si apriva non c'e'. Contiene la trascrizione, cioe' le
 * frasi dette, e nessun gesto dell'app puo' piu' raggiungerlo. Cancellare una
 * scheda «per sempre» e lasciarsi dietro quella riga sarebbe il contrario
 * esatto di cio' che il pulsante promette.
 */
describe("DELETE /api/procedures/:id?definitivo=1", () => {
  /** La scheda nel cestino, che e' l'unico posto da cui si cancella. */
  async function creaEArchivia(token: string): Promise<ProcedureDetail> {
    const creata = await creaScheda(token);
    const res = await call(server, "DELETE", `/api/procedures/${creata.id}`, {
      accessToken: token,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return creata;
  }

  async function cancella(token: string, id: string): Promise<{ status: number; body: unknown }> {
    return call(server, "DELETE", `/api/procedures/${id}?definitivo=1`, { accessToken: token });
  }

  it("cancella la riga, e con lei tutto quello che le stava appeso", async () => {
    const token = await signup();
    const creata = await creaEArchivia(token);
    // I passi ci sono per costruzione — l'estrazione ne produce sempre — ma
    // contarli prima serve a distinguere «cancellati» da «non ce n'erano».
    expect(await server.prisma.step.count({ where: { procedureId: creata.id } })).toBeGreaterThan(0);

    const res = await cancella(token, creata.id);

    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(res.body).toBeNull();
    expect(await server.prisma.procedure.count({ where: { id: creata.id } })).toBe(0);
    // Nessun `deleteMany` sui figli sta nel repository: se il `Cascade` sparisse
    // dallo schema, la `delete` fallirebbe con un errore di vincolo e questa
    // riga non ci arriverebbe nemmeno.
    expect(await server.prisma.step.count({ where: { procedureId: creata.id } })).toBe(0);
  });

  it("si porta via i vocali da cui la scheda e' nata, e i loro byte", async () => {
    const token = await signup();
    const creata = await creaEArchivia(token);

    const vocale = await server.prisma.recording.findFirstOrThrow({
      where: { procedureId: creata.id },
      select: { id: true, audioUrl: true, transcript: true },
    });
    // La trascrizione non e' un rifacimento di cio' che e' stato detto: e' cio'
    // che e' stato detto. E' la ragione per cui il vocale non puo' restare.
    expect(vocale.transcript).not.toBeNull();
    expect(blob.keys).toContain(vocale.audioUrl);

    await cancella(token, creata.id);

    // `SET NULL` lascerebbe qui una riga con `procedureId: null` e stato
    // `ESTRATTO`: invisibile a `listPending`, che filtra proprio quello stato, e
    // orfana della sola schermata che la mostrava.
    expect(await server.prisma.recording.count({ where: { id: vocale.id } })).toBe(0);
    expect(blob.keys).not.toContain(vocale.audioUrl);
  });

  it("non tocca i vocali di un'altra scheda, ne' il loro audio", async () => {
    const token = await signup();
    const daTenere = await creaScheda(token, { titolo: "Disdire la palestra" });
    const daButtare = await creaEArchivia(token);

    const salvo = await server.prisma.recording.findFirstOrThrow({
      where: { procedureId: daTenere.id },
      select: { id: true, audioUrl: true },
    });

    await cancella(token, daButtare.id);

    // Un `deleteMany` con il `procedureId` dimenticato nella `where` — o con lo
    // `userId` al posto suo — porterebbe via anche questo, e la scheda rimasta
    // resterebbe li' senza piu' l'audio da cui e' nata.
    expect(await server.prisma.recording.count({ where: { id: salvo.id } })).toBe(1);
    expect(blob.keys).toContain(salvo.audioUrl);
    expect(await server.prisma.procedure.count({ where: { id: daTenere.id } })).toBe(1);
  });

  it("rimette in coda il sospetto duplicato, invece di lasciarlo appeso al nulla", async () => {
    const token = await signup();
    const prima = await creaScheda(token);

    // Stesso contratto, stesso vettore: l'ingestione lo riconosce come doppione
    // e lo lascia in attesa di una decisione dell'utente.
    llm.enqueue(buildExtractionContract());
    const upload = await uploadRecording(server, {
      accessToken: token,
      metadata: {
        recordedAt: "2026-03-02T09:30:00.000Z",
        durationMs: 42_000,
        mimeType: "audio/webm",
        capturedOffline: false,
        deviceLocale: "it-IT",
      },
    });
    expect(upload.status, JSON.stringify(upload.body)).toBe(202);
    const sospetto = recordingStateSchema.parse(upload.body).id;
    expect((await server.composition.ingestionService.processNext())?.kind).toBe("DUPLICATO");

    await call(server, "DELETE", `/api/procedures/${prima.id}`, { accessToken: token });
    await cancella(token, prima.id);

    const dopo = await server.prisma.recording.findUniqueOrThrow({
      where: { id: sospetto },
      select: { status: true, duplicateOfId: true, duplicateSimilarity: true },
    });
    // Non e' un vocale della scheda: e' un vocale che le somigliava. Cancellarlo
    // insieme a lei butterebbe via un racconto che nessuno ha mai deciso di
    // buttare. Ma lasciarlo `DUPLICATO_SOSPETTO` con `duplicateOfId` azzerato
    // dal `SET NULL` sarebbe peggio: l'avviso a schermo non avrebbe piu' niente
    // da nominare, e il pulsante «tienilo comunque» punterebbe a una scheda che
    // non c'e'. Torna in coda, che e' dov'era prima di somigliare a qualcosa.
    expect(dopo.status).toBe(RecordingStatus.BOZZA_AUDIO);
    expect(dopo.duplicateOfId).toBeNull();
    expect(dopo.duplicateSimilarity).toBeNull();
  });

  it("rifiuta con 409 una scheda che non e' nel cestino, e non la sfiora", async () => {
    const token = await signup();
    const viva = await creaScheda(token);

    const res = await cancella(token, viva.id);

    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe("CONFLICT");
    // I due passaggi non sono una cerimonia: sono cio' che rende impossibile
    // perdere una scheda in uso con una sola chiamata sbagliata.
    expect(await server.prisma.procedure.count({ where: { id: viva.id } })).toBe(1);
    expect(await server.prisma.recording.count({ where: { procedureId: viva.id } })).toBe(1);
  });

  it("non e' idempotente: la seconda volta e' un 404", async () => {
    const token = await signup();
    const creata = await creaEArchivia(token);

    expect((await cancella(token, creata.id)).status).toBe(204);
    const secondo = await cancella(token, creata.id);

    // Al contrario dell'archiviazione, che ripetuta risponde 200. Qui un «fatto»
    // nasconderebbe l'unico caso in cui quel 404 conta: due schermate aperte
    // sulla stessa scheda, e chi preme la seconda volta che crede di aver
    // cancellato quella che ha davanti.
    expect(secondo.status).toBe(404);
    expect(errorCode(secondo.body)).toBe("NOT_FOUND");
  });

  it("non lascia cancellare la scheda archiviata di un altro", async () => {
    const mio = await signup();
    const altrui = await signup();
    const sua = await creaEArchivia(altrui);

    const res = await cancella(mio, sua.id);

    // 404 e non 403: rispondere «non tuo» direbbe a chi tira a indovinare che
    // quell'id esiste.
    expect(res.status).toBe(404);
    expect(await server.prisma.procedure.count({ where: { id: sua.id } })).toBe(1);
  });

  it("senza la query archivia, che e' cio' che questa rotta ha sempre fatto", async () => {
    const token = await signup();
    const creata = await creaScheda(token);

    const res = await call(server, "DELETE", `/api/procedures/${creata.id}?definitivo=0`, {
      accessToken: token,
    });

    // `definitivo=0` esplicito e non solo l'assenza: e' l'altra meta' dello
    // schema, ed e' quella che un `z.coerce.boolean()` leggerebbe come «si'».
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await server.prisma.procedure.count({ where: { id: creata.id } })).toBe(1);
  });

  it("un valore che non e' ne' 1 ne' 0 e' un 400, e non una cancellazione", async () => {
    const token = await signup();
    const creata = await creaEArchivia(token);

    const res = await call(server, "DELETE", `/api/procedures/${creata.id}?definitivo=vero`, {
      accessToken: token,
    });

    // Nessuna interpretazione generosa. Su questa rotta la generosita' costa
    // piu' che altrove, perche' dall'altra parte non c'e' un cestino da cui
    // ripescare.
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
    expect(await server.prisma.procedure.count({ where: { id: creata.id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/procedures?status=ARCHIVIATA&definitivo=1
// ---------------------------------------------------------------------------

/**
 * Lo stesso gesto sull'intero cestino.
 *
 * `procedures.service.test.ts` prova gia' in memoria le due cose che decide il
 * servizio: quali schede finiscono nell'elenco, e che una ripescata nel
 * frattempo si conti invece di interrompere. Qui si prova quello che in memoria
 * non esiste.
 *
 * Il primo e' la `where` vera. `listArchivedIds` e' l'unica difesa di questa
 * rotta — non arriva nessun id da rifiutare — e uno `userId` dimenticato non
 * darebbe un errore: darebbe il cestino di un estraneo vuoto, e nessun test
 * dell'altro file lo vedrebbe, perche' il repository in memoria filtra con la
 * stessa riga di codice che si vorrebbe controllare.
 *
 * Il secondo e' cosa resta appeso. Una scheda per volta significa passare N
 * volte da `deleteForUser`, cioe' N cascate e N `SET NULL`: se una di quelle
 * andasse storta a meta' elenco, il conto tornerebbe lo stesso e resterebbero
 * dietro righe di `Recording` con la trascrizione dentro.
 *
 * Il terzo sono i due parametri obbligatori. In memoria non passano nemmeno da
 * uno schema: e' qui che si vede se `?status=COMPLETA&definitivo=1` e' un 400 o
 * un archivio cancellato.
 */
describe("DELETE /api/procedures?status=ARCHIVIATA&definitivo=1", () => {
  const SVUOTA = "/api/procedures?status=ARCHIVIATA&definitivo=1";

  async function archivia(token: string, id: string): Promise<void> {
    const res = await call(server, "DELETE", `/api/procedures/${id}`, { accessToken: token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  /** Il corpo della risposta, che qui e' l'unica cosa che dice com'e' andata. */
  function esito(body: unknown): { cancellate: number; saltate: number; rimaste: number } {
    return emptyTrashResultSchema.parse(body);
  }

  it("richiede l'autenticazione", async () => {
    const res = await call(server, "DELETE", SVUOTA);

    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("UNAUTHORIZED");
  });

  it("porta via il cestino e lascia in piedi le schede in uso", async () => {
    const token = await signup();
    const buttata = await creaScheda(token, { titolo: "Disdire la palestra" });
    const viva = await creaScheda(token, { titolo: "Richiedere il casellario" });
    await archivia(token, buttata.id);

    const res = await call(server, "DELETE", SVUOTA, { accessToken: token });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(esito(res.body)).toEqual({ cancellate: 1, saltate: 0, rimaste: 0 });
    expect(await server.prisma.procedure.count({ where: { id: buttata.id } })).toBe(0);
    expect(await server.prisma.procedure.count({ where: { id: viva.id } })).toBe(1);
  });

  it("non tocca il cestino di un altro utente", async () => {
    const mio = await signup();
    const altrui = await signup();
    const sua = await creaScheda(altrui, { titolo: "Scheda di un altro" });
    await archivia(altrui, sua.id);
    const mia = await creaScheda(mio, { titolo: "Scheda mia" });
    await archivia(mio, mia.id);

    const res = await call(server, "DELETE", SVUOTA, { accessToken: mio });

    // Uno solo, e non due. E' la sola rotta dell'app in cui una `where`
    // incompleta cancella l'archivio di uno sconosciuto senza nemmeno un id
    // sbagliato da cui accorgersene.
    expect(esito(res.body)).toEqual({ cancellate: 1, saltate: 0, rimaste: 0 });
    expect(await server.prisma.procedure.count({ where: { id: sua.id } })).toBe(1);
    expect(await server.prisma.procedure.count({ where: { id: mia.id } })).toBe(0);
  });

  it("si porta via i figli e i vocali di ognuna, e i loro byte", async () => {
    const token = await signup();
    const prima = await creaScheda(token, { titolo: "Prima da buttare" });
    const seconda = await creaScheda(token, { titolo: "Seconda da buttare" });
    await archivia(token, prima.id);
    await archivia(token, seconda.id);
    const vocali = await server.prisma.recording.findMany({
      where: { procedureId: { in: [prima.id, seconda.id] } },
      select: { id: true, audioUrl: true },
    });
    expect(vocali).toHaveLength(2);

    const res = await call(server, "DELETE", SVUOTA, { accessToken: token });

    expect(esito(res.body)).toEqual({ cancellate: 2, saltate: 0, rimaste: 0 });
    // La seconda scheda e' quella che conta: un ciclo che si fermasse dopo la
    // prima restituirebbe comunque due, perche' il conto lo tiene il servizio e
    // non il database.
    expect(
      await server.prisma.step.count({ where: { procedureId: { in: [prima.id, seconda.id] } } }),
    ).toBe(0);
    for (const vocale of vocali) {
      expect(await server.prisma.recording.count({ where: { id: vocale.id } })).toBe(0);
      expect(blob.keys).not.toContain(vocale.audioUrl);
    }
  });

  it("un cestino vuoto risponde zero, e non un errore", async () => {
    const token = await signup();
    await creaScheda(token);

    const res = await call(server, "DELETE", SVUOTA, { accessToken: token });

    // 200 con un corpo e non 204: e' l'unica risposta che permette a chi ha
    // premuto di distinguere «non c'era niente» da «e' andato tutto via».
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(esito(res.body)).toEqual({ cancellate: 0, saltate: 0, rimaste: 0 });
  });

  it("si ferma al tetto per richiesta, e la seconda chiamata finisce il lavoro", async () => {
    const token = await signup();
    const prima = await creaScheda(token, { titolo: "La prima del mucchio" });
    await archivia(token, prima.id);
    const { userId } = await server.prisma.procedure.findUniqueOrThrow({
      where: { id: prima.id },
      select: { userId: true },
    });

    // Le altre cinquantacinque entrano con una `createMany` invece che dalla
    // pipeline. La regola di questo file — passare sempre dall'ingestione, per
    // non scrivere a mano `searchText` e l'embedding — vale per i casi che
    // leggono il contenuto di una scheda. Qui l'unica cosa che conta e' quante
    // righe ci sono nel cestino, e cinquantacinque giri di trascrizione finta
    // costerebbero minuti per provare un `take`.
    await server.prisma.procedure.createMany({
      data: Array.from({ length: EMPTY_TRASH_BATCH_SIZE + 5 }, (_, i) => ({
        userId,
        titolo: `Riempitivo ${String(i)}`,
        status: CardStatus.ARCHIVIATA,
      })),
    });

    const primaPassata = await call(server, "DELETE", SVUOTA, { accessToken: token });

    // Il tetto e' la ragione per cui questa rotta non si inchioda su un cestino
    // grosso: una scheda per volta significa una transazione e un giro di
    // bucket a testa, e cinquantasei di fila superano il timeout di un proxy
    // prima di arrivare in fondo. Il numero non e' arrotondato qui a mano: se
    // `EMPTY_TRASH_BATCH_SIZE` cambia, questo caso lo segue.
    expect(esito(primaPassata.body)).toEqual({
      cancellate: EMPTY_TRASH_BATCH_SIZE,
      saltate: 0,
      rimaste: 6,
    });
    expect(await server.prisma.procedure.count({ where: { userId } })).toBe(6);

    const seconda = await call(server, "DELETE", SVUOTA, { accessToken: token });

    // La seconda passata e' la meta' che il `take` da solo non garantisce: se
    // `listArchivedIds` prendesse le righe da un ordine instabile, o dalla coda
    // invece che dalla testa, potrebbe ripresentare le stesse cinquanta e il
    // cestino non si accorcerebbe mai.
    expect(esito(seconda.body)).toEqual({ cancellate: 6, saltate: 0, rimaste: 0 });
    expect(await server.prisma.procedure.count({ where: { userId } })).toBe(0);
  });

  it("«status=COMPLETA» e' un 400, e non uno svuotamento dell'archivio", async () => {
    const token = await signup();
    const viva = await creaScheda(token);
    const buttata = await creaScheda(token, { titolo: "Nel cestino" });
    await archivia(token, buttata.id);

    const res = await call(server, "DELETE", "/api/procedures?status=COMPLETA&definitivo=1", {
      accessToken: token,
    });

    // E' la richiesta che non deve esistere, ed e' a un carattere di distanza da
    // quella buona. Un `status` che accettasse l'enum intero la renderebbe
    // esprimibile, e a rifiutarla resterebbe solo il servizio.
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
    expect(await server.prisma.procedure.count({ where: { id: viva.id } })).toBe(1);
    expect(await server.prisma.procedure.count({ where: { id: buttata.id } })).toBe(1);
  });

  it("«definitivo=0» non e' una mezza misura: e' un 400", async () => {
    const token = await signup();
    const buttata = await creaScheda(token);
    await archivia(token, buttata.id);

    const res = await call(server, "DELETE", "/api/procedures?status=ARCHIVIATA&definitivo=0", {
      accessToken: token,
    });

    // Sulla voce singola `definitivo=0` archivia, e ha senso: c'e' una scheda
    // da mettere via. Qui non c'e' niente da archiviare — sono gia' tutte nel
    // cestino — e un `z.string()` al posto del letterale trasformerebbe questa
    // richiesta, che vuole dire tutto tranne «cancella», in uno svuotamento.
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
    expect(await server.prisma.procedure.count({ where: { id: buttata.id } })).toBe(1);
  });

  it("senza parametri non cancella niente: e' un 400", async () => {
    const token = await signup();
    const buttata = await creaScheda(token);
    await archivia(token, buttata.id);

    const res = await call(server, "DELETE", "/api/procedures", { accessToken: token });

    // `DELETE` sulla collezione e' il percorso in cui si finisce per sbaglio —
    // un id che vale stringa vuota nel client, e la barra finale sparisce. I due
    // parametri obbligatori sono li' perche' quello sbaglio non diventi un
    // archivio cancellato.
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
    expect(await server.prisma.procedure.count({ where: { id: buttata.id } })).toBe(1);
  });

  it("un id vuoto sulla rotta della voce singola non diventa uno svuotamento", async () => {
    const token = await signup();
    const buttata = await creaScheda(token);
    await archivia(token, buttata.id);

    const res = await call(server, "DELETE", "/api/procedures/?definitivo=1", {
      accessToken: token,
    });

    // Express fa combaciare `/api/procedures/` con la collezione, non con
    // `/:id`: e' esattamente il caso in cui una `DELETE` scritta per una scheda
    // sola arriva dove si cancella tutto. A fermarla e' `status` che manca.
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
    expect(await server.prisma.procedure.count({ where: { id: buttata.id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/procedures/:id/executions — §8
// ---------------------------------------------------------------------------

describe("POST /api/procedures/:id/executions", () => {
  it("CAMBIATA riporta la scheda in DA_RIVEDERE", async () => {
    const token = await signup();
    const creata = await creaScheda(token);
    await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: { status: CardStatus.COMPLETA },
    });

    const res = await call(server, "POST", `/api/procedures/${creata.id}/executions`, {
      accessToken: token,
      body: { esito: Outcome.CAMBIATA, nota: "Ora il modulo e' online" },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(procedureDetailSchema.parse(res.body).status).toBe(CardStatus.DA_RIVEDERE);
  });

  it("FUNZIONATO aggiorna ultimaVerifica e incrementa volteEseguita", async () => {
    const token = await signup();
    const creata = await creaScheda(token);
    const prima = creata.volteEseguita;

    const res = await call(server, "POST", `/api/procedures/${creata.id}/executions`, {
      accessToken: token,
      body: { esito: Outcome.FUNZIONATO, nota: null },
    });

    const aggiornata = procedureDetailSchema.parse(res.body);
    expect(aggiornata.volteEseguita).toBe(prima + 1);
    expect(aggiornata.ultimaVerifica).not.toBeNull();
    // Le asserzioni sono relative, non assolute: la scheda non nasce vergine.
    // L'ingestione della Fase 2 le mette accanto una `Execution(FUNZIONATO)`
    // datata `recordedAt`, perche' raccontare una procedura al telefono
    // significa averla appena eseguita. Scrivere `toHaveLength(1)` qui
    // fallirebbe, ed e' giusto che fallisca.
    expect(aggiornata.executions).toHaveLength(creata.executions.length + 1);
  });

  it("l'invariante volteEseguita = 1 + numero di esecuzioni regge su piu' giri", async () => {
    // Le esecuzioni si contano in SQL con un `increment`: leggerle in
    // JavaScript e riscriverle perderebbe cio' che un altro dispositivo ha
    // registrato nel frattempo.
    const token = await signup();
    const creata = await creaScheda(token);

    for (let i = 0; i < 3; i += 1) {
      await call(server, "POST", `/api/procedures/${creata.id}/executions`, {
        accessToken: token,
        body: { esito: Outcome.FUNZIONATO, nota: null },
      });
    }

    const finale = await leggi(token, creata.id);
    expect(finale.executions).toHaveLength(creata.executions.length + 3);
    expect(finale.volteEseguita).toBe(creata.volteEseguita + 3);
    // L'invariante vera: il contatore e le righe restano allineati comunque si
    // sia arrivati fin qui, ingestione compresa.
    expect(finale.volteEseguita).toBe(finale.executions.length);
  });

  it("FALLITA non aggiorna ultimaVerifica ne' lo stato", async () => {
    const token = await signup();
    const creata = await creaScheda(token);

    const res = await call(server, "POST", `/api/procedures/${creata.id}/executions`, {
      accessToken: token,
      body: { esito: Outcome.FALLITA, nota: "Ufficio chiuso" },
    });

    const aggiornata = procedureDetailSchema.parse(res.body);
    // «Non aggiorna» e non «e' nulla»: la scheda porta gia' la verifica lasciata
    // dall'ingestione, e un tentativo fallito non deve ne' spostarla in avanti
    // ne' cancellarla — l'ultima volta che la procedura ha funzionato resta
    // l'ultima volta che ha funzionato.
    expect(aggiornata.ultimaVerifica).toBe(creata.ultimaVerifica);
    expect(aggiornata.status).toBe(creata.status);
  });

  it("rifiuta un'esecuzione su una scheda archiviata", async () => {
    const token = await signup();
    const creata = await creaScheda(token);
    await call(server, "DELETE", `/api/procedures/${creata.id}`, { accessToken: token });

    const res = await call(server, "POST", `/api/procedures/${creata.id}/executions`, {
      accessToken: token,
      body: { esito: Outcome.FUNZIONATO, nota: null },
    });

    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe("CONFLICT");
  });

  it("rifiuta un esito che non esiste", async () => {
    const token = await signup();
    const creata = await creaScheda(token);

    const res = await call(server, "POST", `/api/procedures/${creata.id}/executions`, {
      accessToken: token,
      body: { esito: "QUASI", nota: null },
    });

    expect(res.status).toBe(400);
  });

  it("non lascia registrare esecuzioni sulla scheda di un altro", async () => {
    const mio = await signup();
    const altrui = await signup();
    const sua = await creaScheda(altrui);

    const res = await call(server, "POST", `/api/procedures/${sua.id}/executions`, {
      accessToken: mio,
      body: { esito: Outcome.FUNZIONATO, nota: null },
    });

    expect(res.status).toBe(404);
    // Il 404 dev'essere davvero un rifiuto, non un errore emesso dopo la
    // scrittura: la scheda altrui deve avere le stesse esecuzioni di prima.
    expect((await leggi(altrui, sua.id)).executions).toHaveLength(sua.executions.length);
  });
});

// ---------------------------------------------------------------------------
// Obsolescenza
// ---------------------------------------------------------------------------

describe("flag di obsolescenza", () => {
  it("segnala una scheda verificata piu' di un anno fa", async () => {
    // Si scrive `ultimaVerifica` nel passato direttamente: non c'e' modo di far
    // passare un anno dentro un test, e la soglia va provata su dati veri.
    const token = await signup();
    const creata = await creaScheda(token);
    await server.prisma.procedure.update({
      where: { id: creata.id },
      data: { ultimaVerifica: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
    });

    expect((await leggi(token, creata.id)).obsoleta).toBe(true);
  });

  it("non segnala una scheda verificata ieri", async () => {
    const token = await signup();
    const creata = await creaScheda(token);
    await server.prisma.procedure.update({
      where: { id: creata.id },
      data: { ultimaVerifica: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    expect((await leggi(token, creata.id)).obsoleta).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Redazione (§9)
// ---------------------------------------------------------------------------

/**
 * L'esempio pubblico dell'Agenzia delle Entrate. Ha il carattere di controllo
 * giusto — quindi passa il checksum e non viene scartato — e non e' di nessuno.
 */
const CF = "MRTMTT25D09F205Z";

describe("redazione", () => {
  it("richiede l'autenticazione da entrambi i lati", async () => {
    const proposta = await call(server, "GET", "/api/procedures/qualsiasi/redazione");
    const applicazione = await call(server, "POST", "/api/procedures/qualsiasi/redazione", {
      body: { conferme: ["titolo:0:EMAIL"] },
    });

    expect(proposta.status).toBe(401);
    expect(applicazione.status).toBe(401);
  });

  it("propone i dati che trova, senza toccare la scheda", async () => {
    const token = await signup();
    const creata = await creaScheda(token, {
      titolo: `Rinnovare la tessera di ${CF}`,
      riferimenti: [{ tipo: "PERSONA", valore: "Scrivere a mario.rossi@example.com" }],
    });

    const res = await call(server, "GET", `/api/procedures/${creata.id}/redazione`, {
      accessToken: token,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const report = redactionReportSchema.parse(res.body);
    expect(report.procedureId).toBe(creata.id);
    expect(report.proposte.map((p) => p.kind).sort()).toEqual(["CODICE_FISCALE", "EMAIL"]);
    expect((await leggi(token, creata.id)).titolo).toBe(`Rinnovare la tessera di ${CF}`);
  });

  it("applica solo le proposte confermate", async () => {
    const token = await signup();
    const creata = await creaScheda(token, {
      titolo: `Rinnovare la tessera di ${CF}`,
      riferimenti: [{ tipo: "PERSONA", valore: "Scrivere a mario.rossi@example.com" }],
    });

    const proposte = redactionReportSchema.parse(
      (await call(server, "GET", `/api/procedures/${creata.id}/redazione`, { accessToken: token }))
        .body,
    ).proposte;
    const soloEmail = proposte.filter((p) => p.kind === "EMAIL").map((p) => p.id);

    const res = await call(server, "POST", `/api/procedures/${creata.id}/redazione`, {
      accessToken: token,
      body: { conferme: soloEmail },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const scheda = procedureDetailSchema.parse(res.body);
    expect(scheda.refs[0]?.valore).toBe("Scrivere a [email]");
    // Il codice fiscale non era fra le conferme: resta.
    expect(scheda.titolo).toBe(`Rinnovare la tessera di ${CF}`);
  });

  it("toglie la scheda dai risultati della ricerca per il dato redatto", async () => {
    // La ragione per cui la redazione passa dalla PATCH e non scrive dritta sul
    // database. Qui c'e' l'indice vero: se `searchText` non fosse ricalcolato,
    // la scheda resterebbe raggiungibile digitando il codice fiscale che le e'
    // stato appena tolto, e nessun test in memoria potrebbe accorgersene.
    const token = await signup();
    const creata = await creaScheda(token, { titolo: `Pratica intestata a ${CF}` });

    const prima = await call(server, "GET", `/api/search?q=${CF}`, { accessToken: token });
    expect(searchResultSchema.parse(prima.body).items).toHaveLength(1);

    const proposte = redactionReportSchema.parse(
      (await call(server, "GET", `/api/procedures/${creata.id}/redazione`, { accessToken: token }))
        .body,
    ).proposte;
    await call(server, "POST", `/api/procedures/${creata.id}/redazione`, {
      accessToken: token,
      body: { conferme: proposte.map((p) => p.id) },
    });

    const dopo = await call(server, "GET", `/api/search?q=${CF}`, { accessToken: token });
    expect(searchResultSchema.parse(dopo.body).items).toHaveLength(0);
  });

  it("rifiuta con 409 una conferma che non corrisponde piu' a niente", async () => {
    const token = await signup();
    const creata = await creaScheda(token, { titolo: `Pratica di ${CF}` });

    const res = await call(server, "POST", `/api/procedures/${creata.id}/redazione`, {
      accessToken: token,
      body: { conferme: ["titolo:999:IBAN"] },
    });

    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe("CONFLICT");
    expect((await leggi(token, creata.id)).titolo).toBe(`Pratica di ${CF}`);
  });

  it("rifiuta un corpo con del testo dentro", async () => {
    // Lo schema e' `.strict()`: accettare testo qui renderebbe questa rotta una
    // PATCH travestita da redazione.
    const token = await signup();
    const creata = await creaScheda(token, { titolo: `Pratica di ${CF}` });

    const res = await call(server, "POST", `/api/procedures/${creata.id}/redazione`, {
      accessToken: token,
      body: { conferme: ["titolo:11:CODICE_FISCALE"], titolo: "Quello che voglio io" },
    });

    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
  });

  it("non lascia leggere ne' redigere la scheda di un altro", async () => {
    const mio = await signup();
    const altrui = await signup();
    const sua = await creaScheda(altrui, { titolo: `Pratica di ${CF}` });

    const lettura = await call(server, "GET", `/api/procedures/${sua.id}/redazione`, {
      accessToken: mio,
    });
    const scrittura = await call(server, "POST", `/api/procedures/${sua.id}/redazione`, {
      accessToken: mio,
      body: { conferme: ["titolo:11:CODICE_FISCALE"] },
    });

    expect(lettura.status).toBe(404);
    expect(scrittura.status).toBe(404);
    expect((await leggi(altrui, sua.id)).titolo).toBe(`Pratica di ${CF}`);
  });

  it("non toglie il flag: la revisione esplicita resta di una persona", async () => {
    const token = await signup();
    const creata = await creaScheda(token, {
      titolo: `Pratica di ${CF}`,
      _meta: {
        confidenzaGlobale: 0.8,
        campiIncerti: [],
        domandeSuggerite: [],
        contieneDatiSensibili: true,
        tipoRilevato: "PROCEDURA",
      },
    });
    expect(creata.contieneDatiSensibili).toBe(true);

    const proposte = redactionReportSchema.parse(
      (await call(server, "GET", `/api/procedures/${creata.id}/redazione`, { accessToken: token }))
        .body,
    ).proposte;
    const redatta = procedureDetailSchema.parse(
      (
        await call(server, "POST", `/api/procedures/${creata.id}/redazione`, {
          accessToken: token,
          body: { conferme: proposte.map((p) => p.id) },
        })
      ).body,
    );

    expect(redatta.contieneDatiSensibili).toBe(true);

    // E finche' il flag c'e', la §9 continua a bloccare la pubblicazione.
    const pubblica = await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: { visibility: Visibility.PUBBLICA },
    });
    expect(pubblica.status).toBe(409);
  });
});
