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

  /**
   * La lettura che ogni richiesta autenticata paga.
   *
   * `findFirst` con `select` di una colonna sola e non un `count`: la domanda e'
   * «ne esiste almeno uno», e Postgres puo' fermarsi al primo che trova invece
   * di scorrere l'intera catena di rotazioni della famiglia — che dopo un mese
   * di uso quotidiano sono qualche centinaio di righe. L'indice e' quello su
   * `familyId`, che c'era gia' per la revoca.
   */
  async isFamilyActive(familyId: string): Promise<boolean> {
    const alive = await this.#prisma.refreshToken.findFirst({
      where: { familyId, revokedAt: null },
      select: { id: true },
    });
    return alive !== null;
  }

  async revokeFamily(familyId: string, revokedAt: Date): Promise<number> {
    const result = await this.#prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count;
  }

  /**
   * Una sola `updateMany`, e nessuna transazione: qui c'e' una scrittura sola,
   * e una scrittura sola in Postgres o avviene tutta o non avviene.
   *
   * `familyId: { not: ... }` dentro il WHERE e non un filtro applicato dopo la
   * lettura: fra un `findMany` e le revoche ci sta un login su un altro
   * dispositivo, e quel login aprirebbe una sessione che il gesto avrebbe
   * dovuto chiudere e che invece non era ancora nell'elenco. La riga di SQL
   * decide su cio' che c'e' nel momento in cui scrive.
   *
   * `updateMany` e non `deleteMany`, come nel cambio password e per la stessa
   * ragione: le righe revocate sono cio' che fa scattare la reuse detection
   * quando un token tornera'.
   */
  async revokeOtherFamilies(input: {
    userId: string;
    exceptFamilyId: string;
    revokedAt: Date;
  }): Promise<number> {
    const revoked = await this.#prisma.refreshToken.updateMany({
      where: {
        userId: input.userId,
        familyId: { not: input.exceptFamilyId },
        revokedAt: null,
      },
      data: { revokedAt: input.revokedAt },
    });
    return revoked.count;
  }

  /**
   * Le due scritture in una transazione sola: il motivo per cui devono stare
   * insieme e' scritto sulla porta.
   *
   * `updateMany` sull'indice `userId` e non una `deleteMany`: le righe revocate
   * sono la storia delle rotazioni, ed e' quella storia a far scattare la reuse
   * detection quando un token rubato torna. Cancellarle trasformerebbe un riuso
   * in un TOKEN_INVALID, cioe' in un 401 qualunque, e la famiglia non morirebbe
   * piu' — proprio nel momento in cui e' piu' importante che muoia.
   */
  async changePassword(input: {
    userId: string;
    passwordHash: string;
    revokedAt: Date;
  }): Promise<number> {
    return this.#prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: input.userId },
        data: { passwordHash: input.passwordHash },
      });

      const revoked = await tx.refreshToken.updateMany({
        where: { userId: input.userId, revokedAt: null },
        data: { revokedAt: input.revokedAt },
      });

      return revoked.count;
    });
  }
}

export class RefreshTokenRotationConflict extends Error {
  constructor(tokenId: string) {
    super(`Rotazione concorrente sul refresh token ${tokenId}`);
    this.name = "RefreshTokenRotationConflict";
  }
}
