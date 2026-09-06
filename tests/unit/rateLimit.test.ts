import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { AppError } from "../../apps/api/src/errors/AppError.js";
import { createRateLimit } from "../../apps/api/src/http/middleware/rateLimit.js";

/**
 * Un limitatore si prova sul tempo, e il tempo qui e' un parametro.
 *
 * Provare che la finestra si riapre aspettando davvero un minuto darebbe un
 * test che nessuno esegue, e quindi nessuna prova. L'orologio iniettato e' il
 * motivo per cui `createRateLimit` accetta un `now`: non e' testabilita'
 * generica, e' questa riga.
 *
 * Il middleware si chiama a mano con oggetti minimi — qui non c'e' niente di
 * HTTP da esercitare, solo aritmetica su una mappa. Il giro vero su HTTP sta in
 * `tests/integration/rateLimit.e2e.test.ts`, dove serve `req.ip`.
 */

interface Chiamata {
  readonly headers: Record<string, string>;
  readonly errore: unknown;
  readonly passata: boolean;
}

/** Il minimo che il middleware legge: ip, metodo, percorso. */
function richiesta(ip: string, path = "/login"): Request {
  return { ip, method: "POST", baseUrl: "/api/auth", path } as unknown as Request;
}

function esegui(
  middleware: ReturnType<typeof createRateLimit>,
  req: Request,
): Chiamata {
  const headers: Record<string, string> = {};
  const res = {
    setHeader(nome: string, valore: string) {
      headers[nome] = valore;
    },
  } as unknown as Response;

  let errore: unknown = undefined;
  let passata = false;
  const next = ((e?: unknown) => {
    if (e === undefined) {
      passata = true;
    } else {
      errore = e;
    }
  }) as NextFunction;

  middleware(req, res, next);
  return { headers, errore, passata };
}

