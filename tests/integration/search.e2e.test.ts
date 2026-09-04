import {
  Scope,
  SearchMatch,
  authSessionSchema,
  errorBodySchema,
  searchResultSchema,
  toVectorLiteral,
  type SearchResult,
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
 * La ricerca della §7 contro gli indici veri.
 *
 * `search.service.test.ts` prova l'orchestrazione con canali finti. Qui si prova
 * l'unica cosa che quei canali non possono provare: che i due canali *trovino*.
 * In particolare che il dizionario italiano faccia stemming — «pagamento» deve
 * trovare «pagare» — perche' e' la ragione per cui la configurazione e'
 * `italian` e non `simple`, e nessun test in memoria se ne accorgerebbe.
 *
 * L'embedding qui e' quello del `FakeEmbeddingProvider`, deterministico ma senza
 * alcun significato semantico: due testi diversi hanno vettori quasi ortogonali,
 * quindi similarita' vicina a zero, quindi sotto `SEARCH_MIN_SIMILARITY`. Il
 * canale semantico tace, ed e' corretto che taccia: senza significato non ha
 * niente da dire. Che la semantica trovi cose *sensate* dipende dal modello, non
 * dal codice, ed e' fuori da cio' che un test puo' dire.
 *
 * Resta pero' da provare che il percorso SQL semantico funzioni — l'indice, il
 * cast del vettore, il pavimento, la fusione. Lo fa un test solo, scrivendo a
 * mano nella colonna un vettore di cui si conosce la distanza.
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
    body: { email: `ricerca-${String(contatore)}@wikimylife.test`, password: PASSWORD },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return authSessionSchema.parse(res.body).tokens.accessToken;
}

async function creaScheda(
  token: string,
  overrides: Parameters<typeof buildExtractionContract>[0] = {},
): Promise<string> {
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
  return outcome.procedureId;
}

async function cerca(token: string, query: string): Promise<SearchResult> {
  const res = await call(server, "GET", `/api/search?${query}`, { accessToken: token });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return searchResultSchema.parse(res.body);
}

function errorCode(body: unknown): string {
  return errorBodySchema.parse(body).error.code;
}

/** Le due schede del seed di sviluppo, in versione minima. */
async function dueSchede(token: string): Promise<{ casellario: string; vpn: string }> {
  const casellario = await creaScheda(token);
  const vpn = await creaScheda(token, {
    titolo: "Ripristinare la VPN aziendale dopo il cambio password",
    trigger: "La VPN smette di connettersi dopo la rotazione delle credenziali",
    esito: "Tunnel VPN attivo sul portatile di lavoro",
    ambitoSuggerito: Scope.LAVORO,
    tag: ["it", "vpn"],
    prerequisiti: [],
    trappole: [],
    costi: [],
    riferimenti: [],
    passi: [
      {
        ordine: 1,
        azione: "Aggiornare la password nel gestore di credenziali",
        dettaglio: null,
        durataStimataMin: 5,
      },
    ],
  });
  return { casellario, vpn };
}

// ---------------------------------------------------------------------------

describe("GET /api/search — accesso e validazione", () => {
  it("richiede l'autenticazione", async () => {
    const res = await call(server, "GET", "/api/search?q=casellario");

    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("UNAUTHORIZED");
  });

  it("rifiuta una query di un solo carattere", async () => {
    const token = await signup();

    const res = await call(server, "GET", "/api/search?q=a", { accessToken: token });

    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
  });

  it("rifiuta la mancanza di q", async () => {
    const token = await signup();

    const res = await call(server, "GET", "/api/search", { accessToken: token });

    expect(res.status).toBe(400);
  });
});

