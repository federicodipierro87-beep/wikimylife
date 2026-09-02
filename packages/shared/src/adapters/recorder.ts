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

export interface RecorderAdapter {
  isSupported(): boolean;
  /** Chiede il permesso al microfono. `false` se negato. */
  requestPermission(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<RecordingChunk>;
  cancel(): Promise<void>;
  /** Millisecondi trascorsi dall'inizio, per il contatore in interfaccia. */
  elapsedMs(): number;
}
