import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../../apps/api/src/config/env.js";
import { JoseTokenIssuer } from "../../apps/api/src/infra/JoseTokenIssuer.js";
import {
  FakeGoogleIdTokenVerifier,
  tokenGoogleFinto,
  type IdentitaGoogleFinta,
} from "../../apps/api/src/providers/fake/FakeGoogleIdTokenVerifier.js";
import { FakeStorageProvider } from "../../apps/api/src/providers/fake/FakeStorageProvider.js";
import {
  REAUTH_GOOGLE_MAX_MS,
  createAuthService,
  type AuthService,
} from "../../apps/api/src/services/auth.service.js";
import { FakePasswordHasher, testAuthConfig } from "../support/auth.js";
import { FixedClock } from "../support/FixedClock.js";
import { InMemoryAuthRepository } from "../support/InMemoryAuthRepository.js";

/**
 * L'accesso con Google, e Google come prova d'identita'.
 *
 * In un file suo e non dentro `auth.service.test.ts` perche' quello e' gia' il
 * racconto della password, e qui le domande sono altre: di chi e' un conto
 * quando due prove diverse puntano allo stesso indirizzo, e quanto deve essere
 * fresca una prova che non si digita.
 *
 * ## Il finto e il vero
 *
 * Il verificatore e' quello finto: la firma, l'emittente e il destinatario sono
 * affari di `JoseGoogleIdTokenVerifier`, che ha i suoi casi in
 * `googleVerifier.test.ts`. Qui si prova cosa fa il servizio con un'identita'
 * che Google ha gia' confermato — o che non ha confermato.
 *
 * ## Gli orologi
 *
 * Ogni token nasce a `T0` e non a «adesso»: `tokenGoogleFinto` senza data usa
 * l'orologio del processo, e il servizio guarda quello finto. Due orologi
 * diversi in un caso sulla freschezza sono un caso che passa per caso.
 */

const T0 = new Date("2026-04-01T10:00:00.000Z");
const EMAIL = "chi@esempio.it";
const PASSWORD = "una-password-lunga-abbastanza";
const SUB = "google-sub-1";

interface Harness {
  readonly service: AuthService;
  readonly repo: InMemoryAuthRepository;
  readonly clock: FixedClock;
  readonly hasher: FakePasswordHasher;
  readonly google: FakeGoogleIdTokenVerifier;
}

function build(
  overrides: Partial<AuthConfig> = {},
  opzioni: { readonly senzaGoogle?: boolean } = {},
): Harness {
  const repo = new InMemoryAuthRepository();
  const hasher = new FakePasswordHasher();
  const clock = new FixedClock(T0);
  const config = testAuthConfig(overrides);
  const google = new FakeGoogleIdTokenVerifier();
  return {
    service: createAuthService({
      repo,
      hasher,
      tokens: new JoseTokenIssuer({
        accessSecret: config.accessSecret,
        accessTtlSeconds: config.accessTokenTtlSeconds,
      }),
      clock,
      config,
      storage: new FakeStorageProvider(),
      google: opzioni.senzaGoogle === true ? undefined : google,
    }),
    repo,
    clock,
    hasher,
    google,
  };
}

function token(identita: Partial<IdentitaGoogleFinta> = {}): string {
  return tokenGoogleFinto({ sub: SUB, email: EMAIL, issuedAt: T0, ...identita });
}

/**
 * Gli hash su cui il servizio ha chiamato `verify`, in ordine.
 *
 * Contare le chiamate non basta: il ramo «conto senza password» deve verificare
 * contro l'hash *fittizio*, che costa quanto uno vero. Un servizio che passasse
 * al hasher il `null` del conto farebbe lo stesso numero di chiamate, e con
 * argon2 vero risponderebbe subito `false` — cioe' piu' in fretta degli altri, e
 * il tempo direbbe quali conti sono solo Google.
 */
function registraVerifiche(harness: Harness): (string | null)[] {
  const visti: (string | null)[] = [];
  const originale = harness.hasher.verify.bind(harness.hasher);
  harness.hasher.verify = (hash: string, password: string) => {
    visti.push(hash);
    return originale(hash, password);
  };
  return visti;
}

async function hashDi(harness: Harness, password: string): Promise<string> {
  return harness.hasher.hash(password);
}

