import type { ListedObject, StorageProvider } from "@wikimylife/shared";
import type { Clock } from "./ports/Clock.js";
import type { RecordingRepository } from "./ports/RecordingRepository.js";

/**
 * La scopa: gli oggetti che nessuna riga nomina piu'.
 *
 * Il README lo diceva da tempo come cosa mancante. Cancellare una registrazione
 * toglie la riga e poi l'oggetto, e fra le due c'e' una finestra di
 * millisecondi; la stessa finestra sta fra il `put` del caricamento e la riga
 * che lo nomina. Un processo che muoia li' in mezzo — o un bucket
 * irraggiungibile nel momento sbagliato — lascia byte che nessuno sa piu' di
 * avere. Sono kilobyte, finche' non sono gigabyte, e sono la voce di qualcuno
 * che credeva di averla cancellata.
 *
 * ## Perche' non e' una transazione
 *
 * Perche' non puo' esserlo. Il database e il bucket sono due sistemi che non
 * condividono un commit, e ogni schema che pretenda di tenerli allineati in
 * tempo reale — una tabella di intenti, un log da riprodurre — sposta il
 * problema senza risolverlo: resta sempre un momento in cui uno dei due ha
 * scritto e l'altro no. La strada praticabile e' l'altra: accettare la
 * divergenza e riconciliarla dopo, sapendo che «dopo» significa che per un po'
 * la spazzatura c'e'.
 *
 * ## Le tre regole che rendono la cancellazione sicura
 *
 * Questo servizio cancella file di persone sulla base di una query. Se sbaglia,
 * non c'e' un cestino da cui ripescare. Le tre condizioni sotto esistono per
 * rendere improbabile ogni modo che ho saputo immaginare di sbagliare, e sono
 * cumulative: un oggetto si cancella solo se le supera tutte e tre.
 *
 * 1. **Nessuna riga lo nomina.** E' la condizione ovvia, ed e' anche quella su
 *    cui e' piu' facile sbagliarsi: la si interroga a blocchi, e un blocco che
 *    non arrivi al database darebbe come orfano tutto cio' che conteneva. Per
 *    questo un errore di lettura interrompe la passata invece di saltare il
 *    blocco.
 *
 * 2. **E' piu' vecchio della soglia.** Il caricamento scrive l'oggetto PRIMA
 *    della riga: nell'istante fra i due, l'oggetto e' orfano secondo la regola
 *    1 ed e' invece l'audio che qualcuno sta caricando in questo momento. La
 *    soglia e' l'unica difesa contro quella corsa, e per questo il default e'
 *    largo — un giorno — invece di stretto.
 *
 * 3. **Ha la forma di una chiave nostra.** Il bucket puo' non essere solo
 *    nostro: qualcuno puo' averci messo un backup, un export, un file caricato
 *    a mano. Nessuna riga lo nomina, e' vecchio, e cancellarlo sarebbe corretto
 *    secondo le prime due regole e sbagliato secondo il buon senso. Si tocca
 *    solo cio' che ha la forma che scrive `recordings.service.ts`.
 *
 * ## Guarda, e poi cancella
 *
 * `esegui` non cancella se non glielo si dice. Non e' timidezza: la prima volta
 * che si passa la scopa su un bucket vero si vuole leggere l'elenco, e un
 * comando che cancella per default trasforma un errore di configurazione — il
 * `DATABASE_URL` di un altro ambiente, per dire — in una perdita di dati
 * irreversibile invece che in una stampa sbagliata.
 */

/**
 * `{qualcosa}/{uuid}.{est}`, che e' cio' che costruisce `recordings.service.ts`.
 *
 * Volutamente stretta sull'UUID: quella parte non e' scelta da nessuno, e'
 * `randomUUID()`, quindi un nome che non le somiglia non e' un audio nostro
 * qualunque sia il motivo. La prima parte e' l'id dell'utente e resta libera —
 * un cuid oggi, chissa' domani — ma non puo' contenere barre, perche' la chiave
 * ha esattamente due segmenti.
 */
