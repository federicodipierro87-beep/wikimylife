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
 * Una famiglia ancora viva, ridotta a cio' che serve per mostrarla.
 *
 * Il `familyId` c'e' qui e non nella risposta HTTP: serve al servizio per
 * riconoscere quale riga e' la sessione da cui arriva la richiesta, e la sua
 * utilita' finisce li'. Farlo uscire dalla porta e' gratis, farlo uscire dal
 * server vorrebbe dire spedire un identificativo di sessione a ogni apertura
 * della schermata dell'account, senza nessun gesto che lo consumi.
 *
 * `createdAt` e' il minimo degli `issuedAt` della famiglia, cioe' il login. Non
 * e' l'`issuedAt` della riga viva: quello si sposta a ogni rotazione, ed e'
 * «ultimo accesso» sotto un altro nome.
 */
export interface OpenSessionRecord {
  readonly familyId: string;
  readonly createdAt: Date;
}

/**
 * Com'e' andata la cancellazione di un conto: un'unione, non un booleano.
 *
 * ## Perche' un'unione e non un'eccezione
 *
 * Perche' `IN_LAVORAZIONE` non e' un guasto: e' la risposta giusta a una
 * domanda fatta nel momento sbagliato, e porta con se' un numero che chi
 * chiama deve poter scrivere all'utente. Una porta che lancia costringerebbe il
 * servizio a leggere il messaggio di un'eccezione per sapere quanti erano — che
 * e' la forma piu' fragile di passaggio di dati che esista. E' lo stesso
 * disegno di `deleteForUser` in `ProcedureRepository`.
 *
 * ## Perche' `audioKeys` esce da qui
 *
 * Perche' e' l'unica cosa che la cascata del database non porta via, e perche'
 * dopo il `DELETE` non c'e' piu' nessun posto dove andarsela a prendere. La
 * raccolta e la cancellazione devono stare nella stessa transazione, o esiste
 * una finestra in cui un vocale nuovo entra fra le due e i suoi byte restano
 * nel bucket per sempre senza nessuna riga che li nomini.
 */
