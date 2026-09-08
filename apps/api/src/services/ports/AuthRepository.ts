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

/**
 * La sola domanda che il middleware di autenticazione pone al database.
 *
 * E' una porta a se' e non `AuthRepository` intero perche' `requireAuth` non
 * deve poter creare utenti, ruotare token o revocare famiglie: gli serve
 * leggere un bit, e questa interfaccia dice che quello e' tutto cio' che puo'
 * fare. In composizione riceve comunque il repository vero — che la soddisfa
 * strutturalmente — ma la firma del middleware resta onesta su quanto potere ha
 * chiesto.
 */
export interface FamilyRegistry {
  /**
   * Vero se la famiglia ha ancora almeno un refresh token non revocato.
   *
   * Falso significa: quella sessione e' stata chiusa: da un logout, da una
   * reuse detection, o dalla sparizione dell'utente. In tutti e tre i casi
   * l'access token che porta quella famiglia non deve piu' aprire niente.
   */
  isFamilyActive(familyId: string): Promise<boolean>;
}

export interface AuthRepository extends FamilyRegistry {
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

  /**
   * Sostituisce la password e chiude ogni sessione dell'utente, insieme.
   *
   * ## Perche' e' un metodo solo
   *
   * Le due scritture sembrano indipendenti e non lo sono: la seconda e' cio'
   * che rende vera la promessa della prima. Se fossero due chiamate, esiste una
   * riga di codice fra l'una e l'altra in cui il processo puo' morire, e i due
   * modi di morire non si equivalgono.
   *
   * Password cambiata, revoca mancata: chi era dentro ci resta, e la persona
   * che ha appena cambiato password crede di averlo cacciato. E' il caso
   * peggiore, perche' il danno e' silenzioso — non c'e' niente che glielo dica.
   *
   * Revoca fatta, password non cambiata: tutti fuori, la vecchia password
   * ancora buona. E' fastidioso e visibile: si rientra, ci si accorge che non
   * ha funzionato, si riprova.
   *
   * Una transazione toglie di mezzo la scelta fra i due. Se non ci fosse modo
   * di averla, l'ordine giusto sarebbe comunque revoca-poi-password, cioe'
   * quello che sbaglia dalla parte rumorosa.
   *
   * ## Perche' per utente e non per famiglia
   *
   * `revokeFamily` chiude una catena: e' il gesto giusto per «esci da questo
   * telefono». Qui il gesto e' un altro — «non so piu' chi abbia questa
   * password» — e una revoca che risparmiasse le altre sessioni lascerebbe in
   * piedi esattamente quelle di cui si sospetta.
   *
   * Restituisce quante sessioni sono cadute: serve a chi chiama per dire
   * all'utente quanti dispositivi ha appena scollegato, e ai test per
   * distinguere «ha revocato tutto» da «non ha revocato niente e nessuno se ne
   * accorge».
   */
  changePassword(input: {
    readonly userId: string;
    readonly passwordHash: string;
    readonly revokedAt: Date;
  }): Promise<number>;
}
