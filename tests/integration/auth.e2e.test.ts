import { authSessionSchema, errorBodySchema, meResponseSchema } from "@wikimylife/shared";
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
