import { randomBytes, randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { SignJWT, errors as joseErrors, jwtVerify } from "jose";
import { AppError } from "../errors/AppError.js";
import type { AccessTokenClaims, TokenIssuer } from "../services/ports/TokenIssuer.js";

/**
 * Access token JWT HS256 con `jose`, refresh token opachi con `node:crypto`.
 *
 * `jose` invece di `jsonwebtoken`: zero dipendenze transitive, ESM nativo,
 * verifica le `alg` accettate in modo esplicito (niente sorprese con `alg:
 * none` o con la confusione HS/RS).
 *
 * Il `Date` passato da fuori e' quello del `Clock`: sia la firma sia la
 * verifica lo usano, quindi la scadenza si testa avanzando un oggetto, non
 * l'orologio del processo.
 */

const ISSUER = "wikimylife";
const AUDIENCE = "wikimylife-api";
const ALGORITHM = "HS256";

export class JoseTokenIssuer implements TokenIssuer {
  readonly #secret: Uint8Array;
  readonly #accessTtlSeconds: number;

  constructor(params: { accessSecret: string; accessTtlSeconds: number }) {
    this.#secret = new TextEncoder().encode(params.accessSecret);
    this.#accessTtlSeconds = params.accessTtlSeconds;
  }

  issueAccessToken(input: { userId: string; familyId: string; now: Date }): Promise<string> {
    const issuedAtSeconds = Math.floor(input.now.getTime() / 1000);
    // `fid` e' un identificatore opaco: chi intercetta il token impara che
    // esiste una famiglia con quel UUID, e niente altro. Non e' un dato
    // personale e non lo diventa incrociandolo con qualcosa che sta fuori.
    return new SignJWT({ typ: "access", fid: input.familyId })
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(input.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAtSeconds)
      .setNotBefore(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + this.#accessTtlSeconds)
      .setJti(randomUUID())
      .sign(this.#secret);
  }

  async verifyAccessToken(token: string, now: Date): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.#secret, {
        // Lista chiusa: senza, un token con `alg` diverso potrebbe essere
        // accettato da un percorso di verifica che non ci aspettiamo.
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: now,
      });

      if (payload["typ"] !== "access") {
        // Un refresh token non e' un JWT, quindi non puo' finire qui; il
        // controllo protegge dai token che aggiungeremo in futuro (reset
        // password, inviti) e che non devono valere come access token.
        throw AppError.tokenInvalid();
      }
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw AppError.tokenInvalid();
      }
      const familyId = payload["fid"];
      if (typeof familyId !== "string" || familyId.length === 0) {
        // Un token senza famiglia non e' revocabile, e accettarlo "per
        // compatibilita'" vorrebbe dire tenere aperta proprio la finestra che
        // il claim serve a chiudere. Sono i token emessi prima di questo
        // cambiamento: il client, davanti a un 401, ruota una volta e va
        // avanti, quindi il prezzo del rifiuto e' una richiesta in piu' una
        // volta sola, non un utente buttato fuori.
        throw AppError.tokenInvalid();
      }
      return { userId: payload.sub, familyId };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (error instanceof joseErrors.JWTExpired) {
        throw AppError.tokenExpired();
      }
      throw AppError.tokenInvalid();
    }
  }

  generateRefreshToken(): string {
    return randomBytes(32).toString("base64url");
  }

  hashRefreshToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  newFamilyId(): string {
    return randomUUID();
  }
}
