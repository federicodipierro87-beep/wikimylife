import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type {
  PutObjectInput,
  StorageProvider,
  StoredObject,
} from "@wikimylife/shared";

/**
 * Storage su filesystem, per lo sviluppo locale.
 *
 * Non e' adatto alla produzione e il README lo dice: il disco di Railway e'
 * effimero, quindi un riavvio cancellerebbe gli audio. Esiste perche' lo
 * sviluppo con `STORAGE_PROVIDER=fake` perde tutto a ogni riavvio del processo,
 * e per lavorare sulla pipeline serve poter riprocessare due volte la stessa
 * registrazione.
 *
 * Il giorno del passaggio a S3 cambia questa classe e la riga di
 * `buildProviders`: la chiave che gira nel resto del sistema e' gia' una chiave
 * di object storage, non un percorso.
 */
export class LocalFileStorageProvider implements StorageProvider {
  readonly name = "local";
  readonly #root: string;

  constructor(rootDir: string) {
    this.#root = resolve(rootDir);
  }

  /**
   * Traduce una chiave in un percorso, rifiutando l'evasione dalla radice.
   *
   * La chiave la costruisce il servizio (`userId/uuid.ext`), non l'utente, ma
   * il controllo resta: e' una riga, e il giorno in cui qualcuno passasse di
   * qui una stringa che arriva da fuori, la differenza sarebbe fra un bug e una
   * lettura arbitraria del filesystem.
   */
  #pathFor(key: string): string {
    const target = resolve(join(this.#root, normalize(key)));
    if (target !== this.#root && !target.startsWith(this.#root + sep)) {
      throw new Error(`LocalFileStorageProvider: chiave fuori dalla radice: ${key}`);
    }
    return target;
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const path = this.#pathFor(input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.data);
    return {
      key: input.key,
      url: `file://${path.split(sep).join("/")}`,
      mimeType: input.mimeType,
      sizeBytes: input.data.byteLength,
    };
  }

  async get(key: string): Promise<Uint8Array> {
    const buffer = await readFile(this.#pathFor(key));
    // Copia in una `Uint8Array` pura: un `Buffer` e' una vista su un pool
    // condiviso, e il contratto dei provider parla di `Uint8Array` proprio per
    // non far viaggiare un tipo che esiste solo in Node.
    return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  }

  async delete(key: string): Promise<void> {
    await rm(this.#pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.#pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}
