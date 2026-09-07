import type {
  ListObjectsInput,
  ListedObject,
  ListedPage,
  PutObjectInput,
  StorageProvider,
  StoredObject,
  UploadTicket,
} from "@wikimylife/shared";

/**
 * Storage in memoria.
 *
 * Implementa anche `createUploadUrl` per tenere onesta la predisposizione
 * all'URL prefirmato: se il ramo dell'upload diretto non esistesse nemmeno nel
 * fake, scopriremmo solo al momento del passaggio a S3 che i chiamanti non
 * erano pronti.
 *
 * `list` pagina davvero, e non perche' la memoria lo richieda. Chi consuma un
 * elenco paginato ha un modo di sbagliare che si vede solo su due pagine —
 * fermarsi alla prima, o richiedere per sempre la stessa — e un fake che
 * rispondesse tutto in un colpo lascerebbe quel ramo scoperto fino al primo
 * bucket con piu' di mille oggetti.
 */
export class FakeStorageProvider implements StorageProvider {
  readonly name = "fake";
  readonly #objects = new Map<
    string,
    { data: Uint8Array; mimeType: string; lastModified: string }
  >();
  readonly #baseUrl: string;
  readonly #now: () => Date;

  /** Quante chiavi per pagina. `Infinity` = una pagina sola. */
  pageSize = Number.POSITIVE_INFINITY;

  constructor(baseUrl = "memory://wikimylife", now: () => Date = () => new Date()) {
    this.#baseUrl = baseUrl;
    this.#now = now;
  }

  put(input: PutObjectInput): Promise<StoredObject> {
    // Copia difensiva: chi ha passato il buffer potrebbe riusarlo.
    const data = Uint8Array.from(input.data);
    this.#objects.set(input.key, {
      data,
      mimeType: input.mimeType,
      lastModified: this.#now().toISOString(),
    });
    return Promise.resolve({
      key: input.key,
      url: `${this.#baseUrl}/${input.key}`,
      mimeType: input.mimeType,
      sizeBytes: data.byteLength,
    });
  }

  get(key: string): Promise<Uint8Array> {
    const found = this.#objects.get(key);
    if (found === undefined) {
      // `code: "ENOENT"` come il filesystem e come `S3StorageError` con 404: e'
      // la forma su cui `oggettoMancante` decide che riprovare non serve. Un
      // fake che segnalasse l'assenza con un errore anonimo nasconderebbe quel
      // ramo a ogni test che passa di qui.
      const assente: NodeJS.ErrnoException = new Error(
        `FakeStorageProvider: chiave assente ${key}`,
      );
      assente.code = "ENOENT";
      return Promise.reject(assente);
    }
    return Promise.resolve(Uint8Array.from(found.data));
  }

  delete(key: string): Promise<void> {
    this.#objects.delete(key);
    return Promise.resolve();
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.#objects.has(key));
  }

  /**
   * Il segnalibro e' l'indice della prossima chiave, in chiaro.
   *
   * S3 manda una stringa opaca, e imitarla — codificando in base64, per dire —
   * avrebbe reso il fake piu' somigliante e i test meno leggibili, senza
   * cambiare di una riga cio' che il chiamante puo' fare con quel valore:
   * rimandarlo indietro.
   *
   * L'ordine e' quello di inserimento, che e' cio' che `Map` garantisce. S3
   * ordina per chiave; nessuno dei due e' un ordine su cui chi pulisce possa
   * appoggiarsi, ed e' bene che i due non coincidano.
   */
  list(input: ListObjectsInput = {}): Promise<ListedPage> {
    const prefix = input.prefix ?? "";
    const tutte = [...this.#objects.entries()].filter(([key]) => key.startsWith(prefix));

    const da = input.continuationToken === undefined ? 0 : Number(input.continuationToken);
    const a = da + this.pageSize;

    const objects: ListedObject[] = tutte
      .slice(da, a === Number.POSITIVE_INFINITY ? undefined : a)
      .map(([key, o]) => ({
        key,
        sizeBytes: o.data.byteLength,
        lastModified: o.lastModified,
      }));

    return Promise.resolve({
      objects,
      continuationToken: a < tutte.length ? String(a) : undefined,
    });
  }

  createUploadUrl(input: { key: string; mimeType: string }): Promise<UploadTicket> {
    return Promise.resolve({
      key: input.key,
      url: `${this.#baseUrl}/upload/${input.key}`,
      method: "PUT",
      headers: { "Content-Type": input.mimeType },
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
  }

  /**
   * Sposta indietro la data di un oggetto, per i test che hanno bisogno di
   * qualcosa di vecchio senza aspettare.
   */
  touch(key: string, lastModified: Date): this {
    const trovato = this.#objects.get(key);
    if (trovato !== undefined) {
      trovato.lastModified = lastModified.toISOString();
    }
    return this;
  }

  get size(): number {
    return this.#objects.size;
  }

  get keys(): readonly string[] {
    return [...this.#objects.keys()];
  }
}
