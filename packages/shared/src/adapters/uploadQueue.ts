/**
 * Coda di upload persistente (in web: IndexedDB).
 *
 * Serve il requisito piu' importante della specifica: "l'audio si salva su
 * disco locale prima di qualsiasi chiamata di rete". L'utente che registra
 * uscendo da un ufficio senza campo deve poter chiudere l'app subito dopo lo
 * stop e ritrovare l'upload partito da solo al ritorno della connessione.
 */

export interface QueuedRecording {
  readonly id: string;
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly durationMs: number;
  /** ISO 8601, orologio del dispositivo. */
  readonly recordedAt: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly placeLabel: string | null;
  readonly deviceLocale: string | null;
  readonly capturedOffline: boolean;
  readonly attempts: number;
  readonly lastError: string | null;
}

export interface UploadQueueAdapter {
  enqueue(item: Omit<QueuedRecording, "attempts" | "lastError">): Promise<void>;
  list(): Promise<QueuedRecording[]>;
  peek(): Promise<QueuedRecording | null>;
  markFailed(id: string, error: string): Promise<void>;
  remove(id: string): Promise<void>;
  size(): Promise<number>;

  /**
   * Butta via tutto. Esiste per un caso solo: il conto cancellato.
   *
   * ## Perche' non e' `remove` in un ciclo
   *
   * Perche' chi chiama non deve dover leggere l'intera coda — audio compreso,
   * cioe' megabyte in memoria — per poterla svuotare. E perche' un ciclo di
   * `remove` e' una sequenza di transazioni: se il browser si chiude a meta',
   * meta' dei vocali di un conto che non esiste piu' restano sul telefono, e
   * non c'e' nessun secondo momento in cui qualcuno ripassi a toglierli.
   *
   * ## Perche' non lo fa il logout
   *
   * Perche' il logout e' reversibile: chi esce e rientra deve ritrovare il
   * vocale registrato in cantina e mai caricato. E' la ragione per cui questa
   * coda sopravvive apposta alla fine di una sessione, e anche il motivo per cui
   * il metodo si chiama `clear` e non `onLogout` — il gesto che lo chiama e' la
   * cancellazione del conto, e nessun altro.
   */
  clear(): Promise<void>;
}
