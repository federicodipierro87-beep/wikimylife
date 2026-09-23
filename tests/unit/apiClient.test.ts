import {
  ApiError,
  AUTH_STORAGE_KEYS,
  createApiClient,
  emptyTrashQuerySchema,
  listProceduresQuerySchema,
  listTagsQuerySchema,
  searchQuerySchema,
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

describe("cambio password", () => {
  const CORPO = {
    currentPassword: "password-lunga-abbastanza",
    newPassword: "una-password-nuova-lunga",
  };

  it("salva i token nuovi: quelli di prima sono morti sul server", async () => {
    const { fetchImpl, calls } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/password": () => ({ status: 200, payload: session("2") }),
    });
    const storage = createInMemorySecureStorage();
    const client = createApiClient({ baseUrl: BASE, storage, fetchImpl });

    await client.login({ email: "chi@esempio.it", password: CORPO.currentPassword });
    await client.changePassword(CORPO);

    expect(client.getAccessToken()).toBe("access-2");
    expect(storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken]).toBe("refresh-2");
    // Autenticata: senza l'header, la rotta non saprebbe di chi cambiare la
    // password, e il server risponderebbe 401 a chi ha appena fatto login.
    expect(calls.at(-1)?.authorization).toBe("Bearer access-1");
  });

  it("non manda mai la password in chiaro nell'URL", async () => {
    const { fetchImpl, calls } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/password": () => ({ status: 200, payload: session("2") }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await client.login({ email: "chi@esempio.it", password: CORPO.currentPassword });
    await client.changePassword(CORPO);

    const ultima = calls.at(-1);
    expect(ultima?.url).toBe(`${BASE}/api/auth/password`);
    expect(ultima?.body).toEqual(CORPO);
  });

  it("se l'access token scade mentre si compila il modulo, ruota e riprova", async () => {
    // Ripetere non rischia un doppio cambio: si ripete solo dopo un 401, e un
    // 401 vuol dire che la prima non ha cambiato niente.
    let cambi = 0;
    const { fetchImpl } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/refresh": () => ({ status: 200, payload: session("2") }),
      "POST /api/auth/password": () => {
        cambi += 1;
        return cambi === 1
          ? { status: 401, payload: errorPayload("TOKEN_EXPIRED", "Token scaduto") }
          : { status: 200, payload: session("3") };
      },
    });
    const storage = createInMemorySecureStorage();
    const client = createApiClient({ baseUrl: BASE, storage, fetchImpl });

    await client.login({ email: "chi@esempio.it", password: CORPO.currentPassword });
    await expect(client.changePassword(CORPO)).resolves.toMatchObject({ user: { id: "u-1" } });

    expect(cambi).toBe(2);
    expect(storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken]).toBe("refresh-3");
  });

  it("una password attuale sbagliata non butta fuori chi ha sbagliato a scrivere", async () => {
    // Il 401 di questa rotta puo' voler dire due cose opposte. Se e'
    // INVALID_CREDENTIALS parla del corpo — «hai digitato male» — e il token
    // con cui e' arrivata la richiesta e' vivo. Trattarlo come gli altri
    // significherebbe ruotare per niente e poi, al secondo rifiuto identico,
    // svuotare la sessione: chi sbaglia la password attuale verrebbe buttato
    // fuori dall'account che stava proteggendo.
    let refreshCalls = 0;
    const { fetchImpl } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/refresh": () => {
        refreshCalls += 1;
        return { status: 200, payload: session("2") };
      },
      "POST /api/auth/password": () => ({
        status: 401,
        payload: errorPayload("INVALID_CREDENTIALS", "Email o password non corretti"),
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

    await client.login({ email: "chi@esempio.it", password: CORPO.currentPassword });
    await expect(
      client.changePassword({ ...CORPO, currentPassword: "non-e-quella" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    expect(refreshCalls).toBe(0);
    expect(client.getAccessToken()).toBe("access-1");
    expect(storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken]).toBe("refresh-1");
    expect(expiredNotifications).toBe(0);
  });

  it("un 401 che parla davvero della sessione la chiude ancora", async () => {
    // Lo sbaglio opposto del caso qui sopra: l'eccezione vale per
    // INVALID_CREDENTIALS e per nient'altro. Un access token revocato mentre si
    // compilava il modulo deve portare alla schermata di ingresso.
    const { fetchImpl } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/refresh": () => ({
        status: 401,
        payload: errorPayload("TOKEN_REUSED", "Sessione revocata"),
      }),
      "POST /api/auth/password": () => ({
        status: 401,
        payload: errorPayload("UNAUTHORIZED", "Sessione chiusa"),
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

    await client.login({ email: "chi@esempio.it", password: CORPO.currentPassword });
    await expect(client.changePassword(CORPO)).rejects.toBeInstanceOf(ApiError);

    expect(client.getAccessToken()).toBeNull();
    expect(storage.snapshot()).toEqual({});
    expect(expiredNotifications).toBe(1);
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

/**
 * `deleteAccount`, e la rotta che non e' quella che sembra.
 *
 * Il verbo e' `POST` e il percorso e' `/api/auth/delete-account`, non
 * `DELETE /api/auth/me`: la ragione sta scritta per esteso in
 * `auth.routes.ts`, ed e' la stessa per cui `/sessions/revoke` e' un `POST` —
 * un corpo su una `DELETE` attraversa male cio' che sta in mezzo. Il caso qui
 * sotto e' quello che tiene ferma la scelta: se qualcuno "sistemasse" la rotta
 * per farla sembrare giusta, il server risponderebbe 404 e questo test e'
 * l'unico posto in tutta la suite unitaria dove si vedrebbe.
 */
describe("cancellare il proprio conto", () => {
  const CONTI = { vocali: 3, schede: 2, sessioni: 1 };

  it("va in POST a /api/auth/delete-account con la password attuale", async () => {
    const { fetchImpl, calls } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/delete-account": () => ({ status: 200, payload: CONTI }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });
    await expect(client.deleteAccount({ currentPassword: "password-lunga-abbastanza" })).resolves.toEqual(
      CONTI,
    );

    const richiesta = calls[1];
    expect(richiesta?.url).toBe(`${BASE}/api/auth/delete-account`);
    expect(richiesta?.method).toBe("POST");
    // Autenticata: il server deve sapere *quale* conto, e non lo deduce dal
    // corpo. Senza questa riga, un client che mandasse la sola password
    // passerebbe il resto del caso.
    expect(richiesta?.authorization).toBe("Bearer access-1");
    expect(richiesta?.body).toEqual({ currentPassword: "password-lunga-abbastanza" });
  });

  it("dopo la cancellazione il deposito e' vuoto", async () => {
    const { fetchImpl } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/delete-account": () => ({ status: 200, payload: CONTI }),
    });
    const storage = createInMemorySecureStorage();
    const client = createApiClient({ baseUrl: BASE, storage, fetchImpl });

    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });
    expect(storage.snapshot()).not.toEqual({});

    await client.deleteAccount({ currentPassword: "password-lunga-abbastanza" });

    // Il refresh token di un conto che non esiste piu' non apre niente, ma
    // resterebbe scritto sul telefono: al prossimo avvio `restoreSession` lo
    // manderebbe, si prenderebbe un 401 e l'app mostrerebbe un errore dove
    // doveva esserci la schermata di ingresso.
    expect(storage.snapshot()).toEqual({});
    expect(client.getAccessToken()).toBeNull();
  });

  it("una cancellazione rifiutata lascia la sessione in piedi", async () => {
    const { fetchImpl } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      "POST /api/auth/delete-account": () => ({
        status: 409,
        payload: errorPayload("CONFLICT", "Ci sono 2 vocali ancora in lavorazione"),
      }),
    });
    const storage = createInMemorySecureStorage();
    const client = createApiClient({ baseUrl: BASE, storage, fetchImpl });

    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });
    await expect(
      client.deleteAccount({ currentPassword: "password-lunga-abbastanza" }),
    ).rejects.toBeInstanceOf(ApiError);

    // L'errore opposto del caso sopra, ed e' quello che costa: `logout()` svuota
    // il deposito comunque, perche' li' l'intenzione e' uscire. Qui no. Un
    // `finally` intorno al `clear()` sloggherebbe chi ha sbagliato la password.
    expect(storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken]).toBe("refresh-1");
    expect(client.getAccessToken()).toBe("access-1");
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

