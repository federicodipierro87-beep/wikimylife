import {
  ApiError,
  AUTH_STORAGE_KEYS,
  createApiClient,
  type AuthSession,
  type FetchImpl,
} from "@wikimylife/shared";
import { createInMemorySecureStorage } from "@wikimylife/shared/testing";
import { describe, expect, it } from "vitest";

/**
 * Client tipizzato di shared, con `fetch` iniettato.
 *
 * Nessun socket aperto: `fetchImpl` esiste perche' i test lo sostituiscano e
 * perche' React Native ha la propria implementazione. Le due proprieta' che
 * contano qui sono di sicurezza, non di comodita':
 *
 *  - l'access token vive SOLO in memoria; nello storage persistente ci va il
 *    solo refresh token;
 *  - su `TOKEN_REUSED` il client non riprova. Riprovare significherebbe
 *    presentare di nuovo un token di una famiglia gia' revocata, cioe' generare
 *    un secondo allarme di riuso per un incidente solo.
 */

const BASE = "http://api.test";

function session(suffix: string): AuthSession {
  return {
    user: {
      id: "u-1",
      email: "chi@esempio.it",
      locale: "it-IT",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    tokens: {
      accessToken: `access-${suffix}`,
      refreshToken: `refresh-${suffix}`,
      expiresIn: 900,
      tokenType: "Bearer",
    },
  };
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

type Route = (call: Call) => { status: number; payload: unknown };

function stubFetch(routes: Record<string, Route>): {
  fetchImpl: FetchImpl;
  calls: Call[];
} {
  const calls: Call[] = [];

  const fetchImpl: FetchImpl = (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = init?.body;
    const call: Call = {
      url: input,
      method: init?.method ?? "GET",
      authorization: headers["Authorization"],
      body: typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : undefined,
    };
    calls.push(call);

    const key = `${call.method} ${input.replace(BASE, "")}`;
    const route = routes[key];
    if (route === undefined) {
      throw new Error(`rotta non prevista dal test: ${key}`);
    }

    const { status, payload } = route(call);
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  return { fetchImpl, calls };
}

function errorPayload(code: string, message: string): unknown {
  return { error: { code, message } };
}

describe("health", () => {
  it("valida la risposta contro lo schema condiviso", async () => {
    const { fetchImpl } = stubFetch({
      "GET /health": () => ({
        status: 200,
        payload: { status: "ok", db: "up", uptimeSeconds: 12, version: "0.1.0" },
      }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.health()).resolves.toEqual({
      status: "ok",
      db: "up",
      uptimeSeconds: 12,
      version: "0.1.0",
    });
  });

  it("rifiuta una risposta 200 che non rispetta il contratto", async () => {
    // Un 200 con un corpo sbagliato e' peggio di un errore: senza questo
    // controllo il campo mancante diventa `undefined` e il difetto compare
    // molto piu' a valle, in un componente.
    const { fetchImpl } = stubFetch({
      "GET /health": () => ({ status: 200, payload: { status: "ok" } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.health()).rejects.toBeInstanceOf(ApiError);
  });

  it("normalizza le barre nell'URL", async () => {
    const { fetchImpl, calls } = stubFetch({
      "GET /health": () => ({
        status: 200,
        payload: { status: "ok", db: "up", uptimeSeconds: 1, version: "0.1.0" },
      }),
    });
    const client = createApiClient({
      baseUrl: `${BASE}/`,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });
    await client.health();

    expect(calls[0]?.url).toBe(`${BASE}/health`);
  });
});

describe("login", () => {
  it("conserva il refresh token e tiene l'access token in memoria", async () => {
    // L'access token nello storage persistente sarebbe la differenza fra un XSS
    // che ruba 15 minuti e uno che ruba 30 giorni.
    const storage = createInMemorySecureStorage();
    const { fetchImpl } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
    });
    const client = createApiClient({ baseUrl: BASE, storage, fetchImpl });

    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });

    expect(client.getAccessToken()).toBe("access-1");
    expect(storage.snapshot()).toEqual({
      [AUTH_STORAGE_KEYS.refreshToken]: "refresh-1",
    });
  });

  it("traduce un errore del contratto in ApiError", async () => {
    const { fetchImpl } = stubFetch({
      "POST /api/auth/login": () => ({
        status: 401,
        payload: errorPayload("INVALID_CREDENTIALS", "Email o password non corretti"),
      }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(
      client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
  });

  it("regge un corpo di errore fuori contratto", async () => {
    // Un proxy o un load balancer possono restituire HTML: il client non deve
    // esplodere in modo diverso da come esplode su un errore normale.
    const { fetchImpl } = stubFetch({
      "POST /api/auth/login": () => ({ status: 502, payload: "<html>Bad Gateway</html>" }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(
      client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 502 });
  });
});

describe("rotazione automatica su 401", () => {
  it("ruota una volta e ripete la richiesta", async () => {
    let meCalls = 0;
    const { fetchImpl, calls } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/refresh": () => ({ status: 200, payload: session("2") }),
      "GET /api/auth/me": () => {
        meCalls += 1;
        return meCalls === 1
          ? { status: 401, payload: errorPayload("TOKEN_EXPIRED", "Token scaduto") }
          : { status: 200, payload: { user: session("2").user } };
      },
    });
    const storage = createInMemorySecureStorage();
    const client = createApiClient({ baseUrl: BASE, storage, fetchImpl });

    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });
    await expect(client.me()).resolves.toMatchObject({ id: "u-1" });

    expect(meCalls).toBe(2);
    expect(client.getAccessToken()).toBe("access-2");
    expect(storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken]).toBe("refresh-2");
    // La seconda chiamata a /me porta il token nuovo, non quello scaduto.
    expect(calls.at(-1)?.authorization).toBe("Bearer access-2");
  });

  it("non ruota due volte per la stessa richiesta", async () => {
    let refreshCalls = 0;
    const { fetchImpl } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/refresh": () => {
        refreshCalls += 1;
        return { status: 200, payload: session("2") };
      },
      "GET /api/auth/me": () => ({
        status: 401,
        payload: errorPayload("TOKEN_EXPIRED", "Token scaduto"),
      }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });
    await expect(client.me()).rejects.toBeInstanceOf(ApiError);

    expect(refreshCalls).toBe(1);
  });

  it("NON ruota su TOKEN_REUSED", async () => {
    // Riprovare significherebbe presentare un altro token di una famiglia gia'
    // revocata: un secondo allarme di riuso per un incidente solo, e una
    // richiesta in piu' che non puo' riuscire.
    let refreshCalls = 0;
    const { fetchImpl } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/refresh": () => {
        refreshCalls += 1;
        return { status: 200, payload: session("2") };
      },
      "GET /api/auth/me": () => ({
        status: 401,
        payload: errorPayload("TOKEN_REUSED", "Sessione revocata"),
      }),
    });
    const storage = createInMemorySecureStorage();
    let expiredNotifications = 0;
    const client = createApiClient({
      baseUrl: BASE,
      storage,
      fetchImpl,
      onSessionExpired: () => {
        expiredNotifications += 1;
      },
    });

    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });
    await expect(client.me()).rejects.toMatchObject({ code: "TOKEN_REUSED" });

    expect(refreshCalls).toBe(0);
    expect(client.getAccessToken()).toBeNull();
    expect(storage.snapshot()).toEqual({});
    expect(expiredNotifications).toBe(1);
  });

  it("due richieste parallele condividono una sola rotazione", async () => {
    // Due 401 simultanei che ruotassero entrambi produrrebbero un vero riuso:
    // il secondo presenterebbe il token che il primo ha appena consumato, e la
    // difesa lato server butterebbe fuori l'utente. Un bug del client che si
    // manifesta come un allarme di sicurezza.
    let refreshCalls = 0;
    let meCalls = 0;
    const { fetchImpl } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/refresh": () => {
        refreshCalls += 1;
        return { status: 200, payload: session("2") };
      },
      "GET /api/auth/me": () => {
        meCalls += 1;
        return meCalls <= 2
          ? { status: 401, payload: errorPayload("TOKEN_EXPIRED", "Token scaduto") }
          : { status: 200, payload: { user: session("2").user } };
      },
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });
    await Promise.all([client.me(), client.me()]);

    expect(refreshCalls).toBe(1);
  });
});

