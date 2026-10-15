/**
 * Le bozze: i pezzi di una registrazione ancora in corso, messi al sicuro uno
 * alla volta (in web: IndexedDB).
 *
 * Non e' la coda di upload. La coda tiene registrazioni finite, con i loro
 * metadati, pronte a partire; qui stanno pezzi di un secondo di qualcosa che
 * non e' ancora finito, e che forse non finira' mai — perche' il telefono ha
 * bloccato lo schermo, il sistema ha scaricato la pagina, e lo `stop()` non
 * arrivera'. Una bozza diventa una registrazione in due modi soli: lo `stop()`
 * che la sostituisce con quella intera, o il recupero al prossimo avvio.
 */

export interface DraftPiece {
  readonly draftId: string;
  readonly seq: number;
  readonly data: Uint8Array;
  readonly mimeType: string;
  /** Epoch in millisecondi del pezzo. */
  readonly at: number;
  /** Epoch in millisecondi dell'inizio della registrazione. */
  readonly startedAt: number;
}

export interface RecordingDraft {
  readonly id: string;
  readonly mimeType: string;
  readonly startedAt: number;
  /** Epoch in millisecondi dell'ultimo pezzo arrivato: l'ultimo segno di vita. */
  readonly lastPieceAt: number;
  /** In ordine di `seq`. */
  readonly pieces: readonly Uint8Array[];
}

export interface RecordingDraftAdapter {
  append(piece: DraftPiece): Promise<void>;
  /** Tutte le bozze, con i pezzi gia' in ordine. */
  list(): Promise<readonly RecordingDraft[]>;
  discard(id: string): Promise<void>;
  /** Un chiamante solo, come per la coda: il conto cancellato. */
  clear(): Promise<void>;
}
