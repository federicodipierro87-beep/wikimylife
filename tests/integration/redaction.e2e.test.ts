import {
  authSessionSchema,
  procedureDetailSchema,
  redactionReportSchema,
  searchResultSchema,
  type ProcedureDetail,
  type RedactionFinding,
  type RedactionReport,
} from "@wikimylife/shared";
import { buildExtractionContract } from "@wikimylife/shared/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeExtractionProvider,
  FakeRedactionProvider,
} from "../../apps/api/src/providers/fake/index.js";
import { disconnectTestPrisma, resetDatabase } from "./helpers/db.js";
import { call, startTestServer, uploadRecording, type TestServer } from "./helpers/server.js";

/**
 * La meta' assistita della §9, sullo stack vero.
 *
 * Ha un file suo e non un `describe` dentro `procedures.e2e.test.ts` per una
 * ragione di configurazione: il provider di redazione e' spento di default —
 * in produzione come nei test — e accenderlo vuol dire un secondo server con
 * un'altra `AppConfig`. Tenerli insieme avrebbe significato o accenderlo per
 * tutti, e allora ogni GET su `/redazione` di ogni altro test passerebbe da un
 * fake che non c'entra niente, oppure due server nello stesso file che si
 * TRUNCATE il database a vicenda.
 *
 * Cio' che qui si prova e che in `redaction.service.test.ts` non si puo':
 *
 *  1. che `compose()` monti davvero il provider quando la variabile lo dice.
 *     In memoria il servizio riceve il fake da un parametro, e la riga di
 *     composizione — l'unico posto in cui una configurazione diventa un
 *     oggetto — resta non esercitata;
 *  2. che `origine` e `assistenza` sopravvivano al viaggio di andata e ritorno
 *     nel JSON, cioe' che il contratto che il client valida sia lo stesso che
 *     il server produce;
 *  3. che una conferma assistita, i cui id non nascono da nessun rilevatore,
 *     arrivi fino alla `PATCH` e faccia ricalcolare `searchText`: un nome
 *     tolto dalla scheda deve sparire anche dall'indice, e l'indice qui e'
 *     quello vero.
 */

const PASSWORD = "password-di-prova-lunga";

let server: TestServer;
let llm: FakeExtractionProvider;
let redazione: FakeRedactionProvider;

beforeAll(async () => {
  server = await startTestServer({ redactionProvider: "fake" });
  const { extraction, redaction } = server.composition.providers;
  if (!(extraction instanceof FakeExtractionProvider)) {
    throw new Error("I test end-to-end richiedono i provider finti.");
  }
  // L'asserzione che vale il file: se `compose()` non leggesse
  // `REDACTION_PROVIDER`, qui ci sarebbe `undefined` e tutto il resto
  // passerebbe lo stesso, con `assistenza: "NON_CONFIGURATA"` ovunque.
  if (!(redaction instanceof FakeRedactionProvider)) {
    throw new Error("REDACTION_PROVIDER=fake non ha prodotto il provider finto.");
  }
  llm = extraction;
  redazione = redaction;
});

afterAll(async () => {
  await server.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase();
  llm.reset();
  redazione.reset();
});

// ---------------------------------------------------------------------------
// Attrezzi
// ---------------------------------------------------------------------------

let contatore = 0;

