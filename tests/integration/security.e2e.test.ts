import { errorBodySchema } from "@wikimylife/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectTestPrisma, resetDatabase } from "./helpers/db.js";
import { call, startTestServer, type TestServer } from "./helpers/server.js";

/**
 * Il limite dei tentativi e le intestazioni di sicurezza, su HTTP vero.
 *
 * `tests/unit/rateLimit.test.ts` prova gia' l'aritmetica del limitatore con un
 * orologio finto, e lo fa in millisecondi. Qui si prova cio' che quel file non
 * puo' provare: che `req.ip` esista davvero dietro Express, che il 429 esca
 * dall'`errorHandler` con il corpo del contratto invece che come stack, che le
 * intestazioni sopravvivano al viaggio, e che il middleware sia montato sulle
 * rotte giuste e non su tutte.
 *
 * I conteggi stanno in `RateLimitBucket`, e `resetDatabase()` la svuota insieme
 * al resto: e' quella riga in `helpers/db.ts` a rendere indipendenti i casi qui
 * sotto, non il server nuovo. Il server nuovo serve a un'altra cosa — montare
 * il middleware con `max` a tre invece che a diecimila — e con `max` basso il
 * costo di provare il superamento e' qualche login in piu', non qualche secondo
 * di attesa.
 *
 * Che il conteggio ora viaggi nel database non cambia niente per questi test, e
 * questa e' esattamente la proprieta' che devono continuare a mostrare: le
 * intestazioni, il 429 e le rotte protette sono le stesse di prima. Il deposito
 * in se' lo prova `tests/integration/rateLimitStore.test.ts`.
 */

