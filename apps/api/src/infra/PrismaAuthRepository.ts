import type { PrismaClient } from "@prisma/client";
import type {
  AuthRepository,
  NewRefreshToken,
  RefreshTokenRecord,
  UserRecord,
} from "../services/ports/AuthRepository.js";

/**
 * Implementazione Prisma della porta di autenticazione.
 *
 * Traduce fra righe del database e record di dominio, e nient'altro: nessuna
 * decisione qui dentro. Le regole (quando un token e' riusato, cosa succede
 * alla famiglia) stanno nel servizio, che non sa che esiste Prisma.
 */
export class PrismaAuthRepository implements AuthRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.#prisma.user.findUnique({ where: { email } });
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return this.#prisma.user.findUnique({ where: { id } });
  }

  async createUser(input: {
    email: string;
    passwordHash: string;
    locale: string;
  }): Promise<UserRecord> {
    return this.#prisma.user.create({ data: input });
  }

  async createRefreshToken(input: NewRefreshToken): Promise<RefreshTokenRecord> {
    return this.#prisma.refreshToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        familyId: input.familyId,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
      },
    });
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return this.#prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  async rotateRefreshToken(input: {
    currentId: string;
    next: NewRefreshToken;
    rotatedAt: Date;
  }): Promise<RefreshTokenRecord> {
    return this.#prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: {
          userId: input.next.userId,
          tokenHash: input.next.tokenHash,
          familyId: input.next.familyId,
          issuedAt: input.next.issuedAt,
          expiresAt: input.next.expiresAt,
        },
      });

      // `updateMany` con `revokedAt: null` nella clausola WHERE, non `update`:
      // se due rotazioni concorrenti partono dallo stesso token, la seconda
      // aggiorna zero righe invece di sovrascrivere l'esito della prima.
      const updated = await tx.refreshToken.updateMany({
        where: { id: input.currentId, revokedAt: null },
        data: { revokedAt: input.rotatedAt, replacedById: created.id },
      });

      if (updated.count === 0) {
        // Qualcun altro ha gia' ruotato questo token mentre eravamo qui.
        // Annullare la transazione lascia il database esattamente com'era e
        // fa arrivare il chiamante successivo al ramo di riuso.
        throw new RefreshTokenRotationConflict(input.currentId);
      }

      return created;
    });
  }

  async revokeFamily(familyId: string, revokedAt: Date): Promise<number> {
    const result = await this.#prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count;
  }
}

export class RefreshTokenRotationConflict extends Error {
  constructor(tokenId: string) {
    super(`Rotazione concorrente sul refresh token ${tokenId}`);
    this.name = "RefreshTokenRotationConflict";
  }
}
