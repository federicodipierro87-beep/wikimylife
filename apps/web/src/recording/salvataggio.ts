/**
 * Cosa fare quando il disco del browser dice di no.
 *
 * La §2 promette che premuto stop l'audio e' su disco. E' una promessa che
 * dipende da qualcosa che non e' nostro: IndexedDB ha una quota per origine che
 * il browser decide da solo, la riduce quando il dispositivo si riempie, e in
 * Firefox in navigazione privata non esiste proprio. Quando quella quota
 * finisce, la scrittura viene rifiutata e la registrazione — che vive solo
 * nell'array di byte appena tornato dal `MediaRecorder` — sparisce con la
 * funzione che la conteneva.
 *
 * Qui dentro c'e' la parte di quella situazione che si puo' provare senza un
 * browser: riconoscere il rifiuto per quota, dargli un nome leggibile, e
 * costruire il nome del file per l'unica via d'uscita rimasta.
 *
 * ## Perche' la via d'uscita e' uno scaricamento
 *
 * Se il browser non ha spazio, nessun posto del browser ne ha: ne' un'altra
 * coda, ne' la memoria, che sparisce chiudendo la scheda. Il filesystem del
 * dispositivo, invece, e' un posto diverso con un altro budget, e ci si arriva
 * con un `<a download>`. Non e' elegante — l'audio esce dall'app e non ci
 * rientra da solo — ma e' l'unica cosa che trasforma «la registrazione e'
 * persa» in «la registrazione e' nei Download».
 */

/**
 * I nomi con cui i browser dicono «non c'e' piu' spazio».
 *
 * Sono tre perche' Firefox non usa quello standard: `QuotaExceededError` e' la
 * `DOMException` del `DOMException` moderno, gli `NS_ERROR_*` sono quelli che
 * arrivano ancora da Gecko quando la quota o il disco finiscono davvero.
 * Confrontare il messaggio invece del nome sarebbe fragile: e' localizzato.
 */
const NOMI_SPAZIO = new Set([
  "QuotaExceededError",
  "NS_ERROR_DOM_QUOTA_REACHED",
  "NS_ERROR_FILE_NO_DEVICE_SPACE",
]);

/**
 * `true` se l'errore e' «non c'e' spazio» e non «IndexedDB e' rotto».
 *
 * La differenza conta perche' cambia cosa si puo' dire all'utente: nel primo
 * caso liberare spazio e riprovare funziona, nel secondo no.
 */
export function spazioEsaurito(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const nome: unknown = (error as { name?: unknown }).name;
  return typeof nome === "string" && NOMI_SPAZIO.has(nome);
}

/**
 * Il messaggio da mostrare, che dice anche cosa fare.
 *
 * Il testo grezzo di una `DOMException` («A mutation operation was attempted on
 * a database that did not allow mutations») e' vero e inutile: chi ha appena
 * finito di parlare deve capire in una riga che l'audio non e' salvo e che c'e'
 * un modo di tenerlo.
 */
export function motivoDi(error: unknown): string {
  if (spazioEsaurito(error)) {
    return "Non c'e' piu' spazio sul dispositivo: la registrazione non e' stata salvata.";
  }
  return "Questo browser non ha potuto salvare la registrazione sul telefono.";
}

/** L'estensione giusta per il tipo che il `MediaRecorder` ha davvero prodotto. */
export function estensioneDi(mimeType: string): string {
  // `audio/webm;codecs=opus` -> `audio/webm`: i parametri non cambiano il
  // contenitore, e sono l'unica ragione per cui un confronto secco fallirebbe.
  const tipo = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (tipo) {
    case "audio/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    case "audio/mp4":
      // `.m4a` e non `.mp4`: e' lo stesso contenitore, ma e' quello che fa
      // aprire il file a un lettore audio invece che a un lettore video.
      return "m4a";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    default:
      // Meglio un file senza estensione riconosciuta che uno chiamato `.webm`
      // che dentro non e' un webm.
      return "bin";
  }
}

/**
 * Il nome del file scaricato.
 *
 * Contiene data e ora perche' finisce in una cartella Download insieme a tutto
 * il resto, e fra una settimana «registrazione.webm» non dice a nessuno quale
 * pomeriggio fosse. L'ora e' quella locale del dispositivo — la stessa che
 * l'utente ha guardato mentre registrava.
 */
export function nomeFileDi(recordedAt: string, mimeType: string): string {
  const quando = new Date(recordedAt);
  const stampa = Number.isNaN(quando.getTime())
    ? "senza-data"
    : [
        String(quando.getFullYear()),
        due(quando.getMonth() + 1),
        due(quando.getDate()),
        "-",
        due(quando.getHours()),
        due(quando.getMinutes()),
      ].join("");
  return `wikimylife-${stampa}.${estensioneDi(mimeType)}`;
}

function due(n: number): string {
  return String(n).padStart(2, "0");
}
