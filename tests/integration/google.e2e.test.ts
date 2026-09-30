import { authSessionSchema, errorBodySchema, meResponseSchema } from "@wikimylife/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeGoogleIdTokenVerifier,
  tokenGoogleFinto,
} from "../../apps/api/src/providers/fake/FakeGoogleIdTokenVerifier.js";
import { disconnectTestPrisma, resetDatabase, testPrisma } from "./helpers/db.js";
import { call, startTestServer, type TestServer } from "./helpers/server.js";

/**
 * L'accesso con Google attraverso la rotta vera.
 *
 * Il servizio ha i suoi casi in `tests/unit/auth.google.test.ts`, contro un
 * repository in memoria. Qui si prova cio' che quei casi non vedono: che la
 * rotta esista con quel verbo e quel percorso, che lo schema rifiuti i corpi
 * sbagliati prima del servizio, che la migrazione abbia davvero reso la
 * password facoltativa e il `sub` unico, e che una prova d'identita' con Google
 * cancelli davvero le righe.
 *
 * La firma di Google non c'e': il verificatore e' quello finto, acceso da
 * `GOOGLE_AUTH_PROVIDER=fake`. La firma ha i suoi casi in
 * `googleVerifier.test.ts`, con una chiave RSA vera.
 */

const EMAIL = "utente@wikimylife.test";
const PASSWORD = "password-di-prova-lunga";
const SUB = "sub-google-di-prova";

let aperto: TestServer;
let chiuso: TestServer;
let spento: TestServer;

beforeAll(async () => {
  aperto = await startTestServer({ google: "fake", signupEnabled: true });
  chiuso = await startTestServer({ google: "fake", signupEnabled: false });
  spento = await startTestServer({ signupEnabled: true });
});

afterAll(async () => {
  await Promise.all([aperto.close(), chiuso.close(), spento.close()]);
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase();
});

function token(extra: { sub?: string; email?: string; emailVerified?: boolean } = {}): string {
  return tokenGoogleFinto({ sub: SUB, email: EMAIL, ...extra });
}

function codice(body: unknown): string {
  return errorBodySchema.parse(body).error.code;
}

