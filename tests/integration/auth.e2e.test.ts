import {
  authSessionSchema,
  errorBodySchema,
  meResponseSchema,
  openSessionsResponseSchema,
  type AuthSession,
  type OpenSessionsResponse,
} from "@wikimylife/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectTestPrisma, resetDatabase, testPrisma } from "./helpers/db.js";
import { call, startTestServer, type TestServer } from "./helpers/server.js";

/**
 * L'autenticazione contro Postgres vero, attraverso HTTP vero.
 *
 * `auth.service.test.ts` copre gia' la stessa logica con un repository in
 * memoria, e lo fa piu' velocemente. Questo file non lo duplica per pigrizia:
 * la reuse detection e' scritta come una transazione, e una transazione e'
 * proprio la cosa che un repository in memoria non puo' verificare. Un
 * `InMemoryAuthRepository` esegue le quattro operazioni della rotazione in
 * sequenza, sempre, senza mai poter fallire a meta'. Postgres puo'.
 *
 * Il test sul riuso e' il piu' importante della fase: e' l'unico punto dove un
 * bug e' un problema di sicurezza e non di prodotto.
 */

const EMAIL = "utente@wikimylife.test";
const PASSWORD = "password-di-prova-lunga";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase();
});

interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
}

async function signup(email = EMAIL): Promise<Session> {
  const res = await call(server, "POST", "/api/auth/signup", {
    body: { email, password: PASSWORD },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const session = authSessionSchema.parse(res.body);
  return {
    accessToken: session.tokens.accessToken,
    refreshToken: session.tokens.refreshToken,
    userId: session.user.id,
  };
}

async function refresh(refreshToken: string): Promise<{ status: number; body: unknown }> {
  return call(server, "POST", "/api/auth/refresh", { body: { refreshToken } });
}

function errorCode(body: unknown): string {
  return errorBodySchema.parse(body).error.code;
}

describe("health", () => {
  it("riporta il database raggiungibile", async () => {
    const res = await call(server, "GET", "/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", db: "up" });
  });

  it("ogni risposta porta un x-request-id", async () => {
    // E' il filo che lega una risposta 500 anonima allo stack su stderr.
    const res = await call(server, "GET", "/health");

    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("signup", () => {
  it("crea l'utente e restituisce una sessione completa", async () => {
    const res = await call(server, "POST", "/api/auth/signup", {
      body: { email: EMAIL, password: PASSWORD },
    });

    expect(res.status).toBe(201);
    const session = authSessionSchema.parse(res.body);
    expect(session.user.email).toBe(EMAIL);
    expect(session.tokens.tokenType).toBe("Bearer");
  });

  it("la password non torna indietro in nessuna forma", async () => {
    const res = await call(server, "POST", "/api/auth/signup", {
      body: { email: EMAIL, password: PASSWORD },
    });

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain("argon2");
    expect(serialized).not.toContain("passwordHash");
  });

  it("nel database c'e' solo l'hash", async () => {
    await signup();
    const user = await testPrisma().user.findUniqueOrThrow({ where: { email: EMAIL } });

    expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(user.passwordHash).not.toContain(PASSWORD);
  });

  it("rifiuta un'email gia' registrata", async () => {
    await signup();
    const res = await call(server, "POST", "/api/auth/signup", {
      body: { email: EMAIL, password: PASSWORD },
    });

    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe("EMAIL_TAKEN");
  });

  it("l'email e' normalizzata: maiuscole e spazi non creano un secondo account", async () => {
    // Il vincolo unique e' su una colonna, quindi la normalizzazione deve
    // avvenire prima. Senza, "Utente@..." e "utente@..." sarebbero due utenti e
    // uno dei due non riuscirebbe mai a fare login.
    await signup();
    const res = await call(server, "POST", "/api/auth/signup", {
      body: { email: `  ${EMAIL.toUpperCase()}  `, password: PASSWORD },
    });

    expect(res.status).toBe(409);
  });

  it("rifiuta una password troppo corta con i dettagli della validazione", async () => {
    const res = await call(server, "POST", "/api/auth/signup", {
      body: { email: EMAIL, password: "corta" },
    });

    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(res.body);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details?.some((d) => d.path.includes("password"))).toBe(true);
  });

  it("rifiuta campi sconosciuti nel corpo", async () => {
    const res = await call(server, "POST", "/api/auth/signup", {
      body: { email: EMAIL, password: PASSWORD, isAdmin: true },
    });

    expect(res.status).toBe(400);
  });
});

describe("signup disabilitato", () => {
  it("chiude la registrazione senza toccare il resto dell'auth", async () => {
    const closed = await startTestServer({ signupEnabled: false });
    try {
      const res = await call(closed, "POST", "/api/auth/signup", {
        body: { email: EMAIL, password: PASSWORD },
      });

      expect(res.status).toBe(403);
      expect(errorCode(res.body)).toBe("SIGNUP_DISABLED");
    } finally {
      await closed.close();
    }
  });
});

describe("login", () => {
  beforeEach(async () => {
    await signup();
  });

  it("restituisce una sessione nuova", async () => {
    const res = await call(server, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD },
    });

    expect(res.status).toBe(200);
    expect(authSessionSchema.parse(res.body).user.email).toBe(EMAIL);
  });

  it("apre una famiglia di refresh token nuova", async () => {
    // Login e refresh sono cose diverse: un login non deve prolungare la
    // catena precedente, altrimenti revocare una sessione compromessa
    // ucciderebbe anche quella appena aperta dall'utente legittimo.
    const uno = await call(server, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD },
    });
    const due = await call(server, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD },
    });

    expect(uno.status).toBe(200);
    expect(due.status).toBe(200);

    const famiglie = await testPrisma().refreshToken.findMany({ select: { familyId: true } });
    expect(new Set(famiglie.map((f) => f.familyId)).size).toBe(3); // signup + due login
  });

  it("password sbagliata: 401 INVALID_CREDENTIALS", async () => {
    const res = await call(server, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: "password-sbagliata-lunga" },
    });

    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("INVALID_CREDENTIALS");
  });

  it("utente inesistente: la stessa identica risposta", async () => {
    // Distinguere "utente inesistente" da "password errata" regalerebbe un
    // enumeratore di account: bastano richieste di login per sapere chi e'
    // registrato.
    const sbagliata = await call(server, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: "password-sbagliata-lunga" },
    });
    const inesistente = await call(server, "POST", "/api/auth/login", {
      body: { email: "nessuno@wikimylife.test", password: PASSWORD },
    });

    expect(inesistente.status).toBe(sbagliata.status);
    expect(inesistente.body).toEqual(sbagliata.body);
  });

  it("nessun refresh token viene emesso per un login fallito", async () => {
    const prima = await testPrisma().refreshToken.count();
    await call(server, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: "password-sbagliata-lunga" },
    });

    expect(await testPrisma().refreshToken.count()).toBe(prima);
  });
});