/**
 * Le due rotte con una query string.
 *
 * Sono le uniche in cui il client riscrive a mano un pezzo di contratto: la
 * query si costruisce elencando i campi uno per uno, e un campo aggiunto allo
 * schema e dimenticato qui non rompe niente di visibile. La richiesta parte lo
 * stesso, il server applica il default, e il difetto si manifesta come un
 * comportamento sbagliato invece che come un errore.
 *
 * E' successo con `offset` della ricerca: lo schema lo accettava, la schermata
 * lo passava a ogni pagina, e ogni pagina chiedeva la prima. Questi due test
 * non guardano un URL atteso scritto a mano — che si dimenticherebbe insieme
 * al resto — ma confrontano i parametri mandati con le chiavi dello schema.
 * La prossima aggiunta o fallisce qui, o e' arrivata.
 */
describe("query string — nessun parametro si perde per strada", () => {
  function parametriDi(url: string): string[] {
    return [...new URL(url).searchParams.keys()].sort();
  }

  it("manda ogni campo di searchQuerySchema", async () => {
    const { fetchImpl, calls } = stubFetch({
      "GET /api/search?q=residenza&scope=PERSONALE&limit=10&offset=20": () => ({
        status: 200,
        payload: { q: "residenza", items: [], limit: 10, offset: 20, hasMore: false },
      }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await client.search({ q: "residenza", scope: "PERSONALE", limit: 10, offset: 20 });

    expect(parametriDi(calls[0]?.url ?? "")).toEqual(
      Object.keys(searchQuerySchema.shape).sort(),
    );
  });

  it("manda ogni campo di listProceduresQuerySchema", async () => {
    const { fetchImpl, calls } = stubFetch({
      "GET /api/procedures?scope=LAVORO&status=COMPLETA&tag=casa&limit=5&offset=15": () => ({
        status: 200,
        payload: { items: [], total: 0, limit: 5, offset: 15 },
      }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await client.listProcedures({
      scope: "LAVORO",
      status: "COMPLETA",
      tag: "casa",
      limit: 5,
      offset: 15,
    });

    expect(parametriDi(calls[0]?.url ?? "")).toEqual(
      Object.keys(listProceduresQuerySchema.shape).sort(),
    );
  });

  it("manda ogni campo di listTagsQuerySchema", async () => {
    const { fetchImpl, calls } = stubFetch({
      "GET /api/tags?scope=LAVORO": () => ({ status: 200, payload: { items: [] } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await client.listTags({ scope: "LAVORO" });

    expect(parametriDi(calls[0]?.url ?? "")).toEqual(
      Object.keys(listTagsQuerySchema.shape).sort(),
    );
  });
});

/**
 * Le categorie, che sono la terza rotta con una query string.
 *
 * Il percorso conta piu' del solito: `/api/tags` e non
 * `/api/procedures/tags`. La seconda forma sembrerebbe piu' ordinata e
 * funzionerebbe, ma solo finche' resta dichiarata *prima* di
 * `router.get("/:id")` dentro `procedures.routes.ts` — cioe' si reggerebbe
 * sull'ordine delle righe di un file. Spostata di dieci righe piu' in giu',
 * «tags» diventerebbe un id di scheda e la risposta un 404. Qui il percorso e'
 * scritto per esteso apposta: se qualcuno lo cambia, questo caso lo dice.
 */
describe("listTags — dove si chiedono le categorie", () => {
  it("le chiede in GET, a /api/tags, e non tocca le schede", async () => {
    const { fetchImpl, calls } = stubFetch({
      "GET /api/tags": () => ({
        status: 200,
        payload: { items: [{ nome: "casa", conteggio: 7 }] },
      }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.listTags()).resolves.toEqual({
      items: [{ nome: "casa", conteggio: 7 }],
    });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BASE}/api/tags`);
  });

  it("senza ambito la query e' vuota, e non «?scope=undefined»", async () => {
    // `queryString` salta i campi non definiti: se non lo facesse, il server
    // riceverebbe la stringa «undefined» dentro un enum e risponderebbe 400 a
    // chi non ha chiesto nessun filtro, cioe' a tutti.
    const { fetchImpl, calls } = stubFetch({
      "GET /api/tags": () => ({ status: 200, payload: { items: [] } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await client.listTags({});

    expect(calls[0]?.url).not.toContain("?");
  });

  it("l'ambito viaggia nella query e non nel corpo", async () => {
    // Una GET con un corpo non arriva: `fetch` lo scarta, i proxy pure. Il
    // filtro sparirebbe in silenzio e la riga delle chip mostrerebbe le
    // categorie di tutto l'archivio dicendo di mostrare quelle di «Lavoro».
    const { fetchImpl, calls } = stubFetch({
      "GET /api/tags?scope=PERSONALE": () => ({ status: 200, payload: { items: [] } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await client.listTags({ scope: "PERSONALE" });

    expect(calls[0]?.url).toBe(`${BASE}/api/tags?scope=PERSONALE`);
    expect(calls[0]?.body).toBeUndefined();
  });

  it("una categoria senza conteggio non passa il contratto", async () => {
    // Il conteggio e' l'unica ragione per cui questa rotta esiste: i soli nomi
    // si potrebbero gia' raccogliere dalle schede. Un corpo che lo dimentica
    // diventerebbe `undefined` dentro un `String()` e la chip direbbe
    // «Casa undefined» invece di rompersi qui.
    const { fetchImpl } = stubFetch({
      "GET /api/tags": () => ({ status: 200, payload: { items: [{ nome: "casa" }] } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.listTags()).rejects.toBeInstanceOf(ApiError);
  });

  it("un conteggio che non e' un numero intero non passa il contratto", async () => {
    // L'errore opposto del caso sopra: un campo presente ma della forma
    // sbagliata. «7» scritto come stringa passerebbe un controllo di presenza e
    // si ordinerebbe come testo, mettendo 10 prima di 9.
    const { fetchImpl } = stubFetch({
      "GET /api/tags": () => ({
        status: 200,
        payload: { items: [{ nome: "casa", conteggio: "7" }] },
      }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.listTags()).rejects.toBeInstanceOf(ApiError);
  });
});

/**
 * La `DELETE` sulla collezione, che e' l'unica richiesta dell'app capace di
 * cancellare molte cose insieme.
 *
 * `emptyTrash()` non prende argomenti: i due parametri che il server pretende
 * li scrive il client. E' una scelta che sposta il rischio, non lo toglie —
 * nessuna schermata puo' comporre `?status=COMPLETA`, ma se il client
 * dimenticasse un parametro nessuno se ne accorgerebbe finche' qualcuno non
 * preme un pulsante rosso e riceve un 400. Da qui i casi: cosa parte, con
 * quale token, e cosa succede se cio' che torna non e' quel che dice il
 * contratto.
 *
 * ## Il metodo che chiama piu' volte
 *
 * Dietro quella firma senza argomenti non c'e' piu' una richiesta sola. Il
 * server svuota al massimo `EMPTY_TRASH_BATCH_SIZE` schede per volta — perche'
 * un cestino grosso, moltiplicato per i secondi che ogni scheda costa fra
 * transazione e bucket, supera il timeout di qualunque proxy — e dice quante ne
 * restano; il client ripete finche' non e' zero e somma cio' che ha portato via.
 *
 * E' l'unico metodo di questo client in cui una chiamata non corrisponde a una
 * richiesta, ed e' percio' l'unico in cui si puo' sbagliare a fermarsi. I due
 * errori sono opposti e costano cose diverse: fermarsi troppo presto lascia un
 * cestino mezzo pieno dopo un gesto che prometteva di svuotarlo; non fermarsi
 * mai inchioda la scheda su un ciclo che nessuno vede girare.
 */
describe("svuotare il cestino", () => {
  const ROTTA = "DELETE /api/procedures?status=ARCHIVIATA&definitivo=1";

  it("scrive lui i due parametri, e sono quelli che il server pretende", async () => {
    const { fetchImpl, calls } = stubFetch({
      [ROTTA]: () => ({ status: 200, payload: { cancellate: 3, saltate: 1, rimaste: 0 } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.emptyTrash()).resolves.toEqual({
      cancellate: 3,
      saltate: 1,
      rimaste: 0,
    });

    const url = new URL(calls[0]?.url ?? "");
    expect(calls[0]?.method).toBe("DELETE");
    // Sulla collezione e non su un id: `/api/procedures/qualcosa` sarebbe la
    // rotta che ne cancella una sola, e risponderebbe 204 a un pulsante che ha
    // appena promesso di svuotare tutto.
    expect(url.pathname).toBe("/api/procedures");
    // Non un URL atteso scritto a mano: gli stessi parametri passati per lo
    // schema con cui il server li leggera'. Il giorno in cui uno dei due cambia
    // nome, o smette di essere obbligatorio, questa riga lo dice qui invece che
    // in un 400 davanti all'utente.
    const inviati = Object.fromEntries(url.searchParams);
    expect(emptyTrashQuerySchema.safeParse(inviati).success).toBe(true);
    expect(inviati).toEqual({ status: "ARCHIVIATA", definitivo: "1" });
  });

  it("allega il token, che e' l'unica cosa che distingue il proprio cestino da quello di un altro", async () => {
    const { fetchImpl, calls } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      [ROTTA]: () => ({ status: 200, payload: { cancellate: 0, saltate: 0, rimaste: 0 } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });
    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });

    await client.emptyTrash();

    expect(calls[1]?.authorization).toBe("Bearer access-1");
  });

  it("una risposta senza «saltate» non passa per uno svuotamento riuscito", async () => {
    // Il campo che manca diventerebbe `undefined`, e la schermata direbbe
    // «undefined schede sono state ripristinate» — oppure, peggio, tacerebbe su
    // schede rimaste nel cestino facendole sembrare un guasto.
    const { fetchImpl } = stubFetch({
      [ROTTA]: () => ({ status: 200, payload: { cancellate: 3, rimaste: 0 } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.emptyTrash()).rejects.toBeInstanceOf(ApiError);
  });

  it("una risposta senza «rimaste» non passa, ed e' il campo su cui gira il ciclo", async () => {
    // Peggio degli altri due campi mancanti, perche' `rimaste` non serve solo a
    // scrivere una frase: e' la condizione di uscita. Un `undefined` li' dentro
    // non e' zero, e il confronto `rimaste === 0` sarebbe falso per sempre:
    // cinquanta `DELETE` di fila su un cestino gia' vuoto. Meglio un errore.
    const { fetchImpl } = stubFetch({
      [ROTTA]: () => ({ status: 200, payload: { cancellate: 3, saltate: 0 } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.emptyTrash()).rejects.toBeInstanceOf(ApiError);
  });

  it("con il cestino vuoto in una passata sola manda una richiesta sola", async () => {
    // L'errore opposto di quello del caso dopo, e il piu' facile da scrivere
    // per sbaglio: un ciclo che parte sempre da capo «per sicurezza» costa una
    // `DELETE` in piu' su ogni svuotamento riuscito, e nei registri del server
    // il pulsante rosso sembra premuto due volte da chi l'ha premuto una.
    const { fetchImpl, calls } = stubFetch({
      [ROTTA]: () => ({ status: 200, payload: { cancellate: 4, saltate: 0, rimaste: 0 } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await client.emptyTrash();

    expect(calls).toHaveLength(1);
  });

  it("ripete finche' il cestino non e' vuoto, e somma cio' che ha portato via", async () => {
    // Tre passate, come le manderebbe un cestino da centoventi schede contro un
    // tetto di cinquanta. Chi ha premuto il pulsante una volta deve leggere
    // centoventi, non cinquanta: un client che restituisse l'ultima passata
    // invece della somma direbbe un numero vero e senza senso.
    const passate = [
      { cancellate: 50, saltate: 0, rimaste: 70 },
      { cancellate: 48, saltate: 2, rimaste: 20 },
      { cancellate: 19, saltate: 1, rimaste: 0 },
    ];
    let quale = 0;
    const { fetchImpl, calls } = stubFetch({
      [ROTTA]: () => {
        const payload = passate[quale] ?? passate[passate.length - 1];
        quale += 1;
        return { status: 200, payload };
      },
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.emptyTrash()).resolves.toEqual({
      cancellate: 117,
      saltate: 3,
      // `rimaste` e' l'ultimo valore e non la somma: gli altri due contano
      // eventi, questo descrive uno stato, e sommare stati non vuol dire niente.
      rimaste: 0,
    });
    expect(calls).toHaveLength(3);
  });

  it("una passata che non tocca niente ferma il ciclo, anche se il server dice che ne restano", async () => {
    // Un server che risponde «ne restano venti» dopo aver cancellato zero e
    // saltato zero si sta contraddicendo: se ce ne sono venti, una almeno
    // doveva finire in uno dei due conti. Senza questa seconda uscita il client
    // rifarebbe la stessa richiesta cinquanta volte e poi si arrenderebbe —
    // cinquanta `DELETE` inutili al server, e un'attesa lunga a chi guarda.
    const { fetchImpl, calls } = stubFetch({
      [ROTTA]: () => ({ status: 200, payload: { cancellate: 0, saltate: 0, rimaste: 20 } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.emptyTrash()).resolves.toEqual({
      cancellate: 0,
      saltate: 0,
      // E le venti restano scritte nella risposta: il cestino non e' vuoto, e
      // dirlo e' l'unica cosa che distingue questo esito da uno svuotamento
      // riuscito.
      rimaste: 20,
    });
    expect(calls).toHaveLength(1);
  });

  it("una passata di sole saltate non conta come «non ho toccato niente»", async () => {
    // Il caso che separa la condizione giusta da quella sbagliata. Un'uscita
    // scritta `cancellate === 0` si fermerebbe qui, e lascerebbe nel cestino le
    // schede della passata dopo: una passata in cui tutte e cinquanta erano
    // state ripescate non ha cancellato niente, ma il cestino si e' comunque
    // accorciato, e il giro successivo trova roba nuova.
    const passate = [
      { cancellate: 0, saltate: 50, rimaste: 3 },
      { cancellate: 3, saltate: 0, rimaste: 0 },
    ];
    let quale = 0;
    const { fetchImpl, calls } = stubFetch({
      [ROTTA]: () => {
        const payload = passate[quale] ?? passate[passate.length - 1];
        quale += 1;
        return { status: 200, payload };
      },
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.emptyTrash()).resolves.toEqual({
      cancellate: 3,
      saltate: 50,
      rimaste: 0,
    });
    expect(calls).toHaveLength(2);
  });

  it("un server che dice sempre «ne restano» non fa girare il client per sempre", async () => {
    // Il tetto. Non e' un limite pensato per l'utente — cinquanta giri per
    // cinquanta schede sono duemilacinquecento — ma per il caso in cui il
    // numero che guida il ciclo arriva da fuori e non scende mai. Senza, questo
    // test non finirebbe, che e' esattamente cio' che succederebbe alla scheda.
    const { fetchImpl, calls } = stubFetch({
      [ROTTA]: () => ({ status: 200, payload: { cancellate: 1, saltate: 0, rimaste: 9 } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    const esito = await client.emptyTrash();

    expect(calls).toHaveLength(50);
    expect(esito.cancellate).toBe(50);
    // E si arrende dicendo la verita': non «fatto», ma «ne restano nove».
    expect(esito.rimaste).toBe(9);
  });

  it("il token viaggia su ogni passata, non solo sulla prima", async () => {
    // Un `Authorization` allegato fuori dal ciclo — o una variabile letta una
    // volta sola prima di entrarci — reggerebbe il primo giro e prenderebbe 401
    // dal secondo, cioe' solo sui cestini grossi: il difetto che non si vede
    // mai in prova e si vede sempre in mano a chi ha molte schede.
    const passate = [
      { cancellate: 50, saltate: 0, rimaste: 1 },
      { cancellate: 1, saltate: 0, rimaste: 0 },
    ];
    let quale = 0;
    const { fetchImpl, calls } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      [ROTTA]: () => {
        const payload = passate[quale] ?? passate[passate.length - 1];
        quale += 1;
        return { status: 200, payload };
      },
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });
    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });

    await client.emptyTrash();

    expect(calls.slice(1).map((c) => c.authorization)).toEqual([
      "Bearer access-1",
      "Bearer access-1",
    ]);
  });
});

/**
 * L'elenco dei dispositivi collegati.
 *
 * Tre rotte vicine si contendono la stessa parola: `GET /api/auth/sessions`
 * legge, `POST /api/auth/sessions/revoke` chiude tutte le altre,
 * `POST /api/auth/sessions/revoke-one` ne chiude una. Sbagliare percorso qui non
 * produce un errore di compilazione — sono tutte e tre stringhe — e il danno non
 * e' simmetrico: chiedere la lista alla rotta sbagliata scollegherebbe dei
 * dispositivi all'apertura di una schermata, e chiuderne una con il percorso
 * dell'altra le chiuderebbe tutte.
 */
describe("elenco delle sessioni", () => {
  const ROTTA = "GET /api/auth/sessions";

  it("legge, e lo fa con il token che dice di chi e' l'elenco", async () => {
    const { fetchImpl, calls } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      [ROTTA]: () => ({
        status: 200,
        payload: {
          sessions: [
            { id: "fam-questo", createdAt: "2026-04-01T10:00:00.000Z", current: true },
            { id: "fam-altro", createdAt: "2026-03-01T10:00:00.000Z", current: false },
          ],
        },
      }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });
    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });

    const { sessions } = await client.listSessions();

    expect(sessions).toHaveLength(2);
    // Gli id arrivano fino a chi chiama, e nell'ordine in cui il server li ha
    // messi. Sono l'argomento di `revokeSession`: uno schema che li lasciasse
    // cadere — o un `.transform` che li rimescolasse — farebbe premere alla
    // schermata il pulsante di una riga e chiudere il dispositivo di un'altra.
    expect(sessions.map((s) => s.id)).toEqual(["fam-questo", "fam-altro"]);
    // GET e non POST: un verbo sbagliato su `/sessions` non troverebbe nessuna
    // rotta e darebbe un 404, ma un percorso sbagliato con il verbo giusto — un
    // `/sessions/revoke` copiato dal metodo accanto — troverebbe eccome.
    expect(calls[1]?.method).toBe("GET");
    expect(new URL(calls[1]?.url ?? "").pathname).toBe("/api/auth/sessions");
    // Nessun corpo: se ce ne fosse uno, sarebbe una password copiata dal metodo
    // di fianco e spedita a ogni apertura della schermata.
    expect(calls[1]?.body).toBeUndefined();
    expect(calls[1]?.authorization).toBe("Bearer access-1");
  });

  it("una riga senza «id» non passa per una sessione", async () => {
    // Il campo mancante diventerebbe `undefined`, e la schermata costruirebbe
    // pulsanti che spediscono `sessionId: undefined` — cioe' un corpo che il
    // server rifiuta con VALIDATION_FAILED, un rosso incomprensibile su ogni
    // riga. Meglio fermarsi qui, dove il messaggio dice «risposta non conforme»
    // e punta al contratto.
    const { fetchImpl } = stubFetch({
      [ROTTA]: () => ({
        status: 200,
        payload: { sessions: [{ createdAt: "2026-04-01T10:00:00.000Z", current: true }] },
      }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.listSessions()).rejects.toBeInstanceOf(ApiError);
  });

  it("una riga senza «current» non passa per una sessione", async () => {
    // Il campo mancante diventerebbe `undefined`, cioe' falso: la schermata non
    // marcherebbe nessuna riga come «questo dispositivo», e chi legge
    // crederebbe che ce ne sia uno in piu' da scollegare.
    const { fetchImpl } = stubFetch({
      [ROTTA]: () => ({
        status: 200,
        payload: { sessions: [{ id: "fam-questo", createdAt: "2026-04-01T10:00:00.000Z" }] },
      }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.listSessions()).rejects.toBeInstanceOf(ApiError);
  });

  it("un elenco vuoto e' una risposta valida, non un guasto", async () => {
    // Non dovrebbe succedere — chi chiede ha per forza una sessione viva — ma
    // se succedesse, il posto dove accorgersene e' una lista vuota a schermo,
    // non un errore di contratto che nasconde il fatto sotto un «risposta non
    // conforme».
    const { fetchImpl } = stubFetch({
      [ROTTA]: () => ({ status: 200, payload: { sessions: [] } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(client.listSessions()).resolves.toEqual({ sessions: [] });
  });
});

/**
 * Chiuderne una sola.
 *
 * Il metodo e' quasi tutto percorso e corpo — non c'e' niente da calcolare — ed
 * e' proprio per questo che va pinzato qui: gli unici modi di sbagliarlo sono
 * mandare la richiesta a `/sessions/revoke`, che chiude tutto, o dimenticare uno
 * dei due campi, che il server rifiuta senza dire quale schermata ha sbagliato.
 */
describe("chiudere una sessione sola", () => {
  const ROTTA = "POST /api/auth/sessions/revoke-one";

  it("manda id e password al percorso che ne chiude una, non a quello che le chiude tutte", async () => {
    const { fetchImpl, calls } = stubFetch({
      "POST /api/auth/login": () => ({ status: 200, payload: session("1") }),
      [ROTTA]: () => ({ status: 200, payload: { revoked: 1 } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });
    await client.login({ email: "chi@esempio.it", password: "password-lunga-abbastanza" });

    const esito = await client.revokeSession({
      sessionId: "fam-altro",
      currentPassword: "password-lunga-abbastanza",
    });

    expect(esito).toEqual({ revoked: 1 });
    expect(calls[1]?.method).toBe("POST");
    // Il suffisso per intero. `/sessions/revoke` e' un prefisso di
    // `/sessions/revoke-one`, quindi un confronto fatto con `startsWith`
    // altrove — o una riga copiata e accorciata qui — passerebbe di qua e
    // chiuderebbe ogni altro dispositivo dell'utente.
    expect(new URL(calls[1]?.url ?? "").pathname).toBe("/api/auth/sessions/revoke-one");
    // I due campi, e con i nomi che il contratto si aspetta: `sessionId` e non
    // `id`, `currentPassword` e non `password`.
    expect(calls[1]?.body).toEqual({
      sessionId: "fam-altro",
      currentPassword: "password-lunga-abbastanza",
    });
    // Autenticata: senza il token il server non saprebbe di chi e' la famiglia
    // da chiudere, e la password da sola non glielo direbbe.
    expect(calls[1]?.authorization).toBe("Bearer access-1");
  });

  it("uno zero e' una risposta, non un errore", async () => {
    // La riga era gia' chiusa, oppure non era di chi chiede. Il client non ci
    // mette del suo: non alza, non trasforma lo zero in un rifiuto, e lascia
    // decidere alla schermata cosa dirne — che e' l'unica che sa che l'utente
    // aveva appena premuto un pulsante.
    const { fetchImpl } = stubFetch({
      [ROTTA]: () => ({ status: 200, payload: { revoked: 0 } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(
      client.revokeSession({ sessionId: "fam-sparita", currentPassword: "x" }),
    ).resolves.toEqual({ revoked: 0 });
  });

  it("il CONFLICT della propria sessione arriva come ApiError, con il suo codice", async () => {
    // E' la risposta che il server da' a chi chiede di chiudere la sessione da
    // cui sta chiedendo. Il client non la traduce e non la nasconde: il codice
    // serve alla schermata per distinguere «hai premuto la riga sbagliata» da
    // «la password non e' quella».
    const { fetchImpl } = stubFetch({
      [ROTTA]: () => ({
        status: 409,
        payload: { error: { code: "CONFLICT", message: "Questa e' la sessione da cui chiedi" } },
      }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(
      client.revokeSession({ sessionId: "fam-questo", currentPassword: "x" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("una risposta con un campo in piu' non passa", async () => {
    // Lo schema e' `.strict()` di la', e qui si vede il perche': un server che
    // aggiungesse `familyId` alla risposta rimanderebbe indietro l'id che ha
    // appena chiuso, e la schermata se lo ritroverebbe fra le mani senza sapere
    // che farne. Meglio che il ponte si rompa subito.
    const { fetchImpl } = stubFetch({
      [ROTTA]: () => ({ status: 200, payload: { revoked: 1, familyId: "fam-altro" } }),
    });
    const client = createApiClient({
      baseUrl: BASE,
      storage: createInMemorySecureStorage(),
      fetchImpl,
    });

    await expect(
      client.revokeSession({ sessionId: "fam-altro", currentPassword: "x" }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
