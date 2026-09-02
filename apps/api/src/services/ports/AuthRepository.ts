/**
 * Porta di persistenza dell'autenticazione.
 *
 * Il servizio di dominio parla solo con questa interfaccia: non conosce Prisma,
 * non conosce Postgres, e nei test unitari riceve un'implementazione in memoria.
 * Le date entrano come parametro e non vengono mai prese dall'orologio di
 * sistema qui dentro: e' il `Clock` iniettato a decidere che ore sono.
 */

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly locale: string;
  readonly createdAt: Date;
}

export interface RefreshTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly familyId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly replacedById: string | null;
}

export interface NewRefreshToken {
  readonly userId: string;
  readonly tokenHash: string;
  readonly familyId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  createUser(input: {
    readonly email: string;
    readonly passwordHash: string;
    readonly locale: string;
  }): Promise<UserRecord>;

  createRefreshToken(input: NewRefreshToken): Promise<RefreshTokenRecord>;
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;

  /**
   * Rotazione atomica: inserisce il nuovo token e marca il precedente come
   * revocato e sostituito, in un'unica transazione.
   *
   * Deve essere una transazione, non due scritture: fra l'INSERT e l'UPDATE ci
   * sta comodamente una seconda richiesta che rilegge il vecchio token ancora
   * valido e lo ruota a sua volta, producendo due catene vive dalla stessa
   * famiglia — cioe' esattamente il caso che la reuse detection deve impedire.
   */
  rotateRefreshToken(input: {
    readonly currentId: string;
    readonly next: NewRefreshToken;
    readonly rotatedAt: Date;
  }): Promise<RefreshTokenRecord>;

  /** Revoca ogni token non ancora revocato della famiglia. Restituisce quanti. */
  revokeFamily(familyId: string, revokedAt: Date): Promise<number>;
}
