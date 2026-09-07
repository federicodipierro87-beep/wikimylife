import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from "@wikimylife/shared";

/**
 * Trascrizione finta.
 *
 * Puo' essere programmata con una coda di risposte (`enqueue`) oppure fallire a
 * comando (`failNext`): serve a provare che il fallimento dello stadio 2 lascia
 * comunque il Recording riprocessabile, senza dipendere da un disservizio vero
 * di OpenAI.
 */
export class FakeTranscriptionProvider implements TranscriptionProvider {
  readonly name = "fake";
  readonly #queue: string[] = [];
  #failNext: { readonly error: unknown } | null = null;
  #calls = 0;

  enqueue(text: string): this {
    this.#queue.push(text);
    return this;
  }

  /**
   * `error` serve a scegliere *quale* guasto: un errore anonimo torna in coda,
   * un `ProviderHttpError` con 415 no. Senza parametro resta il guasto generico.
   */
  failNext(error?: unknown): this {
    this.#failNext = {
      error: error ?? new Error("FakeTranscriptionProvider: fallimento simulato"),
    };
    return this;
  }

  get calls(): number {
    return this.#calls;
  }

  /**
   * Riporta il fake allo stato iniziale.
   *
   * I test end-to-end condividono una sola istanza per file — riavviare il
   * server a ogni caso costerebbe la chiusura delle connessioni keep-alive di
   * `fetch` — quindi una coda non consumata da un caso avvelenerebbe il
   * successivo, e il fallimento comparirebbe nel test sbagliato.
   */
  reset(): this {
    this.#queue.length = 0;
    this.#failNext = null;
    this.#calls = 0;
    return this;
  }

  transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    this.#calls += 1;

    const guasto = this.#failNext;
    if (guasto !== null) {
      this.#failNext = null;
      return Promise.reject(guasto.error);
    }

    const queued = this.#queue.shift();
    const text =
      queued ??
      `Trascrizione finta di ${String(input.audio.byteLength)} byte ${input.mimeType}.`;

    return Promise.resolve({
      text,
      source: "fake",
      model: "fake-stt-v1",
      detectedLanguage: input.languageHint ?? "it-IT",
      durationMs: 0,
    });
  }
}