async function entraConGoogle(server: TestServer = aperto): Promise<{
  accessToken: string;
  userId: string;
}> {
  const res = await call(server, "POST", "/api/auth/google", { body: { idToken: token() } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const sessione = authSessionSchema.parse(res.body);
  return { accessToken: sessione.tokens.accessToken, userId: sessione.user.id };
}

describe("POST /api/auth/google", () => {
  it("con le iscrizioni aperte crea un conto senza password, e /me lo dice", async () => {
    const { accessToken } = await entraConGoogle();

    const me = meResponseSchema.parse(
      (await call(aperto, "GET", "/api/auth/me", { accessToken })).body,
    );
    expect(me.user).toMatchObject({ email: EMAIL, hasPassword: false, hasGoogle: true });

    const riga = await testPrisma().user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(riga.passwordHash).toBeNull();
    expect(riga.googleSub).toBe(SUB);
  });

  it("la seconda volta entra nello stesso conto, e non ne crea un altro", async () => {
    const prima = await entraConGoogle();
    const seconda = await entraConGoogle();

    expect(seconda.userId).toBe(prima.userId);
    expect(await testPrisma().user.count()).toBe(1);
  });

  it("con le iscrizioni chiuse chi non ha un conto riceve 403, e nel database non nasce niente", async () => {
    const res = await call(chiuso, "POST", "/api/auth/google", { body: { idToken: token() } });

    expect(res.status).toBe(403);
    expect(codice(res.body)).toBe("SIGNUP_DISABLED");
    expect(await testPrisma().user.count()).toBe(0);
  });

  it("con le iscrizioni chiuse un conto con la password si collega, e la password vale ancora", async () => {
    const iscritto = await call(aperto, "POST", "/api/auth/signup", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(iscritto.status).toBe(201);

    const res = await call(chiuso, "POST", "/api/auth/google", { body: { idToken: token() } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(authSessionSchema.parse(res.body).user).toMatchObject({
      hasPassword: true,
      hasGoogle: true,
    });

    const login = await call(chiuso, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(login.status).toBe(200);
  });

  it("un indirizzo non garantito da Google e' 403, e il conto con la password resta scollegato", async () => {
    await call(aperto, "POST", "/api/auth/signup", { body: { email: EMAIL, password: PASSWORD } });

    const res = await call(aperto, "POST", "/api/auth/google", {
      body: { idToken: token({ emailVerified: false }) },
    });

    expect(res.status).toBe(403);
    expect(codice(res.body)).toBe("GOOGLE_EMAIL_UNVERIFIED");
    const riga = await testPrisma().user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(riga.googleSub).toBeNull();
  });

  it("un conto gia' collegato a un altro account Google e' 409, e il sub nel database non cambia", async () => {
    // Due difese per la stessa regola — il controllo nel servizio e la
    // scrittura condizionata di `linkGoogle` — e questo caso le attraversa
    // entrambe: il database vero e' l'unico posto dove la seconda si vede.
    await entraConGoogle();

    const res = await call(aperto, "POST", "/api/auth/google", {
      body: { idToken: token({ sub: "un-altro-account-google" }) },
    });

    expect(res.status).toBe(409);
    expect(codice(res.body)).toBe("CONFLICT");
    const riga = await testPrisma().user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(riga.googleSub).toBe(SUB);
  });

  it("un token che Google non riconosce e' 401 GOOGLE_TOKEN_INVALID", async () => {
    const res = await call(aperto, "POST", "/api/auth/google", { body: { idToken: "falso" } });

    expect(res.status).toBe(401);
    expect(codice(res.body)).toBe("GOOGLE_TOKEN_INVALID");
  });

  it("Google che non risponde e' 503, non 401", async () => {
    const google = aperto.composition.google;
    if (!(google instanceof FakeGoogleIdTokenVerifier)) {
      throw new Error("Il server di prova doveva comporre il Google finto: il caso non regge.");
    }
    google.guastoProssimo();

    const res = await call(aperto, "POST", "/api/auth/google", { body: { idToken: token() } });

    expect(res.status).toBe(503);
    expect(codice(res.body)).toBe("SERVICE_UNAVAILABLE");
  });

  it("con Google spento la rotta risponde 404 GOOGLE_DISABLED, anche a un token buono", async () => {
    const res = await call(spento, "POST", "/api/auth/google", { body: { idToken: token() } });

    expect(res.status).toBe(404);
    expect(codice(res.body)).toBe("GOOGLE_DISABLED");
  });

  it("un corpo senza token, o con un campo in piu', si ferma allo schema", async () => {
    const senza = await call(aperto, "POST", "/api/auth/google", { body: {} });
    const conAltro = await call(aperto, "POST", "/api/auth/google", {
      body: { idToken: token(), email: "altro@esempio.it" },
    });

    expect(senza.status).toBe(400);
    expect(codice(senza.body)).toBe("VALIDATION_FAILED");
    // Il campo in piu' e' un indirizzo: se passasse, un client potrebbe
    // credere di aver scelto con quale email entrare. L'indirizzo lo dice
    // Google, e solo lui.
    expect(conAltro.status).toBe(400);
  });
});

describe("la password su un conto nato con Google", () => {
  it("il login con una password qualunque e' 401 INVALID_CREDENTIALS", async () => {
    await entraConGoogle();

    const res = await call(aperto, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD },
    });

    expect(res.status).toBe(401);
    expect(codice(res.body)).toBe("INVALID_CREDENTIALS");
  });
});

describe("Google come prova d'identita', sulla rotta vera", () => {
  it("un conto solo Google si cancella confermando con Google", async () => {
    const { accessToken, userId } = await entraConGoogle();

    const res = await call(aperto, "POST", "/api/auth/delete-account", {
      accessToken,
      body: { googleIdToken: token() },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await testPrisma().user.findUnique({ where: { id: userId } })).toBeNull();
  });

  it("la conferma di un altro account Google non cancella niente", async () => {
    const { accessToken, userId } = await entraConGoogle();

    const res = await call(aperto, "POST", "/api/auth/delete-account", {
      accessToken,
      body: { googleIdToken: token({ sub: "un-altro-account" }) },
    });

    expect(res.status).toBe(401);
    expect(codice(res.body)).toBe("INVALID_CREDENTIALS");
    expect(await testPrisma().user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it("un corpo con la password e il token insieme e' rifiutato dallo schema", async () => {
    const { accessToken, userId } = await entraConGoogle();

    const res = await call(aperto, "POST", "/api/auth/delete-account", {
      accessToken,
      body: { googleIdToken: token(), currentPassword: PASSWORD },
    });

    // Le due prove si escludono: con entrambe, il servizio dovrebbe scegliere
    // quale guardare, e la scelta sarebbe un posto dove nascondere un errore.
    expect(res.status).toBe(400);
    expect(await testPrisma().user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it("un corpo senza nessuna prova e' rifiutato dallo schema", async () => {
    const { accessToken, userId } = await entraConGoogle();

    const res = await call(aperto, "POST", "/api/auth/delete-account", { accessToken, body: {} });

    expect(res.status).toBe(400);
    expect(await testPrisma().user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it("chi e' entrato solo con Google si da' una password, e poi entra con quella", async () => {
    const { accessToken } = await entraConGoogle();

    const cambio = await call(aperto, "POST", "/api/auth/password", {
      accessToken,
      body: { googleIdToken: token(), newPassword: PASSWORD },
    });
    expect(cambio.status, JSON.stringify(cambio.body)).toBe(200);
    expect(authSessionSchema.parse(cambio.body).user.hasPassword).toBe(true);

    const login = await call(aperto, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(login.status).toBe(200);
  });
});
