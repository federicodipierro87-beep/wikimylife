import type {
  AuthSession,
  ChangePasswordRequest,
  DeleteAccountRequest,
  DeleteAccountResponse,
  GoogleLoginRequest,
  LoginRequest,
  OpenSessionsResponse,
  PublicUser,
  RevokeOtherSessionsRequest,
  RevokeOtherSessionsResponse,
  RevokeSessionRequest,
  RevokeSessionResponse,
  SignupRequest,
  StorageProvider,
} from "@wikimylife/shared";
import type { AuthConfig } from "../config/env.js";
import { AppError } from "../errors/AppError.js";
import type { AuthRepository, UserRecord } from "./ports/AuthRepository.js";
import type { Clock } from "./ports/Clock.js";
import type { GoogleIdentity, GoogleIdTokenVerifier } from "./ports/GoogleIdTokenVerifier.js";
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
  /**
   * Il bucket, che serve a un solo gesto: `deleteAccount`.
   *
   * ## Perche' l'autenticazione ha imparato cos'e' un file
   *
   * Malvolentieri. Fino al commit che ha aggiunto la cancellazione del conto
   * questo servizio parlava di utenti e di token e non sapeva che esistesse uno
   * storage, il che e' la ragione per cui i suoi test girano in millisecondi
   * senza rete. L'alternativa era lasciare il bucket a qualcun altro: una
   * chiamata dalla rotta dopo il servizio, o un servizio terzo che coordina.
   * Entrambe spostano di un piano la stessa dipendenza e in piu' mettono una
   * riga di codice fra il `COMMIT` e la cancellazione dei byte — se il processo
   * muore li', le chiavi le aveva in mano solo chi non le ha piu'.
   *
   * Qui resta almeno vero che chi cancella il conto e' anche chi ne raccoglie
   * i resti. E' la stessa scelta gia' fatta in `procedures.service`, per lo
   * stesso motivo.
   */
  readonly storage: StorageProvider;
  /**
   * Un oggetto rimasto nel bucket dopo che l'utente e' sparito.
   *
   * Stesso patto di `procedures.service`, e qui piu' stretto: dopo il `COMMIT`
   * non esiste piu' nessuna riga che nomini quelle chiavi, in nessun database.
   * Questo e' letteralmente l'ultimo istante in cui un nome puo' essere scritto
   * da qualche parte, e se nessuno lo raccoglie l'oggetto resta nel bucket per
   * sempre, senza che niente lo colleghi piu' a niente.
   */
  readonly onOrphanedAudio?: ((info: { key: string; error: unknown }) => void) | undefined;
  /**
   * Chi verifica i token di Google. Assente vuol dire accesso con Google
   * spento: la rotta risponde `GOOGLE_DISABLED`, e un token Google usato come
   * prova d'identita' non vale niente.
   */
  readonly google?: GoogleIdTokenVerifier | undefined;
}

/**
 * Quanto puo' essere vecchio un token di Google per valere come prova
 * d'identita' al posto della password.
 *
 * ## Perche' serve un limite, se il token ha gia' una scadenza
 *
 * Perche' la scadenza di Google e' un'ora, e un'ora e' la vita di una sessione
 * del pulsante, non di una conferma. La password si digita *adesso*; un token
 * rimasto in memoria da cinquanta minuti dice solo che cinquanta minuti fa
 * qualcuno era entrato in Google da quel browser. Qui si vuole la stessa cosa
 * che vuole la password: che la persona si sia appena fatta riconoscere.
 *
 * ## Perche' cinque minuti
 *
 * Il pulsante consegna un token firmato in quel momento, quindi il tempo vero
 * fra la firma e l'arrivo qui e' di secondi. Il margine copre due cose: un
 * orologio del server un po' indietro rispetto a quello di Google, e chi preme
 * il pulsante e poi resta un momento sulla conferma prima di inviare. Sotto il
 * minuto si rischia di rifiutare conferme legittime per uno sfasamento di
 * orologi; sopra i dieci, la prova smette di essere piu' fresca di una
 * sessione aperta — che e' proprio cio' che non basta.
 */
export const REAUTH_GOOGLE_MAX_MS = 5 * 60 * 1000;

