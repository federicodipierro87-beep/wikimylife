import type {
  AuthRepository,
  NewRefreshToken,
  OpenSessionRecord,
  RefreshTokenRecord,
  UserRecord,
} from "../../apps/api/src/services/ports/AuthRepository.js";

/**
 * `AuthRepository` in memoria.
 *
 * Riproduce i vincoli che contano del database vero, non tutti:
 *  - email unica (case-insensitive: e' cosi' che il servizio la normalizza);
 *  - `tokenHash` unico;
 *  - la rotazione e' atomica — qui e' banale perche' non c'e' concorrenza, ma
 *    la firma e' la stessa, quindi il servizio non sa la differenza.
 *
 * Restituisce sempre copie: un test che modificasse per sbaglio un record
 * restituito starebbe modificando lo "stato del database", e il fallimento
 * comparirebbe altrove.
 */
export class InMemoryAuthRepository implements AuthRepository {
  readonly #users = new Map<string, UserRecord>();
  readonly #tokens = new Map<string, RefreshTokenRecord>();
  #sequence = 0;

  #nextId(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${String(this.#sequence)}`;
  }

  /** Utente preesistente, con l'hash gia' calcolato dal chiamante. */
  seedUser(input: {
    readonly id?: string;
    readonly email: string;
    readonly passwordHash: string;
    readonly locale?: string;
    readonly createdAt?: Date;
  }): UserRecord {
    const user: UserRecord = {
      id: input.id ?? this.#nextId("user"),
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      locale: input.locale ?? "it-IT",
      createdAt: input.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    };
    this.#users.set(user.id, user);
    return { ...user };
  }

  /** Ispezione, per i test sulla revoca di famiglia. */
  tokensOfFamily(familyId: string): RefreshTokenRecord[] {
    return [...this.#tokens.values()]
      .filter((t) => t.familyId === familyId)
      .map((t) => ({ ...t }));
  }

  allTokens(): RefreshTokenRecord[] {
    return [...this.#tokens.values()].map((t) => ({ ...t }));
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const needle = email.toLowerCase();
    for (const user of this.#users.values()) {
      if (user.email === needle) {
        return { ...user };
      }
    }
    return null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const user = this.#users.get(id);
    return user === undefined ? null : { ...user };
  }

  async createUser(input: {
    readonly email: string;
    readonly passwordHash: string;
    readonly locale: string;
  }): Promise<UserRecord> {
    const existing = await this.findUserByEmail(input.email);
    if (existing !== null) {
      throw new Error(`email gia' presente: ${input.email}`);
    }
    return this.seedUser(input);
  }

  async createRefreshToken(input: NewRefreshToken): Promise<RefreshTokenRecord> {
    if (this.#findByHash(input.tokenHash) !== undefined) {
      throw new Error("tokenHash duplicato");
    }
    const record: RefreshTokenRecord = {
      id: this.#nextId("rt"),
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      revokedAt: null,
      replacedById: null,
    };
    this.#tokens.set(record.id, record);
    return { ...record };
  }

  #findByHash(tokenHash: string): RefreshTokenRecord | undefined {
    for (const token of this.#tokens.values()) {
      if (token.tokenHash === tokenHash) {
        return token;
      }
    }
    return undefined;
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const found = this.#findByHash(tokenHash);
    return found === undefined ? null : { ...found };
  }

  async rotateRefreshToken(input: {
    readonly currentId: string;
    readonly next: NewRefreshToken;
    readonly rotatedAt: Date;
  }): Promise<RefreshTokenRecord> {
    const current = this.#tokens.get(input.currentId);
    if (current === undefined) {
      throw new Error(`token assente: ${input.currentId}`);
    }
    if (current.revokedAt !== null) {
      // Il database reale lo impedisce con un UPDATE ... WHERE revokedAt IS NULL
      // che aggiorna zero righe. Qui e' un'eccezione, ma il servizio non ci
      // arriva mai: controlla la revoca prima.
      throw new Error("rotazione su un token gia' revocato");
    }

    const next = await this.createRefreshToken(input.next);
    this.#tokens.set(current.id, {
      ...current,
      revokedAt: input.rotatedAt,
      replacedById: next.id,
    });
    return next;
  }

  async isFamilyActive(familyId: string): Promise<boolean> {
    for (const token of this.#tokens.values()) {
      if (token.familyId === familyId && token.revokedAt === null) {
        return true;
      }
    }
    return false;
  }

  async changePassword(input: {
    readonly userId: string;
    readonly passwordHash: string;
    readonly revokedAt: Date;
  }): Promise<number> {
    const user = this.#users.get(input.userId);
    if (user === undefined) {
      throw new Error(`utente assente: ${input.userId}`);
    }
    this.#users.set(user.id, { ...user, passwordHash: input.passwordHash });

    let revoked = 0;
    for (const [id, token] of this.#tokens) {
      if (token.userId === input.userId && token.revokedAt === null) {
        this.#tokens.set(id, { ...token, revokedAt: input.revokedAt });
        revoked += 1;
      }
    }
    return revoked;
  }

  async revokeOtherFamilies(input: {
    readonly userId: string;
    readonly exceptFamilyId: string;
    readonly revokedAt: Date;
  }): Promise<number> {
    let revoked = 0;
    for (const [id, token] of this.#tokens) {
      if (
        token.userId === input.userId &&
        token.familyId !== input.exceptFamilyId &&
        token.revokedAt === null
      ) {
        this.#tokens.set(id, { ...token, revokedAt: input.revokedAt });
        revoked += 1;
      }
    }
    return revoked;
  }

  async revokeFamily(familyId: string, revokedAt: Date): Promise<number> {
    let revoked = 0;
    for (const [id, token] of this.#tokens) {
      if (token.familyId === familyId && token.revokedAt === null) {
        this.#tokens.set(id, { ...token, revokedAt });
        revoked += 1;
      }
    }
    return revoked;
  }

  /**
   * Due scorse sulla mappa, come Postgres fa due interrogazioni.
   *
   * La prima raccoglie le famiglie con un token vivo, la seconda il minimo degli
   * `issuedAt` su tutte le righe di quelle famiglie — comprese le revocate, che
   * sono la storia delle rotazioni e contengono la nascita. Farlo in una scorsa
   * sola tenendo il minimo solo delle righe vive darebbe l'ultima rotazione, ed
   * e' proprio lo sbaglio che il test deve poter vedere.
   *
   * L'ordinamento e' esplicito e non l'ordine d'inserimento della `Map`: il
   * database non ne ha uno, e un doppio in memoria che ne regala uno gratis
   * lascia passare una `sort` dimenticata nell'adattatore vero.
   */
  async listOpenSessions(userId: string): Promise<readonly OpenSessionRecord[]> {
    const vive = new Set<string>();
    for (const token of this.#tokens.values()) {
      if (token.userId === userId && token.revokedAt === null) {
        vive.add(token.familyId);
      }
    }

    const nascite = new Map<string, Date>();
    for (const token of this.#tokens.values()) {
      if (token.userId !== userId || !vive.has(token.familyId)) {
        continue;
      }
      const gia = nascite.get(token.familyId);
      if (gia === undefined || token.issuedAt.getTime() < gia.getTime()) {
        nascite.set(token.familyId, token.issuedAt);
      }
    }

    return [...nascite.entries()]
      .map(([familyId, createdAt]) => ({ familyId, createdAt }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}
