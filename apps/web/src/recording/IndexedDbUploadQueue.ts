import type { QueuedRecording, UploadQueueAdapter } from "@wikimylife/shared";

/**
 * La coda di upload su IndexedDB.
 *
 * E' l'unico posto del browser dove si possono mettere megabyte di audio senza
 * chiedere permesso e senza perderli alla chiusura della scheda. `localStorage`
 * tiene stringhe e sta sotto i cinque megabyte: un solo vocale di tre minuti lo
 * riempie. La Cache API conserva risposte, non byte arbitrari.
 *
 * La chiave e' `id`, generata dal chiamante (§2: l'audio esiste prima che il
 * server sappia della sua esistenza). L'indice `seq` e' un contatore
 * monotono che serve a una cosa sola: uscire nell'ordine in cui si e' entrati,
 * cioe' caricare per prima la registrazione che l'utente aspetta da piu' tempo.
 * `Date.now()` non basterebbe — due stop nello stesso millisecondo sono
 * improbabili ma non impossibili, e il risultato sarebbe un ordine arbitrario.
 *
 * Ogni operazione apre e chiude la sua transazione. Tenerne una aperta fra due
 * `await` la fa abortire da sola: in IndexedDB una transazione muore quando il
 * task corrente finisce senza altre richieste in volo, e il codice sembra
 * funzionare finche' la macchina non e' abbastanza lenta.
 */

const DB_NAME = "wikimylife";
const DB_VERSION = 1;
const STORE = "uploads";
const SEQ_INDEX = "seq";

/** La riga su disco: quella dell'interfaccia piu' il numero d'ordine. */
interface StoredRecording extends QueuedRecording {
  readonly seq: number;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.onerror = (): void => {
      reject(request.error ?? new Error("IndexedDB: richiesta fallita"));
    };
  });
}

/**
 * Attende la transazione, non la singola richiesta.
 *
 * Una `put` puo' avere successo e la transazione fallire subito dopo, per quota
 * esaurita o per il disco pieno. Su una coda di audio e' il caso che conta: se
 * si risolvesse sulla `put`, l'interfaccia direbbe «salvato» e il file non ci
 * sarebbe.
 */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => {
      resolve();
    };
    tx.onerror = (): void => {
      reject(tx.error ?? new Error("IndexedDB: transazione fallita"));
    };
    tx.onabort = (): void => {
      reject(tx.error ?? new Error("IndexedDB: transazione annullata"));
    };
  });
}

export class IndexedDbUploadQueue implements UploadQueueAdapter {
  readonly #name: string;
  #db: Promise<IDBDatabase> | null = null;

  constructor(name = DB_NAME) {
    this.#name = name;
  }

  static isSupported(): boolean {
    return typeof indexedDB !== "undefined";
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.#name, DB_VERSION);

      request.onupgradeneeded = (): void => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex(SEQ_INDEX, "seq", { unique: false });
        }
      };

      request.onsuccess = (): void => {
        const db = request.result;
        // Un'altra scheda che apre una versione piu' nuova resta bloccata
        // finche' questa non chiude. Meglio cedere: la coda si riapre da sola
        // alla prossima operazione.
        db.onversionchange = (): void => {
          db.close();
          this.#db = null;
        };
        resolve(db);
      };

      request.onerror = (): void => {
        this.#db = null;
        reject(request.error ?? new Error("IndexedDB: apertura fallita"));
      };
    });

    return this.#db;
  }

  async #read<T>(fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await this.#open();
    return fn(db.transaction(STORE, "readonly").objectStore(STORE));
  }

  async enqueue(item: Omit<QueuedRecording, "attempts" | "lastError">): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);

    // Il prossimo numero d'ordine e' l'ultimo piu' uno. La lettura sta dentro
    // la stessa transazione della scrittura, quindi due `enqueue` in parallelo
    // non possono leggere lo stesso massimo.
    const last = await promisify(store.index(SEQ_INDEX).openCursor(null, "prev"));
    const seq = last === null ? 1 : (last.value as StoredRecording).seq + 1;

    const row: StoredRecording = { ...item, attempts: 0, lastError: null, seq };
    store.put(row);

    await committed(tx);
  }

  async list(): Promise<QueuedRecording[]> {
    // `getAll` sull'indice restituisce gia' ordinato per `seq`.
    const rows = await this.#read((store) => promisify(store.index(SEQ_INDEX).getAll()));
    return (rows as StoredRecording[]).map(strip);
  }

  async peek(): Promise<QueuedRecording | null> {
    const cursor = await this.#read((store) => promisify(store.index(SEQ_INDEX).openCursor()));
    return cursor === null ? null : strip(cursor.value as StoredRecording);
  }

  async markFailed(id: string, error: string): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);

    const current = await promisify<StoredRecording | undefined>(store.get(id));
    // Puo' essere sparito: un altro giro l'ha caricato mentre questo falliva.
    // Ricrearlo qui rimetterebbe in coda un audio gia' sul server.
    if (current !== undefined) {
      store.put({ ...current, attempts: current.attempts + 1, lastError: error });
    }

    await committed(tx);
  }

  async remove(id: string): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    await committed(tx);
  }

  async size(): Promise<number> {
    return this.#read((store) => promisify(store.count()));
  }
}

/** Toglie `seq`, che e' un dettaglio di questo archivio e non del contratto. */
function strip(row: StoredRecording): QueuedRecording {
  const { seq: _seq, ...rest } = row;
  return rest;
}
