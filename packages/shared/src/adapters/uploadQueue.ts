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
}
