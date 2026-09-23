import type { PrismaClient } from "@prisma/client";
import type {
  AuthRepository,
  DeleteAccountOutcome,
  NewRefreshToken,
  OpenSessionRecord,
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
   * Due interrogazioni, e non una.
   *
   * Le due domande non si fanno insieme perche' hanno due soggetti diversi.
   * «Viva» e' una proprieta' di una riga — quella non revocata — e la trova un
   * `findMany` sull'indice `userId`. «Nata» e' un minimo su tutte le righe della
   * famiglia, comprese le decine che la rotazione ha gia' revocato: se la si
   * chiedesse alla sola riga viva si otterrebbe l'ultima rotazione, che e'
   * l'informazione che il contratto ha deciso di non raccogliere.
   *
   * L'alternativa a una query sola sarebbe leggere ogni riga dell'utente e
   * aggregare in memoria. Funziona, e trasferisce qualche centinaio di righe per
   * produrne tre: il `groupBy` fa il minimo dentro Postgres e riporta una riga
   * per famiglia.
   *
   * Fra le due interrogazioni c'e' una finestra: un logout puo' revocare una
   * famiglia che il `findMany` aveva visto viva, e allora resta elencata una
   * sessione che non c'e' piu'. Non e' un caso da chiudere con una transazione:
   * la stessa finestra esiste, e piu' larga, fra la risposta e l'occhio che la
   * legge. Una lettura di questo tipo e' vera al momento in cui parte, non per
   * sempre.
   *
   * `_min: { issuedAt }` e nessun `orderBy` nel `groupBy`: ordinare per
   * un'aggregazione si scrive in un modo che nasconde cosa fa, e sono tre righe.
   */
  async listOpenSessions(userId: string): Promise<readonly OpenSessionRecord[]> {
    const vive = await this.#prisma.refreshToken.findMany({
      where: { userId, revokedAt: null },
      select: { familyId: true },
    });
    if (vive.length === 0) {
      return [];
    }

    const nate = await this.#prisma.refreshToken.groupBy({
      by: ["familyId"],
      where: { userId, familyId: { in: vive.map((riga) => riga.familyId) } },
      _min: { issuedAt: true },
    });

    return nate
      .map((gruppo) => ({
        familyId: gruppo.familyId,
        // Il minimo di un gruppo non vuoto esiste sempre, ma il tipo di Prisma
        // lo ammette nullable perche' `_min` su zero righe sarebbe null. Il
        // gruppo viene dal `groupBy` stesso, quindi almeno una riga c'e'.
        createdAt: gruppo._min.issuedAt ?? new Date(0),
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
   * Il WHERE ha tre parti, e ciascuna ha un difetto tutto suo se manca.
   *
   * Senza `userId`, la rotta revoca la famiglia di un altro: e' l'unica delle
   * tre che trasforma un guasto in un problema di sicurezza, ed e' anche la piu'
   * facile da togliere, perche' senza di lei tutti i test che chiudono una
   * propria sessione passano lo stesso.
   *
   * Senza `familyId`, ne revoca tutte — «chiudi questa» diventa «chiudi tutto»,
   * cioe' il gesto che sta due sezioni piu' su e che l'utente non ha premuto.
   *
   * Senza `revokedAt: null` non cambia cosa succede, cambia cosa si racconta:
   * le righe gia' morte verrebbero ricontate, il numero in risposta sarebbe piu'
   * alto del vero, e la data del logout di tre settimane fa verrebbe riscritta
   * con quella di stasera — l'unica traccia di quando una sessione e' stata
   * chiusa davvero.
   *
   * `updateMany` e non `delete`, come ovunque qui: le righe revocate sono cio'
   * che fa scattare la reuse detection quando il token tornera'.
   */
  async revokeFamilyOfUser(input: {
    userId: string;
    familyId: string;
    revokedAt: Date;
  }): Promise<number> {
    const revoked = await this.#prisma.refreshToken.updateMany({
      where: {
        userId: input.userId,
        familyId: input.familyId,
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

  async deleteAccount(userId: string): Promise<DeleteAccountOutcome> {
    return this.#prisma.$transaction(async (tx) => {
      const inLavorazione = await tx.recording.count({
        where: { userId, status: "IN_ELABORAZIONE" },
      });
      if (inLavorazione > 0) {
        return { kind: "IN_LAVORAZIONE", quanti: inLavorazione };
      }

      // `select` e non `findMany` intero: di un vocale serve la chiave S3 e
      // nient'altro, e un conto con molti vocali lunghi tirerebbe in memoria
      // trascrizioni intere per buttarle un'istruzione dopo.
      const vocali = await tx.recording.findMany({
        where: { userId },
        select: { audioUrl: true },
      });
      const schede = await tx.procedure.count({ where: { userId } });

      // Si contano le famiglie vive, cioe' i dispositivi collegati, e non le
      // righe: un conto che ha ruotato quarantadue volte ha quarantadue righe e
      // un dispositivo solo, e la ricevuta direbbe «hai scollegato quarantadue
      // dispositivi» a chi ne ha uno. Il filtro `revokedAt: null` e' la stessa
      // definizione di «viva» che usano `isFamilyActive` e `listOpenSessions`,
      // e deve restare la stessa: se qui divergesse, il numero nella ricevuta
      // non sarebbe quello dell'elenco che l'utente ha appena finito di
      // guardare.
      //
      // ## Il `distinct` da solo non serve, e resta lo stesso
      //
      // Onesta' su una ridondanza, perche' e' emersa da una mutazione
      // sopravvissuta: a fare il lavoro qui e' `revokedAt: null`, non
      // `distinct`. La rotazione revoca la riga di partenza nella stessa
      // transazione in cui crea quella nuova (`rotateRefreshToken`, sopra),
      // quindi di ogni famiglia viva esiste **una sola** riga non revocata e
      // togliere il `distinct` non cambierebbe nessun numero. Togliere il
      // `distinct` e' una mutazione equivalente, ed e' dichiarata invece che
      // coperta: un caso che la pinzasse dovrebbe prima costruire uno stato che
      // la rotazione non sa produrre.
      //
      // Resta perche' e' la clausola che dice **cosa si sta contando**. Il
      // giorno che qualcuno allargasse il filtro — o che una rotazione
      // concorrente lasciasse per un istante due righe vive della stessa
      // famiglia — questa riga e' la differenza fra un numero sbagliato e un
      // numero giusto, e costa nulla.
      const famiglie = await tx.refreshToken.findMany({
        where: { userId, revokedAt: null },
        select: { familyId: true },
        distinct: ["familyId"],
      });

      // Una `delete` sola: passi, prerequisiti, esecuzioni, tag e legami se ne
      // vanno per cascata, dichiarata sulle relazioni in `schema.prisma`.
      await tx.user.delete({ where: { id: userId } });

      return {
        kind: "CANCELLATO",
        audioKeys: vocali.map((v) => v.audioUrl),
        vocali: vocali.length,
        schede,
        sessioni: famiglie.length,
      };
    });
  }
}

export class RefreshTokenRotationConflict extends Error {
  constructor(tokenId: string) {
    super(`Rotazione concorrente sul refresh token ${tokenId}`);
    this.name = "RefreshTokenRotationConflict";
  }
}
