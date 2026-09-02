/**
 * Stadio 2 della pipeline. L'implementazione vive in `apps/api`; qui c'e' solo
 * il contratto, cosi' il codice di dominio non sa se dietro c'e' Whisper, lo
 * STT on-device o un fake.
 *
 * L'audio viaggia come `Uint8Array`: `Buffer` esiste solo in Node, `Blob` solo
 * nel browser. `Uint8Array` e' l'unico tipo che entrambi possiedono davvero.
 */

export interface TranscriptionInput {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  /** Da `Recording.deviceLocale`: la lingua attesa dallo STT. */
  readonly languageHint?: string | undefined;
  /**
   * Vocabolario di contesto (§3): SPID, CIE, casellario, marca da bollo, PEC,
   * F24, ASL, staff augmentation, deploy, VPN, ticket.
   */
  readonly vocabulary?: readonly string[] | undefined;
}

export interface TranscriptionResult {
  readonly text: string;
  /** Finisce in `Recording.transcriptSource`: "on-device", "whisper", "fake". */
  readonly source: string;
  readonly model?: string | undefined;
  readonly detectedLanguage?: string | undefined;
  readonly durationMs?: number | undefined;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}
