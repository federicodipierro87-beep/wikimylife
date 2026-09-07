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
 */

/**
 * Gli stati HTTP che parlano del contenuto della richiesta, non del server che
 * la riceve.
 *
 * - `400` la richiesta e' malformata. Con un corpo costruito dal nostro codice
 *   significa quasi sempre che l'audio dentro non e' quello che dichiara.
 * - `413` questo file e' troppo grande per questo fornitore, e non rimpicciolira'.
 * - `415` questo formato non e' supportato, e non lo diventera'.
 * - `422` il contenuto e' stato letto e rifiutato.
 *
 * Non ci sono `401` e `403`, che parlano di credenziali e si risolvono da fuori;
 * non c'e' `404`, che su un endpoint di un fornitore vuol dire url o modello
 * sbagliati, cioe' di nuovo configurazione; non c'e' `429` ne' nessun `5xx`, che
 * sono la definizione stessa di transitorio.
 */
export const STATI_RIFIUTO = new Set([400, 413, 415, 422]);

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
