import type {
  AuthSession,
  ChangePasswordRequest,
  LoginRequest,
  PublicUser,
  SignupRequest,
} from "@wikimylife/shared";
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
  changePassword(userId: string, input: ChangePasswordRequest): Promise<AuthSession>;
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
    const accessToken = await tokens.issueAccessToken({ userId: user.id, familyId, now });
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

      // La famiglia e' quella di prima: la rotazione allunga la catena, non
      // apre una sessione nuova. Se qui nascesse una famiglia diversa, il
      // logout dovrebbe inseguirle tutte per chiuderne una.
      const accessToken = await tokens.issueAccessToken({
        userId: user.id,
        familyId: stored.familyId,
        now,
      });

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

    /**
     * Cambia la password e chiude tutte le sessioni, tranne quella da cui la
     * richiesta arriva.
     *
     * ## Perche' chiede la password che l'utente ha gia' dato
     *
     * La rotta sta dietro `requireAuth`, quindi chi chiama ha una sessione
     * valida. Non basta: una sessione valida e' uno schermo sbloccato, non una
     * persona. Il secondo fattore qui non e' un'app di codici, e' il fatto che
     * la password sta nella testa del proprietario e non nel telefono che gli
     * hanno preso di mano.
     *
     * ## Perche' rifiuta la stessa password
     *
     * Perche' il gesto avrebbe successo senza fare cio' che l'utente credeva di
     * fare. Chi cambia password sospettando che sia in giro, e per errore
     * ridigita quella, vedrebbe le sessioni cadere e ne dedurrebbe che il
     * problema e' risolto: la credenziale sospetta invece funziona ancora. Un
     * fallimento visibile costa una schermata di errore; il successo apparente
     * costa l'account.
     *
     * ## Perche' chi chiama non viene buttato fuori
     *
     * La revoca cade su tutto — e' il senso della cosa — ma poi si apre una
     * famiglia nuova per chi ha appena dimostrato di sapere la password. La
     * sessione da cui parte la richiesta non e' fra quelle sospette: e' l'unica
     * di cui in questo istante si sappia qualcosa. Costringere a rifare login
     * anche li' non aggiungerebbe sicurezza, aggiungerebbe soltanto un motivo
     * per non cambiare mai la password.
     *
     * L'ordine fra le due cose non e' negoziabile: prima la revoca, poi la
     * nuova famiglia. Al contrario, il token appena emesso finirebbe nella
     * mannaia insieme agli altri, e la risposta consegnerebbe al client una
     * sessione gia' morta.
     */
    async changePassword(userId: string, input: ChangePasswordRequest): Promise<AuthSession> {
      const user = await repo.findUserById(userId);
      if (user === null) {
        // Token firmato, famiglia viva, utente cancellato: e' un 401, come in
        // `me`. Non e' un 404: non si sta cercando una risorsa, si sta
        // scoprendo che chi chiede non esiste piu'.
        throw AppError.unauthorized();
      }

      const ok = await hasher.verify(user.passwordHash, input.currentPassword);
      if (!ok) {
        // Lo stesso errore di `login`, e per la stessa ragione: qui non c'e'
        // niente da enumerare, ma avere due codici diversi per «password
        // sbagliata» significherebbe che prima o poi uno dei due percorsi
        // cambia e l'altro no.
        throw AppError.invalidCredentials();
      }

      if (input.newPassword === input.currentPassword) {
        throw AppError.conflict("La nuova password e' identica a quella attuale");
      }

      const now = clock.now();
      await repo.changePassword({
        userId: user.id,
        passwordHash: await hasher.hash(input.newPassword),
        revokedAt: now,
      });

      return issueSession(user, tokens.newFamilyId());
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
