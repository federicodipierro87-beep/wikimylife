/**
 * Capacita' di registrazione del dispositivo.
 *
 * L'interfaccia sta qui e l'implementazione in `apps/web` (MediaRecorder).
 * Domani in React Native cambia solo l'implementazione: la logica di cattura,
 * che e' logica di prodotto, e' scritta contro questo tipo e non si tocca.
 *
 * `mimeType` e' dichiarato dal recorder e viaggia fino al server, che non lo
 * deve mai dare per scontato: MediaRecorder produce webm/opus, iOS produce m4a.
 */

export interface RecordingChunk {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly durationMs: number;
}

/**
 * Un pezzo dell'audio mentre si registra, prima che la registrazione finisca.
 *
 * Esiste per una ragione sola: la registrazione intera nasce allo `stop()`, e
 * fino a li' sta in memoria. Su un telefono che blocca lo schermo la pagina
 * puo' essere sospesa e poi scaricata, e con lei se ne va tutto senza un errore.
 * Chi riceve i pezzi mentre arrivano li puo' mettere al sicuro uno per uno.
 */
export interface RecordingPiece {
  /**
   * L'ordine in cui il registratore li ha prodotti, da zero. Lo assegna lui e
   * non chi scrive: le scritture finiscono in un ordine qualsiasi, e solo
   * questo numero dice in che ordine vanno rimessi insieme.
   */
  readonly seq: number;
  readonly data: Uint8Array;
  readonly mimeType: string;
  /** Epoch in millisecondi, orologio del dispositivo. */
  readonly at: number;
}

export interface RecorderStartOptions {
  /** Chiamata per ogni pezzo, in ordine di `seq`. Non deve lanciare. */
  readonly onPezzo?: (pezzo: RecordingPiece) => void;
}

export interface RecorderAdapter {
  isSupported(): boolean;
  /** Chiede il permesso al microfono. `false` se negato. */
  requestPermission(): Promise<boolean>;
  start(options?: RecorderStartOptions): Promise<void>;
  stop(): Promise<RecordingChunk>;
  cancel(): Promise<void>;
  /** Millisecondi trascorsi dall'inizio, per il contatore in interfaccia. */
  elapsedMs(): number;
}
