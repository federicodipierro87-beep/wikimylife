import {
  CardStatus,
  Outcome,
  Scope,
  Severity,
  Visibility,
  authSessionSchema,
  errorBodySchema,
  procedureDetailSchema,
  procedureListSchema,
  redactionReportSchema,
  searchResultSchema,
  type ProcedureDetail,
} from "@wikimylife/shared";
import { buildExtractionContract } from "@wikimylife/shared/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeExtractionProvider,
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

beforeAll(async () => {
  server = await startTestServer();
  const { transcription, extraction } = server.composition.providers;
  if (
    !(transcription instanceof FakeTranscriptionProvider) ||
    !(extraction instanceof FakeExtractionProvider)
  ) {
    throw new Error("I test end-to-end richiedono i provider finti.");
  }
  stt = transcription;
  llm = extraction;
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
