/**
 * Distinguere «riprova fra un minuto» da «riprovare non serve».
 *
 * Il tetto ai tentativi e il backoff trattano ogni fallimento allo stesso modo:
 * tre giri distanziati un minuto, dieci e un'ora, e poi fuori dalla coda. Per un
 * 429 e' esattamente giusto — la causa passa da sola, e aspettare e' l'unica
 * cosa sensata da fare. Per un audio che il fornitore rifiuta perche' e' in un
 * formato che non sa leggere e' un'ora e mezza di attesa al termine della quale
 * si sa gia' cosa succedera': la stessa cosa. Nel frattempo la registrazione
 * resta «in lavorazione» agli occhi di chi l'ha fatta, e l'errore vero — quello
 * su cui si potrebbe agire — e' nascosto dietro un'attesa che finge speranza.
 *
 * ## La classificazione e' volutamente sbilanciata
 *
 * Sbagliare in una direzione costa poco, nell'altra costa un intervento a mano.
 *
 * Chiamare «transitorio» qualcosa di definitivo produce novanta minuti di
 * tentativi inutili e poi lo stesso `ESTRAZIONE_FALLITA` di adesso: e'
 * esattamente il comportamento che c'era prima di questo file, quindi non e' un
 * peggioramento di niente.
 *
 * Chiamare «definitivo» qualcosa di transitorio toglie alla registrazione i suoi
 * tentativi automatici, e per riaverli serve che un umano apra l'app e prema
 * «riprova». Se poi la causa era comune a tutta la coda — una chiave API
 * scaduta, un endpoint sbagliato — l'umano deve premerlo una volta per riga.
 *
 * Quindi qui dentro finisce solo cio' che riguarda *questa* richiesta e non
 * potrebbe cambiare al giro dopo. Tutto il resto, incluso cio' che sembra
 * definitivo ma si aggiusta con una variabile d'ambiente e un redeploy, resta
 * transitorio: novanta minuti sono anche la finestra entro cui chi ha sbagliato
 * la chiave puo' correggerla senza che nessuno perda un tentativo.
 *
 * Il file non importa `ProviderHttpError` ne' `S3StorageError`. Riconosce gli
 * errori dalla forma — `name` e `status` — perche' il servizio di ingestione non
 * dipende da nessuna implementazione di provider, ed e' proprio quella
 * indipendenza che permette di provarlo senza chiavi API.
 *
 * ## Il 400 c'era, e il primo deploy vero l'ha tolto
 *
 * Fino al primo deploy questo elenco conteneva anche `400`, sulla premessa che
 * con un corpo costruito dal nostro codice «malformata» potesse voler dire solo
 * che l'audio dentro non e' quello che dichiara. La premessa era falsa, e a
 * dirlo e' stata la produzione: una chiave Anthropic legata all'organizzazione e
 * non a un workspace fa rispondere
 *
 *     HTTP 400 — This API key is not scoped to a workspace, so this request
 *     must include the anthropic-workspace-id header
 *
 * cioe' il caso di configurazione per eccellenza, quello che le due righe qui
 * sopra promettono di lasciare transitorio. Al posto dei novanta minuti di
 * finestra la registrazione e' uscita dalla coda al primo tentativo su tre, con
 * scritto all'utente che era colpa di com'era fatta la sua trascrizione.
 *
 * La ragione per cui il difetto era strutturale e non una svista: `413`, `415` e
 * `422` sono stati che *per definizione* parlano dell'entita' spedita — troppo
 * grande, formato non gestito, contenuto letto e rifiutato. Non esiste una
 * lettura di quei tre in cui il soggetto sia chi sta chiamando. `400` e' invece
 * il generico di «richiesta malformata», e una richiesta comprende il corpo ma
 * anche le intestazioni e la forma delle credenziali: e' ambiguo per
 * costruzione, e non smettera' di esserlo. La regola dell'asimmetria qui sopra
 * decide i pareggi verso il transitorio, e questo e' un pareggio permanente.
 *
 * Scartata l'alternativa di distinguere *dentro* il 400 cercando nel messaggio i
 * marcatori della configurazione. Due ragioni: il corpo della risposta arriva
 * qui dentro solo perche' `ProviderHttpError` lo concatena nel `message`
 * troncato a 500 caratteri, quindi il marcatore puo' cadere fuori dalla
 * finestra; e legare la classificazione alla prosa inglese di un fornitore
 * significa che il giorno in cui la riscrive nessun test cade e il difetto
 * torna in silenzio. Questo file riconosce gli errori dalla forma, mai dal
 * testo, ed e' la stessa ragione per cui non importa le classi.
 */

/**
 * Gli stati HTTP che parlano del contenuto della richiesta, non del server che
 * la riceve.
 *
 * - `413` questo file e' troppo grande per questo fornitore, e non rimpicciolira'.
 * - `415` questo formato non e' supportato, e non lo diventera'.
 * - `422` il contenuto e' stato letto e rifiutato.
 *
 * Non c'e' `400`, per la ragione in testa al file: e' il generico delle
 * richieste malformate, e i fornitori ci mettono dentro anche le credenziali.
 * Non ci sono `401` e `403`, che parlano di credenziali e si risolvono da fuori;
 * non c'e' `404`, che su un endpoint di un fornitore vuol dire url o modello
 * sbagliati, cioe' di nuovo configurazione; non c'e' `429` ne' nessun `5xx`, che
 * sono la definizione stessa di transitorio.
 *
 * Il prezzo di togliere il `400`, e va detto invece che scoperto: un fornitore
 * che rifiuta il contenuto con un `400` invece che con uno dei tre — una
 * trascrizione piu' lunga del massimo, per esempio — adesso si porta via i
 * novanta minuti prima di finire in `ESTRAZIONE_FALLITA`. E' il costo che il
 * paragrafo sull'asimmetria dichiara accettabile: e' il comportamento che c'era
 * prima che questo file esistesse.
 */
export const STATI_RIFIUTO = new Set([413, 415, 422]);

/** I nomi degli errori che portano uno `status` HTTP significativo. */
const NOMI_CON_STATUS = new Set(["ProviderHttpError", "S3StorageError"]);

function nomeDi(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const nome: unknown = (error as { name?: unknown }).name;
  return typeof nome === "string" ? nome : null;
}

function statusDi(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const status: unknown = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/**
 * L'audio non c'e'.
 *
 * Un 404 dallo storage o un `ENOENT` dal filesystem: la chiave e' stata scritta
 * nella riga ma l'oggetto non esiste. Nessuna attesa lo fa comparire, e
 * riprovare tre volte significa solo spostare piu' avanti il momento in cui
 * qualcuno legge il messaggio e va a cercare l'oggetto.
 */
export function oggettoMancante(error: unknown): boolean {
  if (nomeDi(error) === "S3StorageError" && statusDi(error) === 404) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code: unknown = (error as { code?: unknown }).code;
  return code === "ENOENT";
}

/**
 * Il fornitore ha guardato dentro la richiesta e l'ha rifiutata.
 *
 * Rimandare gli stessi byte allo stesso endpoint puo' solo ottenere la stessa
 * risposta: e' l'unico caso in cui «riprovare non serve» e' una deduzione e non
 * una scommessa.
 */
export function richiestaRifiutata(error: unknown): boolean {
  const nome = nomeDi(error);
  if (nome === null || !NOMI_CON_STATUS.has(nome)) {
    return false;
  }
  const status = statusDi(error);
  return status !== null && STATI_RIFIUTO.has(status);
}