export type DeleteAccountOutcome =
  | {
      /** C'e' del lavoro in corso su questo conto: non si cancella niente. */
      readonly kind: "IN_LAVORAZIONE";
      readonly quanti: number;
    }
  | {
      readonly kind: "CANCELLATO";
      /** Le chiavi S3 dei vocali. Il bucket lo svuota chi chiama, dopo. */
      readonly audioKeys: readonly string[];
      readonly vocali: number;
      readonly schede: number;
      /** Famiglie di refresh token vive, cioe' dispositivi scollegati. */
      readonly sessioni: number;
    };

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
   * Le famiglie dell'utente che hanno ancora un token vivo, dalla piu' recente.
   *
   * ## «Viva» qui vuol dire la stessa cosa che in `isFamilyActive`
   *
   * Almeno una riga con `revokedAt: null`, e nessun controllo sulla scadenza.
   * Deve essere la stessa definizione, altrimenti l'elenco mostra sessioni che
   * `requireAuth` rifiuterebbe, o ne nasconde di funzionanti — e in entrambi i
   * casi il numero che torna da `revokeOtherFamilies` non corrisponde a quello
   * che l'utente ha appena finito di leggere. Un token scaduto e non revocato
   * resta elencato perche' e' esattamente cio' che e': una sessione che la
   * scopa non ha ancora raccolto e che un refresh farebbe ancora ripartire.
   *
   * Non e' `listSessions`: la porta non sa cosa sia una «sessione» per chi
   * guarda, sa cos'e' una famiglia con un token vivo. La traduzione la fa il
   * servizio, che e' anche l'unico a sapere da quale famiglia arriva la
   * richiesta.
   */
  listOpenSessions(userId: string): Promise<readonly OpenSessionRecord[]>;

  /**
   * Revoca ogni sessione dell'utente tranne una: quella da cui la richiesta
   * arriva. Restituisce quante ne sono cadute.
   *
   * ## Perche' e' un metodo e non `changePassword` senza la password
   *
   * Perche' la clausola e' diversa in un punto che cambia tutto. `changePassword`
   * revoca tutto, compreso chi chiama, e poi gli apre una famiglia nuova: deve
   * farlo, perche' la credenziale con cui quella sessione era nata non esiste
   * piu'. Qui la password resta quella di prima, quindi non c'e' niente da
   * rifare: la sessione di chi chiede non e' sospetta e non ha bisogno di
   * essere sostituita, basta non toccarla.
   *
   * La differenza si vede in cosa succede se la risposta si perde per strada.
   * Con revoca-e-riemissione, i token nuovi erano in quella risposta e adesso
   * non li ha nessuno: chi ha premuto il pulsante e' fuori dal proprio account
   * senza aver fatto niente di male. Con l'esclusione non c'e' nessuna
   * credenziale che viaggi una volta sola, e riprovare e' gratis.
   *
   * ## Perche' per famiglia e non per token
   *
   * Perche' un dispositivo e' una famiglia: la catena di rotazioni di quel
   * telefono, non il singolo anello che ha in mano adesso. Escludere il token
   * corrente e non la sua famiglia lascerebbe revocati i suoi antenati — che
   * sono gia' revocati — e vivo il presente: identico, finche' non arriva una
   * rotazione a meta' strada.
   */
  revokeOtherFamilies(input: {
    readonly userId: string;
    readonly exceptFamilyId: string;
    readonly revokedAt: Date;
  }): Promise<number>;

  /**
   * Revoca una famiglia sola, ma solo se e' di quell'utente.
   *
   * ## Perche' non e' `revokeFamily` con un parametro in piu'
   *
   * Perche' `revokeFamily(familyId, revokedAt)` — due righe piu' su — non ha
   * lo `userId`, e non lo ha per un motivo: i suoi due chiamanti partono da una
   * riga gia' letta dal database e gia' attribuita a qualcuno. La reuse
   * detection ha in mano il token riusato, il logout ha in mano il token che gli
   * e' stato consegnato: in entrambi i casi la famiglia non e' un dato che
   * arriva da fuori, e' una conseguenza di cio' che si e' appena letto.
   *
   * Qui il `familyId` arriva dal corpo di una richiesta HTTP, cioe' da
   * chiunque. Raggiungere `revokeFamily` con quel valore vorrebbe dire «revoca
   * la sessione di chiunque, se ne indovini l'id»: un `familyId` e' un UUID e
   * non si indovina a caso, ma e' anche un identificativo che passa per i log,
   * per le risposte e per la memoria di un browser, e una rotta che lo accetta
   * senza controllare a chi appartiene e' una rotta che trasforma un id
   * trapelato in una disconnessione altrui.
   *
   * Chi legge questo file trovera' due metodi quasi uguali e sara' tentato di
   * cancellarne uno. Non si possono unire: uno e' sicuro *perche'* non ha lo
   * `userId`, l'altro e' sicuro *perche'* ce l'ha.
   *
   * Restituisce quante righe ha revocato: zero se la famiglia era gia' chiusa,
   * zero se non e' di quell'utente, e zero se non esiste. I tre casi si
   * confondono di proposito — distinguerli direbbe a chi tira a indovinare se
   * l'id esiste.
   */
  revokeFamilyOfUser(input: {
    readonly userId: string;
    readonly familyId: string;
    readonly revokedAt: Date;
  }): Promise<number>;

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

  /**
   * Cancella l'utente e tutto cio' che pende da lui. Non si torna indietro.
   *
   * ## Perche' non prende una data
   *
   * Ogni altro metodo distruttivo di questa porta prende un `revokedAt`, perche'
   * marca righe che restano. Qui non resta niente da datare: non c'e' nessun
   * campo su cui scrivere quando e' successo, perche' non c'e' nessuna riga su
   * cui scriverlo. E' l'unico metodo di questo file che non ha bisogno
   * dell'orologio, e vale la pena dirlo invece di lasciar credere a una
   * dimenticanza.
   *
   * ## Perche' conta prima di cancellare, e dentro la stessa transazione
   *
   * I tre numeri sono l'unica ricevuta che questo gesto potra' mai avere: dopo
   * non c'e' piu' niente da contare. Contarli fuori dalla transazione vorrebbe
   * dire riportare un numero che nel frattempo e' cambiato — un vocale entrato
   * mezzo secondo dopo il conteggio viene cancellato ma non compare nella
   * ricevuta, e i suoi byte restano nel bucket perche' la sua chiave non era
   * nell'elenco.
   *
   * ## Il rifiuto, e il suo prezzo
   *
   * Un vocale in `IN_ELABORAZIONE` ferma tutto e non cancella niente. Un worker
   * ci sta lavorando adesso: cancellargli la riga sotto vuol dire farlo
   * schiantare su una chiave che non c'e' piu', e per un caso che si risolve da
   * solo aspettando. Il prezzo e' dichiarato ed e' scomodo: la 5.1.1(v) di
   * Apple vuole un gesto che *funziona*, e qui esiste un istante in cui non
   * funziona. La mitigazione e' che il messaggio dica quanti sono e che passa
   * da se'; il residuo — un utente che riprova e trova lo stesso muro perche'
   * un vocale e' rimasto incastrato — e' nei difetti noti.
   *
   * Resta una finestra che nessuna transazione chiude: fra il `SELECT` che
   * conta e il `COMMIT`, un worker puo' prendersi un vocale in `BOZZA_AUDIO` e
   * ritrovarselo cancellato sotto. Il caso e' innocuo — il worker fallisce quel
   * lavoro e non ne ha altri su quel conto — ed e' l'unica cosa che l'alternativa
   * (bloccare anche le bozze) impedirebbe, al prezzo di rendere impossibile
   * cancellare un conto che ha un solo vocale mai elaborato.
   */
  deleteAccount(userId: string): Promise<DeleteAccountOutcome>;
}
