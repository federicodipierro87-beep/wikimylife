import type { AuthSession } from "@wikimylife/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { JoseTokenIssuer } from "../../apps/api/src/infra/JoseTokenIssuer.js";
import { FakeStorageProvider } from "../../apps/api/src/providers/fake/FakeStorageProvider.js";
import {
  createAuthService,
  type AuthService,
} from "../../apps/api/src/services/auth.service.js";
import { FakePasswordHasher, testAuthConfig } from "../support/auth.js";
import { FixedClock } from "../support/FixedClock.js";
import { InMemoryAuthRepository } from "../support/InMemoryAuthRepository.js";
import type { AuthConfig } from "../../apps/api/src/config/env.js";

/**
 * `auth.service` con repository in memoria, hasher finto e orologio fisso.
 *
 * Nessun database, nessuna rete, nessun argon2 vero: la suite intera gira in
 * millisecondi, e quindi la si lancia davvero. La logica di sicurezza — che e'
 * dove i bug costano — e' testabile cosi' solo perche' il servizio non importa
 * ne' express, ne' prisma, ne' jose, ne' argon2.
 */

const T0 = new Date("2026-04-01T10:00:00.000Z");
const EMAIL = "chi@esempio.it";
const PASSWORD = "una-password-lunga-abbastanza";

interface Harness {
  readonly service: AuthService;
  readonly repo: InMemoryAuthRepository;
  readonly clock: FixedClock;
  readonly hasher: FakePasswordHasher;
  readonly config: AuthConfig;
  /** Serve a risalire dalla sessione alla sua famiglia, che il servizio non dice. */
  readonly tokens: JoseTokenIssuer;
  /** Serve solo a `deleteAccount`: e' l'unico gesto che tocchi il bucket. */
  readonly storage: FakeStorageProvider;
  /** Le chiavi che lo storage non e' riuscito a cancellare, riportate qui. */
  readonly orfani: { key: string; error: unknown }[];
}

function build(overrides: Partial<AuthConfig> = {}): Harness {
  const repo = new InMemoryAuthRepository();
  const hasher = new FakePasswordHasher();
  const clock = new FixedClock(T0);
  const config = testAuthConfig(overrides);
  const tokens = new JoseTokenIssuer({
    accessSecret: config.accessSecret,
    accessTtlSeconds: config.accessTokenTtlSeconds,
  });
  const storage = new FakeStorageProvider();
  const orfani: { key: string; error: unknown }[] = [];

  return {
    service: createAuthService({
      repo,
      hasher,
      tokens,
      clock,
      config,
      storage,
      onOrphanedAudio: (info) => orfani.push(info),
    }),
    repo,
    clock,
    hasher,
    config,
    tokens,
    storage,
    orfani,
  };
}

/**
 * La famiglia di una sessione, che nel prodotto arriva dal claim `fid`
 * dell'access token e che qui si ricava dalla riga del refresh token.
 *
 * Passare per il repository e non per `verifyAccessToken` e' voluto: l'access
 * token e' quello che il client mostra, il refresh token e' quello che il
 * database conosce, e il caso deve dire che le due cose combaciano — se un
 * giorno la rotazione aprisse una famiglia nuova, questa funzione e i test che
 * la usano se ne accorgerebbero.
 */
function famigliaDi(harness: Harness, sessione: AuthSession): string {
  const hash = harness.tokens.hashRefreshToken(sessione.tokens.refreshToken);
  const riga = harness.repo.allTokens().find((t) => t.tokenHash === hash);
  if (riga === undefined) {
    throw new Error("La sessione non ha un refresh token nel repository: il caso non regge.");
  }
  return riga.familyId;
}

describe("signup", () => {
  it("crea l'utente e apre una sessione", async () => {
    const { service, repo } = build();
    const session = await service.signup({ email: EMAIL, password: PASSWORD });

    expect(session.user.email).toBe(EMAIL);
    expect(session.tokens.tokenType).toBe("Bearer");
    expect(session.tokens.accessToken.split(".")).toHaveLength(3);
    expect(await repo.findUserByEmail(EMAIL)).not.toBeNull();
  });

  it("non restituisce mai il passwordHash", async () => {
    const { service } = build();
    const session = await service.signup({ email: EMAIL, password: PASSWORD });

    // Sul JSON serializzato e non sulle chiavi: cosi' il test prende anche un
    // campo annidato che qualcuno aggiungesse in futuro.
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain("passwordHash");
  });

  it("salva la password sempre e solo hashata", async () => {
    const { service, repo } = build();
    await service.signup({ email: EMAIL, password: PASSWORD });

    const user = await repo.findUserByEmail(EMAIL);
    expect(user?.passwordHash).not.toBe(PASSWORD);
    expect(user?.passwordHash).toContain("$");
  });

  it("rifiuta un'email gia' presa", async () => {
    const { service } = build();
    await service.signup({ email: EMAIL, password: PASSWORD });

    await expect(service.signup({ email: EMAIL, password: PASSWORD })).rejects.toMatchObject({
      code: "EMAIL_TAKEN",
    });
  });

  it("rifiuta tutto quando SIGNUP_ENABLED e' falso", async () => {
    // La chiusura della registrazione dopo il primo utente e' l'unico
    // meccanismo che impedisce a chiunque trovi l'URL di crearsi un account.
    const { service } = build({ signupEnabled: false });

    await expect(service.signup({ email: EMAIL, password: PASSWORD })).rejects.toMatchObject({
      code: "SIGNUP_DISABLED",
    });
  });

  it("apre una famiglia sola", async () => {
    const { service, repo } = build();
    await service.signup({ email: EMAIL, password: PASSWORD });

    const families = new Set(repo.allTokens().map((t) => t.familyId));
    expect(families.size).toBe(1);
  });
});

