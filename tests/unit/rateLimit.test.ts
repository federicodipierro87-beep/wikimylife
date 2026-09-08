import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { AppError } from "../../apps/api/src/errors/AppError.js";
import { createRateLimit } from "../../apps/api/src/http/middleware/rateLimit.js";
import type { RateLimitStore } from "../../apps/api/src/services/ports/RateLimitStore.js";
import {
  BrokenRateLimitStore,
  InMemoryRateLimitStore,
} from "../support/InMemoryRateLimitStore.js";
import { contrattoRateLimitStore } from "../support/rateLimitStoreContract.js";

/**
 * Un limitatore si prova sul tempo, e il tempo qui e' un parametro.
 *
 * Provare che la finestra si riapre aspettando davvero un minuto darebbe un
 * test che nessuno esegue, e quindi nessuna prova. L'orologio iniettato e' il
 * motivo per cui `createRateLimit` accetta un `now`: non e' testabilita'
 * generica, e' questa riga.
 *
 * Il middleware si chiama a mano con oggetti minimi — qui non c'e' niente di
 * HTTP da esercitare, solo la composizione della chiave, le intestazioni e il
 * ramo del 429. Il giro vero su HTTP sta in
 * `tests/integration/security.e2e.test.ts`, dove serve `req.ip` vero dietro
 * Express.
 *
 * Il deposito e' quello in memoria, che in produzione non si usa piu': le
 * regole che deve rispettare per essere intercambiabile con Postgres non stanno
 * qui ma in `rateLimitStoreContract.ts`, e in fondo a questo file si vede che
 * le rispetta. Le stesse girano contro il database vero
 * in `tests/integration/rateLimitStore.test.ts`.
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

async function esegui(
  middleware: ReturnType<typeof createRateLimit>,
  req: Request,
): Promise<Chiamata> {
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

  await middleware(req, res, next);
  return { headers, errore, passata };
}

/** Il limitatore col suo deposito nuovo, che e' come lo vuole ogni test. */
function creaLimite(options: {
  windowMs: number;
  max: number;
  now?: () => number;
  store?: RateLimitStore;
  onErrore?: (error: unknown) => void;
}): ReturnType<typeof createRateLimit> {
  return createRateLimit({
    windowMs: options.windowMs,
    max: options.max,
    now: options.now ?? ((): number => 0),
    store: options.store ?? new InMemoryRateLimitStore(),
    ...(options.onErrore === undefined ? {} : { onErrore: options.onErrore }),
  });
}