const EMAIL = "limite@wikimylife.test";
const PASSWORD = "password-di-prova-lunga";

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("limite dei tentativi", () => {
  let server: TestServer;

  beforeEach(async () => {
    await resetDatabase();
    // Tre, non il valore di produzione: provare venti tentativi vorrebbe dire
    // venti verifiche argon2id, che sono lente per costruzione. Il numero non
    // e' cio' che si sta provando — il comportamento al superamento lo e'.
    server = await startTestServer({ authRateLimitMax: 3 });
  });

  afterEach(async () => {
    await server.close();
  });

  async function login(): Promise<{ status: number; body: unknown; headers: Headers }> {
    return call(server, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: "password-sbagliata-ma-lunga" },
    });
  }

  it("i primi tentativi arrivano all'autenticazione e falliscono da soli", async () => {
    // 401 e non 429: il limite non deve accendersi prima del suo numero,
    // altrimenti chi sbaglia password una volta non entra piu'.
    for (let i = 0; i < 3; i += 1) {
      expect((await login()).status).toBe(401);
    }
  });

  it("il quarto e' 429 con codice RATE_LIMITED", async () => {
    for (let i = 0; i < 3; i += 1) {
      await login();
    }

    const negato = await login();
    expect(negato.status).toBe(429);
    expect(errorBodySchema.parse(negato.body).error.code).toBe("RATE_LIMITED");
  });

  it("il 429 e' un errore del contratto, non una pagina di Express", async () => {
    // Il gestore degli errori deve riconoscere l'AppError che arriva da un
    // middleware montato prima delle rotte: se non lo riconoscesse, uscirebbe
    // l'HTML del gestore di default e il client non troverebbe `error.code`.
    for (let i = 0; i < 4; i += 1) {
      await login();
    }
    const negato = await login();

    expect(negato.headers.get("content-type")).toContain("application/json");
    const corpo = errorBodySchema.parse(negato.body);
    expect(corpo.error.message).toBeTruthy();
    // `.parse` di uno schema stretto avrebbe gia' fallito su un campo in piu':
    // il 429 passa dallo stesso imbuto di tutti gli altri errori.
    expect(negato.headers.get("x-request-id")).toBeTruthy();
  });

  it("il corpo non dice a che tentativo si e' arrivati", async () => {
    // Il conteggio direbbe anche quando ricominciare. Resta nel `context`, che
    // il gestore degli errori logga e non serializza.
    for (let i = 0; i < 4; i += 1) {
      await login();
    }
    const corpo = errorBodySchema.parse((await login()).body);

    expect(corpo.error.details).toBeUndefined();
    expect(JSON.stringify(corpo)).not.toContain("rateLimitKey");
  });

  it("Retry-After dice quanto aspettare", async () => {
    for (let i = 0; i < 4; i += 1) {
      await login();
    }
    const negato = await login();

    const attesa = Number(negato.headers.get("retry-after"));
    expect(attesa).toBeGreaterThan(0);
    expect(attesa).toBeLessThanOrEqual(60);
  });

  it("le intestazioni RateLimit ci sono anche quando la richiesta passa", async () => {
    const prima = await login();

    expect(prima.headers.get("ratelimit-limit")).toBe("3");
    expect(prima.headers.get("ratelimit-remaining")).toBe("2");
    expect(prima.headers.get("ratelimit-reset")).toBeTruthy();
  });

  it("login e refresh hanno budget separati", async () => {
    // Consumare /login non deve chiudere /refresh: un utente legittimo con la
    // sessione da rinnovare non c'entra niente con chi prova password.
    for (let i = 0; i < 4; i += 1) {
      await login();
    }
    expect((await login()).status).toBe(429);

    const rinnovo = await call(server, "POST", "/api/auth/refresh", {
      body: { refreshToken: "token-inesistente" },
    });
    expect(rinnovo.status).not.toBe(429);
  });

  it("anche signup e' limitato", async () => {
    // Senza, si riempirebbe la tabella degli utenti a costo zero, e ogni riga
    // costa un hash argon2id di CPU al server.
    for (let i = 0; i < 3; i += 1) {
      await call(server, "POST", "/api/auth/signup", {
        body: { email: `nuovo-${String(i)}@wikimylife.test`, password: PASSWORD },
      });
    }

    const quarto = await call(server, "POST", "/api/auth/signup", {
      body: { email: "nuovo-3@wikimylife.test", password: PASSWORD },
    });
    expect(quarto.status).toBe(429);
  });

  it("falsificare X-Forwarded-For non compra un budget nuovo", async () => {
    // E' il test che tiene in piedi tutti gli altri. Con `trust proxy: true`
    // Express prende il primo indirizzo di quell'intestazione, e quel primo lo
    // scrive il client: bastava cambiarlo a ogni richiesta per non incontrare
    // mai il limite. Il limitatore avrebbe continuato a rispondere 429 a chi
    // non falsificava niente, il che e' il modo migliore di sembrare a posto.
    for (let i = 0; i < 4; i += 1) {
      await login();
    }

    const res = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ email: EMAIL, password: "password-sbagliata-ma-lunga" }),
    });

    // Il rovescio — che due indirizzi diversi abbiano davvero due budget — non
    // si prova qui: sopra HTTP vero i client sono tutti 127.0.0.1. Sta in
    // `tests/unit/rateLimit.test.ts`, dove l'IP e' un parametro.
    expect(res.status).toBe(429);
  });

  it("anche il cambio password e' limitato, pur essendo autenticato", async () => {
    // E' uno dei due posti in cui chi ha rubato un access token puo' indovinare
    // la password online, ed e' l'unica rotta che paga due argon2 per richiesta.
    // Il fatto che stia dietro `requireAuth` non la mette al riparo: la mette
    // al riparo da chi non ha rubato niente.
    for (let i = 0; i < 3; i += 1) {
      await call(server, "POST", "/api/auth/password", {
        body: { currentPassword: PASSWORD, newPassword: "un-altra-password-lunga" },
      });
    }

    const quarto = await call(server, "POST", "/api/auth/password", {
      body: { currentPassword: PASSWORD, newPassword: "un-altra-password-lunga" },
    });
    expect(quarto.status).toBe(429);
  });

  it("il cambio password non consuma il budget del login", async () => {
    // Budget separati, come fra login e refresh: chi cambia password non deve
    // ritrovarsi chiuso fuori dalla schermata di ingresso.
    for (let i = 0; i < 4; i += 1) {
      await call(server, "POST", "/api/auth/password", {
        body: { currentPassword: PASSWORD, newPassword: "un-altra-password-lunga" },
      });
    }

    expect((await login()).status).not.toBe(429);
  });

  it("anche scollegare gli altri dispositivi e' limitato", async () => {
    // L'altro dei due. Qui l'argon2 per richiesta e' uno solo, ma la rotta ha
    // in piu' il fatto che il gesto e' distruttivo: senza limite, chi ha in
    // mano un access token rubato puo' provarci finche' non indovina, e quando
    // indovina resta l'unico collegato.
    for (let i = 0; i < 3; i += 1) {
      await call(server, "POST", "/api/auth/sessions/revoke", {
        body: { currentPassword: PASSWORD },
      });
    }

    const quarto = await call(server, "POST", "/api/auth/sessions/revoke", {
      body: { currentPassword: PASSWORD },
    });
    expect(quarto.status).toBe(429);
  });

  it("anche chiuderne una sola e' limitato, e il limite non dipende da quale", async () => {
    // Questa e' la rotta per cui il limitatore ha deciso la forma dell'URL.
    // La chiave del secchiello contiene `req.path`, che e' il percorso
    // *concreto*: con l'id nella posizione — `POST /sessions/:id/revoke` —
    // ogni id aprirebbe un budget nuovo, e una rotta che accetta una password
    // diventerebbe un oracolo senza limite, perche' basta cambiare l'UUID a
    // ogni tentativo. Con l'id nel corpo il percorso e' uno solo, e i quattro
    // tentativi qui sotto — tutti con un `sessionId` diverso — cadono nello
    // stesso secchiello.
    for (let i = 0; i < 3; i += 1) {
      await call(server, "POST", "/api/auth/sessions/revoke-one", {
        body: { sessionId: `fam-inventata-${String(i)}`, currentPassword: PASSWORD },
      });
    }

    const quarto = await call(server, "POST", "/api/auth/sessions/revoke-one", {
      body: { sessionId: "fam-inventata-3", currentPassword: PASSWORD },
    });
    expect(quarto.status).toBe(429);
  });

  it("le due rotte con la password hanno budget separati", async () => {
    // Altrimenti chi sbaglia tre volte a scollegare i dispositivi non puo' piu'
    // cambiare la password, che e' il gesto piu' forte dei due: il limite
    // finirebbe per difendere l'attaccante.
    for (let i = 0; i < 4; i += 1) {
      await call(server, "POST", "/api/auth/sessions/revoke", {
        body: { currentPassword: PASSWORD },
      });
    }

    const cambio = await call(server, "POST", "/api/auth/password", {
      body: { currentPassword: PASSWORD, newPassword: "un-altra-password-lunga" },
    });
    expect(cambio.status).not.toBe(429);
  });

  it("le rotte non autenticanti non sono limitate", async () => {
    // `/health` lo chiama l'host a intervalli fissi: limitarlo vorrebbe dire
    // far dichiarare morto il servizio a chi lo sorveglia.
    for (let i = 0; i < 10; i += 1) {
      expect((await call(server, "GET", "/health")).status).toBe(200);
    }
  });

  it("un accesso riuscito consuma comunque un tentativo", async () => {
    // Il conteggio e' sui tentativi, non sui fallimenti: contare solo gli
    // errori lascerebbe passare chi indovina, ed e' proprio il caso che
    // conta.
    await call(server, "POST", "/api/auth/signup", { body: { email: EMAIL, password: PASSWORD } });

    const accesso = await call(server, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(accesso.status).toBe(200);
    expect(accesso.headers.get("ratelimit-remaining")).toBe("2");
  });
});

describe("intestazioni di sicurezza", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("ci sono su una risposta riuscita", async () => {
    const res = await call(server, "GET", "/health");

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("ci sono anche su una risposta d'errore", async () => {
    // Sono impostate prima delle rotte, quindi valgono anche per cio' che non
    // arriva mai a una rotta. Un 404 o un 401 e' pur sempre una risposta che
    // un browser interpreta.
    const res = await call(server, "GET", "/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("HSTS non parte fuori dalla produzione", async () => {
    // In sviluppo l'API sta su http://localhost, e un browser che ricevesse
    // HSTS da li' rifiuterebbe il testo in chiaro su TUTTO localhost per un
    // anno, Vite compreso. Il test esiste perche' il danno non e' reversibile
    // ridistribuendo.
    const res = await call(server, "GET", "/health");

    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("l'API non dichiara di essere Express", async () => {
    // `x-powered-by` non e' una vulnerabilita', e' un suggerimento gratuito su
    // dove cercarne una.
    const res = await call(server, "GET", "/health");

    expect(res.headers.get("x-powered-by")).toBeNull();
  });
});
