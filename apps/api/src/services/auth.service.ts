import type { AuthSession, LoginRequest, PublicUser, SignupRequest } from "@wikimylife/shared";
import type { AuthConfig } from "../config/env.js";
import { AppError } from "../errors/AppError.js";
import type { AuthRepository, UserRecord } from "./ports/AuthRepository.js";
import type { Clock } from "./ports/Clock.js";
import type { PasswordHasher } from "./ports/PasswordHasher.js";
import type { TokenIssuer } from "./ports/TokenIssuer.js";

/**
 * Servizio di dominio dell'autenticazione.
 *
 * Zero import di express, prisma, jose, argon2, node:crypto. Riceve tutto:
 * `{ repo, hasher, tokens, clock, config }`. E' la ragione per cui i test
 * unitari coprono rotazione, riuso e scadenza senza database, senza rete e in
 * millisecondi.
 */

export interface AuthServiceDeps {
  readonly repo: AuthRepository;
  readonly hasher: PasswordHasher;
  readonly tokens: TokenIssuer;
  readonly clock: Clock;
  readonly config: AuthConfig;
}

export interface AuthService {
  signup(input: SignupRequest): Promise<AuthSession>;
  login(input: LoginRequest): Promise<AuthSession>;
  refresh(rawRefreshToken: string): Promise<AuthSession>;
  logout(rawRefreshToken: string): Promise<void>;
  me(userId: string): Promise<PublicUser>;
}

export function toPublicUser(user: UserRecord): PublicUser {
  // Costruito campo per campo, mai con lo spread: cosi' aggiungere una colonna
  // al modello non puo' far uscire per sbaglio il passwordHash.
  return {
    id: user.id,
    email: user.email,
    locale: user.locale,
    createdAt: user.createdAt.toISOString(),
  };
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { repo, hasher, tokens, clock, config } = deps;

  async function issueSession(user: UserRecord, familyId: string): Promise<AuthSession> {
    const now = clock.now();
    const accessToken = await tokens.issueAccessToken({ userId: user.id, now });
    const refreshToken = tokens.generateRefreshToken();

    await repo.createRefreshToken({
      userId: user.id,
      tokenHash: tokens.hashRefreshToken(refreshToken),
      familyId,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + config.refreshTokenTtlSeconds * 1000),
    });

    return {
      user: toPublicUser(user),
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: config.accessTokenTtlSeconds,
        tokenType: "Bearer",
      },
    };
  }

  return {
    async signup(input: SignupRequest): Promise<AuthSession> {
      if (!config.signupEnabled) {
        throw AppError.signupDisabled();
      }

      const existing = await repo.findUserByEmail(input.email);
      if (existing !== null) {
        throw AppError.emailTaken();
      }

      const user = await repo.createUser({
        email: input.email,
        passwordHash: await hasher.hash(input.password),
        locale: input.locale ?? "it-IT",
      });

      return issueSession(user, tokens.newFamilyId());
    },

    async login(input: LoginRequest): Promise<AuthSession> {
      const user = await repo.findUserByEmail(input.email);

      if (user === null) {
        // Si verifica comunque, contro un hash fittizio: il costo in tempo del
        // ramo "utente inesistente" deve essere lo stesso del ramo "password
        // errata", altrimenti la latenza dice chi e' registrato.
        await hasher.verify(hasher.dummyHash, input.password);
        throw AppError.invalidCredentials();
      }

      const ok = await hasher.verify(user.passwordHash, input.password);
      if (!ok) {
        throw AppError.invalidCredentials();
      }

      // Ogni login apre una famiglia nuova: le sessioni su dispositivi diversi
      // sono indipendenti, e revocarne una non butta giu' le altre.
      return issueSession(user, tokens.newFamilyId());
    },

    /**
     * Rotazione con reuse detection.
     *
     *   1. hash del token -> riga assente                 => TOKEN_INVALID
     *   2. riga gia' revocata                             => RIUSO: revoca
     *                                                        l'intera famiglia,
     *                                                        poi TOKEN_REUSED
     *   3. riga scaduta                                   => TOKEN_EXPIRED
     *   4. transazione: INSERT del nuovo (stessa famiglia)
     *                   UPDATE del vecchio (revokedAt, replacedById)
     *
     * Il punto 2 e' il cuore della difesa: un token rubato che venga usato dopo
     * la rotazione legittima non ottiene una sessione, uccide la catena. Il
     * ladro non entra e il proprietario se ne accorge, perche' viene buttato
     * fuori.
     */
    async refresh(rawRefreshToken: string): Promise<AuthSession> {
      const now = clock.now();
      const tokenHash = tokens.hashRefreshToken(rawRefreshToken);
      const stored = await repo.findRefreshTokenByHash(tokenHash);

      if (stored === null) {
        throw AppError.tokenInvalid();
      }

      if (stored.revokedAt !== null) {
        await repo.revokeFamily(stored.familyId, now);
        throw AppError.tokenReused();
      }

      if (stored.expiresAt.getTime() <= now.getTime()) {
        throw AppError.tokenExpired();
      }

      const user = await repo.findUserById(stored.userId);
      if (user === null) {
        // Utente sparito ma token vivo: la famiglia non ha piu' senso.
        await repo.revokeFamily(stored.familyId, now);
        throw AppError.tokenInvalid();
      }

      const nextToken = tokens.generateRefreshToken();
      await repo.rotateRefreshToken({
        currentId: stored.id,
        rotatedAt: now,
        next: {
          userId: user.id,
          tokenHash: tokens.hashRefreshToken(nextToken),
          familyId: stored.familyId,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + config.refreshTokenTtlSeconds * 1000),
        },
      });

      const accessToken = await tokens.issueAccessToken({ userId: user.id, now });

      return {
        user: toPublicUser(user),
        tokens: {
          accessToken,
          refreshToken: nextToken,
          expiresIn: config.accessTokenTtlSeconds,
          tokenType: "Bearer",
        },
      };
    },

    /**
     * Chiude la famiglia intera, non il singolo anello: se restasse in piedi un
     * discendente, "esci" non avrebbe mantenuto la promessa.
     *
     * Non dice mai se il token esisteva: un logout con un token inventato deve
     * essere indistinguibile da uno legittimo.
     */
    async logout(rawRefreshToken: string): Promise<void> {
      const stored = await repo.findRefreshTokenByHash(
        tokens.hashRefreshToken(rawRefreshToken),
      );
      if (stored === null) {
        return;
      }
      await repo.revokeFamily(stored.familyId, clock.now());
    },

    async me(userId: string): Promise<PublicUser> {
      const user = await repo.findUserById(userId);
      if (user === null) {
        // Access token firmato ma utente cancellato: e' un 401, non un 404.
        throw AppError.unauthorized();
      }
      return toPublicUser(user);
    },
  };
}
