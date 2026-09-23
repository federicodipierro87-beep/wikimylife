import { z } from "zod";

/**
 * Contratto HTTP dell'autenticazione. Stessi schemi su entrambi i lati: le
 * rotte di `apps/api` li usano per validare l'ingresso, il client tipizzato per
 * validare cio' che torna. Una divergenza rompe la compilazione, non un test in
 * produzione.
 */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email();

/**
 * Il minimo, esportato perche' serve anche a chi non valida.
 *
 * L'API risponde a una password troppo corta con VALIDATION_FAILED e il
 * messaggio "La richiesta non e' valida", che e' giusto per un client e
 * inservibile per una persona: non dice cosa correggere. Una schermata che
 * voglia dirlo prima di inviare deve conoscere il numero, e l'unico modo di non
 * farne due copie destinate a divergere e' che il numero sia questo.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * 12 caratteri minimi, nessun requisito di composizione. Le regole "almeno una
 * maiuscola e un simbolo" spingono verso password piu' corte e piu' prevedibili:
 * la lunghezza e' l'unico parametro che paghi davvero.
 */
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(256);

export const signupRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    locale: z.string().min(2).max(35).optional(),
  })
  .strict();

export const loginRequestSchema = z
  .object({
    email: emailSchema,
    // Non `passwordSchema`: le regole di lunghezza sui vecchi account non
    // devono trasformarsi in un rifiuto di login (e in un oracolo su quali
    // password esistono).
    password: z.string().min(1).max(256),
  })
  .strict();

/**
 * Cambio password.
 *
 * `currentPassword` c'e' anche se la rotta sta dietro `requireAuth`: il token
 * dice «questa e' una sessione aperta», non «di la' dallo schermo c'e' il
 * proprietario». Senza questo campo, un telefono lasciato sbloccato per due
 * minuti basterebbe a prendersi l'account, e la password ricordata a memoria
 * smetterebbe di servire a qualcosa.
 *
 * Le due regole di lunghezza sono deliberatamente diverse. `currentPassword`
 * segue `loginRequestSchema` — permissiva, perche' una password vecchia piu'
 * corta di dodici caratteri esiste e deve poter essere digitata proprio nel
 * momento in cui la si sta sostituendo; rifiutarla qui vorrebbe dire
 * condannare quegli account a tenersela. `newPassword` segue `passwordSchema`,
 * perche' cio' che entra da oggi rispetta la regola di oggi.
 */
export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: passwordSchema,
  })
  .strict();

/**
 * «Scollega tutti gli altri dispositivi», senza toccare la password.
 *
 * ## Perche' non basta il cambio password
 *
 * Il cambio password fa gia' cadere ogni altra sessione, ma lo fa come effetto
 * collaterale di un'altra cosa. Chi ha perso il telefono e usa un gestore di
 * password non ha nessun motivo di cambiare una credenziale che sta al sicuro:
 * gli serve chiudere una sessione che e' rimasta aperta dentro un oggetto che
 * non ha piu'. Costringerlo a cambiare password per riuscirci vuol dire
 * chiedergli di aggiornarla ovunque, e il costo di quell'aggiornamento e' la
 * ragione per cui poi non lo fa nessuno.
 *
 * ## Perche' chiede comunque la password
 *
 * Per la stessa ragione del cambio password, e qui con un motivo in piu' che le
 * e' proprio. Questo gesto risparmia la sessione da cui parte: se non chiedesse
 * niente, chi ha in mano il telefono rubato potrebbe premerlo e restare
 * l'unico collegato, buttando fuori il proprietario da tutto il resto. Il campo
 * che sembra un fastidio e' l'unica cosa che tiene l'arma dalla parte giusta.
 *
 * `min(1).max(256)` come in `login` e non `passwordSchema`: si sta verificando
 * una password che esiste gia', non se ne sta accettando una nuova, e una piu'
 * corta del minimo di oggi deve poter essere digitata proprio da chi ha un
 * problema da risolvere adesso.
 */
export const revokeOtherSessionsRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
  })
  .strict();

/**
 * Quante sessioni sono cadute — e non `{ ok: true }`.
 *
 * Zero e uno non vogliono dire la stessa cosa, e l'interfaccia deve poterli
 * distinguere: «non c'era nessun altro dispositivo collegato» e' una risposta
 * utile, «fatto» sopra la stessa situazione lascia credere di aver disconnesso
 * il telefono che si sta cercando.
 *
 * Il numero conta i refresh token vivi revocati, che e' il numero di
 * dispositivi perche' una famiglia viva ne ha esattamente uno: la rotazione e'
 * una transazione che ne revoca uno e ne crea uno, e non c'e' nessun percorso
 * che ne lasci due.
 */
