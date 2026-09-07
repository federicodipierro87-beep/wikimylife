import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type {
  ListObjectsInput,
  ListedObject,
  ListedPage,
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

  /**
   * Una sola pagina, sempre: il filesystem non ha un motivo per spezzarla.
   *
   * `readdir` ricorsivo su una cartella che non esiste ancora non e' un guasto —
   * significa che non e' stato ancora caricato niente — e restituire un elenco
   * vuoto e' la risposta esatta. Le barre si normalizzano a `/` perche' su
   * Windows `readdir` le dà come `\`, e una chiave con la barra rovescia non
   * combacerebbe con la stessa chiave scritta nel database da un altro sistema
   * operativo.
   *
   * L'ordinamento è quello del filesystem, cioè nessuno in particolare: chi
   * chiama non deve dipenderne, come non può dipendere da quello di S3.
   */
  async list(input: ListObjectsInput = {}): Promise<ListedPage> {
    let voci: string[];
    try {
      voci = await readdir(this.#root, { recursive: true });
    } catch {
      return { objects: [], continuationToken: undefined };
    }

    const prefix = input.prefix ?? "";
    const objects: ListedObject[] = [];

    for (const voce of voci) {
      const key = voce.split(sep).join("/");
      if (!key.startsWith(prefix)) {
        continue;
      }
      const info = await stat(join(this.#root, voce)).catch(() => null);
      // Le cartelle non sono oggetti: in uno storage a chiavi non esistono, e
      // farle comparire qui vorrebbe dire proporre a chi pulisce di cancellare
      // la cartella di un utente perche' «nessuna riga la nomina».
      if (info === null || !info.isFile()) {
        continue;
      }
      objects.push({
        key,
        sizeBytes: info.size,
        lastModified: info.mtime.toISOString(),
      });
    }

    return { objects, continuationToken: undefined };
  }
}
