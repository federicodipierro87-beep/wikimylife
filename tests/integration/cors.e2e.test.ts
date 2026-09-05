import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./helpers/server.js";

/**
 * Il CORS si prova su HTTP vero, non con un finto oggetto request.
 *
 * Le cose che si rompono qui sono cose dello stack: un preflight che
 * attraversa il parser JSON e muore su un corpo vuoto, un `OPTIONS` che finisce
 * nel gestore delle rotte inesistenti e torna 404, un'intestazione impostata
 * dopo che la risposta e' gia' partita. Nessuna si vede chiamando la funzione
 * middleware a mano.
 *
 * Questi test non toccano il database, ma stanno nella suite di integrazione
 * perche' hanno bisogno di un server in ascolto — e `startTestServer` e' quello
 * vero, composto come in produzione.
 */

const AMMESSA = "https://wikimylife.netlify.app";
const ALTRA = "https://sito-di-qualcun-altro.example";

describe("CORS", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({ corsOrigins: `${AMMESSA}, http://localhost:5173` });
  });

  afterAll(async () => {
    await server.close();
  });

  async function preflight(origin: string, path = "/api/auth/login"): Promise<Response> {
    return fetch(`${server.url}${path}`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
  }

  describe("origine ammessa", () => {
    it("il preflight risponde 204 senza corpo", async () => {
      const res = await preflight(AMMESSA);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    });

    it("rimanda l'origine, non un asterisco", async () => {
      // `*` direbbe «chiunque puo' leggermi», e sarebbe falso.
      const res = await preflight(AMMESSA);
      expect(res.headers.get("access-control-allow-origin")).toBe(AMMESSA);
    });

    it("dichiara i metodi e le intestazioni che servono davvero", async () => {
      const res = await preflight(AMMESSA);
      const metodi = res.headers.get("access-control-allow-methods") ?? "";
      expect(metodi).toContain("PATCH");
      expect(metodi).toContain("DELETE");

      const intestazioni = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      expect(intestazioni).toContain("authorization");
      expect(intestazioni).toContain("content-type");
    });

    it("non dichiara le credenziali: i token stanno in Authorization", async () => {
      const res = await preflight(AMMESSA);
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    });

    it("vale anche per la seconda origine della lista", async () => {
      const res = await preflight("http://localhost:5173");
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    });

    it("una richiesta vera porta le intestazioni e passa alle rotte", async () => {
      const res = await fetch(`${server.url}/health`, { headers: { origin: AMMESSA } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(AMMESSA);
      expect(await res.json()).toMatchObject({ status: expect.any(String) });
    });

    it("espone x-request-id, che e' cio' che si cita in una segnalazione", async () => {
      const res = await fetch(`${server.url}/health`, { headers: { origin: AMMESSA } });
      expect(res.headers.get("access-control-expose-headers")).toContain("x-request-id");
      expect(res.headers.get("x-request-id")).not.toBeNull();
    });

    it("anche una risposta d'errore porta le intestazioni CORS", async () => {
      // Senza, il browser mostra «errore di rete» al posto del 401 e il client
      // non puo' distinguere una password sbagliata da un'API spenta.
      const res = await fetch(`${server.url}/api/auth/me`, { headers: { origin: AMMESSA } });
      expect(res.status).toBe(401);
      expect(res.headers.get("access-control-allow-origin")).toBe(AMMESSA);
    });
  });

  describe("origine non ammessa", () => {
    it("il preflight risponde 403, non 404", async () => {
      // Il 404 arriverebbe dal gestore delle rotte inesistenti e manderebbe
      // chi configura il dominio a cercare un errore di routing.
      const res = await preflight(ALTRA);
      expect(res.status).toBe(403);
    });

    it("non concede l'origine", async () => {
      const res = await preflight(ALTRA);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("una richiesta vera passa ma senza intestazioni: la blocca il browser", async () => {
      const res = await fetch(`${server.url}/health`, { headers: { origin: ALTRA } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("l'autenticazione resta l'unica difesa, e regge", async () => {
      const res = await fetch(`${server.url}/api/procedures`, { headers: { origin: ALTRA } });
      expect(res.status).toBe(401);
    });
  });

  describe("Vary", () => {
    it("c'e' anche quando l'origine e' negata", async () => {
      // E' il ramo che nega quello che una cache condivisa riuserebbe per
      // un'origine diversa, con l'intestazione sbagliata attaccata.
      const res = await fetch(`${server.url}/health`, { headers: { origin: ALTRA } });
      expect(res.headers.get("vary")).toContain("Origin");
    });

    it("c'e' anche senza origine", async () => {
      const res = await fetch(`${server.url}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("vary")).toContain("Origin");
    });
  });

  describe("senza origini configurate", () => {
    it("nessuna origine esterna e' ammessa", async () => {
      const chiuso = await startTestServer();
      try {
        const res = await fetch(`${chiuso.url}/health`, { headers: { origin: AMMESSA } });
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      } finally {
        await chiuso.close();
      }
    });

    it("le chiamate senza origine continuano a funzionare", async () => {
      // curl, gli health check dell'host, il worker: nessuno manda Origin.
      const chiuso = await startTestServer();
      try {
        const res = await fetch(`${chiuso.url}/health`);
        expect(res.status).toBe(200);
      } finally {
        await chiuso.close();
      }
    });
  });
});
