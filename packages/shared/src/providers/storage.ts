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

export interface ListedObject {
  readonly key: string;
  readonly sizeBytes: number;
  /**
   * ISO 8601, e non un `Date`: e' quello che scrive S3 nel suo XML, ed e' anche
   * cio' che permette al confronto con la soglia di essere una sottrazione fra
   * numeri invece che una conversione di fuso.
   */
  readonly lastModified: string;
}

export interface ListObjectsInput {
  readonly prefix?: string | undefined;
  /**
   * Il segnalibro restituito dalla pagina precedente. Assente = si comincia.
   *
   * Dice DOPO QUALE OGGETTO riprendere, e non a quale posizione: la differenza
   * si vede solo quando qualcuno cancella mentre scorre — che e' esattamente
   * cio' per cui questo elenco esiste. Un segnalibro posizionale farebbe saltare
   * tanti oggetti mai guardati quanti ne sono stati tolti, senza dirlo.
   */
  readonly continuationToken?: string | undefined;
}

export interface ListedPage {
  readonly objects: readonly ListedObject[];
  /** Assente = era l'ultima pagina. */
  readonly continuationToken: string | undefined;
}

export interface StorageProvider {
  readonly name: string;
  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * Elenca cio' che c'e' davvero nello storage, una pagina alla volta.
   *
   * Serve a una cosa sola: sapere quali oggetti nessuna riga nomina piu'. Ogni
   * altra domanda sull'audio ha una risposta migliore nel database, che sa
   * anche a chi appartiene.
   *
   * E' paginata perche' S3 lo impone — mille chiavi per risposta e un
   * segnalibro — e nascondere la paginazione dentro il provider avrebbe voluto
   * dire tenere in memoria l'intero elenco di un bucket per restituirlo in un
   * array. Chi chiama scorre le pagine e non accumula niente.
   *
   * Non e' opzionale come `createUploadUrl`: uno storage che non sa dire cosa
   * contiene e' uno storage in cui la spazzatura non si trova, e tutti e tre i
   * provider di questo repository sanno farlo.
   */
  list(input?: ListObjectsInput): Promise<ListedPage>;
  createUploadUrl?(input: {
    readonly key: string;
    readonly mimeType: string;
  }): Promise<UploadTicket>;
}
