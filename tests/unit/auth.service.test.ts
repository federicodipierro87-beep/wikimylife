import { beforeEach, describe, expect, it } from "vitest";
import { JoseTokenIssuer } from "../../apps/api/src/infra/JoseTokenIssuer.js";
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

  return {
    service: createAuthService({ repo, hasher, tokens, clock, config }),
    repo,
    clock,
    hasher,
    config,
  };
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