describe("loginWithGoogle: chi entra", () => {
  it("un conto gia' collegato si apre dal sub, anche se Google adesso dice un altro indirizzo", async () => {
    const harness = build();
    const conto = harness.repo.seedUser({ email: EMAIL, passwordHash: null, googleSub: SUB });

    const sessione = await harness.service.loginWithGoogle({
      idToken: token({ email: "indirizzo-nuovo@esempio.it" }),
    });

    expect(sessione.user.id).toBe(conto.id);
    // L'indirizzo del conto non si riscrive con quello nuovo di Google: il
    // conto e' dell'utente, e Google non decide come si chiama.
    expect(sessione.user.email).toBe(EMAIL);
  });

  it("il sub vince sull'indirizzo: se sono di due conti diversi, entra quello del sub", async () => {
    const harness = build();
    harness.repo.seedUser({ email: EMAIL, passwordHash: await hashDi(harness, PASSWORD) });
    const collegato = harness.repo.seedUser({
      email: "altro@esempio.it",
      passwordHash: null,
      googleSub: SUB,
    });

    const sessione = await harness.service.loginWithGoogle({ idToken: token() });

    expect(sessione.user.id).toBe(collegato.id);
  });
});

describe("loginWithGoogle: il collegamento", () => {
  it("un conto con la password e lo stesso indirizzo verificato si collega, e da li' valgono tutte e due", async () => {
    const harness = build();
    const conto = harness.repo.seedUser({
      email: EMAIL,
      passwordHash: await hashDi(harness, PASSWORD),
    });

    const sessione = await harness.service.loginWithGoogle({ idToken: token() });

    expect(sessione.user.id).toBe(conto.id);
    expect(sessione.user.hasPassword).toBe(true);
    expect(sessione.user.hasGoogle).toBe(true);
    expect((await harness.repo.findUserById(conto.id))?.googleSub).toBe(SUB);
    // La password non e' stata toccata dal collegamento.
    await expect(harness.service.login({ email: EMAIL, password: PASSWORD })).resolves.toBeTruthy();
  });

  it("un indirizzo che Google non garantisce non collega niente", async () => {
    const harness = build();
    const conto = harness.repo.seedUser({
      email: EMAIL,
      passwordHash: await hashDi(harness, PASSWORD),
    });

    await expect(
      harness.service.loginWithGoogle({ idToken: token({ emailVerified: false }) }),
    ).rejects.toMatchObject({ code: "GOOGLE_EMAIL_UNVERIFIED", status: 403 });
    expect((await harness.repo.findUserById(conto.id))?.googleSub).toBeNull();
  });

  it("un indirizzo non garantito non crea nemmeno un conto nuovo", async () => {
    const harness = build({ signupEnabled: true });

    await expect(
      harness.service.loginWithGoogle({ idToken: token({ emailVerified: false }) }),
    ).rejects.toMatchObject({ code: "GOOGLE_EMAIL_UNVERIFIED" });
    expect(await harness.repo.findUserByEmail(EMAIL)).toBeNull();
  });

  it("ma un conto gia' collegato si apre anche se oggi Google non garantisce piu' l'indirizzo", async () => {
    // L'opposto dei due sopra: la garanzia serve a *collegare*, cioe' a
    // consegnare un conto la prima volta. Chi e' gia' collegato si riconosce
    // dal sub, e l'indirizzo non c'entra piu'.
    const harness = build();
    const conto = harness.repo.seedUser({ email: EMAIL, passwordHash: null, googleSub: SUB });

    const sessione = await harness.service.loginWithGoogle({
      idToken: token({ emailVerified: false }),
    });

    expect(sessione.user.id).toBe(conto.id);
  });

  it("un conto gia' collegato a un altro account Google e' un conflitto, e resta collegato a quello", async () => {
    const harness = build();
    const conto = harness.repo.seedUser({
      email: EMAIL,
      passwordHash: await hashDi(harness, PASSWORD),
      googleSub: "google-sub-di-prima",
    });

    await expect(harness.service.loginWithGoogle({ idToken: token() })).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
    expect((await harness.repo.findUserById(conto.id))?.googleSub).toBe("google-sub-di-prima");
  });
});

