import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  type KeyLike,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { JoseGoogleIdTokenVerifier } from "../../apps/api/src/infra/JoseGoogleIdTokenVerifier.js";

/**
 * Il verificatore vero, contro una chiave fatta qui.
 *
 * Google firma con RS256 e pubblica le chiavi in un JWKS; qui si genera una
 * coppia RSA, si pubblica la meta' pubblica in un JWKS locale, e si firmano
 * token come li firmerebbe Google — e poi, uno per volta, come non li
 * firmerebbe. Nessuna rete: il costruttore accetta le chiavi da fuori
 * esattamente per questo.
 *
 * Ogni regola ha il suo caso e il suo opposto: il destinatario sbagliato non
 * passa, ma il secondo della lista si'; l'emittente sconosciuto no, ma le due
 * forme di quello di Google si'. Senza l'opposto, un verificatore che rifiuta
 * tutto passerebbe mezza suite.
 */

const CLIENT = "client-web.apps.googleusercontent.com";
const CLIENT_APP = "client-android.apps.googleusercontent.com";
const KID = "chiave-di-prova";

let chiavi: JWTVerifyGetKey;
let privata: KeyLike;
let estranea: KeyLike;

beforeAll(async () => {
  const coppia = await generateKeyPair("RS256");
  privata = coppia.privateKey;
  const pubblica = { ...(await exportJWK(coppia.publicKey)), kid: KID, alg: "RS256" };
  chiavi = createLocalJWKSet({ keys: [pubblica] });
  estranea = (await generateKeyPair("RS256")).privateKey;
});

function verificatore(clientIds: readonly string[] = [CLIENT]): JoseGoogleIdTokenVerifier {
  return new JoseGoogleIdTokenVerifier({ clientIds, keys: chiavi });
}

async function firma(
  campi: JWTPayload = {},
  opzioni: {
    readonly chiave?: KeyLike;
    readonly aud?: string;
    readonly iss?: string;
    readonly scadenza?: number;
  } = {},
): Promise<string> {
  const adesso = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: "Chi@Esempio.it", email_verified: true, ...campi })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject("1234567890")
    .setIssuer(opzioni.iss ?? "https://accounts.google.com")
    .setAudience(opzioni.aud ?? CLIENT)
    .setIssuedAt(adesso)
    .setExpirationTime(opzioni.scadenza ?? adesso + 3600)
    .sign(opzioni.chiave ?? privata);
}

describe("JoseGoogleIdTokenVerifier: cio' che passa", () => {
  it("un token di Google per questo client diventa un'identita', con l'indirizzo in minuscolo", async () => {
    const identita = await verificatore().verify(await firma());

    expect(identita).not.toBeNull();
    expect(identita?.sub).toBe("1234567890");
    expect(identita?.email).toBe("chi@esempio.it");
    expect(identita?.emailVerified).toBe(true);
    // Al secondo: e' la precisione di `iat`.
    expect(Math.abs((identita?.issuedAt.getTime() ?? 0) - Date.now())).toBeLessThan(5000);
  });

  it("anche il secondo client della lista e' un destinatario valido", async () => {
    const identita = await verificatore([CLIENT, CLIENT_APP]).verify(
      await firma({}, { aud: CLIENT_APP }),
    );

    expect(identita?.sub).toBe("1234567890");
  });

  it("l'emittente senza schema, che Google usa ancora, e' accettato", async () => {
    const identita = await verificatore().verify(await firma({}, { iss: "accounts.google.com" }));

    expect(identita).not.toBeNull();
  });

  it("email_verified come stringa «true», dei token di qualche anno fa, vale verificato", async () => {
    const identita = await verificatore().verify(await firma({ email_verified: "true" }));

    expect(identita?.emailVerified).toBe(true);
  });
});

describe("JoseGoogleIdTokenVerifier: cio' che non passa", () => {
  it("un token emesso per un'altra applicazione e' null", async () => {
    expect(await verificatore().verify(await firma({}, { aud: CLIENT_APP }))).toBeNull();
  });

  it("un emittente che non e' Google e' null", async () => {
    expect(
      await verificatore().verify(await firma({}, { iss: "https://accounts.example.com" })),
    ).toBeNull();
  });

  it("un token scaduto e' null", async () => {
    const passato = Math.floor(Date.now() / 1000) - 60;
    expect(await verificatore().verify(await firma({}, { scadenza: passato }))).toBeNull();
  });

  it("un token firmato con un'altra chiave e' null", async () => {
    expect(await verificatore().verify(await firma({}, { chiave: estranea }))).toBeNull();
  });

  it("un token firmato HS256 con un segreto qualunque e' null", async () => {
    // La confusione fra algoritmi: un HS256 «firmato» con un segreto. Le difese
    // sono due e questo caso non le distingue: `algorithms: ["RS256"]` lo ferma
    // prima della firma, e anche senza nessuna chiave RSA del JWKS combacerebbe
    // con un HS256. La mutazione che toglie la prima sopravvive per questo, ed
    // e' dichiarata equivalente: la seconda basta, e la prima resta perche'
    // costa una riga e non dipende da come `jose` sceglie le chiavi.
    const falso = await new SignJWT({ email: "chi@esempio.it", email_verified: true })
      .setProtectedHeader({ alg: "HS256", kid: KID })
      .setSubject("1234567890")
      .setIssuer("https://accounts.google.com")
      .setAudience(CLIENT)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("un-segreto-qualunque-lungo-abbastanza"));

    expect(await verificatore().verify(falso)).toBeNull();
  });

  it("una stringa che non e' un JWT e' null, e non un'eccezione", async () => {
    expect(await verificatore().verify("non-e-un-token")).toBeNull();
  });

  it("un token senza indirizzo e' null: non c'e' niente da collegare ne' da creare", async () => {
    expect(await verificatore().verify(await firma({ email: undefined }))).toBeNull();
  });

  it("email_verified assente vale non verificato, che e' il lato sicuro", async () => {
    const identita = await verificatore().verify(await firma({ email_verified: undefined }));

    expect(identita).not.toBeNull();
    expect(identita?.emailVerified).toBe(false);
  });
});

describe("JoseGoogleIdTokenVerifier: quando non si riesce a guardare", () => {
  it("le chiavi che non arrivano sono un'eccezione, non un null", async () => {
    // L'opposto di tutti i null qui sopra: Google giu' non e' un token
    // sbagliato, e il servizio deve poterli distinguere per rispondere 503 e
    // non 401 a un utente in regola.
    const giu: JWTVerifyGetKey = () => Promise.reject(new TypeError("fetch failed"));
    const soloGiu = new JoseGoogleIdTokenVerifier({ clientIds: [CLIENT], keys: giu });

    await expect(soloGiu.verify(await firma())).rejects.toThrow("fetch failed");
  });

  it("senza client id non parte: una lista vuota non controllerebbe il destinatario", () => {
    expect(() => new JoseGoogleIdTokenVerifier({ clientIds: [], keys: chiavi })).toThrow(
      /client id/,
    );
  });
});