export const revokeOtherSessionsResponseSchema = z
  .object({
    revoked: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Una sessione aperta, vista da chi la possiede.
 *
 * ## Due campi, e nessun terzo
 *
 * Niente indirizzo IP, niente user-agent, niente «ultimo accesso». Non e' una
 * versione ridotta in attesa di crescere: un elenco che dice da dove e con che
 * cosa ci si e' collegati, e quando lo si e' fatto l'ultima volta, e' un
 * registro degli spostamenti di chi lo legge. Lo si costruirebbe per far
 * riconoscere la sessione da buttare, e intanto esisterebbe anche quando
 * nessuno ha niente da buttare — leggibile da chiunque prenda in mano uno
 * qualsiasi dei dispositivi elencati.
 *
 * `createdAt` e' il momento del login, non quello dell'ultima rotazione. La
 * differenza non e' un dettaglio: la riga viva di una famiglia ha un `issuedAt`
 * che si sposta a ogni giro, cioe' e' esattamente «ultimo accesso» sotto un
 * altro nome. La nascita e' il minimo sulla famiglia, e distingue «il telefono
 * di ieri» da «quello di due anni fa» senza dire nient'altro.
 *
 * ## Perche' l'`id` compare solo adesso
 *
 * Fino al commit che ha aggiunto `revokeSessionRequestSchema` questo schema
 * aveva due campi, e il commento diceva che il terzo non c'era «perche' non
 * c'e' un gesto che lo consumi»: si scollegavano tutti gli altri insieme, e per
 * quello bastava sapere quale fosse `current`. Un id spedito senza che serva e'
 * un id che prima o poi finisce in un log — e a quel punto e' un identificativo
 * di sessione lasciato in giro per niente.
 *
 * Adesso il gesto c'e', e l'id e' arrivato nello stesso commit che lo consuma.
 * La regola che resta e' quella, non il numero dei campi: un identificativo si
 * aggiunge al contratto insieme alla cosa che lo usa, mai prima. E' un
 * `familyId`, cioe' un dispositivo e non un token — la catena di rotazioni non
 * cambia nome quando ruota, quindi l'id di una riga di questo elenco resta
 * valido finche' quella sessione e' viva.
 */
export const openSessionSchema = z
  .object({
    /** Il `familyId`: quello che `revokeSession` accetta come `sessionId`. */
    id: z.string(),
    /** ISO, come tutte le date del contratto. */
    createdAt: z.string(),
    /** Quella da cui arriva la richiesta: l'unica che «scollega gli altri» risparmia. */
    current: z.boolean(),
  })
  .strict();

export const openSessionsResponseSchema = z
  .object({
    sessions: z.array(openSessionSchema),
  })
  .strict();

/**
 * «Chiudi questa riga», una sola.
 *
 * ## Perche' l'id sta nel corpo e non nel percorso
 *
 * La rotta e' `POST /api/auth/sessions/revoke-one`, e non
 * `POST /sessions/:id/revoke` ne' `DELETE /sessions/:id`. La ragione e' il
 * limitatore: la chiave di un secchiello e' costruita sul percorso concreto
 * della richiesta, non sullo schema della rotta. Con l'id nel percorso ogni id
 * diverso aprirebbe un secchiello nuovo, e una rotta che accetta una password
 * diventerebbe un oracolo senza limite — basta cambiare l'UUID a ogni tentativo
 * per non incontrare mai il 429.
 *
 * ## Perche' non e' `revokeOtherSessions` con un campo in piu'
 *
 * Perche' un `sessionId` facoltativo farebbe decidere a un campo *assente* se
 * il gesto ne chiude una o tutte, e un corpo malformato sceglierebbe il ramo
 * piu' distruttivo. Due gesti con due conseguenze cosi' diverse hanno due
 * schemi e due rotte.
 *
 * ## Perche' chiede la password anche per una sola
 *
 * Per la ragione di `revokeOtherSessions`, che qui non si indebolisce: senza,
 * chi ha in mano il telefono rubato chiude le altre una per una e ottiene
 * esattamente cio' che il campo dell'altro gesto esiste per impedire. Farlo in
 * tre tocchi invece che in uno non e' una difesa.
 *
 * `min(1).max(256)` come in `login` e in `revokeOtherSessions`, e per il motivo
 * gia' scritto li': si sta verificando una password che esiste gia', non
 * accettandone una nuova.
 */
export const revokeSessionRequestSchema = z
  .object({
    /** L'`id` di una riga di `openSessionsResponseSchema`, cioe' un `familyId`. */
    sessionId: z.string().min(1),
    currentPassword: z.string().min(1).max(256),
  })
  .strict();

/**
 * Quante ne sono cadute: zero o uno, e il tetto non e' nello schema.
 *
 * Zero e' la risposta a «l'avevo gia' chiusa», e non un 404: due schede aperte
 * sullo stesso account, si preme lo stesso pulsante due volte, e la seconda
 * volta il risultato voluto c'e' gia'. Un errore direbbe «e' andata male» a chi
 * ha ottenuto cio' che chiedeva.
 *
 * Nessun `.max(1)`, pur essendo uno il massimo vero. Un tetto qui vive nel
 * client, e il suo unico effetto possibile e' rifiutare come non conforme la
 * risposta di un'operazione riuscita: il server avrebbe chiuso la sessione e
 * l'utente leggerebbe un errore di validazione. L'invariante «una richiesta
 * chiude al massimo una famiglia» si difende con un test sul servizio, dove
 * fallire costa un test rosso e non un utente confuso.
 */
export const revokeSessionResponseSchema = z
  .object({
    revoked: z.number().int().nonnegative(),
  })
  .strict();

/**
 * «Cancella il mio account», e con lui tutto quello che c'e' dentro.
 *
 * ## Perche' esiste
 *
 * Perche' la linea guida 5.1.1(v) di Apple dice che un'app che permette di
 * creare un account deve permettere di cancellarlo *dentro l'app*, e senza il
 * rifiuto e' certo. Ma la ragione per cui merita di esistere anche senza Apple
 * e' un'altra: qui dentro finisce la voce di chi parla, e una voce che non si
 * puo' riprendere indietro e' una cosa che non si affida.
 *
 * ## Perche' chiede la password, e perche' con questa regola
 *
 * Per la ragione di `revokeOtherSessions` portata all'estremo: chi ha in mano
 * il telefono di un altro, con una sessione aperta sopra, qui non buttera'
 * fuori il proprietario — glielo cancellera'. E' il gesto meno reversibile che
 * esiste in questa applicazione, quindi e' il posto dove il campo che sembra un
 * fastidio serve di piu'.
 *
 * `min(1).max(256)` come in `login`, e non `passwordSchema`: si sta verificando
 * una password che esiste gia'. Qui il motivo e' ancora piu' netto che altrove
 * — rifiutare una password vecchia troppo corta vorrebbe dire condannare quel
 * conto a non potersi cancellare, cioe' produrre esattamente la situazione che
 * la 5.1.1(v) vieta, con il pretesto di una regola di robustezza.
 *
 * ## Perche' non c'e' un campo «scrivi CANCELLA per confermare»
 *
 * Perche' la conferma e' una cosa della schermata, non del contratto. Metterla
 * qui vorrebbe dire far dipendere l'API da una parola italiana disegnata su un
 * pulsante, e costringere ogni futuro client a riprodurre quella parola. La
 * doppia conferma sta in `AccountScreen`, dove si puo' cambiare senza cambiare
 * il contratto.
 */
export const deleteAccountRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
  })
  .strict();