describe("canale full-text", () => {
  it("trova per una parola del titolo", async () => {
    const token = await signup();
    const { casellario } = await dueSchede(token);

    const result = await cerca(token, "q=casellario");

    expect(result.items.map((i) => i.id)).toContain(casellario);
  });

  it("trova per una parola che compare solo in un passo", async () => {
    // La §7 chiede esplicitamente che i passi siano indicizzati: «marca da
    // bollo» sta solo nel primo passo della scheda del casellario.
    const token = await signup();
    const { casellario } = await dueSchede(token);

    const result = await cerca(token, "q=tabaccheria");

    expect(result.items.map((i) => i.id)).toEqual([casellario]);
  });

  it("trova per una parola che compare solo in una trappola", async () => {
    const token = await signup();
    const { casellario } = await dueSchede(token);

    const result = await cerca(token, "q=sportello");

    expect(result.items.map((i) => i.id)).toContain(casellario);
  });

  it("fa stemming italiano: una forma flessa trova la scheda", async () => {
    // E' la ragione per cui la configurazione e' `italian` e non `simple`.
    // «credenziale» al singolare deve trovare «credenziali».
    const token = await signup();
    const { vpn } = await dueSchede(token);

    const result = await cerca(token, "q=credenziale");

    expect(result.items.map((i) => i.id)).toContain(vpn);
  });

  it("non muore su una query con caratteri speciali", async () => {
    // `websearch_to_tsquery` non solleva su input arbitrario; `to_tsquery`
    // morirebbe su una parentesi spaiata. Le query le scrivono le persone.
    const token = await signup();
    await dueSchede(token);

    const res = await call(server, "GET", `/api/search?q=${encodeURIComponent("vpn ( \"or ! &")}`, {
      accessToken: token,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("gestisce le frasi fra virgolette", async () => {
    const token = await signup();
    const { casellario } = await dueSchede(token);

    const trovata = await cerca(token, `q=${encodeURIComponent('"marca da bollo"')}`);
    const assente = await cerca(token, `q=${encodeURIComponent('"bollo da marca"')}`);

    expect(trovata.items.map((i) => i.id)).toContain(casellario);
    expect(assente.items).toHaveLength(0);
  });
});

describe("canale semantico", () => {
  it("trova una scheda vicina nello spazio dei vettori anche senza parole in comune", async () => {
    // Si scrive nella colonna l'embedding *della query*: distanza zero, quindi
    // ben dentro il pavimento. E' l'unico modo di provare il percorso SQL
    // semantico con un provider che non sa cosa significhino le parole.
    const token = await signup();
    const { vpn } = await dueSchede(token);
    const vettore = await server.composition.providers.embedding.embed("criptovalute");
    await server.prisma.$executeRaw`
      UPDATE "Procedure" SET embedding = ${toVectorLiteral(vettore)}::vector WHERE id = ${vpn}
    `;

    const result = await cerca(token, "q=criptovalute");

    expect(result.items.map((i) => i.id)).toEqual([vpn]);
    expect(result.items[0]?.matchedBy).toBe(SearchMatch.SEMANTICA);
  });

  it("tace sulle schede che non c'entrano invece di restituirle in fondo", async () => {
    // Una query ai vicini piu' prossimi non sa dire «nessun risultato»: senza
    // `SEARCH_MIN_SIMILARITY` questa ricerca tornerebbe con entrambe le schede,
    // etichettate SEMANTICA e con un punteggio piccolo ma non nullo.
    const token = await signup();
    await dueSchede(token);

    const result = await cerca(token, "q=criptovalute");

    expect(result.items).toEqual([]);
  });
});

describe("fusione e ordinamento", () => {
  it("etichetta la provenienza di ogni risultato", async () => {
    const token = await signup();
    await dueSchede(token);

    const result = await cerca(token, "q=casellario");

    // Col fake la semantica non partecipa, quindi l'unica etichetta possibile e'
    // TESTO. Il caso ENTRAMBE e' coperto dal test unitario sulla fusione, dove i
    // due canali si possono pilotare.
    expect(result.items[0]?.matchedBy).toBe(SearchMatch.TESTO);
  });

  it("non restituisce mai la stessa scheda due volte", async () => {
    const token = await signup();
    await dueSchede(token);

    const result = await cerca(token, "q=password");

    expect(new Set(result.items.map((i) => i.id)).size).toBe(result.items.length);
  });

  it("rispetta il limite richiesto", async () => {
    const token = await signup();
    await dueSchede(token);

    const result = await cerca(token, "q=casellario&limit=1");

    expect(result.items).toHaveLength(1);
  });

  it("espone punteggio, obsolescenza e riepilogo su ogni risultato", async () => {
    const token = await signup();
    await dueSchede(token);

    const result = await cerca(token, "q=casellario");
    const hit = result.items[0];

    expect(hit?.score).toBeGreaterThan(0);
    expect(hit?.obsoleta).toBe(false);
    expect(hit?.numeroPassi).toBeGreaterThan(0);
    expect(hit?.tag.length).toBeGreaterThan(0);
  });
});

describe("confini", () => {
  it("non mostra le schede di un altro utente", async () => {
    const mio = await signup();
    const altrui = await signup();
    await dueSchede(altrui);

    const result = await cerca(mio, "q=casellario");

    expect(result.items).toEqual([]);
  });

  it("esclude le schede archiviate", async () => {
    // Il cestino non deve tornare a galla da una ricerca: sarebbe la peggiore
    // delle sorprese per un soft delete.
    const token = await signup();
    const { casellario } = await dueSchede(token);
    await call(server, "DELETE", `/api/procedures/${casellario}`, { accessToken: token });

    const result = await cerca(token, "q=casellario");

    expect(result.items.map((i) => i.id)).not.toContain(casellario);
  });

  it("filtra per ambito", async () => {
    const token = await signup();
    const { vpn } = await dueSchede(token);

    const result = await cerca(token, "q=password&scope=LAVORO");

    expect(result.items.every((i) => i.scope === Scope.LAVORO)).toBe(true);
    expect(result.items.map((i) => i.id)).toContain(vpn);
  });

  it("segue le modifiche: una PATCH rende cercabile una parola nuova", async () => {
    // Prova che `searchText` e la colonna generata restano allineati dopo una
    // modifica manuale, non solo dopo l'ingestione.
    const token = await signup();
    const { casellario } = await dueSchede(token);
    expect((await cerca(token, "q=defibrillatore")).items).toEqual([]);

    await call(server, "PATCH", `/api/procedures/${casellario}`, {
      accessToken: token,
      body: { esito: "Certificato ritirato accanto al defibrillatore" },
    });

    expect((await cerca(token, "q=defibrillatore")).items.map((i) => i.id)).toEqual([casellario]);
  });
});
