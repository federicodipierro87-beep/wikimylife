import type { DraftPiece, RecordingDraft, RecordingDraftAdapter } from "@wikimylife/shared";
import { committed, promisify } from "./IndexedDbUploadQueue";

/**
 * Le bozze su IndexedDB: una riga per ogni secondo di audio registrato.
 *
 * ## Un database suo, e non un secondo archivio in quello della coda
 *
 * Aggiungere un archivio a `wikimylife` vorrebbe dire alzarne la versione, e una
 * versione nuova aperta da una scheda resta bloccata finche' tutte le altre
 * schede con la vecchia non chiudono: proprio la coda, cioe' la cosa che non
 * deve mai fermarsi. Un database a parte non tocca niente di cio' che c'era.
 *
 * ## La chiave e' [bozza, numero]
 *
 * Cosi' `getAll` restituisce gia' ogni bozza con i pezzi in fila, e buttarne una
 * e' una `delete` su un intervallo di chiavi invece di una lettura seguita da
 * tante cancellazioni. Una riga per pezzo e non una riga per bozza che si
 * allunga: riscrivere a ogni secondo tutto l'audio registrato fin li' vorrebbe
 * dire, al decimo minuto, scrivere seicento secondi di audio per salvarne uno.
 *
 * Nessun test esegue questa classe, come nessuno esegue `IndexedDbUploadQueue`:
 * in `jsdom` `indexedDB` non esiste. Le decisioni stanno in `bozze.ts`, che e'
 * provato contro un archivio in memoria.
 */

const DB_NAME = "wikimylife-bozze";
const DB_VERSION = 1;
const STORE = "pezzi";

type Riga = DraftPiece;

export class IndexedDbBozze implements RecordingDraftAdapter {
  #db: Promise<IDBDatabase> | null = null;

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (): void => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: ["draftId", "seq"] });
        }
      };

      request.onsuccess = (): void => {
        const db = request.result;
        db.onversionchange = (): void => {
          db.close();
          this.#db = null;
        };
        resolve(db);
      };

      request.onerror = (): void => {
        this.#db = null;
        reject(request.error ?? new Error("IndexedDB: apertura delle bozze fallita"));
      };
    });

    return this.#db;
  }

  async #scrivi(fn: (store: IDBObjectStore) => void): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(STORE, "readwrite");
    fn(tx.objectStore(STORE));
    await committed(tx);
  }

  append(piece: DraftPiece): Promise<void> {
    return this.#scrivi((store) => {
      store.put(piece);
    });
  }

  async list(): Promise<readonly RecordingDraft[]> {
    const db = await this.#open();
    const righe = (await promisify(
      db.transaction(STORE, "readonly").objectStore(STORE).getAll(),
    )) as Riga[];

    // Le righe arrivano in ordine di chiave, cioe' per bozza e poi per numero:
    // basta raggrupparle senza riordinarle.
    const bozze = new Map<string, { prima: Riga; ultima: Riga; pezzi: Uint8Array[] }>();
    for (const riga of righe) {
      const corrente = bozze.get(riga.draftId);
      if (corrente === undefined) {
        bozze.set(riga.draftId, { prima: riga, ultima: riga, pezzi: [riga.data] });
      } else {
        corrente.pezzi.push(riga.data);
        if (riga.at > corrente.ultima.at) {
          corrente.ultima = riga;
        }
      }
    }

    return [...bozze.values()].map(({ prima, ultima, pezzi }) => ({
      id: prima.draftId,
      mimeType: prima.mimeType,
      startedAt: prima.startedAt,
      lastPieceAt: ultima.at,
      pieces: pezzi,
    }));
  }

  discard(id: string): Promise<void> {
    return this.#scrivi((store) => {
      store.delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
    });
  }

  clear(): Promise<void> {
    return this.#scrivi((store) => {
      store.clear();
    });
  }
}