describe("createRateLimit", () => {
  it("lascia passare fino al limite compreso", async () => {
    const limite = creaLimite({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect((await esegui(limite, richiesta("1.1.1.1"))).passata).toBe(true);
    }
  });

  it("il tentativo successivo diventa un 429 con codice RATE_LIMITED", async () => {
    const limite = creaLimite({ windowMs: 60_000, max: 2 });
    await esegui(limite, richiesta("1.1.1.1"));
    await esegui(limite, richiesta("1.1.1.1"));

    const terza = await esegui(limite, richiesta("1.1.1.1"));
    expect(terza.passata).toBe(false);
    expect(terza.errore).toBeInstanceOf(AppError);
    const errore = terza.errore as AppError;
    expect(errore.status).toBe(429);
    expect(errore.code).toBe("RATE_LIMITED");
  });

  it("il conteggio non finisce nella risposta", async () => {
    // Dire «sei al tentativo 47» a chi prova password gli direbbe anche quando
    // ricominciare. Sta nel `context`, che il gestore degli errori logga e non
    // serializza.
    const limite = creaLimite({ windowMs: 60_000, max: 1 });
    await esegui(limite, richiesta("1.1.1.1"));
    const errore = (await esegui(limite, richiesta("1.1.1.1"))).errore as AppError;

    expect(errore.details).toBeUndefined();
    expect(errore.message).not.toContain("2");
    expect(errore.context).toMatchObject({ count: 2 });
  });

  describe("le chiavi", () => {
    it("due IP hanno due budget", async () => {
      const limite = creaLimite({ windowMs: 60_000, max: 1 });
      expect((await esegui(limite, richiesta("1.1.1.1"))).passata).toBe(true);
      expect((await esegui(limite, richiesta("2.2.2.2"))).passata).toBe(true);
      expect((await esegui(limite, richiesta("1.1.1.1"))).passata).toBe(false);
    });

    it("due rotte hanno due budget", async () => {
      // Il limite di /login non deve consumarsi con i tentativi di /refresh:
      // sono due bersagli diversi.
      const limite = creaLimite({ windowMs: 60_000, max: 1 });
      expect((await esegui(limite, richiesta("1.1.1.1", "/login"))).passata).toBe(true);
      expect((await esegui(limite, richiesta("1.1.1.1", "/refresh"))).passata).toBe(true);
      expect((await esegui(limite, richiesta("1.1.1.1", "/login"))).passata).toBe(false);
    });

    it("un IP assente non fa cadere il middleware", async () => {
      // `req.ip` e' `string | undefined` nei tipi di Express, e un undefined
      // che diventasse la chiave "undefined" per tutti sarebbe comunque meglio
      // di un TypeError dentro l'autenticazione.
      const limite = creaLimite({ windowMs: 60_000, max: 1 });
      const senzaIp = { method: "POST", baseUrl: "/api/auth", path: "/login" } as Request;
      expect((await esegui(limite, senzaIp)).passata).toBe(true);
      expect((await esegui(limite, senzaIp)).passata).toBe(false);
    });
  });

  describe("la finestra", () => {
    it("si riapre quando scade", async () => {
      let adesso = 0;
      const limite = creaLimite({ windowMs: 60_000, max: 1, now: () => adesso });

      expect((await esegui(limite, richiesta("1.1.1.1"))).passata).toBe(true);
      expect((await esegui(limite, richiesta("1.1.1.1"))).passata).toBe(false);

      adesso = 60_000;
      expect((await esegui(limite, richiesta("1.1.1.1"))).passata).toBe(true);
    });

    it("non si riapre un millisecondo prima", async () => {
      let adesso = 0;
      const limite = creaLimite({ windowMs: 60_000, max: 1, now: () => adesso });
      await esegui(limite, richiesta("1.1.1.1"));

      adesso = 59_999;
      expect((await esegui(limite, richiesta("1.1.1.1"))).passata).toBe(false);
    });

    it("non scorre: il tempo passato dentro la finestra non regala tentativi", async () => {
      // E' una finestra fissa, non un token bucket. Il difetto noto e' il
      // raddoppio al confine fra due finestre, e qui non conta: la differenza
      // che serve e' fra venti tentativi al minuto e diecimila.
      let adesso = 0;
      const limite = creaLimite({ windowMs: 60_000, max: 2, now: () => adesso });
      await esegui(limite, richiesta("1.1.1.1"));
      adesso = 59_000;
      await esegui(limite, richiesta("1.1.1.1"));
      expect((await esegui(limite, richiesta("1.1.1.1"))).passata).toBe(false);
    });
  });

  describe("le intestazioni", () => {
    it("ci sono anche quando la richiesta passa", async () => {
      // Un client che vede il limite avvicinarsi puo' rallentare da solo.
      const limite = creaLimite({ windowMs: 60_000, max: 3 });
      const prima = await esegui(limite, richiesta("1.1.1.1"));

      expect(prima.headers["RateLimit-Limit"]).toBe("3");
      expect(prima.headers["RateLimit-Remaining"]).toBe("2");
      expect(prima.headers["RateLimit-Reset"]).toBe("60");
    });

    it("il residuo non scende sotto zero", async () => {
      const limite = creaLimite({ windowMs: 60_000, max: 1 });
      await esegui(limite, richiesta("1.1.1.1"));
      await esegui(limite, richiesta("1.1.1.1"));
      const terza = await esegui(limite, richiesta("1.1.1.1"));
      expect(terza.headers["RateLimit-Remaining"]).toBe("0");
    });

    it("Retry-After compare solo negando, ed e' il tempo che manca davvero", async () => {
      // Senza, la PWA riproverebbe subito peggiorando le cose.
      let adesso = 0;
      const limite = creaLimite({ windowMs: 60_000, max: 1, now: () => adesso });
      const prima = await esegui(limite, richiesta("1.1.1.1"));
      expect(prima.headers["Retry-After"]).toBeUndefined();

      adesso = 30_000;
      const seconda = await esegui(limite, richiesta("1.1.1.1"));
      expect(seconda.headers["Retry-After"]).toBe("30");
    });
  });

  it("non accumula chiavi all'infinito", async () => {
    // Una riga per ogni IP che abbia mai chiamato e' una perdita lenta: in
    // memoria si manifestava dopo settimane come un processo riavviato
    // dall'host, e su una tabella si manifesta come una tabella che nessuno
    // guarda finche' non pesa. La pulizia e' opportunistica, quindi la si prova
    // facendo abbastanza richieste da farla scattare.
    let adesso = 0;
    const limite = creaLimite({ windowMs: 1_000, max: 1, now: () => adesso });

    for (let i = 0; i < 600; i += 1) {
      await esegui(limite, richiesta(`10.0.0.${String(i)}`));
      adesso += 10;
    }

    // Le finestre dei primi IP sono scadute da un pezzo: se fossero ancora
    // tutte nel deposito, riprovare dal primo verrebbe negato.
    expect((await esegui(limite, richiesta("10.0.0.0"))).passata).toBe(true);
  });

  describe("quando il deposito non risponde", () => {
    it("lascia passare invece di negare", async () => {
      // Sembra la scelta sbagliata e non lo e': senza database, `/login` non
      // puo' comunque leggere l'utente ne' verificare la password, quindi nella
      // finestra in cui il limite manca non c'e' niente da forzare. Negare
      // aggiungerebbe un secondo modo di rompersi alla stessa richiesta.
      const limite = creaLimite({ windowMs: 60_000, max: 1, store: new BrokenRateLimitStore() });

      for (let i = 0; i < 5; i += 1) {
        expect((await esegui(limite, richiesta("1.1.1.1"))).passata).toBe(true);
      }
    });

    it("non dichiara intestazioni che non ha", async () => {
      // Un `RateLimit-Remaining` inventato e' peggio di nessun
      // `RateLimit-Remaining`: un client che lo legge rallenta o accelera
      // seguendo un numero che non corrisponde a niente.
      const limite = creaLimite({ windowMs: 60_000, max: 1, store: new BrokenRateLimitStore() });
      const esito = await esegui(limite, richiesta("1.1.1.1"));
      expect(esito.headers).toEqual({});
    });

    it("lo dice a chi ascolta", async () => {
      // Un tetto spento in silenzio e' indistinguibile da un tetto mai acceso.
      const visti: unknown[] = [];
      const limite = creaLimite({
        windowMs: 60_000,
        max: 1,
        store: new BrokenRateLimitStore(),
        onErrore: (error) => visti.push(error),
      });

      await esegui(limite, richiesta("1.1.1.1"));
      expect(visti).toHaveLength(1);
      expect(visti[0]).toBeInstanceOf(Error);
    });

    it("una pulizia fallita non fa saltare la richiesta", async () => {
      // La pulizia e' manutenzione, non una condizione del limite: se scade
      // proprio sulla richiesta numero cinquecento, quella richiesta va contata
      // lo stesso.
      let adesso = 0;
      const store = new InMemoryRateLimitStore();
      const rotto: RateLimitStore = {
        hit: (input) => store.hit(input),
        purgeExpired: () => Promise.reject(new Error("pulizia fallita")),
      };
      const limite = creaLimite({ windowMs: 60_000, max: 10_000, store: rotto, now: () => adesso });

      for (let i = 0; i < 501; i += 1) {
        adesso += 1;
        expect((await esegui(limite, richiesta("1.1.1.1"))).passata).toBe(true);
      }
      // Il conteggio non si e' azzerato per strada: la cinquecentunesima e' la
      // cinquecentunesima.
      const ultima = await esegui(limite, richiesta("1.1.1.1"));
      expect(ultima.headers["RateLimit-Remaining"]).toBe(String(10_000 - 502));
    });
  });
});

contrattoRateLimitStore("in memoria", () => new InMemoryRateLimitStore());
