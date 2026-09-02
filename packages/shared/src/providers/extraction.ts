import type { Scope } from "../enums.js";

/**
 * Stadio 3 della pipeline.
 *
 * `raw` e' `unknown` di proposito: e' l'output integrale del modello, non
 * ancora passato dallo schema Zod. Tipizzarlo come `ExtractionContract` qui
 * sarebbe una bugia — sarebbe il provider a dichiarare valido cio' che deve
 * validare la §5. Chi chiama fa il parse e decide cosa fare del fallimento.
 * Lo stesso valore integrale finisce in `Recording.rawExtraction`.
 */

/** Blocco "CONTESTO DISPONIBILE" del prompt §4.2. */
export interface ExtractionContext {
  /** ISO 8601. Nel prompt: {recordedAt}. */
  readonly recordedAt: string;
  readonly placeLabel: string | null;
  readonly existingScopes: readonly Scope[];
  readonly existingTags: readonly string[];
}

export interface ExtractionInput {
  readonly transcript: string;
  readonly context: ExtractionContext;
}

export interface ExtractionResult {
  /** Output integrale del modello, non validato. */
  readonly raw: unknown;
  /** Finisce in `Recording.extractionModel`. */
  readonly model: string;
  /** Versione del prompt usato, es. "extraction.v1". */
  readonly promptVersion: string;
}

export interface ExtractionProvider {
  readonly name: string;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}