describe("login", () => {
  async function withUser(overrides: Partial<AuthConfig> = {}): Promise<Harness> {
    const harness = build(overrides);
    await harness.service.signup({ email: EMAIL, password: PASSWORD });
    return harness;
  }

  it("accetta le credenziali giuste", async () => {
    const { service } = await withUser();
    const session = await service.login({ email: EMAIL, password: PASSWORD });

    expect(session.user.email).toBe(EMAIL);
  });

  it("rifiuta la password sbagliata con INVALID_CREDENTIALS", async () => {
    const { service } = await withUser();

    await expect(
      service.login({ email: EMAIL, password: "quella-sbagliata-pero-lunga" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("da' lo stesso codice per un utente inesistente", async () => {
    // Distinguere i due casi direbbe a un attaccante quali email sono
    // registrate: un enumeratore di account regalato.
    const { service } = await withUser();

    await expect(
      service.login({ email: "nessuno@esempio.it", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("verifica un hash fittizio anche quando l'utente non esiste", async () => {
    // Senza questo, il ramo "utente inesistente" torna subito e quello
    // "password errata" costa 50 ms di argon2: la differenza di latenza e' un
    // oracolo che risponde alla domanda che il codice di errore nasconde.
    const { service, hasher } = await withUser();
    const before = hasher.verifyCalls;

    await expect(
      service.login({ email: "nessuno@esempio.it", password: PASSWORD }),
    ).rejects.toThrow();

    expect(hasher.verifyCalls).toBe(before + 1);
  });

  it("ogni login apre una famiglia nuova", async () => {
    // Sessioni indipendenti fra dispositivi: uscire dal telefono non deve
    // buttare fuori dal portatile.
    const { service, repo } = await withUser();
    await service.login({ email: EMAIL, password: PASSWORD });
    await service.login({ email: EMAIL, password: PASSWORD });

    const families = new Set(repo.allTokens().map((t) => t.familyId));
    expect(families.size).toBe(3); // signup + due login
  });
});

describe("refresh", () => {
  async function loggedIn(): Promise<Harness & { refreshToken: string }> {
    const harness = build();
    const session = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    return { ...harness, refreshToken: session.tokens.refreshToken };
  }

  it("restituisce una coppia nuova", async () => {
    const { service, refreshToken, clock } = await loggedIn();
    clock.advanceSeconds(30);

    const next = await service.refresh(refreshToken);

    expect(next.tokens.refreshToken).not.toBe(refreshToken);
    expect(next.user.email).toBe(EMAIL);
  });

  it("resta nella stessa famiglia", async () => {
    const { service, repo, refreshToken } = await loggedIn();
    await service.refresh(refreshToken);

    const families = new Set(repo.allTokens().map((t) => t.familyId));
    expect(families.size).toBe(1);
    expect(repo.allTokens()).toHaveLength(2);
  });

  it("revoca il token usato e lo collega al successore", async () => {
    const { service, repo, refreshToken } = await loggedIn();
    const before = repo.allTokens();
    expect(before).toHaveLength(1);
    const usedId = before[0]?.id;

    await service.refresh(refreshToken);

    const used = repo.allTokens().find((t) => t.id === usedId);
    expect(used?.revokedAt).not.toBeNull();
    expect(used?.replacedById).not.toBeNull();
  });

  it("il token in chiaro non e' mai salvato", async () => {
    // Nel database ci va sha256(token). Un dump non deve permettere a nessuno
    // di impersonare l'utente.
    const { service, repo, refreshToken } = await loggedIn();
    await service.refresh(refreshToken);

    for (const stored of repo.allTokens()) {
      expect(stored.tokenHash).not.toBe(refreshToken);
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("rifiuta un token mai emesso", async () => {
    const { service } = await loggedIn();

    await expect(service.refresh("token-inventato")).rejects.toMatchObject({
      code: "TOKEN_INVALID",
    });
  });

  it("rifiuta un token scaduto", async () => {
    const { service, refreshToken, clock, config } = await loggedIn();
    clock.advanceSeconds(config.refreshTokenTtlSeconds + 1);

    await expect(service.refresh(refreshToken)).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
    });
  });

  it("e' ancora valido un secondo prima della scadenza", async () => {
    const { service, refreshToken, clock, config } = await loggedIn();
    clock.advanceSeconds(config.refreshTokenTtlSeconds - 1);

    await expect(service.refresh(refreshToken)).resolves.toBeDefined();
  });

  it("un token scaduto non e' un riuso: non revoca la famiglia", async () => {
    // Sono due allarmi diversi. Scaduto capita a chiunque lasci l'app chiusa
    // per un mese e non deve produrre nessun effetto collaterale.
    const { service, repo, refreshToken, clock, config } = await loggedIn();
    clock.advanceSeconds(config.refreshTokenTtlSeconds + 1);

    await expect(service.refresh(refreshToken)).rejects.toThrow();

    expect(repo.allTokens().every((t) => t.revokedAt === null)).toBe(true);
  });
});

describe("refresh: riuso", () => {
  /**
   * Il test piu' importante della fase.
   *
   * E' l'unico punto in cui un bug non e' un difetto di prodotto ma un problema
   * di sicurezza: un refresh token rubato che continui a funzionare dopo la
   * rotazione legittima da' all'attaccante una sessione rinnovabile
   * indefinitamente, e al proprietario nessun segnale.
   */
  async function rotatedOnce(): Promise<{
    harness: Harness;
    oldToken: string;
    newToken: string;
  }> {
    const harness = build();
    const first = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    harness.clock.advanceSeconds(10);
    const second = await harness.service.refresh(first.tokens.refreshToken);

    return {
      harness,
      oldToken: first.tokens.refreshToken,
      newToken: second.tokens.refreshToken,
    };
  }

  it("il vecchio token da' TOKEN_REUSED, non TOKEN_INVALID", async () => {
    // La distinzione conta: TOKEN_INVALID e' "non lo conosco", TOKEN_REUSED e'
    // "lo conosco ed e' un allarme". Il client deve reagire diversamente.
    const { harness, oldToken } = await rotatedOnce();

    await expect(harness.service.refresh(oldToken)).rejects.toMatchObject({
      code: "TOKEN_REUSED",
    });
  });

  it("il riuso uccide anche la coppia nuova", async () => {
    // Questa e' la ragione d'essere della famiglia. Se sopravvivesse il token
    // nuovo, l'attaccante che ha rubato il vecchio verrebbe respinto ma la
    // vittima resterebbe dentro, ignara: nessuno si accorgerebbe del furto.
    const { harness, oldToken, newToken } = await rotatedOnce();

    await expect(harness.service.refresh(oldToken)).rejects.toMatchObject({
      code: "TOKEN_REUSED",
    });

    await expect(harness.service.refresh(newToken)).rejects.toMatchObject({
      code: "TOKEN_REUSED",
    });
  });

  it("dopo il riuso nessun token della famiglia sopravvive", async () => {
    const { harness, oldToken } = await rotatedOnce();
    await expect(harness.service.refresh(oldToken)).rejects.toThrow();

    expect(harness.repo.allTokens().every((t) => t.revokedAt !== null)).toBe(true);
  });

  it("non tocca le altre famiglie", async () => {
    // Un furto su un dispositivo non deve buttare fuori dagli altri: sarebbe
    // una negazione di servizio innescabile da chiunque conosca un token
    // vecchio.
    const harness = build();
    const a = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const b = await harness.service.login({ email: EMAIL, password: PASSWORD });

    harness.clock.advanceSeconds(10);
    await harness.service.refresh(a.tokens.refreshToken);
    await expect(harness.service.refresh(a.tokens.refreshToken)).rejects.toMatchObject({
      code: "TOKEN_REUSED",
    });

    await expect(harness.service.refresh(b.tokens.refreshToken)).resolves.toBeDefined();
  });

  it("il riuso rilevato non emette comunque una sessione", async () => {
    const { harness, oldToken } = await rotatedOnce();

    const result = await harness.service.refresh(oldToken).then(
      (session) => session,
      () => null,
    );
    expect(result).toBeNull();
  });
});

describe("logout", () => {
  it("revoca la famiglia intera", async () => {
    const harness = build();
    const first = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    harness.clock.advanceSeconds(10);
    const second = await harness.service.refresh(first.tokens.refreshToken);

    await harness.service.logout(second.tokens.refreshToken);

    await expect(harness.service.refresh(second.tokens.refreshToken)).rejects.toMatchObject({
      code: "TOKEN_REUSED",
    });
  });

  it("non lascia in piedi le altre sessioni", async () => {
    const harness = build();
    const a = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const b = await harness.service.login({ email: EMAIL, password: PASSWORD });

    await harness.service.logout(a.tokens.refreshToken);

    await expect(harness.service.refresh(b.tokens.refreshToken)).resolves.toBeDefined();
  });

  it("non dice se il token esisteva", async () => {
    // Un logout con un token inventato deve essere indistinguibile da uno
    // legittimo, altrimenti e' un oracolo di validita' gratuito.
    const harness = build();
    await harness.service.signup({ email: EMAIL, password: PASSWORD });

    await expect(harness.service.logout("mai-emesso")).resolves.toBeUndefined();
  });
});

describe("changePassword", () => {
  const NUOVA = "un-altra-password-lunga";

  it("chiude ogni sessione dell'utente, non solo quella da cui si chiama", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const portatile = await harness.service.login({ email: EMAIL, password: PASSWORD });
    const tablet = await harness.service.login({ email: EMAIL, password: PASSWORD });

    await harness.service.changePassword(telefono.user.id, {
      currentPassword: PASSWORD,
      newPassword: NUOVA,
    });

    // Tutte e tre, compresa quella del chiamante: la famiglia con cui
    // proseguira' e' nuova, non quella con cui ha chiesto.
    for (const vecchia of [telefono, portatile, tablet]) {
      await expect(harness.service.refresh(vecchia.tokens.refreshToken)).rejects.toMatchObject({
        code: "TOKEN_REUSED",
      });
    }
  });

  it("la sessione restituita e' viva, e non nasce gia' revocata", async () => {
    const harness = build();
    const prima = await harness.service.signup({ email: EMAIL, password: PASSWORD });

    const dopo = await harness.service.changePassword(prima.user.id, {
      currentPassword: PASSWORD,
      newPassword: NUOVA,
    });

    // Il caso che l'ordine sbagliato — nuova famiglia e poi revoca — produce:
    // una risposta piena di token che il client non puo' usare.
    await expect(harness.service.refresh(dopo.tokens.refreshToken)).resolves.toBeDefined();
  });

  it("la nuova password entra in vigore e la vecchia smette di funzionare", async () => {
    const harness = build();
    const sessione = await harness.service.signup({ email: EMAIL, password: PASSWORD });

    await harness.service.changePassword(sessione.user.id, {
      currentPassword: PASSWORD,
      newPassword: NUOVA,
    });

    await expect(harness.service.login({ email: EMAIL, password: NUOVA })).resolves.toBeDefined();
    await expect(
      harness.service.login({ email: EMAIL, password: PASSWORD }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("la nuova password finisce nel database hashata, mai in chiaro", async () => {
    const harness = build();
    const sessione = await harness.service.signup({ email: EMAIL, password: PASSWORD });

    await harness.service.changePassword(sessione.user.id, {
      currentPassword: PASSWORD,
      newPassword: NUOVA,
    });

    const user = await harness.repo.findUserByEmail(EMAIL);
    expect(user?.passwordHash).not.toBe(NUOVA);
    expect(user?.passwordHash).toContain("$");
  });

  it("rifiuta chi non sa la password attuale, e non tocca niente", async () => {
    const harness = build();
    const sessione = await harness.service.signup({ email: EMAIL, password: PASSWORD });

    await expect(
      harness.service.changePassword(sessione.user.id, {
        currentPassword: "non-e-quella",
        newPassword: NUOVA,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    // Un rifiuto che avesse comunque revocato sarebbe un modo per chiunque
    // abbia un access token di buttare fuori tutti gli altri dispositivi senza
    // sapere niente.
    await expect(
      harness.service.refresh(sessione.tokens.refreshToken),
    ).resolves.toBeDefined();
    await expect(harness.service.login({ email: EMAIL, password: PASSWORD })).resolves.toBeDefined();
  });

  it("rifiuta la stessa password, invece di revocare tutto per niente", async () => {
    const harness = build();
    const sessione = await harness.service.signup({ email: EMAIL, password: PASSWORD });

    await expect(
      harness.service.changePassword(sessione.user.id, {
        currentPassword: PASSWORD,
        newPassword: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      harness.service.refresh(sessione.tokens.refreshToken),
    ).resolves.toBeDefined();
  });

  it("non tocca le sessioni di un altro utente", async () => {
    const harness = build();
    const mio = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const altro = await harness.service.signup({
      email: "altro@esempio.it",
      password: PASSWORD,
    });

    await harness.service.changePassword(mio.user.id, {
      currentPassword: PASSWORD,
      newPassword: NUOVA,
    });

    await expect(harness.service.refresh(altro.tokens.refreshToken)).resolves.toBeDefined();
    await expect(
      harness.service.login({ email: "altro@esempio.it", password: PASSWORD }),
    ).resolves.toBeDefined();
  });

  it("e' UNAUTHORIZED se l'utente non esiste piu'", async () => {
    const harness = build();

    await expect(
      harness.service.changePassword("utente-sparito", {
        currentPassword: PASSWORD,
        newPassword: NUOVA,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("verifica la password attuale contro l'hash vero, non contro un ramo saltato", async () => {
    const harness = build();
    const sessione = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const prima = harness.hasher.verifyCalls;

    await harness.service.changePassword(sessione.user.id, {
      currentPassword: PASSWORD,
      newPassword: NUOVA,
    });

    expect(harness.hasher.verifyCalls).toBe(prima + 1);
  });

  it("la revoca porta l'istante del Clock iniettato", async () => {
    const harness = build();
    const sessione = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    harness.clock.advanceSeconds(3600);

    await harness.service.changePassword(sessione.user.id, {
      currentPassword: PASSWORD,
      newPassword: NUOVA,
    });

    const revocati = harness.repo.allTokens().filter((t) => t.revokedAt !== null);
    expect(revocati).toHaveLength(1);
    expect(revocati[0]?.revokedAt?.getTime()).toBe(T0.getTime() + 3600 * 1000);
  });
});

/**
 * `revokeOtherSessions`, cioe' il cambio password senza il cambio password.
 *
 * Le due cose si somigliano abbastanza da poter essere scritte con lo stesso
 * codice per sbaglio, e differiscono in tre punti che valgono l'intera
 * funzione: qui la password non cambia, la sessione di chi chiama non viene
 * sostituita ma risparmiata, e il numero che torna e' cio' che l'utente
 * leggera'. Ognuno dei tre ha il suo caso, perche' sbagliarne uno solo lascia
 * una funzione che sembra funzionare.
 */
describe("revokeOtherSessions", () => {
  it("chiude le altre sessioni e lascia in piedi quella da cui si chiama", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const portatile = await harness.service.login({ email: EMAIL, password: PASSWORD });
    const tablet = await harness.service.login({ email: EMAIL, password: PASSWORD });

    await harness.service.revokeOtherSessions(telefono.user.id, famigliaDi(harness, telefono), {
      currentPassword: PASSWORD,
    });

    for (const caduta of [portatile, tablet]) {
      await expect(harness.service.refresh(caduta.tokens.refreshToken)).rejects.toMatchObject({
        code: "TOKEN_REUSED",
      });
    }
    // E' l'unica differenza che conta rispetto a `changePassword`, che invece
    // butta fuori anche chi chiama e gli restituisce dei token nuovi. Se questa
    // riga fallisse, la risposta — che non contiene nessuna credenziale — non
    // avrebbe modo di rimettere dentro nessuno.
    await expect(harness.service.refresh(telefono.tokens.refreshToken)).resolves.toBeDefined();
  });

  it("dice quante ne ha chiuse, perche' e' quello che l'utente leggera'", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    await harness.service.login({ email: EMAIL, password: PASSWORD });
    await harness.service.login({ email: EMAIL, password: PASSWORD });

    const esito = await harness.service.revokeOtherSessions(
      telefono.user.id,
      famigliaDi(harness, telefono),
      { currentPassword: PASSWORD },
    );

    // Due, non tre: il conto e' di cio' che e' caduto, e chi chiede non e'
    // caduto. Un tre qui vorrebbe dire che la schermata annuncia di aver
    // scollegato un dispositivo che sta ancora usando.
    expect(esito).toEqual({ revoked: 2 });
  });

  it("risponde zero quando non c'era nessun altro, e non e' un errore", async () => {
    const harness = build();
    const sola = await harness.service.signup({ email: EMAIL, password: PASSWORD });

    const esito = await harness.service.revokeOtherSessions(
      sola.user.id,
      famigliaDi(harness, sola),
      { currentPassword: PASSWORD },
    );

    // Zero e' la risposta piu' utile delle tre: dice che il telefono che si sta
    // cercando non era collegato. Un CONFLICT al suo posto trasformerebbe
    // un'informazione in un fallimento.
    expect(esito).toEqual({ revoked: 0 });
    await expect(harness.service.refresh(sola.tokens.refreshToken)).resolves.toBeDefined();
  });

  it("non conta le sessioni che erano gia' chiuse", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const perduto = await harness.service.login({ email: EMAIL, password: PASSWORD });
    await harness.service.logout(perduto.tokens.refreshToken);

    const esito = await harness.service.revokeOtherSessions(
      telefono.user.id,
      famigliaDi(harness, telefono),
      { currentPassword: PASSWORD },
    );

    // Senza `revokedAt: null` nella clausola, il conto includerebbe ogni
    // sessione mai aperta da questo utente: dopo un mese di uso, un numero a
    // due cifre che non corrisponde a niente di reale.
    expect(esito).toEqual({ revoked: 0 });
  });

  it("risparmia la famiglia, non il solo token che il chiamante ha in mano", async () => {
    const harness = build();
    const primo = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const famiglia = famigliaDi(harness, primo);
    // Una rotazione: adesso nella famiglia c'e' un token revocato e uno vivo, e
    // quello vivo non e' quello con cui la sessione era nata.
    const ruotato = await harness.service.refresh(primo.tokens.refreshToken);

    await harness.service.revokeOtherSessions(primo.user.id, famiglia, {
      currentPassword: PASSWORD,
    });

    // Escludere il token e non la famiglia avrebbe scollegato proprio il
    // dispositivo che ha premuto il pulsante, e per giunta solo se aveva
    // ruotato di recente: un guasto che si presenta a giorni alterni.
    await expect(harness.service.refresh(ruotato.tokens.refreshToken)).resolves.toBeDefined();
  });

  it("rifiuta chi non sa la password, e non scollega niente", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const altrove = await harness.service.login({ email: EMAIL, password: PASSWORD });

    await expect(
      harness.service.revokeOtherSessions(telefono.user.id, famigliaDi(harness, telefono), {
        currentPassword: "non-e-questa",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    // La verifica prima della revoca, e non dopo. Nell'ordine opposto chi
    // sbaglia a digitare riceverebbe un errore avendo pero' gia' scollegato
    // tutto, e nessuna schermata gli direbbe mai che e' successo.
    await expect(harness.service.refresh(altrove.tokens.refreshToken)).resolves.toBeDefined();
  });

  it("non cambia la password: e' l'unica ragione per cui esiste", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });

    await harness.service.revokeOtherSessions(telefono.user.id, famigliaDi(harness, telefono), {
      currentPassword: PASSWORD,
    });

    // Se la password cambiasse — o si riscrivesse identica con un hash nuovo —
    // questa rotta sarebbe `changePassword` con un nome diverso, e chi la usa
    // per non toccare la propria password si troverebbe fuori da ogni altro
    // posto in cui l'aveva salvata.
    await expect(harness.service.login({ email: EMAIL, password: PASSWORD })).resolves.toBeDefined();
  });

  it("non tocca le sessioni di un altro utente", async () => {
    const harness = build();
    const mio = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const altro = await harness.service.signup({
      email: "altro@esempio.it",
      password: PASSWORD,
    });

    const esito = await harness.service.revokeOtherSessions(
      mio.user.id,
      famigliaDi(harness, mio),
      { currentPassword: PASSWORD },
    );

    // Senza `userId` nella clausola, «tutti gli altri dispositivi» sarebbe
    // tutti i dispositivi di tutti. Il conto lo dice prima del refresh: uno
    // zero qui e' la prova che la query non ha nemmeno visto l'altro utente.
    expect(esito).toEqual({ revoked: 0 });
    await expect(harness.service.refresh(altro.tokens.refreshToken)).resolves.toBeDefined();
  });

  it("e' UNAUTHORIZED se l'utente non esiste piu'", async () => {
    const harness = build();

    await expect(
      harness.service.revokeOtherSessions("utente-sparito", "fam-qualunque", {
        currentPassword: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("verifica la password contro l'hash vero, non contro un ramo saltato", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const prima = harness.hasher.verifyCalls;

    await harness.service.revokeOtherSessions(telefono.user.id, famigliaDi(harness, telefono), {
      currentPassword: PASSWORD,
    });

    expect(harness.hasher.verifyCalls).toBe(prima + 1);
  });

  it("la revoca porta l'istante del Clock iniettato", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    await harness.service.login({ email: EMAIL, password: PASSWORD });
    harness.clock.advanceSeconds(3600);

    await harness.service.revokeOtherSessions(telefono.user.id, famigliaDi(harness, telefono), {
      currentPassword: PASSWORD,
    });

    const revocati = harness.repo.allTokens().filter((t) => t.revokedAt !== null);
    expect(revocati).toHaveLength(1);
    expect(revocati[0]?.revokedAt?.getTime()).toBe(T0.getTime() + 3600 * 1000);
  });
});

/**
 * L'elenco che da' un metro al numero di sopra.
 *
 * Ogni caso qui guarda un modo diverso in cui la lista puo' mentire, e tutti e
 * cinque mentono in silenzio — non c'e' niente, nel guardare la schermata, che
 * distingua un elenco giusto da uno che conta le sessioni chiuse o che mostra
 * l'ultima rotazione al posto del login.
 */
describe("listSessions", () => {
  it("elenca una riga per dispositivo, e ne marca una sola come questo", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    await harness.service.login({ email: EMAIL, password: PASSWORD });
    await harness.service.login({ email: EMAIL, password: PASSWORD });

    const { sessions } = await harness.service.listSessions(
      telefono.user.id,
      famigliaDi(harness, telefono),
    );

    expect(sessions).toHaveLength(3);
    // Una sola, e non zero: un confronto sbagliato — il `familyId` contro
    // l'`userId`, per dirne uno che compila — lascerebbe tutte le righe a
    // `false`, e la schermata direbbe «tre dispositivi» senza che nessuno sia
    // quello in mano. Chi legge premerebbe «scollega gli altri» credendo di
    // chiuderne tre.
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.filter((s) => !s.current)).toHaveLength(2);
  });

  it("la data e' quella del login, non quella dell'ultima rotazione", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const famiglia = famigliaDi(harness, telefono);

    // Due giorni di uso quotidiano, ridotti a due rotazioni. La famiglia adesso
    // ha tre righe: due revocate e una viva, e la viva e' di oggi.
    harness.clock.advanceDays(1);
    const primoGiro = await harness.service.refresh(telefono.tokens.refreshToken);
    harness.clock.advanceDays(1);
    await harness.service.refresh(primoGiro.tokens.refreshToken);

    const { sessions } = await harness.service.listSessions(telefono.user.id, famiglia);

    expect(sessions).toHaveLength(1);
    // Prendere l'`issuedAt` della riga viva sarebbe la cosa naturale da
    // scrivere, e darebbe «oggi» — cioe' l'ultimo accesso, che e' proprio il
    // dato che il contratto ha deciso di non raccogliere. La distanza fra le
    // due letture cresce con l'uso: piu' un dispositivo e' usato, piu' la data
    // sbagliata lo fa sembrare nuovo.
    expect(sessions[0]?.createdAt).toBe(T0.toISOString());
  });

  it("una sessione chiusa sparisce, e le altre restano", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const famiglia = famigliaDi(harness, telefono);
    const portatile = await harness.service.login({ email: EMAIL, password: PASSWORD });

    // Prima di chiudere ce n'erano due: senza questa riga il caso passerebbe
    // anche se `listSessions` restituisse sempre la sola sessione corrente.
    expect((await harness.service.listSessions(telefono.user.id, famiglia)).sessions).toHaveLength(2);

    await harness.service.logout(portatile.tokens.refreshToken);

    const { sessions } = await harness.service.listSessions(telefono.user.id, famiglia);
    // Senza `revokedAt: null`, l'elenco conterrebbe ogni famiglia mai aperta da
    // questo utente, e chi cerca un telefono perduto lo vedrebbe ancora li'
    // dopo averlo scollegato.
    expect(sessions).toEqual([{ id: famiglia, createdAt: T0.toISOString(), current: true }]);
  });

  it("non mostra le sessioni di un altro utente", async () => {
    const harness = build();
    const mio = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    await harness.service.signup({ email: "altro@esempio.it", password: PASSWORD });
    await harness.service.login({ email: "altro@esempio.it", password: PASSWORD });
    const famiglia = famigliaDi(harness, mio);

    const { sessions } = await harness.service.listSessions(mio.user.id, famiglia);

    // Senza `userId` nella clausola sarebbero quattro, e due di quelle date
    // direbbero a uno sconosciuto quando un altro si e' collegato. Adesso che
    // c'e' anche l'`id`, quello che uscirebbe sarebbe peggio di una data: un
    // `sessionId` altrui, cioe' esattamente l'argomento che `revokeSession`
    // accetta.
    expect(sessions).toEqual([{ id: famiglia, createdAt: T0.toISOString(), current: true }]);
  });

  it("ordina dalla piu' recente, che e' quella che si riconosce", async () => {
    const harness = build();
    const vecchio = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    harness.clock.advanceDays(30);
    await harness.service.login({ email: EMAIL, password: PASSWORD });
    harness.clock.advanceDays(30);
    await harness.service.login({ email: EMAIL, password: PASSWORD });
    const famiglia = famigliaDi(harness, vecchio);

    const { sessions } = await harness.service.listSessions(vecchio.user.id, famiglia);

    // L'ordine non e' estetica: chi apre questa schermata cerca il dispositivo
    // di cui si e' appena accorto, e quello e' l'ultimo arrivato. In fondo alla
    // lista, dopo sei accessi vecchi, non lo trova.
    const date = sessions.map((s) => s.createdAt);
    expect(date).toEqual([...date].sort().reverse());
    // E la piu' vecchia — quella di chi sta chiedendo — e' in fondo, non in
    // cima: un ordine che mettesse per primo il chiamante passerebbe il
    // controllo di sopra e sarebbe comunque sbagliato.
    expect(sessions[2]).toEqual({ id: famiglia, createdAt: T0.toISOString(), current: true });
  });

  /**
   * Il caso di prima diceva il contrario, e diceva il vero.
   *
   * Finche' non e' esistito un gesto che consumasse l'id, questo `expect`
   * chiedeva `["createdAt", "current"]` e il commento spiegava che uno spread al
   * posto della costruzione campo per campo avrebbe fatto uscire un
   * identificativo di sessione a cui non corrispondeva niente. Adesso il gesto
   * c'e', l'id esce, e il caso e' rovesciato — ma i campi restano contati, non
   * verificati uno per uno: il difetto che quel conteggio prende e' ancora lo
   * spread, che oggi porterebbe fuori `issuedAt` e `expiresAt` insieme all'id.
   */
  it("fa uscire l'id, e nient'altro oltre ai tre campi del contratto", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const famiglia = famigliaDi(harness, telefono);

    const { sessions } = await harness.service.listSessions(telefono.user.id, famiglia);

    expect(Object.keys(sessions[0] ?? {}).sort()).toEqual(["createdAt", "current", "id"]);
    // E l'id e' *quello*, non un indice o un contatore: e' l'argomento che
    // `revokeSession` andra' a cercare nel database, quindi deve essere la
    // stessa stringa che il repository conosce come `familyId`.
    expect(sessions[0]?.id).toBe(famiglia);
  });
});

/**
 * Chiuderne una sola, scelta dall'elenco di sopra.
 *
 * I casi qui dentro guardano tutti la stessa cosa da lati diversi: che l'unico
 * modo di usare questa rotta sia quello previsto. Il `sessionId` arriva dal
 * corpo di una richiesta HTTP — cioe' da chiunque, con qualunque valore — ed e'
 * l'unico posto del servizio in cui un identificativo di un'altra riga del
 * database entra da fuori. Le tre difese sono la password, lo `userId` nella
 * clausola, e il rifiuto della propria famiglia; ognuna ha qui il suo caso e il
 * suo opposto.
 */
describe("revokeSession", () => {
  it("chiude la sessione scelta, e quella sola", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const portatile = await harness.service.login({ email: EMAIL, password: PASSWORD });
    const tablet = await harness.service.login({ email: EMAIL, password: PASSWORD });

    const esito = await harness.service.revokeSession(
      telefono.user.id,
      famigliaDi(harness, telefono),
      { sessionId: famigliaDi(harness, portatile), currentPassword: PASSWORD },
    );

    expect(esito).toEqual({ revoked: 1 });
    // Il numero da solo non basta: `revoked: 1` uscirebbe identico da una query
    // che ne ha chiusa una a caso. Le tre prove che seguono dicono *quale*.
    //
    // `TOKEN_REUSED` e non `UNAUTHORIZED`, ed e' la risposta giusta: il token
    // del portatile esiste ancora nel database con `revokedAt` valorizzato, e
    // presentarne uno revocato e' indistinguibile — di proposito — da un furto.
    // Chi scollega un dispositivo e poi lo riprende in mano rientra con la
    // password, che e' cio' che deve succedere.
    await expect(harness.service.refresh(portatile.tokens.refreshToken)).rejects.toMatchObject({
      code: "TOKEN_REUSED",
    });
    await expect(harness.service.refresh(tablet.tokens.refreshToken)).resolves.toBeDefined();
    // E la propria, che e' quella che si perderebbe con un `familyId` sbagliato
    // nella clausola: chi scollega un dispositivo altrui e si ritrova fuori non
    // riproverebbe mai piu'.
    await expect(harness.service.refresh(telefono.tokens.refreshToken)).resolves.toBeDefined();
  });

  it("rifiuta chi non sa la password, e non chiude niente", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const portatile = await harness.service.login({ email: EMAIL, password: PASSWORD });

    await expect(
      harness.service.revokeSession(telefono.user.id, famigliaDi(harness, telefono), {
        sessionId: famigliaDi(harness, portatile),
        currentPassword: "non-e-questa",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    // Senza la password questa rotta sarebbe il modo di aggirare quella di
    // sopra: chi ha in mano il telefono chiuderebbe gli altri uno per uno, e il
    // campo che protegge «scollega gli altri» non proteggerebbe piu' niente.
    await expect(harness.service.refresh(portatile.tokens.refreshToken)).resolves.toBeDefined();
  });

  it("verifica la password contro l'hash vero, non contro un ramo saltato", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const portatile = await harness.service.login({ email: EMAIL, password: PASSWORD });
    const prima = harness.hasher.verifyCalls;

    await harness.service.revokeSession(telefono.user.id, famigliaDi(harness, telefono), {
      sessionId: famigliaDi(harness, portatile),
      currentPassword: PASSWORD,
    });

    expect(harness.hasher.verifyCalls).toBe(prima + 1);
  });

  it("non chiude la sessione di un altro utente, e risponde zero", async () => {
    const harness = build();
    const mio = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const altro = await harness.service.signup({
      email: "altro@esempio.it",
      password: PASSWORD,
    });

    const esito = await harness.service.revokeSession(mio.user.id, famigliaDi(harness, mio), {
      // Un `familyId` vero, di un altro. Nel prodotto non si indovina, ma non
      // e' l'indovinabilita' la difesa: e' lo `userId` nella clausola.
      sessionId: famigliaDi(harness, altro),
      currentPassword: PASSWORD,
    });

    // Zero e non un errore: dire «quella sessione non e' tua» confermerebbe che
    // esiste, e questa rotta risponde uguale a un id altrui, a uno gia' chiuso
    // e a uno inventato.
    expect(esito).toEqual({ revoked: 0 });
    await expect(harness.service.refresh(altro.tokens.refreshToken)).resolves.toBeDefined();
  });

  it("rifiuta la propria sessione con un CONFLICT, e la lascia viva", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const famiglia = famigliaDi(harness, telefono);

    await expect(
      harness.service.revokeSession(telefono.user.id, famiglia, {
        sessionId: famiglia,
        currentPassword: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Lasciarla passare sarebbe peggio di un errore: la risposta direbbe
    // `revoked: 1` viaggiando su una sessione che quella stessa risposta ha
    // appena ucciso, e il client lo scoprirebbe alla richiesta dopo, con una
    // rotazione che fallisce su un token morto per mano sua.
    await expect(harness.service.refresh(telefono.tokens.refreshToken)).resolves.toBeDefined();
  });

  it("sulla propria sessione con la password sbagliata dice INVALID_CREDENTIALS, non CONFLICT", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const famiglia = famigliaDi(harness, telefono);

    // L'ordine fra le due difese e' esso stesso una difesa. Con il 409 davanti
    // alla verifica, il codice di stato diventa un oracolo: 409 vuol dire
    // «questa riga e' la tua», 401 vuol dire «non lo e'», e chi ha rubato un
    // access token impara quale dispositivo sta usando il proprietario
    // provando gli id dell'elenco con una password qualunque.
    await expect(
      harness.service.revokeSession(telefono.user.id, famiglia, {
        sessionId: famiglia,
        currentPassword: "non-e-questa",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("su una sessione gia' chiusa risponde zero, e non un errore", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const portatile = await harness.service.login({ email: EMAIL, password: PASSWORD });
    const famiglia = famigliaDi(harness, telefono);
    const chiusa = famigliaDi(harness, portatile);

    await harness.service.revokeSession(telefono.user.id, famiglia, {
      sessionId: chiusa,
      currentPassword: PASSWORD,
    });

    // Due schede aperte sullo stesso account, lo stesso pulsante premuto due
    // volte: la seconda volta il risultato voluto c'e' gia'. Un errore direbbe
    // «e' andata male» a chi ha ottenuto esattamente cio' che chiedeva.
    const esito = await harness.service.revokeSession(telefono.user.id, famiglia, {
      sessionId: chiusa,
      currentPassword: PASSWORD,
    });

    expect(esito).toEqual({ revoked: 0 });
  });

  it("su un id che non esiste risponde zero", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });

    const esito = await harness.service.revokeSession(
      telefono.user.id,
      famigliaDi(harness, telefono),
      { sessionId: "famiglia-che-non-c-e-mai-stata", currentPassword: PASSWORD },
    );

    expect(esito).toEqual({ revoked: 0 });
  });

  it("e' UNAUTHORIZED se l'utente non esiste piu'", async () => {
    const harness = build();

    // Senza il `findUserById` davanti, non ci sarebbe nessun hash contro cui
    // verificare e il ramo della password diventerebbe irraggiungibile o
    // esploderebbe: l'`AppError` esplicito e' l'unica delle due che si legge
    // dal client.
    await expect(
      harness.service.revokeSession("utente-sparito", "fam-qualunque", {
        sessionId: "fam-altra",
        currentPassword: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("la revoca porta l'istante del Clock iniettato", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const portatile = await harness.service.login({ email: EMAIL, password: PASSWORD });
    const chiusa = famigliaDi(harness, portatile);
    harness.clock.advanceSeconds(3600);

    await harness.service.revokeSession(telefono.user.id, famigliaDi(harness, telefono), {
      sessionId: chiusa,
      currentPassword: PASSWORD,
    });

    const revocati = harness.repo.allTokens().filter((t) => t.revokedAt !== null);
    expect(revocati).toHaveLength(1);
    expect(revocati[0]?.familyId).toBe(chiusa);
    expect(revocati[0]?.revokedAt?.getTime()).toBe(T0.getTime() + 3600 * 1000);
  });

  it("la riga chiusa sparisce dall'elenco, e le altre restano", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const portatile = await harness.service.login({ email: EMAIL, password: PASSWORD });
    await harness.service.login({ email: EMAIL, password: PASSWORD });
    const famiglia = famigliaDi(harness, telefono);
    const chiusa = famigliaDi(harness, portatile);

    await harness.service.revokeSession(telefono.user.id, famiglia, {
      sessionId: chiusa,
      currentPassword: PASSWORD,
    });

    // Il giro completo: l'id letto dall'elenco, speso, e l'elenco riletto. E'
    // la cosa che la schermata fa davvero, ed e' anche l'unico caso che
    // fallirebbe se `listSessions` esponesse come `id` qualcosa che non e' il
    // `familyId` — un indice, o il `tokenHash`.
    const { sessions } = await harness.service.listSessions(telefono.user.id, famiglia);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id)).not.toContain(chiusa);
  });
});

describe("me", () => {
  it("restituisce l'utente pubblico", async () => {
    const harness = build();
    const session = await harness.service.signup({ email: EMAIL, password: PASSWORD });

    const user = await harness.service.me(session.user.id);
    expect(user).toEqual(session.user);
    expect(Object.keys(user).sort()).toEqual(["createdAt", "email", "id", "locale"]);
  });

  it("e' UNAUTHORIZED se l'utente non esiste piu'", async () => {
    const harness = build();

    await expect(harness.service.me("utente-sparito")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

/**
 * `deleteAccount`, cioe' l'unico gesto di questo servizio che non si disfa.
 *
 * Ogni altro caso di questo file prova qualcosa che, se sbagliato, si corregge:
 * una sessione revocata si riapre, una password cambiata si ricambia. Qui no.
 * Per questo i casi guardano sempre due cose insieme — cosa e' sparito e cosa e'
 * rimasto — e mai solo la prima: un metodo che cancellasse l'intero database
 * restituendo i numeri giusti passerebbe qualunque asserzione scritta solo
 * sull'utente che ha chiesto di andarsene.
 */
describe("deleteAccount", () => {
  /**
   * Due utenti con le stesse cose addosso, e i byte veri nel bucket.
   *
   * Il secondo utente non e' un di piu': senza, nessuno dei casi distingue
   * «cancella le mie cose» da «cancella tutto», che e' precisamente il difetto
   * che un `where` dimenticato produce.
   */
  async function dueUtenti(): Promise<{
    harness: Harness;
    mia: AuthSession;
    altrui: AuthSession;
  }> {
    const harness = build();
    const mia = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const altrui = await harness.service.signup({
      email: "altro@esempio.it",
      password: PASSWORD,
    });

    for (const [utente, chiave] of [
      [mia.user.id, "audio/mio-1.webm"],
      [mia.user.id, "audio/mio-2.webm"],
      [altrui.user.id, "audio/suo-1.webm"],
    ] as const) {
      harness.repo.seedRecording({ userId: utente, audioUrl: chiave });
      await harness.storage.put({
        key: chiave,
        data: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm",
      });
    }

    harness.repo.seedProcedure(mia.user.id);
    harness.repo.seedProcedure(altrui.user.id);

    return { harness, mia, altrui };
  }

  it("cancella solo le mie cose", async () => {
    const { harness, mia, altrui } = await dueUtenti();

    const conti = await harness.service.deleteAccount(mia.user.id, {
      currentPassword: PASSWORD,
    });

    expect(conti).toEqual({ vocali: 2, schede: 1, sessioni: 1 });

    const dopo = harness.repo.snapshot();
    expect(dopo.utenti).toEqual([altrui.user.id]);
    expect(dopo.vocali).toEqual(["audio/suo-1.webm"]);
    expect(dopo.schede).toBe(1);
    expect(dopo.token).toBe(1);
  });

  it("i byte dell'audio spariscono dal bucket, e solo i miei", async () => {
    const { harness, mia } = await dueUtenti();

    await harness.service.deleteAccount(mia.user.id, { currentPassword: PASSWORD });

    // La cascata del database non arriva nel bucket: se il servizio si fidasse
    // di lei, qui resterebbero tre chiavi e nessun'altra asserzione se ne
    // accorgerebbe — l'audio orfano non rompe niente, costa solo per sempre.
    expect(harness.storage.keys).toEqual(["audio/suo-1.webm"]);
    expect(harness.orfani).toEqual([]);
  });

  it("un bucket che non collabora non ferma la cancellazione, ma lo dice", async () => {
    const { harness, mia } = await dueUtenti();
    harness.storage.delete = (key: string) =>
      Promise.reject(new Error(`il bucket dice di no su ${key}`));

    // Le righe sono gia' andate quando lo storage protesta: fallire adesso
    // vorrebbe dire rispondere «non ho cancellato» a chi e' gia' stato
    // cancellato, cioe' la bugia peggiore delle due.
    const conti = await harness.service.deleteAccount(mia.user.id, {
      currentPassword: PASSWORD,
    });

    expect(conti.vocali).toBe(2);
    expect(harness.repo.snapshot().utenti).toHaveLength(1);
    expect(harness.orfani.map((o) => o.key)).toEqual([
      "audio/mio-1.webm",
      "audio/mio-2.webm",
    ]);
  });

  it("la password sbagliata non cancella niente", async () => {
    const { harness, mia, altrui } = await dueUtenti();

    await expect(
      harness.service.deleteAccount(mia.user.id, { currentPassword: "non-e-questa" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    const dopo = harness.repo.snapshot();
    expect([...dopo.utenti].sort()).toEqual([mia.user.id, altrui.user.id].sort());
    expect(dopo.vocali).toHaveLength(3);
    expect(dopo.schede).toBe(2);
    expect(harness.storage.keys).toHaveLength(3);
  });

  it("con un vocale in lavorazione rifiuta e non cancella niente", async () => {
    const { harness, mia } = await dueUtenti();
    harness.repo.seedRecording({
      userId: mia.user.id,
      audioUrl: "audio/mio-3.webm",
      inLavorazione: true,
    });

    await expect(
      harness.service.deleteAccount(mia.user.id, { currentPassword: PASSWORD }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const dopo = harness.repo.snapshot();
    expect(dopo.utenti).toContain(mia.user.id);
    expect(dopo.vocali).toHaveLength(4);
    expect(harness.storage.keys).toHaveLength(3);
  });

  it("il rifiuto dice quanti sono, perche' e' un'attesa e non un guasto", async () => {
    const { harness, mia } = await dueUtenti();
    harness.repo.seedRecording({
      userId: mia.user.id,
      audioUrl: "audio/a.webm",
      inLavorazione: true,
    });
    harness.repo.seedRecording({
      userId: mia.user.id,
      audioUrl: "audio/b.webm",
      inLavorazione: true,
    });

    // Il numero e' l'unica cosa che distingue «riprova fra poco» da «e' rotto».
    // Senza, l'utente non ha nessun modo di sapere se aspettare ha senso.
    await expect(
      harness.service.deleteAccount(mia.user.id, { currentPassword: PASSWORD }),
    ).rejects.toMatchObject({ message: expect.stringContaining("2") as unknown as string });
  });

  it("un vocale in lavorazione di un altro non mi trattiene", async () => {
    const { harness, mia, altrui } = await dueUtenti();
    harness.repo.seedRecording({
      userId: altrui.user.id,
      audioUrl: "audio/suo-2.webm",
      inLavorazione: true,
    });

    // L'errore opposto del caso sopra: un conteggio senza `userId` fermerebbe
    // la cancellazione di chiunque ogni volta che un qualsiasi altro utente sta
    // registrando, e non lo direbbe nessuno.
    await expect(
      harness.service.deleteAccount(mia.user.id, { currentPassword: PASSWORD }),
    ).resolves.toMatchObject({ vocali: 2 });
  });

  it("conta le sessioni vive, non le righe dei token", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    await harness.service.login({ email: EMAIL, password: PASSWORD });

    // Una famiglia che ha ruotato tre volte ha quattro righe e resta un
    // dispositivo solo: se il numero fosse quello delle righe, la ricevuta
    // direbbe «hai scollegato cinque dispositivi» a chi ne ha due.
    let corrente = telefono.tokens.refreshToken;
    for (let i = 0; i < 3; i += 1) {
      const ruotata = await harness.service.refresh(corrente);
      corrente = ruotata.tokens.refreshToken;
    }
    expect(harness.repo.allTokens().length).toBeGreaterThan(2);

    const conti = await harness.service.deleteAccount(telefono.user.id, {
      currentPassword: PASSWORD,
    });
    expect(conti.sessioni).toBe(2);
  });

  it("una sessione gia' chiusa non si conta fra quelle scollegate", async () => {
    const harness = build();
    const telefono = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const portatile = await harness.service.login({ email: EMAIL, password: PASSWORD });
    await harness.service.logout(portatile.tokens.refreshToken);

    const conti = await harness.service.deleteAccount(telefono.user.id, {
      currentPassword: PASSWORD,
    });
    expect(conti.sessioni).toBe(1);
  });

  it("e' UNAUTHORIZED se l'utente non esiste piu'", async () => {
    const harness = build();

    // Non INVALID_CREDENTIALS: qui l'access token era valido e l'utente non
    // c'e'. E' lo stato di chi preme due volte, ed e' la stessa risposta che
    // `me` da' nello stesso caso.
    await expect(
      harness.service.deleteAccount("utente-sparito", { currentPassword: PASSWORD }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("un conto senza niente dentro si cancella lo stesso", async () => {
    const harness = build();
    const sessione = await harness.service.signup({ email: EMAIL, password: PASSWORD });

    const conti = await harness.service.deleteAccount(sessione.user.id, {
      currentPassword: PASSWORD,
    });

    // Zero non e' un errore, ed e' il caso di chi si e' iscritto e ci ha
    // ripensato: la 5.1.1(v) vale per lui esattamente come per gli altri.
    expect(conti).toEqual({ vocali: 0, schede: 0, sessioni: 1 });
    expect(harness.repo.snapshot().utenti).toEqual([]);
  });
});

describe("il servizio non conosce l'orologio di sistema", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = build();
  });

  it("le scadenze sono calcolate sul Clock iniettato", async () => {
    const session = await harness.service.signup({ email: EMAIL, password: PASSWORD });
    const stored = harness.repo.allTokens()[0];

    expect(stored?.issuedAt.toISOString()).toBe(T0.toISOString());
    expect(stored?.expiresAt.getTime()).toBe(
      T0.getTime() + harness.config.refreshTokenTtlSeconds * 1000,
    );
    expect(session.tokens.expiresIn).toBe(harness.config.accessTokenTtlSeconds);
  });
});