export interface AuthService {
  signup(input: SignupRequest): Promise<AuthSession>;
  login(input: LoginRequest): Promise<AuthSession>;
  loginWithGoogle(input: GoogleLoginRequest): Promise<AuthSession>;
  refresh(rawRefreshToken: string): Promise<AuthSession>;
  logout(rawRefreshToken: string): Promise<void>;
  changePassword(userId: string, input: ChangePasswordRequest): Promise<AuthSession>;
  revokeOtherSessions(
    userId: string,
    familyId: string,
    input: RevokeOtherSessionsRequest,
  ): Promise<RevokeOtherSessionsResponse>;
  revokeSession(
    userId: string,
    familyId: string,
    input: RevokeSessionRequest,
  ): Promise<RevokeSessionResponse>;
  listSessions(userId: string, familyId: string): Promise<OpenSessionsResponse>;
  deleteAccount(userId: string, input: DeleteAccountRequest): Promise<DeleteAccountResponse>;
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
    hasPassword: user.passwordHash !== null,
    hasGoogle: user.googleSub !== null,
  };
}

/** Le due prove d'identita' che i gesti protetti accettano: una sola per volta. */
type Prova = { readonly currentPassword: string } | { readonly googleIdToken: string };

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { repo, hasher, tokens, clock, config } = deps;

  /**
   * Toglie i byte dal bucket, uno per volta, senza mai far cadere il gesto.
   *
   * Copia deliberata di `togliDalBucket` in `procedures.service`, e non un
   * modulo condiviso: le due funzioni si assomigliano adesso perche' fanno la
   * stessa cosa, ma il patto che le tiene e' diverso. La' l'utente ha avuto un
   * 204 e la scheda e' sparita; qui l'utente ha avuto tre numeri e *non esiste
   * piu'* — non c'e' nessuno a cui un errore potrebbe essere riportato. Unirle
   * legherebbe l'autenticazione alle procedure per risparmiare otto righe.
   */
  async function togliDalBucket(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await deps.storage.delete(key);
      } catch (error: unknown) {
        deps.onOrphanedAudio?.({ key, error });
      }
    }
  }

  /**
   * Chiede a Google chi e' il titolare del token.
   *
   * Un guasto della verifica — le chiavi di Google che non si scaricano —
   * diventa un 503 e non un 401: l'utente non ha sbagliato niente, e un 401 gli
   * direbbe che il suo account Google non va.
   */
  async function identitaGoogle(idToken: string): Promise<GoogleIdentity> {
    if (deps.google === undefined) {
      throw AppError.googleDisabled();
    }
    let identita: GoogleIdentity | null;
    try {
      identita = await deps.google.verify(idToken);
    } catch {
      throw AppError.serviceUnavailable("Google non risponde, riprova fra poco");
    }
    if (identita === null) {
      throw AppError.googleTokenInvalid();
    }
    return identita;
  }

  /**
   * La prova che di la' dallo schermo c'e' il proprietario: la password, o un
   * token di Google appena emesso per l'account collegato a questo conto.
   *
   * ## Un conto senza password
   *
   * Chi si e' iscritto con Google e prova con una password riceve lo stesso
   * rifiuto di una password sbagliata, dopo la stessa verifica fittizia del
   * login: il tempo di risposta non deve dire quali conti sono solo Google.
   *
   * ## Un token di un altro account Google
   *
   * Valido, firmato, fresco — e di qualcun altro. E' `INVALID_CREDENTIALS` e non
   * `GOOGLE_TOKEN_INVALID`: Google ha confermato benissimo *chi*, e' il chi a
   * non essere il titolare. Lo stesso rifiuto vale per un conto a cui Google
   * non e' mai stato collegato.
   */
  async function verificaProva(user: UserRecord, prova: Prova): Promise<void> {
    if ("currentPassword" in prova) {
      if (user.passwordHash === null) {
        await hasher.verify(hasher.dummyHash, prova.currentPassword);
        throw AppError.invalidCredentials();
      }
      const ok = await hasher.verify(user.passwordHash, prova.currentPassword);
      if (!ok) {
        throw AppError.invalidCredentials();
      }
      return;
    }

    const identita = await identitaGoogle(prova.googleIdToken);
    if (user.googleSub === null || identita.sub !== user.googleSub) {
      throw AppError.invalidCredentials();
    }
    if (clock.now().getTime() - identita.issuedAt.getTime() > REAUTH_GOOGLE_MAX_MS) {
      throw AppError.googleTokenInvalid();
    }
  }

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

      if (user.passwordHash === null) {
        // Un conto nato con Google: la password non c'e', e va detto con lo
        // stesso messaggio e lo stesso tempo di una password sbagliata. Un
        // messaggio diverso («entra con Google») sarebbe gentile, e direbbe a
        // chiunque provi un indirizzo che quel conto esiste.
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
     * Entra con Google, collegando o creando il conto se serve.
     *
     *   1. il `sub` e' gia' di un conto                  => si entra in quello
     *   2. Google non garantisce l'indirizzo              => GOOGLE_EMAIL_UNVERIFIED
     *   3. l'indirizzo e' di un conto senza Google        => si collega, e si entra
     *   4. l'indirizzo e' di un conto con un altro Google => CONFLICT
     *   5. nessun conto, iscrizioni chiuse                => SIGNUP_DISABLED
     *   6. nessun conto, iscrizioni aperte                => si crea, senza password
     *
     * ## Perche' il `sub` prima dell'indirizzo
     *
     * Perche' e' l'identita' vera: l'indirizzo di un account Google puo'
     * cambiare, e chi l'ha cambiato deve continuare a entrare nel suo conto.
     * L'indirizzo serve solo la prima volta, per trovare un conto che esisteva
     * gia' con la password.
     *
     * ## Perche' il collegamento chiede l'indirizzo verificato
     *
     * Perche' collegare vuol dire consegnare un conto a chi presenta il token.
     * Se Google non garantisce che l'indirizzo sia di chi ha l'account, chiunque
     * potrebbe creare un account Google con l'indirizzo di un altro e prendersi
     * il suo conto qui. Per la stessa ragione un indirizzo non verificato non
     * crea un conto nuovo: occuperebbe l'indirizzo di qualcuno che poi non
     * potrebbe piu' iscriversi.
     *
     * ## Perche' un conto gia' collegato a un altro Google e' un 409
     *
     * Perche' un conto ha un solo account Google, e il `sub` non si sostituisce
     * da qui: se si potesse, il nuovo titolare dell'indirizzo — chi l'ha
     * ereditato da un'azienda, per dire — prenderebbe il conto del vecchio.
     *
     * ## Perche' le iscrizioni chiuse chiudono anche Google
     *
     * Un interruttore solo per tutte le porte, per scelta del prodotto: ogni
     * conto nuovo costa trascrizione ed estrazione, e un Google sempre aperto
     * renderebbe `SIGNUP_ENABLED=false` una promessa con un buco.
     */
    async loginWithGoogle(input: GoogleLoginRequest): Promise<AuthSession> {
      const identita = await identitaGoogle(input.idToken);

      const collegato = await repo.findUserByGoogleSub(identita.sub);
      if (collegato !== null) {
        return issueSession(collegato, tokens.newFamilyId());
      }

      if (!identita.emailVerified) {
        throw AppError.googleEmailUnverified();
      }

      const esistente = await repo.findUserByEmail(identita.email);
      if (esistente !== null) {
        // Questa riga e la condizione dentro `linkGoogle` sono la stessa regola
        // scritta due volte, e si coprono a vicenda: tolta una, l'altra da'
        // ancora 409 (le mutazioni lo hanno mostrato, e cadono solo insieme).
        // La garanzia vera e' la scrittura condizionata, l'unica che regge a
        // due richieste in parallelo; questa risparmia una scrittura e un giro
        // nel ramo della corsa nel caso comune.
        if (esistente.googleSub !== null) {
          throw AppError.conflict("Questo indirizzo e' gia' collegato a un altro account Google");
        }
        const aggiornato = await repo.linkGoogle({
          userId: esistente.id,
          googleSub: identita.sub,
        });
        if (aggiornato === null) {
          // Un altro collegamento e' arrivato fra la lettura e la scrittura. Se
          // era questo stesso `sub` il conto e' gia' nostro; se era un altro,
          // vale la regola di sopra.
          const riletto = await repo.findUserByGoogleSub(identita.sub);
          if (riletto === null) {
            throw AppError.conflict("Questo indirizzo e' gia' collegato a un altro account Google");
          }
          return issueSession(riletto, tokens.newFamilyId());
        }
        return issueSession(aggiornato, tokens.newFamilyId());
      }

      if (!config.signupEnabled) {
        throw AppError.signupDisabled();
      }

      const creato = await repo.createUser({
        email: identita.email,
        googleSub: identita.sub,
        locale: input.locale ?? "it-IT",
      });
      return issueSession(creato, tokens.newFamilyId());
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

      // Lo stesso errore di `login`, e per la stessa ragione: qui non c'e'
      // niente da enumerare, ma avere due codici diversi per «password
      // sbagliata» significherebbe che prima o poi uno dei due percorsi cambia
      // e l'altro no. Con Google la prova e' il token: e' cosi' che chi si e'
      // iscritto con Google si da' una password la prima volta.
      await verificaProva(user, input);

      if ("currentPassword" in input && input.newPassword === input.currentPassword) {
        throw AppError.conflict("La nuova password e' identica a quella attuale");
      }

      const now = clock.now();
      const passwordHash = await hasher.hash(input.newPassword);
      await repo.changePassword({ userId: user.id, passwordHash, revokedAt: now });

      // Il conto con l'hash nuovo e non quello letto prima: finche' ogni conto
      // aveva una password la differenza non si vedeva, ma chi se ne da' una per
      // la prima volta riceverebbe `hasPassword: false` nella stessa risposta
      // che gliel'ha appena data, e la schermata continuerebbe a chiedergli
      // Google.
      return issueSession({ ...user, passwordHash }, tokens.newFamilyId());
    },

    /**
     * Chiude tutte le sessioni tranne questa, e non tocca la password.
     *
     * ## A cosa serve, visto che il cambio password fa gia' questo
     *
     * Il cambio password lo fa per un'altra ragione: la vecchia credenziale non
     * vale piu', quindi tutto cio' che ci stava sopra deve cadere. Qui la
     * ragione e' che un dispositivo non e' piu' in mano al proprietario, e la
     * password non c'entra niente. Sono due guasti diversi e finora avevano una
     * riparazione sola — quella piu' cara, perche' cambiare password significa
     * riscriverla ovunque sia salvata, e il gesto che costa e' il gesto che non
     * si fa.
     *
     * ## Perche' chiede la password lo stesso
     *
     * `requireAuth` dice che chi chiama ha una sessione viva. In questo caso
     * proprio non basta: il gesto risparmia la sessione da cui parte, quindi
     * senza verifica sarebbe uno strumento perfetto per chi ha in mano il
     * telefono rubato — un tocco e resta lui solo, dentro, con il proprietario
     * scollegato da tutto il resto. La password sposta la disponibilita' del
     * gesto da chi tiene il dispositivo a chi conosce il segreto, ed e'
     * l'inversione esatta che serve.
     *
     * ## Perche' non rifiuta quando non c'e' niente da revocare
     *
     * Zero non e' un errore, e' un'informazione: «non c'era nessun altro
     * collegato». Chi lo chiede sospetta qualcosa e ha diritto di sapere che il
     * sospetto era infondato. Un 409 al suo posto direbbe che il gesto e'
     * fallito, e chi lo legge continuerebbe a cercare un dispositivo che non
     * c'e'.
     */
    async revokeOtherSessions(
      userId: string,
      familyId: string,
      input: RevokeOtherSessionsRequest,
    ): Promise<RevokeOtherSessionsResponse> {
      const user = await repo.findUserById(userId);
      if (user === null) {
        throw AppError.unauthorized();
      }

      // Prima la verifica, poi la revoca: nell'ordine opposto una password
      // sbagliata avrebbe comunque scollegato tutto, e l'errore in risposta
      // racconterebbe il contrario di quello che e' successo.
      await verificaProva(user, input);

      const revoked = await repo.revokeOtherFamilies({
        userId: user.id,
        exceptFamilyId: familyId,
        revokedAt: clock.now(),
      });

      return { revoked };
    },

    /**
     * Chiude una sessione sola, quella scelta nell'elenco.
     *
     * ## Perche' chiede la password anche per una sola
     *
     * Perche' il gesto di sopra la chiede, e questo lo si puo' ripetere. Senza
     * verifica, chi ha in mano il telefono rubato aprirebbe l'elenco e
     * chiuderebbe le altre una per una, ottenendo in tre tocchi esattamente
     * cio' che la password su «scollega gli altri» esiste per impedirgli in uno.
     * Una difesa che si aggira contando fino a tre non e' una difesa.
     *
     * ## Perche' la verifica viene prima del 409
     *
     * Nell'ordine opposto il codice di stato diventerebbe un oracolo: 409 su
     * una famiglia vorrebbe dire «questa e' la tua», 401 vorrebbe dire «non lo
     * e'», e chi ha rubato un access token — ma non sa la password — imparerebbe
     * quale riga dell'elenco e' la propria provandole tutte. Messa prima, la
     * verifica fa rispondere 401 a ogni id finche' la password non e' quella
     * giusta, e a quel punto non c'e' piu' niente da imparare.
     *
     * ## Perche' la propria famiglia e' un 409 e non un 200 silenzioso
     *
     * Perche' la schermata non mette nessun pulsante sulla riga `current`:
     * chiudere la propria sessione e' il logout, che sta dieci righe piu' su.
     * Una richiesta che chiede la propria famiglia e' quindi una richiesta che
     * nessuna schermata produce, e se arriva vuol dire che qualcosa non ha
     * capito quale riga stava premendo. Lasciarla passare sarebbe peggio che
     * rifiutarla: revocherebbe il refresh token di chi sta chiamando mentre la
     * risposta dice `revoked: 1`, e il client scoprirebbe di essere fuori alla
     * richiesta dopo, con una rotazione che fallisce su un token ucciso da se'.
     *
     * ## Perche' zero non e' un errore
     *
     * Una sessione gia' chiusa risponde `{ revoked: 0 }`: due schede aperte
     * sullo stesso account, lo stesso pulsante premuto due volte, e la seconda
     * volta il risultato voluto c'e' gia'. Zero e' anche cio' che torna per la
     * famiglia di un altro utente, e i due casi si confondono di proposito —
     * un 404 sul primo e uno zero sul secondo direbbero a chi tira a indovinare
     * quali id esistono.
     */
    async revokeSession(
      userId: string,
      familyId: string,
      input: RevokeSessionRequest,
    ): Promise<RevokeSessionResponse> {
      const user = await repo.findUserById(userId);
      if (user === null) {
        throw AppError.unauthorized();
      }

      await verificaProva(user, input);

      if (input.sessionId === familyId) {
        throw AppError.conflict(
          "Questa e' la sessione da cui stai chiedendo: per chiuderla, esci da questo dispositivo",
        );
      }

      // `revokeFamilyOfUser` e non `revokeFamily`: lo `userId` che arriva da
      // `requireAuth` e il `sessionId` che arriva dal corpo devono stare nella
      // stessa clausola, perche' e' la clausola a decidere che quella famiglia
      // sia di chi la sta chiudendo. Un controllo scritto qui sopra — leggere e
      // confrontare — lascerebbe fra la lettura e la scrittura una finestra, e
      // soprattutto sarebbe una seconda copia della stessa regola.
      const revoked = await repo.revokeFamilyOfUser({
        userId: user.id,
        familyId: input.sessionId,
        revokedAt: clock.now(),
      });

      return { revoked };
    },

    /**
     * L'elenco dei dispositivi collegati, che da' un senso al numero di sopra.
     *
     * ## Perche' esiste
     *
     * «Ne ho scollegate due» significa qualcosa solo a chi sapeva che ce
     * n'erano tre. Senza elenco, chi preme «scollega gli altri dispositivi»
     * preme al buio e legge un numero che non puo' confrontare con niente: non
     * sa se il telefono perso era fra quelli, non sa se ne era rimasto uno che
     * non ricordava di aver aperto.
     *
     * ## Perche' non chiede la password
     *
     * Perche' non fa niente. `revokeOtherSessions` la chiede perche' risparmia
     * la sessione di chi chiama, e senza verifica sarebbe l'arma perfetta per
     * chi tiene in mano il telefono rubato. Qui non c'e' niente da impugnare: e'
     * una lettura, e cio' che mostra — quante sessioni, e da quando — lo sa gia'
     * chiunque abbia una sessione viva, perche' e' il proprio account.
     *
     * ## Perche' adesso il familyId esce
     *
     * Per un commit intero non usciva: la porta lo restituiva, questo metodo lo
     * consumava per marcare `current` e lo buttava, perche' spedire un
     * identificativo di sessione a ogni apertura della schermata senza un gesto
     * che lo usi vuol dire lasciarlo nei log per niente. Il commento di allora
     * diceva «il giorno in cui "chiudi questa sessione" esistera', il campo si
     * aggiunge allora e non prima»: quel giorno e' arrivato, ed e' `revokeSession`
     * — atterrata nello stesso commit di questo campo.
     *
     * Esce come `id` e non come `familyId` perche' dall'esterno e' l'id di una
     * riga dell'elenco: che dentro sia la catena di rotazioni di un dispositivo
     * e' un fatto del database, e il client non deve poterlo dedurre dal nome.
     *
     * ## Perche' non si controlla che l'elenco non sia vuoto
     *
     * Non puo' esserlo: si arriva qui attraverso `requireAuth`, che ha appena
     * verificato che la famiglia di chi chiama e' viva. Una lista vuota
     * significherebbe che quella verifica e questa lettura non sono d'accordo, e
     * il posto dove accorgersene e' un test, non un ramo di codice che si
     * inventa un messaggio per una situazione impossibile.
     */
    async listSessions(userId: string, familyId: string): Promise<OpenSessionsResponse> {
      const aperte = await repo.listOpenSessions(userId);
      return {
        sessions: aperte.map((sessione) => ({
          id: sessione.familyId,
          createdAt: sessione.createdAt.toISOString(),
          current: sessione.familyId === familyId,
        })),
      };
    },

    /**
     * Cancella il conto, e con lui tutto. Non c'e' un annullamento.
     *
     * ## Perche' esiste
     *
     * La linea guida 5.1.1(v) di Apple vuole che un conto creato dentro l'app
     * si possa cancellare dentro l'app, e senza questa rotta il rifiuto e'
     * certo. Ma la ragione per cui merita di esistere anche senza Apple e'
     * un'altra, e questo servizio e' il posto giusto per dirla: qui dentro
     * finisce la voce di chi parla, e una voce che non si puo' riprendere
     * indietro e' una cosa che non si affida.
     *
     * ## Perche' chiede la password
     *
     * Per la ragione di `revokeOtherSessions` portata al limite. La' chi ha in
     * mano un telefono altrui puo' buttare fuori il proprietario; qui puo'
     * cancellarlo. E' il gesto meno reversibile che esista in questa
     * applicazione, quindi e' il posto dove il campo che sembra un fastidio
     * serve di piu'. La verifica sta prima di tutto, per il motivo scritto
     * sopra a `revokeOtherSessions`: nell'ordine opposto una password sbagliata
     * avrebbe comunque cancellato l'account, e l'errore in risposta
     * racconterebbe il contrario di quello che e' successo.
     *
     * ## Perche' non revoca le sessioni prima di cancellare
     *
     * Perche' le righe se ne vanno per cascata e la revoca sarebbe una scrittura
     * su qualcosa che sta per sparire. `requireAuth` chiede `isFamilyActive`, e
     * una famiglia le cui righe non esistono piu' non e' attiva: gli access
     * token ancora firmati e non scaduti smettono di aprire qualcosa
     * esattamente come se fossero stati revocati. Il numero `sessioni` nella
     * risposta e' quindi un conteggio di cio' che e' caduto, non di cio' che e'
     * stato marcato.
     *
     * ## Il 409, e il suo prezzo
     *
     * Un vocale in lavorazione ferma tutto. E' la decisione scomoda di questo
     * metodo: la 5.1.1(v) vuole un gesto che *funziona*, e qui esiste un
     * istante in cui risponde «riprova». L'alternativa era cancellare sotto un
     * worker che sta scrivendo, cioe' farlo schiantare su una chiave sparita
     * per un caso che passa da solo. Il messaggio dice quanti sono e che si
     * risolve da se'; il residuo — un vocale incastrato in `IN_ELABORAZIONE`
     * che non esce mai da li' e blocca la cancellazione per sempre — e' nei
     * difetti noti, e la sua riparazione e' la scopa, non questa rotta.
     *
     * ## Perche' l'audio si toglie dopo, e non dentro
     *
     * Perche' il bucket non partecipa alla transazione: un `delete` sullo
     * storage fatto prima del `COMMIT` non si annulla se il `COMMIT` fallisce,
     * e l'utente resterebbe con il conto intero e i vocali muti. Nell'ordine
     * giusto il modo di sbagliare e' l'altro — righe sparite, byte rimasti — che
     * costa spazio e non dati.
     */
    async deleteAccount(
      userId: string,
      input: DeleteAccountRequest,
    ): Promise<DeleteAccountResponse> {
      const user = await repo.findUserById(userId);
      if (user === null) {
        throw AppError.unauthorized();
      }

      await verificaProva(user, input);

      const esito = await repo.deleteAccount(user.id);

      if (esito.kind === "IN_LAVORAZIONE") {
        // Il numero sta nel messaggio perche' cambia cosa si sta aspettando:
        // «uno» e' un istante, «dodici» e' il momento di andare a prendere un
        // caffe'. Un messaggio fisso lascerebbe premere di nuovo subito, e
        // trovare lo stesso muro.
        throw AppError.conflict(
          `Ci sono ${String(esito.quanti)} vocali ancora in lavorazione: ` +
            "finiscono da soli, riprova fra poco",
        );
      }

      await togliDalBucket(esito.audioKeys);

      return {
        vocali: esito.vocali,
        schede: esito.schede,
        sessioni: esito.sessioni,
      };
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