describe("createRateLimit", () => {
  it("lascia passare fino al limite compreso", () => {
    const limite = createRateLimit({ windowMs: 60_000, max: 3, now: () => 0 });
    for (let i = 0; i < 3; i += 1) {
      expect(esegui(limite, richiesta("1.1.1.1")).passata).toBe(true);
    }
  });

  it("il tentativo successivo diventa un 429 con codice RATE_LIMITED", () => {
    const limite = createRateLimit({ windowMs: 60_000, max: 2, now: () => 0 });
    esegui(limite, richiesta("1.1.1.1"));
    esegui(limite, richiesta("1.1.1.1"));

    const terza = esegui(limite, richiesta("1.1.1.1"));
    expect(terza.passata).toBe(false);
    expect(terza.errore).toBeInstanceOf(AppError);
    const errore = terza.errore as AppError;
    expect(errore.status).toBe(429);
    expect(errore.code).toBe("RATE_LIMITED");
  });

  it("il conteggio non finisce nella risposta", () => {
    // Dire «sei al tentativo 47» a chi prova password gli direbbe anche quando
    // ricominciare. Sta nel `context`, che il gestore degli errori logga e non
    // serializza.
    const limite = createRateLimit({ windowMs: 60_000, max: 1, now: () => 0 });
    esegui(limite, richiesta("1.1.1.1"));
    const errore = esegui(limite, richiesta("1.1.1.1")).errore as AppError;

    expect(errore.details).toBeUndefined();
    expect(errore.message).not.toContain("2");
    expect(errore.context).toMatchObject({ count: 2 });
  });

  describe("le chiavi", () => {
    it("due IP hanno due budget", () => {
      const limite = createRateLimit({ windowMs: 60_000, max: 1, now: () => 0 });
      expect(esegui(limite, richiesta("1.1.1.1")).passata).toBe(true);
      expect(esegui(limite, richiesta("2.2.2.2")).passata).toBe(true);
      expect(esegui(limite, richiesta("1.1.1.1")).passata).toBe(false);
    });

    it("due rotte hanno due budget", () => {
      // Il limite di /login non deve consumarsi con i tentativi di /refresh:
      // sono due bersagli diversi.
      const limite = createRateLimit({ windowMs: 60_000, max: 1, now: () => 0 });
      expect(esegui(limite, richiesta("1.1.1.1", "/login")).passata).toBe(true);
      expect(esegui(limite, richiesta("1.1.1.1", "/refresh")).passata).toBe(true);
      expect(esegui(limite, richiesta("1.1.1.1", "/login")).passata).toBe(false);
    });

    it("un IP assente non fa cadere il middleware", () => {
      // `req.ip` e' `string | undefined` nei tipi di Express, e un undefined
      // che diventasse la chiave "undefined" per tutti sarebbe comunque meglio
      // di un TypeError dentro l'autenticazione.
      const limite = createRateLimit({ windowMs: 60_000, max: 1, now: () => 0 });
      const senzaIp = { method: "POST", baseUrl: "/api/auth", path: "/login" } as Request;
      expect(esegui(limite, senzaIp).passata).toBe(true);
      expect(esegui(limite, senzaIp).passata).toBe(false);
    });
  });

  describe("la finestra", () => {
    it("si riapre quando scade", () => {
      let adesso = 0;
      const limite = createRateLimit({ windowMs: 60_000, max: 1, now: () => adesso });

      expect(esegui(limite, richiesta("1.1.1.1")).passata).toBe(true);
      expect(esegui(limite, richiesta("1.1.1.1")).passata).toBe(false);

      adesso = 60_000;
      expect(esegui(limite, richiesta("1.1.1.1")).passata).toBe(true);
    });

    it("non si riapre un millisecondo prima", () => {
      let adesso = 0;
      const limite = createRateLimit({ windowMs: 60_000, max: 1, now: () => adesso });
      esegui(limite, richiesta("1.1.1.1"));

      adesso = 59_999;
      expect(esegui(limite, richiesta("1.1.1.1")).passata).toBe(false);
    });

    it("non scorre: il tempo passato dentro la finestra non regala tentativi", () => {
      // E' una finestra fissa, non un token bucket. Il difetto noto e' il
      // raddoppio al confine fra due finestre, e qui non conta: la differenza
      // che serve e' fra venti tentativi al minuto e diecimila.
      let adesso = 0;
      const limite = createRateLimit({ windowMs: 60_000, max: 2, now: () => adesso });
      esegui(limite, richiesta("1.1.1.1"));
      adesso = 59_000;
      esegui(limite, richiesta("1.1.1.1"));
      expect(esegui(limite, richiesta("1.1.1.1")).passata).toBe(false);
    });
  });

  describe("le intestazioni", () => {
    it("ci sono anche quando la richiesta passa", () => {
      // Un client che vede il limite avvicinarsi puo' rallentare da solo.
      const limite = createRateLimit({ windowMs: 60_000, max: 3, now: () => 0 });
      const prima = esegui(limite, richiesta("1.1.1.1"));

      expect(prima.headers["RateLimit-Limit"]).toBe("3");
      expect(prima.headers["RateLimit-Remaining"]).toBe("2");
      expect(prima.headers["RateLimit-Reset"]).toBe("60");
    });

    it("il residuo non scende sotto zero", () => {
      const limite = createRateLimit({ windowMs: 60_000, max: 1, now: () => 0 });
      esegui(limite, richiesta("1.1.1.1"));
      esegui(limite, richiesta("1.1.1.1"));
      const terza = esegui(limite, richiesta("1.1.1.1"));
      expect(terza.headers["RateLimit-Remaining"]).toBe("0");
    });

    it("Retry-After compare solo negando, ed e' il tempo che manca davvero", () => {
      // Senza, la PWA riproverebbe subito peggiorando le cose.
      let adesso = 0;
      const limite = createRateLimit({ windowMs: 60_000, max: 1, now: () => adesso });
      const prima = esegui(limite, richiesta("1.1.1.1"));
      expect(prima.headers["Retry-After"]).toBeUndefined();

      adesso = 30_000;
      const seconda = esegui(limite, richiesta("1.1.1.1"));
      expect(seconda.headers["Retry-After"]).toBe("30");
    });
  });

  it("non accumula chiavi all'infinito", () => {
    // Una voce per ogni IP che abbia mai chiamato e' una perdita di memoria
    // lenta: si manifesta dopo settimane come un processo riavviato dall'host,
    // e a quel punto nessuno la collega al limitatore.
    let adesso = 0;
    const limite = createRateLimit({ windowMs: 1_000, max: 1, now: () => adesso });

    for (let i = 0; i < 600; i += 1) {
      esegui(limite, richiesta(`10.0.0.${String(i)}`));
      adesso += 10;
    }

    // Le finestre dei primi IP sono scadute da un pezzo: se fossero ancora
    // tutte in memoria, riprovare dal primo verrebbe negato.
    expect(esegui(limite, richiesta("10.0.0.0")).passata).toBe(true);
  });
});