async function signup(): Promise<string> {
  contatore += 1;
  const res = await call(server, "POST", "/api/auth/signup", {
    body: { email: `redazione-${String(contatore)}@wikimylife.test`, password: PASSWORD },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return authSessionSchema.parse(res.body).tokens.accessToken;
}

/** Come in `procedures.e2e.test.ts`: la pipeline vera, non un insert a mano. */
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

  const res = await call(server, "GET", `/api/procedures/${outcome.procedureId}`, {
    accessToken: token,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return procedureDetailSchema.parse(res.body);
}

async function proposte(token: string, id: string): Promise<RedactionReport> {
  const res = await call(server, "GET", `/api/procedures/${id}/redazione`, {
    accessToken: token,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return redactionReportSchema.parse(res.body);
}

const NOME: RedactionFinding = {
  campo: "titolo",
  valore: "Mario Rossi",
  kind: "NOME_PERSONA",
};

// ---------------------------------------------------------------------------

describe("GET /redazione con la passata assistita accesa", () => {
  it("propone un nome che nessun rilevatore avrebbe trovato", async () => {
    const token = await signup();
    const creata = await creaScheda(token, { titolo: "Pratica di Mario Rossi" });
    redazione.enqueue([NOME]);

    const report = await proposte(token, creata.id);

    expect(report.assistenza).toBe("ESEGUITA");
    expect(report.proposte).toHaveLength(1);
    expect(report.proposte[0]).toMatchObject({
      kind: "NOME_PERSONA",
      origine: "ASSISTITA",
      campo: "titolo",
      valore: "Mario Rossi",
      sostituzione: "[nome]",
    });
  });

  it("manda al modello i campi della scheda, non la scheda intera", async () => {
    // Il provider riceve testo e percorsi, non la riga del database: niente id,
    // niente proprietario, niente date. E' cio' che rende l'invio a un terzo
    // difendibile — e il fake e' l'unico posto da cui si puo' guardare.
    const token = await signup();
    await creaScheda(token, { titolo: "Pratica di Mario Rossi", esito: "Certificato in mano" });

    const creataAltro = await creaScheda(token, { titolo: "Altra scheda" });
    await proposte(token, creataAltro.id);

    const input = redazione.lastInput;
    expect(input).not.toBeNull();
    expect(input?.campi.map((c) => c.campo)).toContain("titolo");
    expect(JSON.stringify(input)).not.toContain(creataAltro.id);
  });

  it("tiene insieme le proposte certe e quelle assistite", async () => {
    const token = await signup();
    const creata = await creaScheda(token, {
      titolo: "Pratica di Mario Rossi",
      esito: "Scrivere a mario.rossi@example.com",
    });
    redazione.enqueue([NOME]);

    const report = await proposte(token, creata.id);
    const origini = report.proposte.map((p) => p.origine);

    expect(origini).toContain("CERTA");
    expect(origini).toContain("ASSISTITA");
  });

  it("scarta un valore che nella scheda non c'e'", async () => {
    // Un modello che inventa e' il caso normale, non l'eccezione: la §9 non
    // cancella testo che non ha mostrato, e non puo' mostrare cio' che non
    // trova.
    const token = await signup();
    const creata = await creaScheda(token, { titolo: "Pratica di Mario Rossi" });
    redazione.enqueue([{ campo: "titolo", valore: "Luigi Bianchi", kind: "NOME_PERSONA" }]);

    expect((await proposte(token, creata.id)).proposte).toHaveLength(0);
  });

  it("degrada alle sole proposte certe quando il provider non risponde", async () => {
    const token = await signup();
    const creata = await creaScheda(token, {
      titolo: "Pratica di Mario Rossi",
      esito: "Scrivere a mario.rossi@example.com",
    });
    redazione.failNext();

    const report = await proposte(token, creata.id);

    // 200, non 500: gli IBAN e le email sono li' e non hanno bisogno di
    // nessuno per essere trovati.
    expect(report.assistenza).toBe("NON_RIUSCITA");
    expect(report.proposte.map((p) => p.origine)).toEqual(["CERTA"]);
  });
});

describe("POST /redazione con una conferma assistita", () => {
  it("toglie il nome e lo toglie anche dall'indice di ricerca", async () => {
    const token = await signup();
    const creata = await creaScheda(token, { titolo: "Pratica di Mario Rossi" });

    const prima = await call(server, "GET", "/api/search?q=Mario%20Rossi", {
      accessToken: token,
    });
    expect(searchResultSchema.parse(prima.body).items).toHaveLength(1);

    redazione.enqueue([NOME]);
    const report = await proposte(token, creata.id);

    const res = await call(server, "POST", `/api/procedures/${creata.id}/redazione`, {
      accessToken: token,
      body: { conferme: report.proposte.map((p) => p.id) },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(procedureDetailSchema.parse(res.body).titolo).toBe("Pratica di [nome]");

    // La ragione per cui la redazione passa dalla PATCH: `searchText` si
    // ricalcola, e la scheda smette di essere raggiungibile digitando il nome
    // che le e' stato appena tolto.
    const dopo = await call(server, "GET", "/api/search?q=Mario%20Rossi", {
      accessToken: token,
    });
    expect(searchResultSchema.parse(dopo.body).items).toHaveLength(0);
  });

  it("rifiuta con 409 un id che non combacia piu' con il testo", async () => {
    // Gli id assistiti portano un'impronta del valore: e' il modo di verificare
    // una proposta che nessun rilevatore sa ricalcolare. Qui la scheda cambia
    // sotto, e cio' che l'utente ha letto non e' piu' cio' che c'e' scritto.
    const token = await signup();
    const creata = await creaScheda(token, { titolo: "Pratica di Mario Rossi" });

    redazione.enqueue([NOME]);
    const report = await proposte(token, creata.id);

    const patch = await call(server, "PATCH", `/api/procedures/${creata.id}`, {
      accessToken: token,
      body: { titolo: "La pratica di Mario Rossi" },
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);

    const res = await call(server, "POST", `/api/procedures/${creata.id}/redazione`, {
      accessToken: token,
      body: { conferme: report.proposte.map((p) => p.id) },
    });

    expect(res.status).toBe(409);
    expect(procedureDetailSchema.parse((await call(server, "GET", `/api/procedures/${creata.id}`, {
      accessToken: token,
    })).body).titolo).toBe("La pratica di Mario Rossi");
  });

  it("non chiede niente al modello per applicare una conferma", async () => {
    // La POST non ri-esegue la passata: rifarla vorrebbe dire un secondo
    // parere non richiesto su una decisione gia' presa, e proposte che
    // spariscono fra la lettura e la conferma.
    const token = await signup();
    const creata = await creaScheda(token, { titolo: "Pratica di Mario Rossi" });

    redazione.enqueue([NOME]);
    const report = await proposte(token, creata.id);
    const chiamate = redazione.calls;

    await call(server, "POST", `/api/procedures/${creata.id}/redazione`, {
      accessToken: token,
      body: { conferme: report.proposte.map((p) => p.id) },
    });

    expect(redazione.calls).toBe(chiamate);
  });
});

describe("con la passata assistita spenta", () => {
  it("resta la meta' deterministica e il report lo dice", async () => {
    // Il default, cioe' come gira ogni altro file di questa suite e ogni
    // installazione che non ha scelto di accenderla.
    const spento = await startTestServer();
    try {
      expect(spento.composition.providers.redaction).toBeUndefined();

      const res = await call(spento, "POST", "/api/auth/signup", {
        body: { email: "spenta@wikimylife.test", password: PASSWORD },
      });
      const token = authSessionSchema.parse(res.body).tokens.accessToken;

      // Il fake dell'altro server non c'entra niente con questo: `compose()` ne
      // ha costruito uno suo, ed e' quello che le richieste useranno.
      const suoLlm = spento.composition.providers.extraction;
      if (!(suoLlm instanceof FakeExtractionProvider)) {
        throw new Error("Atteso il provider di estrazione finto.");
      }
      suoLlm.enqueue(
        buildExtractionContract({ titolo: "Pratica di Mario Rossi mario.rossi@example.com" }),
      );
      await uploadRecording(spento, {
        accessToken: token,
        metadata: {
          recordedAt: "2026-03-01T09:30:00.000Z",
          durationMs: 42_000,
          mimeType: "audio/webm",
          capturedOffline: false,
          deviceLocale: "it-IT",
        },
      });
      const outcome = await spento.composition.ingestionService.processNext();
      if (outcome === null || outcome.kind !== "ESTRATTO") {
        throw new Error("Attesa una scheda");
      }

      const report = redactionReportSchema.parse(
        (
          await call(spento, "GET", `/api/procedures/${outcome.procedureId}/redazione`, {
            accessToken: token,
          })
        ).body,
      );

      expect(report.assistenza).toBe("NON_CONFIGURATA");
      expect(report.proposte.map((p) => p.origine)).toEqual(["CERTA"]);
    } finally {
      await spento.close();
    }
  });
});