describe("GET /me", () => {
  it("con Bearer valido restituisce l'utente", async () => {
    const session = await signup();
    const res = await call(server, "GET", "/api/auth/me", {
      accessToken: session.accessToken,
    });

    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(res.body).user.id).toBe(session.userId);
  });

  it("senza header: 401 UNAUTHORIZED", async () => {
    const res = await call(server, "GET", "/api/auth/me");

    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("UNAUTHORIZED");
  });

  it("con uno schema diverso da Bearer: 401", async () => {
    const response = await fetch(`${server.url}/api/auth/me`, {
      headers: { authorization: "Basic dXRlbnRlOnBhc3N3b3Jk" },
    });

    expect(response.status).toBe(401);
  });

  it("con un token inventato: 401 TOKEN_INVALID", async () => {
    const res = await call(server, "GET", "/api/auth/me", { accessToken: "non-un-jwt" });

    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("TOKEN_INVALID");
  });

  it("un refresh token non vale come access token", async () => {
    // Sono due cose diverse: uno e' un JWT firmato che vive 15 minuti, l'altro
    // 32 byte opachi che vivono 30 giorni. Accettare il secondo dove serve il
    // primo annullerebbe il TTL breve.
    const session = await signup();
    const res = await call(server, "GET", "/api/auth/me", {
      accessToken: session.refreshToken,
    });

    expect(res.status).toBe(401);
  });
});

