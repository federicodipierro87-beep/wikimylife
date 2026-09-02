import type {
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
 */
export class FakeStorageProvider implements StorageProvider {
  readonly name = "fake";
  readonly #objects = new Map<string, { data: Uint8Array; mimeType: string }>();
  readonly #baseUrl: string;

  constructor(baseUrl = "memory://wikimylife") {
    this.#baseUrl = baseUrl;
  }

  put(input: PutObjectInput): Promise<StoredObject> {
    // Copia difensiva: chi ha passato il buffer potrebbe riusarlo.
    const data = Uint8Array.from(input.data);
    this.#objects.set(input.key, { data, mimeType: input.mimeType });
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
      return Promise.reject(new Error(`FakeStorageProvider: chiave assente ${key}`));
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

  createUploadUrl(input: { key: string; mimeType: string }): Promise<UploadTicket> {
    return Promise.resolve({
      key: input.key,
      url: `${this.#baseUrl}/upload/${input.key}`,
      method: "PUT",
      headers: { "Content-Type": input.mimeType },
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
  }

  get size(): number {
    return this.#objects.size;
  }
}
