/**
 * Storage dell'audio. In sviluppo e' il filesystem, in produzione object
 * storage (il disco di Railway e' effimero).
 *
 * `createUploadUrl` e' opzionale e non e' usato in Fase 2: esiste perche' il
 * giorno in cui l'audio salira' con un URL prefirmato, quel cambiamento deve
 * restare dentro il provider e non toccare ne' le rotte ne' i client.
 */

export interface StoredObject {
  readonly key: string;
  readonly url: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface PutObjectInput {
  readonly key: string;
  readonly data: Uint8Array;
  readonly mimeType: string;
}

export interface UploadTicket {
  readonly key: string;
  readonly url: string;
  readonly method: "PUT" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  /** ISO 8601. */
  readonly expiresAt: string;
}

export interface StorageProvider {
  readonly name: string;
  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  createUploadUrl?(input: {
    readonly key: string;
    readonly mimeType: string;
  }): Promise<UploadTicket>;
}
