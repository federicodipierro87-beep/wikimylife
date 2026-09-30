import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type {
  GoogleIdentity,
  GoogleIdTokenVerifier,
} from "../services/ports/GoogleIdTokenVerifier.js";

/**
 * Verifica un ID token di Google con le chiavi pubbliche di Google.
 *
 * ## Perche' qui e non con la libreria di Google
 *
 * `google-auth-library` fa la stessa cosa e porta con se' mezzo client HTTP di
 * Google. `jose` c'e' gia' — firma gli access token — e verificare un RS256
 * contro un JWKS e' esattamente cio' per cui esiste. Le regole che Google chiede
 * di controllare sono quattro, e stanno tutte qui sotto: firma, emittente,
 * destinatario, scadenza.
 *
 * ## Perche' il destinatario e' una lista
 *
 * L'`aud` di un ID token e' l'identificativo del client OAuth che l'ha chiesto,
 * e ogni piattaforma ne ha uno: il sito il suo, e domani le app native il loro.
 * Un token emesso per un'applicazione che non e' nella lista e' un token che
 * qualcun altro ha ottenuto per se' — accettarlo vorrebbe dire che qualunque
 * sito con un pulsante di Google potrebbe entrare qui con le identita' dei suoi
 * utenti.
 *
 * ## Le chiavi
 *
 * `createRemoteJWKSet` le scarica alla prima verifica e le tiene in memoria;
 * quando arriva un token firmato con una chiave che non conosce — Google le
 * ruota — le riscarica. Il parametro `keys` esiste per i test, che firmano con
 * una chiave loro e non devono parlare con Google.
 */

const CHIAVI_GOOGLE = new URL("https://www.googleapis.com/oauth2/v3/certs");

/** Google firma con l'uno o con l'altro, e la documentazione dice di accettarli entrambi. */
const EMITTENTI = ["https://accounts.google.com", "accounts.google.com"];

export class JoseGoogleIdTokenVerifier implements GoogleIdTokenVerifier {
  readonly #clientIds: readonly string[];
  readonly #keys: JWTVerifyGetKey;

  constructor(params: { clientIds: readonly string[]; keys?: JWTVerifyGetKey }) {
    if (params.clientIds.length === 0) {
      // Con una lista vuota `jwtVerify` non controllerebbe il destinatario
      // affatto, e ogni token di Google del mondo passerebbe. Meglio non partire.
      throw new Error("JoseGoogleIdTokenVerifier: serve almeno un client id");
    }
    this.#clientIds = params.clientIds;
    this.#keys = params.keys ?? createRemoteJWKSet(CHIAVI_GOOGLE);
  }

  async verify(idToken: string): Promise<GoogleIdentity | null> {
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, this.#keys, {
        issuer: EMITTENTI,
        audience: [...this.#clientIds],
        algorithms: ["RS256"],
      }));
    } catch (error: unknown) {
      if (eColpaDelToken(error)) {
        return null;
      }
      throw error;
    }

    const { sub, email, iat } = payload;
    if (typeof sub !== "string" || sub === "" || typeof email !== "string" || typeof iat !== "number") {
      // Un token firmato da Google senza questi campi non dovrebbe esistere; se
      // esiste, chiede un permesso («email») che il pulsante non ha chiesto, e
      // senza l'indirizzo non si puo' ne' collegare ne' creare niente.
      return null;
    }

    return {
      sub,
      email: email.trim().toLowerCase(),
      // Booleano nei token di oggi, stringa «true» in quelli di qualche anno fa.
      // Qualunque altra cosa vale «non verificato», che e' il lato sicuro.
      emailVerified: payload["email_verified"] === true || payload["email_verified"] === "true",
      issuedAt: new Date(iat * 1000),
    };
  }
}

/**
 * Gli errori che dicono «il token non va», distinti da quelli che dicono «non
 * sono riuscito a guardarlo».
 *
 * `JWKSTimeout` e i guasti di rete restano fuori apposta: sono i casi in cui
 * Google non ha risposto, e trasformarli in un 401 direbbe a un utente in
 * regola che il suo account non vale.
 */
function eColpaDelToken(error: unknown): boolean {
  return (
    error instanceof joseErrors.JWTExpired ||
    error instanceof joseErrors.JWTClaimValidationFailed ||
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JWTInvalid ||
    error instanceof joseErrors.JWKSNoMatchingKey ||
    error instanceof joseErrors.JOSEAlgNotAllowed ||
    error instanceof joseErrors.JOSENotSupported
  );
}