/**
 * Che cosa e' sparito — e non `{ ok: true }`.
 *
 * Per la ragione di `revokeOtherSessionsResponseSchema`, e qui con un peso in
 * piu'. «Fatto» sopra una cancellazione e' la risposta che non si puo'
 * verificare: non c'e' piu' nessun posto dove tornare a guardare se e' vero, e
 * non c'e' nessun modo di rifarlo per controllare. Tre numeri sono l'unica
 * ricevuta che questo gesto potra' mai avere, e sono l'ultima cosa che l'utente
 * legge di un conto che non esiste piu'.
 *
 * I nomi sono quelli del prodotto e non quelli delle tabelle: `vocali` sono le
 * registrazioni, `schede` sono le procedure. Il contratto lo legge una
 * schermata che deve scriverli a un essere umano, e tradurli li' vorrebbe dire
 * avere la parola giusta in due posti.
 *
 * `sessioni` conta i dispositivi che si sono scollegati, cioe' le famiglie di
 * refresh token vive, per la ragione scritta in
 * `revokeOtherSessionsResponseSchema`: una famiglia viva ha esattamente una
 * riga. Include quella da cui parte la richiesta — qui non si risparmia
 * nessuno, ed e' l'unico gesto dell'autenticazione di cui questo sia vero.
 */
export const deleteAccountResponseSchema = z
  .object({
    vocali: z.number().int().nonnegative(),
    schede: z.number().int().nonnegative(),
    sessioni: z.number().int().nonnegative(),
  })
  .strict();

export const refreshRequestSchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .strict();

export const logoutRequestSchema = refreshRequestSchema;

export const publicUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    locale: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const authTokensSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    /** Secondi di vita residua dell'access token. */
    expiresIn: z.number().int(),
    tokenType: z.literal("Bearer"),
  })
  .strict();

export const authSessionSchema = z
  .object({
    user: publicUserSchema,
    tokens: authTokensSchema,
  })
  .strict();

export const meResponseSchema = z
  .object({
    user: publicUserSchema,
  })
  .strict();

export const logoutResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export const healthResponseSchema = z
  .object({
    status: z.union([z.literal("ok"), z.literal("degraded")]),
    db: z.union([z.literal("up"), z.literal("down")]),
    uptimeSeconds: z.number(),
    version: z.string(),
  })
  .strict();

export type SignupRequest = z.infer<typeof signupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type RevokeOtherSessionsRequest = z.infer<typeof revokeOtherSessionsRequestSchema>;
export type RevokeOtherSessionsResponse = z.infer<typeof revokeOtherSessionsResponseSchema>;
export type OpenSession = z.infer<typeof openSessionSchema>;
export type OpenSessionsResponse = z.infer<typeof openSessionsResponseSchema>;
export type RevokeSessionRequest = z.infer<typeof revokeSessionRequestSchema>;
export type RevokeSessionResponse = z.infer<typeof revokeSessionResponseSchema>;
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;
export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
export type AuthTokens = z.infer<typeof authTokensSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