describe("refresh", () => {
  it("ruota la coppia: entrambi i token cambiano", async () => {
    const session = await signup();
    const res = await refresh(session.refreshToken);

    expect(res.status).toBe(200);
    const rotated = authSessionSchema.parse(res.body);
    expect(rotated.tokens.refreshToken).not.toBe(session.refreshToken);
    expect(rotated.tokens.accessToken).not.toBe(session.accessToken);
  });

  it("il nuovo access token funziona su /me", async () => {
    const session = await signup();
    const rotated = authSessionSchema.parse((await refresh(session.refreshToken)).body);

    const me = await call(server, "GET", "/api/auth/me", {
      accessToken: rotated.tokens.accessToken,
    });

    expect(me.status).toBe(200);
  });

  it("resta nella stessa famiglia e marca il vecchio come sostituito", async () => {
    const session = await signup();
    await refresh(session.refreshToken);

    const rows = await testPrisma().refreshToken.findMany({ orderBy: { issuedAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.familyId).toBe(rows[1]?.familyId);
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect(rows[0]?.replacedById).toBe(rows[1]?.id);
    expect(rows[1]?.revokedAt).toBeNull();
  });

  it("il token in chiaro non e' mai nel database", async () => {
    const session = await signup();
    const rows = await testPrisma().refreshToken.findMany();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(session.refreshToken);
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("un token inesistente: 401 TOKEN_INVALID", async () => {
    const res = await refresh("token-mai-emesso");

    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("TOKEN_INVALID");
  });

  it("catene multiple restano indipendenti", async () => {
    const a = await signup("a@wikimylife.test");
    const b = await signup("b@wikimylife.test");

    await refresh(a.refreshToken);
    // Il token di B e' ancora quello iniziale e deve continuare a valere.
    expect((await refresh(b.refreshToken)).status).toBe(200);
  });
});

describe("riuso di un refresh token", () => {
  it("risponde 401 TOKEN_REUSED", async () => {
    const session = await signup();
    await refresh(session.refreshToken); // rotazione legittima

    const riuso = await refresh(session.refreshToken);

    expect(riuso.status).toBe(401);
    expect(errorCode(riuso.body)).toBe("TOKEN_REUSED");
  });

  it("uccide anche la coppia nuova, appena emessa", async () => {
    // E' il cuore del meccanismo. Al momento del riuso il server non puo'
    // sapere chi sia il ladro: se il token rubato viene presentato dopo la
    // rotazione legittima, l'attaccante ha una copia; se prima, ce l'ha
    // l'utente. In entrambi i casi la coppia in circolazione e' compromessa, e
    // l'unica risposta corretta e' chiudere tutto e costringere a rifare login.
    //
    // Un'implementazione che revocasse solo il token riusato lascerebbe
    // all'attaccante una catena valida per trenta giorni, e il test qui sopra
    // passerebbe lo stesso.
    const session = await signup();
    const rotated = authSessionSchema.parse((await refresh(session.refreshToken)).body);

    await refresh(session.refreshToken); // riuso

    const dopo = await refresh(rotated.tokens.refreshToken);
    expect(dopo.status).toBe(401);
    expect(errorCode(dopo.body)).toBe("TOKEN_REUSED");
  });

  it("revoca ogni token della famiglia nel database", async () => {
    const session = await signup();
    await refresh(session.refreshToken);
    await refresh(session.refreshToken);

    const rows = await testPrisma().refreshToken.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it("non emette nessuna sessione", async () => {
    const session = await signup();
    await refresh(session.refreshToken);
    const prima = await testPrisma().refreshToken.count();

    await refresh(session.refreshToken);

    expect(await testPrisma().refreshToken.count()).toBe(prima);
  });

  it("non tocca le altre famiglie dello stesso utente", async () => {
    // Un secondo dispositivo dello stesso utente non deve essere buttato fuori
    // perche' il primo ha avuto un problema: la revoca e' per catena, non per
    // account.
    const primoDispositivo = await signup();
    const secondoDispositivo = authSessionSchema.parse(
      (
        await call(server, "POST", "/api/auth/login", {
          body: { email: EMAIL, password: PASSWORD },
        })
      ).body,
    );

    await refresh(primoDispositivo.refreshToken);
    await refresh(primoDispositivo.refreshToken); // riuso

    expect((await refresh(secondoDispositivo.tokens.refreshToken)).status).toBe(200);
  });

  it("il riuso spegne anche gli access token gia' emessi", async () => {
    // Qui c'era il test opposto, e la sua motivazione era scritta bene:
    // revocare un JWT costa una lettura del database a ogni richiesta, che e'
    // esattamente il costo che l'access token esiste per evitare. Il conto pero'
    // era incompleto. Nessuna rotta protetta si concludeva senza interrogare
    // Postgres per fare il proprio lavoro, quindi la lettura in piu' e' una
    // riga su un indice dentro un giro che il database faceva comunque; e cio'
    // che si comprava con quel risparmio era un quarto d'ora di accesso pieno
    // per chi avesse rubato un token, contato a partire dal momento in cui il
    // furto e' stato scoperto.
    //
    // Il claim `fid` nel token e una `SELECT` su `familyId` chiudono la
    // finestra. Questo caso e' il motivo per cui valeva la pena.
    const session = await signup();
    await refresh(session.refreshToken);
    await refresh(session.refreshToken); // riuso: la famiglia muore

    const me = await call(server, "GET", "/api/auth/me", { accessToken: session.accessToken });
    expect(me.status).toBe(401);
  });

  it("prima del riuso lo stesso access token apriva", async () => {
    // Il caso di sopra da solo passerebbe anche con un access token rotto per
    // qualunque altro motivo — un claim scritto male, una firma sbagliata, un
    // 401 che c'era gia' prima. Questo dice che l'unica differenza fra i due e'
    // il riuso.
    const session = await signup();
    await refresh(session.refreshToken);

    const me = await call(server, "GET", "/api/auth/me", { accessToken: session.accessToken });
    expect(me.status).toBe(200);
  });
});

describe("logout", () => {
  it("revoca il token corrente", async () => {
    const session = await signup();

    const res = await call(server, "POST", "/api/auth/logout", {
      body: { refreshToken: session.refreshToken },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("dopo il logout il refresh non funziona piu'", async () => {
    const session = await signup();
    await call(server, "POST", "/api/auth/logout", {
      body: { refreshToken: session.refreshToken },
    });

    const res = await refresh(session.refreshToken);
    expect(res.status).toBe(401);
  });

  it("su un token sconosciuto risponde comunque ok", async () => {
    // Un logout che fallisce lascia il client in uno stato ambiguo: ha buttato
    // via i token locali ma ha ricevuto un errore. Non c'e' niente da
    // proteggere qui — il token o esiste ed e' revocato, o non esiste.
    const res = await call(server, "POST", "/api/auth/logout", {
      body: { refreshToken: "mai-esistito" },
    });

    expect(res.status).toBe(200);
  });

  it("non tocca le altre sessioni", async () => {
    const uno = await signup();
    const due = authSessionSchema.parse(
      (
        await call(server, "POST", "/api/auth/login", {
          body: { email: EMAIL, password: PASSWORD },
        })
      ).body,
    );

    await call(server, "POST", "/api/auth/logout", { body: { refreshToken: uno.refreshToken } });

    expect((await refresh(due.tokens.refreshToken)).status).toBe(200);
  });

  it("dopo il logout l'access token non apre piu' niente", async () => {
    // La promessa che "esci" fa. Il refresh moriva gia' — lo dice il caso qui
    // sopra — ma l'access token campava fino a quindici minuti, cioe' per tutto
    // il tempo che serve a chi ha in mano un telefono rubato.
    const session = await signup();
    expect(
      (await call(server, "GET", "/api/auth/me", { accessToken: session.accessToken })).status,
    ).toBe(200);

    await call(server, "POST", "/api/auth/logout", {
      body: { refreshToken: session.refreshToken },
    });

    const me = await call(server, "GET", "/api/auth/me", { accessToken: session.accessToken });
    expect(me.status).toBe(401);
    // UNAUTHORIZED e non TOKEN_REUSED: il client ritenta la rotazione su
    // qualunque 401 tranne quello, e chi ha solo chiuso un'altra sessione deve
    // poter tentare — fallira', ma finendo sulla schermata di ingresso invece
    // che su un errore che nessuna schermata sa mostrare.
    expect(errorCode(me.body)).toBe("UNAUTHORIZED");
  });

  it("uscire da un dispositivo non chiude l'access token dell'altro", async () => {
    // Il prezzo da non pagare per la revoca. Se la sessione fosse per utente
    // invece che per famiglia, "esci dal telefono" spegnerebbe anche il
    // portatile: nessuno l'ha chiesto, e sarebbe una regressione peggiore del
    // problema risolto.
    const telefono = await signup();
    const portatile = authSessionSchema.parse(
      (
        await call(server, "POST", "/api/auth/login", {
          body: { email: EMAIL, password: PASSWORD },
        })
      ).body,
    );

    await call(server, "POST", "/api/auth/logout", {
      body: { refreshToken: telefono.refreshToken },
    });

    expect(
      (await call(server, "GET", "/api/auth/me", { accessToken: telefono.accessToken })).status,
    ).toBe(401);
    expect(
      (
        await call(server, "GET", "/api/auth/me", {
          accessToken: portatile.tokens.accessToken,
        })
      ).status,
    ).toBe(200);
  });

  it("una rotazione normale non invalida l'access token gia' in mano", async () => {
    // Lo sbaglio opposto, e l'unico che si vedrebbe subito in produzione: se la
    // revoca del vecchio refresh contasse come sessione chiusa, ogni rinnovo
    // farebbe cadere le richieste ancora in volo con il token precedente.
    const session = await signup();
    const ruotata = await refresh(session.refreshToken);
    expect(ruotata.status).toBe(200);

    const me = await call(server, "GET", "/api/auth/me", { accessToken: session.accessToken });
    expect(me.status).toBe(200);

    // E quello nuovo apre a sua volta: la rotazione allunga la catena, non
    // apre una famiglia che il database non conosce.
    const nuovo = authSessionSchema.parse(ruotata.body).tokens.accessToken;
    expect((await call(server, "GET", "/api/auth/me", { accessToken: nuovo })).status).toBe(200);
  });
});

describe("cambio password", () => {
  const NUOVA = "una-password-nuova-lunga";

  async function login(email = EMAIL, password = PASSWORD): Promise<{ status: number; body: unknown }> {
    return call(server, "POST", "/api/auth/login", { body: { email, password } });
  }

  async function cambia(
    accessToken: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return call(server, "POST", "/api/auth/password", { accessToken, body });
  }

  it("chiude ogni sessione dell'utente, su tutti i dispositivi", async () => {
    // La differenza fra questo e il logout, in una riga: li' muore una catena,
    // qui muoiono tutte. E' il gesto per quando non si sa piu' chi abbia la
    // password, e risparmiare una sessione vorrebbe dire risparmiare proprio
    // quella di cui si sospetta.
    const telefono = await signup();
    const portatile = authSessionSchema.parse((await login()).body);

    const res = await cambia(telefono.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NUOVA,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect((await refresh(portatile.tokens.refreshToken)).status).toBe(401);
    expect(
      (
        await call(server, "GET", "/api/auth/me", {
          accessToken: portatile.tokens.accessToken,
        })
      ).status,
    ).toBe(401);
  });

  it("la sessione restituita apre, e quella con cui si e' chiamato no", async () => {
    // I due lati dello stesso istante, e il motivo per cui la risposta contiene
    // token e non un `ok`: la credenziale con cui il client ha chiesto e' morta
    // nel momento in cui ha ottenuto risposta.
    const prima = await signup();

    const res = await cambia(prima.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NUOVA,
    });
    const dopo = authSessionSchema.parse(res.body);

    expect(
      (await call(server, "GET", "/api/auth/me", { accessToken: dopo.tokens.accessToken })).status,
    ).toBe(200);
    expect((await refresh(dopo.tokens.refreshToken)).status).toBe(200);

    expect(
      (await call(server, "GET", "/api/auth/me", { accessToken: prima.accessToken })).status,
    ).toBe(401);
  });

  it("le due scritture cadono insieme: password nuova e sessioni chiuse", async () => {
    // La transazione, vista da fuori. Un cambio che avesse revocato senza
    // scrivere la password lascerebbe passare il vecchio login; uno che avesse
    // scritto senza revocare lascerebbe dentro chi c'era.
    const session = await signup();
    await call(server, "POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD } });
    await cambia(session.accessToken, { currentPassword: PASSWORD, newPassword: NUOVA });

    // Prima di aprire altre sessioni: delle tre catene che esistevano — signup,
    // login, e quella nata dal cambio — ne resta viva una sola, l'ultima.
    // Contato sul database e non attraverso HTTP, perche' una revoca parziale
    // si vedrebbe solo qui.
    const vivi = await testPrisma().refreshToken.count({
      where: { userId: session.userId, revokedAt: null },
    });
    expect(vivi).toBe(1);

    expect((await login(EMAIL, NUOVA)).status).toBe(200);

    const vecchio = await login(EMAIL, PASSWORD);
    expect(vecchio.status).toBe(401);
    expect(errorCode(vecchio.body)).toBe("INVALID_CREDENTIALS");
  });

  it("senza access token non si cambia niente", async () => {
    const session = await signup();

    const res = await call(server, "POST", "/api/auth/password", {
      body: { currentPassword: PASSWORD, newPassword: NUOVA },
    });

    expect(res.status).toBe(401);
    expect((await login(EMAIL, PASSWORD)).status).toBe(200);
    expect((await refresh(session.refreshToken)).status).toBe(200);
  });

  it("con la password attuale sbagliata non revoca niente", async () => {
    // Il caso che trasformerebbe un access token rubato in un pulsante "butta
    // fuori il proprietario": se il rifiuto arrivasse dopo la revoca, chi non
    // sa la password potrebbe comunque scollegare tutti gli altri dispositivi.
    const session = await signup();

    const res = await cambia(session.accessToken, {
      currentPassword: "non-e-quella-giusta",
      newPassword: NUOVA,
    });

    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("INVALID_CREDENTIALS");
    expect((await refresh(session.refreshToken)).status).toBe(200);
    expect((await login(EMAIL, PASSWORD)).status).toBe(200);
  });

  it("rifiuta la stessa password con CONFLICT, e lascia tutto in piedi", async () => {
    const session = await signup();

    const res = await cambia(session.accessToken, {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });

    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe("CONFLICT");
    expect((await refresh(session.refreshToken)).status).toBe(200);
  });

  it("rifiuta una password nuova troppo corta prima di guardare la vecchia", async () => {
    const session = await signup();

    const res = await cambia(session.accessToken, {
      currentPassword: PASSWORD,
      newPassword: "corta",
    });

    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
    expect((await refresh(session.refreshToken)).status).toBe(200);
  });

  it("non tocca le sessioni di un altro utente", async () => {
    const mio = await signup();
    const altro = await signup("altro@wikimylife.test");

    await cambia(mio.accessToken, { currentPassword: PASSWORD, newPassword: NUOVA });

    expect(
      (await call(server, "GET", "/api/auth/me", { accessToken: altro.accessToken })).status,
    ).toBe(200);
    expect((await refresh(altro.refreshToken)).status).toBe(200);
  });

  it("le righe revocate restano: la reuse detection ha ancora di che accorgersi", async () => {
    // Se il cambio password cancellasse invece di revocare, un refresh token
    // rubato prima del cambio tornerebbe come TOKEN_INVALID — un 401 qualunque
    // — invece di far scattare la revoca di famiglia.
    const session = await signup();
    await cambia(session.accessToken, { currentPassword: PASSWORD, newPassword: NUOVA });

    const res = await refresh(session.refreshToken);
    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("TOKEN_REUSED");
  });
});

/**
 * «Scollega gli altri dispositivi», contro il database vero.
 *
 * Qui la parte che non si puo' provare in memoria e' la clausola: `WHERE userId
 * = ... AND familyId <> ... AND revokedAt IS NULL` e' una riga sola, e ognuno
 * dei tre pezzi, tolto, produce un guasto che i tipi non vedono. Senza
 * `userId`, il gesto scollega i dispositivi di tutti; senza il `<>`, scollega
 * anche chi ha premuto; senza `revokedAt IS NULL`, il numero in risposta conta
 * anche le sessioni chiuse settimane fa.
 *
 * L'altra meta' e' che `requireAuth` porti davvero la famiglia fino alla rotta.
 * In memoria il servizio la riceve come parametro e il caso la sceglie; qui
 * deve uscire dal claim `fid` di un access token vero, attraversare il
 * middleware e arrivare intera — e se si perdesse per strada, l'unico modo di
 * accorgersene e' che la sessione del chiamante cada insieme alle altre.
 */
describe("scollega gli altri dispositivi", () => {
  async function login(): Promise<AuthSession> {
    const res = await call(server, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return authSessionSchema.parse(res.body);
  }

  async function scollega(
    accessToken: string,
    body: unknown = { currentPassword: PASSWORD },
  ): Promise<{ status: number; body: unknown }> {
    return call(server, "POST", "/api/auth/sessions/revoke", { accessToken, body });
  }

  async function apre(accessToken: string): Promise<number> {
    return (await call(server, "GET", "/api/auth/me", { accessToken })).status;
  }

  it("chiude gli altri e lascia intatto il proprio, token compresi", async () => {
    const telefono = await signup();
    const portatile = await login();
    const tablet = await login();

    const res = await scollega(telefono.accessToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ revoked: 2 });

    expect((await refresh(portatile.tokens.refreshToken)).status).toBe(401);
    expect(await apre(tablet.tokens.accessToken)).toBe(401);

    // Il caso per cui esiste il claim `fid` nel contesto autenticato. Se la
    // famiglia non arrivasse fino alla clausola, questi due sarebbero 401 come
    // gli altri, e la risposta — che non contiene nessun token — non avrebbe
    // modo di rimediare: chi ha premuto il pulsante si troverebbe fuori
    // dall'account che stava mettendo in sicurezza.
    expect(await apre(telefono.accessToken)).toBe(200);
    expect((await refresh(telefono.refreshToken)).status).toBe(200);
  });

  it("risparmia la famiglia anche dopo che ha ruotato", async () => {
    const telefono = await signup();
    await login();
    // La rotazione tiene la famiglia e cambia il token: e' la condizione
    // normale di un dispositivo usato da piu' di un quarto d'ora.
    const ruotata = authSessionSchema.parse((await refresh(telefono.refreshToken)).body);

    const res = await scollega(ruotata.tokens.accessToken);
    expect(res.body).toEqual({ revoked: 1 });

    expect(await apre(ruotata.tokens.accessToken)).toBe(200);
    expect((await refresh(ruotata.tokens.refreshToken)).status).toBe(200);
  });

  it("non conta le sessioni gia' chiuse, e non le riscrive", async () => {
    const telefono = await signup();
    const perduto = await login();
    await call(server, "POST", "/api/auth/logout", {
      body: { refreshToken: perduto.tokens.refreshToken },
    });

    const primaDelGesto = await testPrisma().refreshToken.findFirst({
      where: { userId: telefono.userId, revokedAt: { not: null } },
      select: { id: true, revokedAt: true },
    });

    const res = await scollega(telefono.accessToken);
    expect(res.body).toEqual({ revoked: 0 });

    // `revokedAt IS NULL` nella clausola serve a due cose insieme: il numero, e
    // l'istante. Senza, la revoca di stasera sovrascriverebbe la data di un
    // logout di tre settimane fa, e quella data e' l'unica traccia di quando
    // una sessione e' stata chiusa davvero.
    const dopoIlGesto = await testPrisma().refreshToken.findUnique({
      where: { id: primaDelGesto?.id ?? "" },
      select: { revokedAt: true },
    });
    expect(dopoIlGesto?.revokedAt?.getTime()).toBe(primaDelGesto?.revokedAt?.getTime());
  });

  it("le righe revocate restano, come dopo ogni altra revoca", async () => {
    const telefono = await signup();
    const portatile = await login();
    await scollega(telefono.accessToken);

    // Una `deleteMany` al posto di `updateMany` passerebbe ogni caso di sopra e
    // spegnerebbe la reuse detection: il token del dispositivo perduto, tornando
    // domani, sarebbe un TOKEN_INVALID qualunque invece di un riuso che uccide
    // la catena e si fa notare.
    const riga = await testPrisma().refreshToken.count({
      where: { userId: telefono.userId, revokedAt: { not: null } },
    });
    expect(riga).toBe(1);
    expect(errorCode((await refresh(portatile.tokens.refreshToken)).body)).toBe("TOKEN_REUSED");
  });

  it("non tocca le sessioni di un altro utente", async () => {
    const mio = await signup();
    const altro = await signup("altra@wikimylife.test");

    const res = await scollega(mio.accessToken);
    expect(res.body).toEqual({ revoked: 0 });

    expect(await apre(altro.accessToken)).toBe(200);
    expect((await refresh(altro.refreshToken)).status).toBe(200);
  });

  it("con la password sbagliata non scollega niente", async () => {
    const telefono = await signup();
    const portatile = await login();

    const res = await scollega(telefono.accessToken, { currentPassword: "non-e-questa" });
    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("INVALID_CREDENTIALS");

    // Il campo che sembra un fastidio. Senza, chiunque abbia in mano il telefono
    // sbloccato potrebbe premere il pulsante e restare l'unico collegato,
    // buttando fuori il proprietario da tutto il resto.
    expect((await refresh(portatile.tokens.refreshToken)).status).toBe(200);
  });

  it("senza access token non scollega niente", async () => {
    const telefono = await signup();

    const res = await call(server, "POST", "/api/auth/sessions/revoke", {
      body: { currentPassword: PASSWORD },
    });
    expect(res.status).toBe(401);

    expect((await refresh(telefono.refreshToken)).status).toBe(200);
  });

  it("non cambia la password", async () => {
    const telefono = await signup();
    await scollega(telefono.accessToken);

    // La riga che separa questa rotta da `/auth/password`. Se cadesse, chi la
    // usa proprio per non toccare la propria password si troverebbe fuori da
    // ogni posto in cui l'aveva salvata.
    expect((await login()).tokens).toBeDefined();
  });

  it("rifiuta un corpo senza password, e un corpo con campi in piu'", async () => {
    const telefono = await signup();

    const vuoto = await scollega(telefono.accessToken, {});
    expect(vuoto.status).toBe(400);
    expect(errorCode(vuoto.body)).toBe("VALIDATION_FAILED");

    // `.strict()`: un `familyId` mandato dal client verrebbe ignorato in
    // silenzio da uno schema permissivo, e chi lo ha scritto crederebbe di
    // poter scegliere quale sessione risparmiare.
    const inPiu = await scollega(telefono.accessToken, {
      currentPassword: PASSWORD,
      familyId: "quella-che-dico-io",
    });
    expect(inPiu.status).toBe(400);
    expect(errorCode(inPiu.body)).toBe("VALIDATION_FAILED");
  });
});

/**
 * L'elenco delle sessioni aperte, contro Postgres vero.
 *
 * `auth.service.test.ts` prova la stessa logica piu' in fretta, e non basta: qui
 * ci sono due cose che il repository in memoria non puo' sbagliare come le
 * sbaglia il database. La prima e' il `groupBy` con `_min` — l'aggregazione che
 * distingue la nascita di una famiglia dalla sua ultima rotazione la fa
 * Postgres, e il doppio in memoria la rifa' a mano con un `for`. La seconda e'
 * il routing: `GET /sessions` e `POST /sessions/revoke` condividono un prefisso,
 * e chi decide se si pestano i piedi e' Express, che nei test unitari non c'e'.
 */
describe("elenco delle sessioni aperte", () => {
  async function login(): Promise<AuthSession> {
    const res = await call(server, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return authSessionSchema.parse(res.body);
  }

  async function elenco(accessToken: string): Promise<OpenSessionsResponse> {
    const res = await call(server, "GET", "/api/auth/sessions", { accessToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Parsato con lo schema `.strict()` e non letto a mano: e' cio' che fa
    // fallire il caso se un giorno il `familyId` uscisse dal servizio insieme
    // agli altri due campi.
    return openSessionsResponseSchema.parse(res.body);
  }

  it("un dispositivo per login, e una sola riga e' quella da cui si chiede", async () => {
    const telefono = await signup();
    await login();
    await login();

    const { sessions } = await elenco(telefono.accessToken);

    expect(sessions).toHaveLength(3);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.filter((s) => !s.current)).toHaveLength(2);

    // Dalla piu' recente. Il `groupBy` non ha un ordine — Postgres restituisce i
    // gruppi come gli conviene — quindi se la `sort` nell'adattatore sparisse la
    // lista cambierebbe ordine da una lettura all'altra senza che niente sia
    // cambiato. Che il dispositivo di questa richiesta sia l'ultimo dice che
    // l'ordine c'e' davvero: e' il primo dei tre ad essersi collegato.
    const date = sessions.map((s) => s.createdAt);
    expect(date).toEqual([...date].sort().reverse());
    expect(sessions[2]?.current).toBe(true);
  });

  it("una rotazione non aggiunge una riga, e non sposta la data", async () => {
    const telefono = await signup();
    const prima = await elenco(telefono.accessToken);

    const ruotata = authSessionSchema.parse((await refresh(telefono.refreshToken)).body);
    const dopo = await elenco(ruotata.tokens.accessToken);

    // Una riga sola: la famiglia adesso ha due token nel database, e contarli
    // invece di raggrupparli farebbe comparire un secondo dispositivo che non
    // esiste — uno in piu' a ogni quarto d'ora di uso.
    expect(dopo.sessions).toHaveLength(1);
    // E la stessa data: e' il `_min` che lo garantisce. Leggere l'`issuedAt`
    // della riga viva darebbe l'istante della rotazione, cioe' «ultimo
    // accesso», che questo prodotto ha deciso di non raccogliere.
    expect(dopo.sessions[0]?.createdAt).toBe(prima.sessions[0]?.createdAt);
    expect(dopo.sessions[0]?.current).toBe(true);
  });

  it("dopo «scollega gli altri» l'elenco si accorcia davvero", async () => {
    const telefono = await signup();
    await login();
    await login();
    const prima = await elenco(telefono.accessToken);
    expect(prima.sessions).toHaveLength(3);
    const mia = prima.sessions.find((s) => s.current)?.id;
    expect(mia).toBeDefined();

    await call(server, "POST", "/api/auth/sessions/revoke", {
      accessToken: telefono.accessToken,
      body: { currentPassword: PASSWORD },
    });

    // Le righe revocate restano nel database — servono alla reuse detection — e
    // devono sparire da qui. Senza `revokedAt: null` nella clausola, l'elenco
    // crescerebbe a ogni revoca invece di accorciarsi, cioe' direbbe l'opposto
    // di quello che e' appena successo.
    const { sessions } = await elenco(telefono.accessToken);
    // E la riga superstite e' *la stessa* di prima, riconosciuta dal suo id e
    // non dedotta dal fatto che sia l'unica rimasta: un id ricalcolato a ogni
    // lettura — un indice, o un valore casuale — passerebbe ogni altro caso di
    // questo file e farebbe premere alla schermata il pulsante di un
    // dispositivo che nel frattempo ha cambiato numero.
    expect(sessions).toEqual([
      { id: mia, createdAt: sessions[0]?.createdAt ?? "", current: true },
    ]);
  });

  it("non mostra le sessioni di un altro utente", async () => {
    const mio = await signup();
    await signup("altra@wikimylife.test");

    const { sessions } = await elenco(mio.accessToken);

    // Senza `userId` nella clausola, aprire la schermata dell'account
    // mostrerebbe a ogni utente quando si sono collegati tutti gli altri.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.current).toBe(true);
  });

  it("senza access token non si legge niente", async () => {
    await signup();

    const res = await call(server, "GET", "/api/auth/sessions");
    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("UNAUTHORIZED");
  });

  it("le tre rotte sotto /sessions non si contendono il percorso", async () => {
    const telefono = await signup();
    await login();
    await login();

    // Il verbo giusto sul percorso giusto: tutte e tre rispondono, e rispondono
    // cose diverse.
    const tre = await elenco(telefono.accessToken);
    expect(tre.sessions).toHaveLength(3);
    const unaAltrui = tre.sessions.find((s) => !s.current)?.id ?? "";

    const unaSola = await call(server, "POST", "/api/auth/sessions/revoke-one", {
      accessToken: telefono.accessToken,
      body: { sessionId: unaAltrui, currentPassword: PASSWORD },
    });
    expect(unaSola.body).toEqual({ revoked: 1 });

    const revoca = await call(server, "POST", "/api/auth/sessions/revoke", {
      accessToken: telefono.accessToken,
      body: { currentPassword: PASSWORD },
    });
    // Una sola: delle tre ne restavano due, e questa ha chiuso l'altra. Il
    // numero e' anche la prova che le due POST sono finite su gestori diversi —
    // se `revoke-one` fosse caduta su `revoke`, qui ne resterebbe zero.
    expect(revoca.body).toEqual({ revoked: 1 });

    // E le combinazioni sbagliate non trovano niente. La piu' pericolosa e' la
    // prima: se `GET /sessions` fosse scritta come `/sessions/:qualcosa`,
    // leggere l'elenco potrebbe finire su un gestore che revoca.
    const getSuRevoke = await call(server, "GET", "/api/auth/sessions/revoke", {
      accessToken: telefono.accessToken,
    });
    expect(getSuRevoke.status).toBe(404);
    const getSuRevokeOne = await call(server, "GET", "/api/auth/sessions/revoke-one", {
      accessToken: telefono.accessToken,
    });
    expect(getSuRevokeOne.status).toBe(404);
    const postSuSessions = await call(server, "POST", "/api/auth/sessions", {
      accessToken: telefono.accessToken,
      body: {},
    });
    expect(postSuSessions.status).toBe(404);
    // `/sessions/revoke` e' un prefisso di `/sessions/revoke-one`, e questa e' la
    // terza combinazione che il commento di `auth.routes.ts` prometteva di
    // provare: un id nel percorso non trova nessun gestore, che e' il motivo per
    // cui sta nel corpo.
    const idNelPercorso = await call(server, "POST", `/api/auth/sessions/${unaAltrui}/revoke`, {
      accessToken: telefono.accessToken,
      body: { currentPassword: PASSWORD },
    });
    expect(idNelPercorso.status).toBe(404);
  });
});

/**
 * Chiuderne una sola, contro Postgres vero.
 *
 * Quello che qui si prova e che il repository in memoria non puo' provare e' il
 * `WHERE` a tre parti dell'`updateMany`. Il doppio in memoria lo ricopia a mano
 * con tre condizioni in un `if` — di proposito, perche' altrimenti i casi
 * unitari passerebbero anche togliendo lo `userId` dalla query — ma «ricopiato a
 * mano» e' esattamente cio' che puo' divergere. Qui la clausola e' quella vera,
 * e il `count` che torna e' quello che Postgres ha contato.
 *
 * La seconda cosa e' che i refresh token chiusi qui sono token veri: il caso non
 * legge una colonna per dire che la sessione e' morta, la usa.
 */
describe("chiudere una sessione sola", () => {
  async function login(): Promise<AuthSession> {
    const res = await call(server, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return authSessionSchema.parse(res.body);
  }

  async function elenco(accessToken: string): Promise<OpenSessionsResponse> {
    const res = await call(server, "GET", "/api/auth/sessions", { accessToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return openSessionsResponseSchema.parse(res.body);
  }

  async function chiudi(
    accessToken: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return call(server, "POST", "/api/auth/sessions/revoke-one", { accessToken, body });
  }

  /** L'id della riga che *non* e' quella da cui si sta chiedendo. */
  async function altrui(accessToken: string): Promise<string> {
    const { sessions } = await elenco(accessToken);
    const riga = sessions.find((s) => !s.current);
    if (riga === undefined) {
      throw new Error("Il caso presuppone almeno due dispositivi collegati.");
    }
    return riga.id;
  }

  it("chiude il dispositivo scelto, e lascia vivo quello da cui si chiede", async () => {
    const telefono = await signup();
    const portatile = await login();

    const res = await chiudi(telefono.accessToken, {
      sessionId: await altrui(telefono.accessToken),
      currentPassword: PASSWORD,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ revoked: 1 });

    // Il token del portatile non vale piu', e lo dice usandolo: una colonna
    // aggiornata che non fermasse davvero la rotazione sarebbe un pulsante che
    // sembra funzionare e non scollega niente. `TOKEN_REUSED` e non
    // `UNAUTHORIZED` perche' la riga esiste ancora, revocata, ed e' quello che
    // la reuse detection vede.
    const morto = await refresh(portatile.tokens.refreshToken);
    expect(morto.status).toBe(401);
    expect(errorCode(morto.body)).toBe("TOKEN_REUSED");

    // E il proprio si': senza il `familyId` nella clausola verrebbero chiusi
    // tutti e due, e chi scollega un dispositivo si troverebbe fuori senza
    // capire perche'.
    expect((await refresh(telefono.refreshToken)).status).toBe(200);
  });

  it("l'elenco si accorcia di quella riga, e delle altre non tocca nessuna", async () => {
    const telefono = await signup();
    await login();
    await login();
    const chiusa = await altrui(telefono.accessToken);

    await chiudi(telefono.accessToken, { sessionId: chiusa, currentPassword: PASSWORD });

    const { sessions } = await elenco(telefono.accessToken);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id)).not.toContain(chiusa);
    // E il giro si chiude: l'id e' stato letto da una risposta, speso su una
    // rotta, e la risposta dopo lo conferma sparito. E' l'unica catena che prova
    // che l'`id` del contratto e il `familyId` del database sono la stessa cosa.
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
  });

  it("non chiude la sessione di un altro utente, e risponde zero", async () => {
    const mio = await signup();
    const altro = await signup("altra@wikimylife.test");
    const sueSessioni = await elenco(altro.accessToken);
    const sua = sueSessioni.sessions[0]?.id ?? "";

    const res = await chiudi(mio.accessToken, { sessionId: sua, currentPassword: PASSWORD });

    // Zero e non 404: la risposta e' identica per un id altrui, uno gia' chiuso
    // e uno inventato, e distinguerli direbbe a chi prova quali esistono.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: 0 });
    // La difesa vera e' lo `userId` nel `WHERE`, e questa riga la prova: senza,
    // il `familyId` da solo basterebbe a chiudere la sessione di chiunque.
    expect((await refresh(altro.refreshToken)).status).toBe(200);
    expect((await elenco(altro.accessToken)).sessions).toHaveLength(1);
  });

  it("rifiuta la propria sessione con un 409, e la lascia viva", async () => {
    const telefono = await signup();
    await login();
    const mia = (await elenco(telefono.accessToken)).sessions.find((s) => s.current)?.id ?? "";

    const res = await chiudi(telefono.accessToken, {
      sessionId: mia,
      currentPassword: PASSWORD,
    });

    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe("CONFLICT");
    // Lasciar passare direbbe `revoked: 1` su una sessione che quella stessa
    // risposta ha ucciso: il client lo scoprirebbe alla richiesta dopo, con una
    // rotazione fallita su un token morto per mano sua.
    expect((await refresh(telefono.refreshToken)).status).toBe(200);
  });

  it("con la password sbagliata non chiude niente, e non dice di chi e' la riga", async () => {
    const telefono = await signup();
    const portatile = await login();
    const sua = await altrui(telefono.accessToken);
    const mia = (await elenco(telefono.accessToken)).sessions.find((s) => s.current)?.id ?? "";

    const res = await chiudi(telefono.accessToken, {
      sessionId: sua,
      currentPassword: "non-e-questa",
    });
    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("INVALID_CREDENTIALS");
    expect((await refresh(portatile.tokens.refreshToken)).status).toBe(200);

    // E la stessa risposta sulla propria riga, dove senza la verifica davanti
    // arriverebbe un 409. Sono i due codici che rendono il controllo un oracolo:
    // con l'ordine invertito, chi ha rubato un access token prova gli id
    // dell'elenco con una password qualunque e impara quale dispositivo ha in
    // mano il proprietario — senza mai sapere la password.
    const suDiSe = await chiudi(telefono.accessToken, {
      sessionId: mia,
      currentPassword: "non-e-questa",
    });
    expect(suDiSe.status).toBe(401);
    expect(errorCode(suDiSe.body)).toBe("INVALID_CREDENTIALS");
  });

  it("premuto due volte sulla stessa riga risponde zero, non un errore", async () => {
    const telefono = await signup();
    await login();
    const chiusa = await altrui(telefono.accessToken);

    const prima = await chiudi(telefono.accessToken, {
      sessionId: chiusa,
      currentPassword: PASSWORD,
    });
    expect(prima.body).toEqual({ revoked: 1 });

    // Due schede aperte sullo stesso account, lo stesso pulsante premuto due
    // volte. Senza `revokedAt: null` nella clausola la seconda riconterebbe la
    // riga gia' morta e risponderebbe uno, riscrivendole sopra la data della
    // revoca: il numero mentirebbe e la storia della sessione si perderebbe.
    const seconda = await chiudi(telefono.accessToken, {
      sessionId: chiusa,
      currentPassword: PASSWORD,
    });
    expect(seconda.status).toBe(200);
    expect(seconda.body).toEqual({ revoked: 0 });
  });

  it("senza access token non chiude niente", async () => {
    const telefono = await signup();
    const portatile = await login();
    const sua = await altrui(telefono.accessToken);

    const res = await call(server, "POST", "/api/auth/sessions/revoke-one", {
      body: { sessionId: sua, currentPassword: PASSWORD },
    });

    // La password da sola non basta: senza il token il server non saprebbe
    // nemmeno di chi verificarla, e la rotta diventerebbe «chiudi la sessione di
    // chiunque, se ne indovini l'id».
    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("UNAUTHORIZED");
    expect((await refresh(portatile.tokens.refreshToken)).status).toBe(200);
  });

  it("rifiuta un corpo monco, un id vuoto e un campo in piu'", async () => {
    const telefono = await signup();
    await login();
    const sua = await altrui(telefono.accessToken);

    for (const corpo of [
      // Senza id: con uno schema permissivo diventerebbe `undefined`, e il
      // servizio confronterebbe `undefined` con il proprio `familyId` — cioe'
      // andrebbe dritto all'`updateMany` con una famiglia che non esiste.
      { currentPassword: PASSWORD },
      // Senza password: e' la difesa che questa rotta condivide con «scollega
      // gli altri», e senza il `min(1)` una stringa vuota arriverebbe fino
      // all'argon2.
      { sessionId: sua },
      { sessionId: "", currentPassword: PASSWORD },
      { sessionId: sua, currentPassword: "" },
      // `.strict()`: un `userId` mandato dal client verrebbe ignorato in
      // silenzio da uno schema permissivo, e chi lo ha scritto crederebbe di
      // poter scegliere di chi chiudere le sessioni.
      { sessionId: sua, currentPassword: PASSWORD, userId: "quello-che-dico-io" },
    ]) {
      const res = await chiudi(telefono.accessToken, corpo);
      expect(res.status, JSON.stringify(corpo)).toBe(400);
      expect(errorCode(res.body)).toBe("VALIDATION_FAILED");
    }

    // E l'opposto: il corpo giusto passa, quindi il ciclo di sopra non sta
    // provando che questa rotta rifiuta tutto.
    const buono = await chiudi(telefono.accessToken, {
      sessionId: sua,
      currentPassword: PASSWORD,
    });
    expect(buono.status).toBe(200);
  });

  it("non cambia la password, e non tocca le altre famiglie", async () => {
    const telefono = await signup();
    const portatile = await login();
    // Il tablet e' il piu' recente, quindi e' la prima riga non corrente
    // dell'elenco: e' quello che questo caso chiude.
    await login();
    const tablet = await altrui(telefono.accessToken);

    await chiudi(telefono.accessToken, { sessionId: tablet, currentPassword: PASSWORD });

    // Le due cose che distinguono questa rotta dalle sue due vicine: non e'
    // `changePassword` con un altro nome, e non e' `revoke` con un argomento in
    // piu'. La terza sessione e' viva, e la password e' ancora quella.
    expect((await refresh(portatile.tokens.refreshToken)).status).toBe(200);
    expect((await login()).tokens).toBeDefined();
  });
});

describe("forma degli errori", () => {
  it("una rotta inesistente risponde con lo stesso schema di tutto il resto", async () => {
    const res = await call(server, "GET", "/api/non-esiste");

    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe("NOT_FOUND");
  });

  it("nessun errore di auth porta details", async () => {
    // `details` esiste per dire a un umano quale campo del modulo e' sbagliato.
    // Su un errore di autenticazione direbbe quale controllo e' fallito, cioe'
    // quali sono passati.
    for (const body of [
      { email: EMAIL, password: "password-sbagliata-lunga" },
      { email: "nessuno@wikimylife.test", password: PASSWORD },
    ]) {
      const res = await call(server, "POST", "/api/auth/login", { body });
      expect(errorBodySchema.parse(res.body).error.details).toBeUndefined();
    }
  });

  it("un JSON malformato non fa uscire uno stack", async () => {
    const response = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ questo non e' json",
    });
    const text = await response.text();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(text).not.toContain("at Object.");
    expect(text).not.toContain("node_modules");
    expect(errorBodySchema.safeParse(JSON.parse(text)).success).toBe(true);
  });
});