describe("loginWithGoogle: due collegamenti in parallelo", () => {
  // La corsa che `linkGoogle` esiste per chiudere: fra la lettura del conto e
  // la scrittura del `sub`, un'altra richiesta ha gia' collegato. Si simula
  // facendo collegare il conto proprio dentro la scrittura, e lasciando che la
  // scrittura risponda «era gia' collegato».
  function corsa(harness: Harness, subArrivatoPrima: string): void {
    const originale = harness.repo.linkGoogle.bind(harness.repo);
    harness.repo.linkGoogle = async (input) => {
      await originale({ userId: input.userId, googleSub: subArrivatoPrima });
      return null;
    };
  }

  it("se l'altra richiesta era lo stesso account Google, si entra nel conto", async () => {
    const harness = build();
    const conto = harness.repo.seedUser({
      email: EMAIL,
      passwordHash: await hashDi(harness, PASSWORD),
    });
    corsa(harness, SUB);

    const sessione = await harness.service.loginWithGoogle({ idToken: token() });

    expect(sessione.user.id).toBe(conto.id);
  });

  it("se l'altra richiesta era un altro account Google, e' un conflitto", async () => {
    const harness = build();
    harness.repo.seedUser({ email: EMAIL, passwordHash: await hashDi(harness, PASSWORD) });
    corsa(harness, "un-altro-sub-arrivato-prima");

    await expect(harness.service.loginWithGoogle({ idToken: token() })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("loginWithGoogle: l'iscrizione", () => {
  it("con le iscrizioni aperte nasce un conto senza password, nella lingua chiesta", async () => {
    const harness = build({ signupEnabled: true });

    const sessione = await harness.service.loginWithGoogle({ idToken: token(), locale: "en-GB" });

    expect(sessione.user.email).toBe(EMAIL);
    expect(sessione.user.locale).toBe("en-GB");
    expect(sessione.user.hasPassword).toBe(false);
    expect(sessione.user.hasGoogle).toBe(true);
    const salvato = await harness.repo.findUserByGoogleSub(SUB);
    expect(salvato?.passwordHash).toBeNull();
  });

  it("con le iscrizioni chiuse chi non ha un conto resta fuori, e non nasce niente", async () => {
    const harness = build({ signupEnabled: false });

    await expect(harness.service.loginWithGoogle({ idToken: token() })).rejects.toMatchObject({
      code: "SIGNUP_DISABLED",
      status: 403,
    });
    expect(await harness.repo.findUserByEmail(EMAIL)).toBeNull();
  });

  it("con le iscrizioni chiuse chi un conto ce l'ha entra lo stesso, collegandolo", async () => {
    const harness = build({ signupEnabled: false });
    const conto = harness.repo.seedUser({
      email: EMAIL,
      passwordHash: await hashDi(harness, PASSWORD),
    });

    const sessione = await harness.service.loginWithGoogle({ idToken: token() });

    expect(sessione.user.id).toBe(conto.id);
  });
});

describe("loginWithGoogle: quando Google non conferma", () => {
  it("un token che Google non riconosce e' GOOGLE_TOKEN_INVALID, un 401", async () => {
    const harness = build();

    await expect(
      harness.service.loginWithGoogle({ idToken: "non-e-un-token" }),
    ).rejects.toMatchObject({ code: "GOOGLE_TOKEN_INVALID", status: 401 });
  });

  it("Google che non risponde e' un 503, non un 401: l'utente non ha sbagliato niente", async () => {
    const harness = build();
    harness.google.guastoProssimo();

    await expect(harness.service.loginWithGoogle({ idToken: token() })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });

  it("senza verificatore la porta non esiste: GOOGLE_DISABLED, un 404", async () => {
    const harness = build({}, { senzaGoogle: true });

    await expect(harness.service.loginWithGoogle({ idToken: token() })).rejects.toMatchObject({
      code: "GOOGLE_DISABLED",
      status: 404,
    });
  });
});

describe("login con la password su un conto nato con Google", () => {
  it("e' una password sbagliata come le altre, e costa la stessa verifica", async () => {
    const harness = build();
    harness.repo.seedUser({ email: EMAIL, passwordHash: null, googleSub: SUB });
    const verifiche = registraVerifiche(harness);

    await expect(harness.service.login({ email: EMAIL, password: PASSWORD })).rejects.toMatchObject(
      { code: "INVALID_CREDENTIALS" },
    );
    // La verifica fittizia: senza, un conto solo Google risponderebbe prima di
    // uno con la password, e il tempo direbbe quali conti esistono e come.
    expect(verifiche).toEqual([harness.hasher.dummyHash]);
  });
});

describe("Google come prova d'identita'", () => {
  async function contoSoloGoogle(harness: Harness): Promise<string> {
    const sessione = await harness.service.loginWithGoogle({ idToken: token() });
    return sessione.user.id;
  }

  it("un token fresco del titolare cancella il conto", async () => {
    const harness = build();
    const id = await contoSoloGoogle(harness);

    await harness.service.deleteAccount(id, { googleIdToken: token() });

    expect(await harness.repo.findUserById(id)).toBeNull();
  });

  it("un token valido di un altro account Google non cancella niente", async () => {
    const harness = build();
    const id = await contoSoloGoogle(harness);

    await expect(
      harness.service.deleteAccount(id, { googleIdToken: token({ sub: "un-altro" }) }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(await harness.repo.findUserById(id)).not.toBeNull();
  });

  it("un conto senza Google non si apre con un token di Google", async () => {
    const harness = build();
    const conto = harness.repo.seedUser({
      email: EMAIL,
      passwordHash: await hashDi(harness, PASSWORD),
    });

    await expect(
      harness.service.deleteAccount(conto.id, { googleIdToken: token() }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(await harness.repo.findUserById(conto.id)).not.toBeNull();
  });

  it("un conto senza password non si apre con una password, e costa la stessa verifica", async () => {
    const harness = build();
    const id = await contoSoloGoogle(harness);
    const verifiche = registraVerifiche(harness);

    await expect(
      harness.service.deleteAccount(id, { currentPassword: PASSWORD }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(verifiche).toEqual([harness.hasher.dummyHash]);
    expect(await harness.repo.findUserById(id)).not.toBeNull();
  });

  it("un token firmato esattamente al limite vale ancora", async () => {
    const harness = build();
    const id = await contoSoloGoogle(harness);
    harness.clock.advanceSeconds(REAUTH_GOOGLE_MAX_MS / 1000);

    await harness.service.deleteAccount(id, { googleIdToken: token() });

    expect(await harness.repo.findUserById(id)).toBeNull();
  });

  it("un secondo oltre il limite non vale piu', anche se Google lo considera ancora valido", async () => {
    const harness = build();
    const id = await contoSoloGoogle(harness);
    harness.clock.advanceSeconds(REAUTH_GOOGLE_MAX_MS / 1000 + 1);

    await expect(
      harness.service.deleteAccount(id, { googleIdToken: token() }),
    ).rejects.toMatchObject({ code: "GOOGLE_TOKEN_INVALID" });
    expect(await harness.repo.findUserById(id)).not.toBeNull();
  });

  it("il limite di freschezza sta fra uno e dieci minuti", () => {
    // Sotto il minuto uno sfasamento fra l'orologio del server e quello di
    // Google rifiuterebbe conferme appena fatte; sopra i dieci la prova non e'
    // piu' fresca di una sessione aperta, che e' proprio cio' che non basta.
    expect(REAUTH_GOOGLE_MAX_MS).toBeGreaterThanOrEqual(60 * 1000);
    expect(REAUTH_GOOGLE_MAX_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("chi e' entrato solo con Google si da' una password confermando con Google, e poi entra con quella", async () => {
    const harness = build();
    const id = await contoSoloGoogle(harness);

    const sessione = await harness.service.changePassword(id, {
      googleIdToken: token(),
      newPassword: PASSWORD,
    });

    expect(sessione.user.hasPassword).toBe(true);
    expect(sessione.user.hasGoogle).toBe(true);
    await expect(harness.service.login({ email: EMAIL, password: PASSWORD })).resolves.toBeTruthy();
  });

  it("con Google come prova la nuova password non si confronta con nessuna vecchia", async () => {
    // L'errore opposto del rifiuto «identica a quella attuale»: quel confronto
    // ha senso solo quando la prova e' la password, e con Google non c'e'
    // niente con cui confrontare — un conto con la password che conferma con
    // Google puo' riscrivere la stessa, e non e' un 409.
    const harness = build();
    const conto = harness.repo.seedUser({
      email: EMAIL,
      passwordHash: await hashDi(harness, PASSWORD),
      googleSub: SUB,
    });

    await expect(
      harness.service.changePassword(conto.id, { googleIdToken: token(), newPassword: PASSWORD }),
    ).resolves.toBeTruthy();
  });

  it("scollegare gli altri dispositivi accetta la conferma di Google", async () => {
    const harness = build();
    await contoSoloGoogle(harness);
    const seconda = await harness.service.loginWithGoogle({ idToken: token() });
    const id = seconda.user.id;
    const [famiglia] = (await harness.repo.listOpenSessions(id)).map((s) => s.familyId);
    if (famiglia === undefined) {
      throw new Error("Nessuna sessione aperta: il caso non regge.");
    }

    const { revoked } = await harness.service.revokeOtherSessions(id, famiglia, {
      googleIdToken: token(),
    });

    expect(revoked).toBe(1);
  });

  it("chiudere una sessione sola accetta la conferma di Google, e rifiuta quella di un altro", async () => {
    const harness = build();
    await contoSoloGoogle(harness);
    await harness.service.loginWithGoogle({ idToken: token() });
    const id = (await harness.repo.findUserByGoogleSub(SUB))?.id ?? "";
    const [mia, altra] = (await harness.repo.listOpenSessions(id)).map((s) => s.familyId);
    if (mia === undefined || altra === undefined) {
      throw new Error("Servono due sessioni aperte: il caso non regge.");
    }

    await expect(
      harness.service.revokeSession(id, mia, { sessionId: altra, googleIdToken: token({ sub: "x" }) }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    const { revoked } = await harness.service.revokeSession(id, mia, {
      sessionId: altra,
      googleIdToken: token(),
    });
    expect(revoked).toBe(1);
  });
});
