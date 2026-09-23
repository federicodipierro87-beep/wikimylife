import type {
  AuthRepository,
  DeleteAccountOutcome,
  NewRefreshToken,
  OpenSessionRecord,
  RefreshTokenRecord,
  UserRecord,
} from "../../apps/api/src/services/ports/AuthRepository.js";

/**
 * Un vocale, ridotto ai tre campi che `deleteAccount` guarda.
 *
 * Non e' il `Recording` del database: qui non servono trascrizione, durata,
 * mime type. Tenerli costringerebbe ogni test a inventarsi dei valori per
 * campi che nessuna asserzione guarda, e la prima volta che il modello cresce
 * di una colonna obbligatoria si romperebbero tutti insieme per niente.
 */
interface VocaleFinto {
  readonly userId: string;
  readonly audioUrl: string;
  readonly inLavorazione: boolean;
}

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
  /**
   * I vocali e le schede, che nel database vero non stanno in questa porta.
   *
   * Ci stanno qui perche' `deleteAccount` li conta e li porta via: e' l'unico
   * metodo dell'autenticazione che guardi oltre gli utenti e i token, e un
   * doppio che fingesse di non vederli renderebbe impossibile provare l'unica
   * cosa che quel metodo deve garantire — che porti via le proprie cose e
   * lasci stare quelle degli altri.
   */
  #vocali: VocaleFinto[] = [];
  #schede: { readonly userId: string }[] = [];
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

  /** Un vocale preesistente. `inLavorazione` e' lo stato `IN_ELABORAZIONE`. */
  seedRecording(input: {
    readonly userId: string;
    readonly audioUrl: string;
    readonly inLavorazione?: boolean;
  }): void {
    this.#vocali.push({
      userId: input.userId,
      audioUrl: input.audioUrl,
      inLavorazione: input.inLavorazione ?? false,
    });
  }

  /** Una scheda preesistente: qui conta solo di chi e'. */
  seedProcedure(userId: string): void {
    this.#schede.push({ userId });
  }

  /** Ispezione: cosa e' rimasto dopo una cancellazione. */
  snapshot(): {
    readonly utenti: readonly string[];
    readonly vocali: readonly string[];
    readonly schede: number;
    readonly token: number;
  } {
    return {
      utenti: [...this.#users.keys()],
      vocali: this.#vocali.map((v) => v.audioUrl),
      schede: this.#schede.length,
      token: this.#tokens.size,
    };
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

  /**
   * Lo stesso scope a tre parti dell'adattatore vero, scritto come tre
   * condizioni in un `if` invece che come tre chiavi in un `WHERE`.
   *
   * Ricopiarlo e' il punto: se questo doppio si accontentasse del `familyId` —
   * cioe' se fosse `revokeFamily` con un nome diverso — i test unitari del
   * servizio passerebbero anche togliendo lo `userId` dalla query di Prisma, e
   * l'unico posto dove il difetto si vedrebbe sarebbe l'integrazione.
   */
  async revokeFamilyOfUser(input: {
    readonly userId: string;
    readonly familyId: string;
    readonly revokedAt: Date;
  }): Promise<number> {
    let revoked = 0;
    for (const [id, token] of this.#tokens) {
      if (
        token.userId === input.userId &&
        token.familyId === input.familyId &&
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

  /**
   * La cascata scritta a mano, perche' qui non c'e' nessun database a farla.
   *
   * Ogni filtro e' ripetuto con lo `userId`, come nell'adattatore vero, e per
   * il motivo gia' scritto su `revokeFamilyOfUser`: un doppio che cancellasse
   * tutto e restituisse i numeri giusti lascerebbe passare una query di Prisma
   * senza `where`, e l'unico posto dove il difetto si vedrebbe sarebbe
   * l'integrazione — cioe' dopo aver cancellato gli account di tutti.
   *
   * `sessioni` conta le *famiglie* vive e non le righe vive, come il `distinct`
   * dell'adattatore vero: una famiglia viva ha una riga sola, ma qui non c'e'
   * niente che lo imponga, e un test che facesse ruotare una sessione due volte
   * otterrebbe un numero diverso dal server se questa contasse le righe.
   */
  async deleteAccount(userId: string): Promise<DeleteAccountOutcome> {
    const inLavorazione = this.#vocali.filter(
      (v) => v.userId === userId && v.inLavorazione,
    ).length;
    if (inLavorazione > 0) {
      return { kind: "IN_LAVORAZIONE", quanti: inLavorazione };
    }

    const miei = this.#vocali.filter((v) => v.userId === userId);
    const schede = this.#schede.filter((s) => s.userId === userId).length;

    const famiglie = new Set<string>();
    for (const token of this.#tokens.values()) {
      if (token.userId === userId && token.revokedAt === null) {
        famiglie.add(token.familyId);
      }
    }

    this.#vocali = this.#vocali.filter((v) => v.userId !== userId);
    this.#schede = this.#schede.filter((s) => s.userId !== userId);
    for (const [id, token] of this.#tokens) {
      if (token.userId === userId) {
        this.#tokens.delete(id);
      }
    }
    this.#users.delete(userId);

    return {
      kind: "CANCELLATO",
      audioKeys: miei.map((v) => v.audioUrl),
      vocali: miei.length,
      schede,
      sessioni: famiglie.size,
    };
  }
}