describe("logout", () => {
  it("svuota lo stato locale anche se il server rifiuta", async () => {
    const { fetchImpl } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/logout": () => ({
        status: 401,
        payload: errorPayload("TOKEN_INVALID", "Token non valido"),
      }),
    });
    const storage = createInMemorySecureStorage();
    const client = createApiClient({ baseUrl: BASE, storage, fetchImpl });

    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });
    await expect(client.logout()).resolves.toBeUndefined();

    expect(client.getAccessToken()).toBeNull();
    expect(storage.snapshot()).toEqual({});
  });
});

describe("restoreSession", () => {
  it("torna null senza chiamare la rete se non c'e' nulla da ripristinare", async () => {
    const { fetchImpl, calls } = stubFetch({});
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.restoreSession()).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("ripristina la sessione dal refresh token conservato", async () => {
    const { fetchImpl } = stubFetch({
      "POST /api/auth/refresh": () => ({ status: 200, payload: session("2") }),
    });
    const storage = createInMemorySecureStorage({
      [AUTH_STORAGE_KEYS.refreshToken]: "refresh-1",
    });
    const client = createApiClient({ baseUrl: BASE, storage, fetchImpl });

    await expect(client.restoreSession()).resolves.toMatchObject({ id: "u-1" });
    expect(client.getAccessToken()).toBe("access-2");
  });

  it("pulisce tutto se il refresh conservato non vale piu'", async () => {
    const { fetchImpl } = stubFetch({
      "POST /api/auth/refresh": () => ({
        status: 401,
        payload: errorPayload("TOKEN_REUSED", "Sessione revocata"),
      }),
    });
    const storage = createInMemorySecureStorage({
      [AUTH_STORAGE_KEYS.refreshToken]: "refresh-rubato",
    });
    const client = createApiClient({ baseUrl: BASE, storage, fetchImpl });

    await expect(client.restoreSession()).resolves.toBeNull();
    expect(storage.snapshot()).toEqual({});
  });
});