const CHIAVE_NOSTRA =
  /^[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/i;

export function sembraUnAudioNostro(key: string): boolean {
  return CHIAVE_NOSTRA.test(key);
}

/** Un giorno. Vedi la regola 2: e' largo apposta. */
export const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Quante chiavi per interrogazione del database.
 *
 * Una pagina di S3 ne porta mille, e mille parametri in un `IN (...)` sono
 * ancora una query ragionevole per Postgres. Si tiene comunque un blocco
 * proprio, indipendente dalla pagina, perche' il provider locale risponde tutto
 * in una volta e senza questo taglio manderebbe al database un elenco lungo
 * quanto la cartella.
 */
const BLOCCO = 500;

export interface SweepSummary {
  /** Quanti oggetti ha guardato in tutto. */
  readonly esaminati: number;
  /** Quanti sono nominati da una riga. */
  readonly nominati: number;
  /** Quanti sono stati saltati perche' non hanno la forma di una chiave nostra. */
  readonly estranei: number;
  /** Quanti sono orfani ma troppo recenti per la soglia. */
  readonly troppoRecenti: number;
  /** Gli orfani da cancellare, o cancellati. */
  readonly orfani: readonly ListedObject[];
  /** Byte che gli orfani occupano. */
  readonly byteOrfani: number;
  /** Quanti sono stati cancellati davvero. Zero se `cancella` era falso. */
  readonly cancellati: number;
  /** Quanti hanno rifiutato di farsi cancellare. */
  readonly falliti: number;
}

export interface SweepOptions {
  /**
   * `false` guarda e basta. Il default e' `false` per la ragione scritta sopra.
   */
  readonly cancella?: boolean;
  /** Quanto deve essere vecchio un orfano per essere tale. */
  readonly graceMs?: number;
  readonly prefix?: string | undefined;
}

export interface StorageSweepDeps {
  readonly storage: StorageProvider;
  readonly repo: Pick<RecordingRepository, "findExistingAudioKeys">;
  readonly clock: Clock;
  /** Chiamato per ogni orfano trovato, prima di ogni eventuale cancellazione. */
  readonly onOrfano?: (object: ListedObject) => void;
  readonly onErroreCancellazione?: (input: {
    readonly key: string;
    readonly error: unknown;
  }) => void;
}

export interface StorageSweepService {
  esegui(options?: SweepOptions): Promise<SweepSummary>;
}

export function createStorageSweepService(deps: StorageSweepDeps): StorageSweepService {
  return {
    async esegui(options: SweepOptions = {}): Promise<SweepSummary> {
      const cancella = options.cancella ?? false;
      const graceMs = options.graceMs ?? SWEEP_GRACE_MS;
      const limite = deps.clock.now().getTime() - graceMs;

      let esaminati = 0;
      let nominati = 0;
      let estranei = 0;
      let troppoRecenti = 0;
      let cancellati = 0;
      let falliti = 0;
      let byteOrfani = 0;
      const orfani: ListedObject[] = [];

      /**
       * Confronta un blocco di candidati con il database.
       *
       * Un errore qui NON si ignora e non si salta: e' la regola 1. Se questa
       * chiamata fallisse in silenzio, ogni chiave del blocco risulterebbe non
       * nominata, cioe' orfana, cioe' da cancellare.
       */
      const confronta = async (blocco: readonly ListedObject[]): Promise<void> => {
        const esistenti = await deps.repo.findExistingAudioKeys(blocco.map((o) => o.key));

        for (const oggetto of blocco) {
          if (esistenti.has(oggetto.key)) {
            nominati += 1;
            continue;
          }
          if (Date.parse(oggetto.lastModified) > limite) {
            troppoRecenti += 1;
            continue;
          }
          orfani.push(oggetto);
          byteOrfani += oggetto.sizeBytes;
          deps.onOrfano?.(oggetto);
        }
      };

      // Accumula attraverso le pagine: una di S3 ne porta mille, quella locale
      // le porta tutte, e la dimensione del blocco mandato al database non deve
      // dipendere da quale provider ha risposto.
      let candidati: ListedObject[] = [];
      let token: string | undefined;

      do {
        const pagina = await deps.storage.list({
          prefix: options.prefix,
          continuationToken: token,
        });

        for (const oggetto of pagina.objects) {
          esaminati += 1;
          // La regola 3 si applica prima di interrogare il database: un file che
          // non e' nostro non e' una domanda da fare.
          if (!sembraUnAudioNostro(oggetto.key)) {
            estranei += 1;
            continue;
          }
          candidati.push(oggetto);
        }

        while (candidati.length >= BLOCCO) {
          await confronta(candidati.slice(0, BLOCCO));
          candidati = candidati.slice(BLOCCO);
        }

        token = pagina.continuationToken;
      } while (token !== undefined);

      if (candidati.length > 0) {
        await confronta(candidati);
      }

      if (cancella) {
        for (const oggetto of orfani) {
          try {
            await deps.storage.delete(oggetto.key);
            cancellati += 1;
          } catch (error: unknown) {
            // Una chiave che non si lascia cancellare non ferma le altre: la
            // passata successiva la ritrovera' identica, ed e' esattamente
            // quello che deve succedere.
            falliti += 1;
            deps.onErroreCancellazione?.({ key: oggetto.key, error });
          }
        }
      }

      return {
        esaminati,
        nominati,
        estranei,
        troppoRecenti,
        orfani,
        byteOrfani,
        cancellati,
        falliti,
      };
    },
  };
}
