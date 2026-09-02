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
  #failNext = false;
  #calls = 0;

  enqueue(text: string): this {
    this.#queue.push(text);
    return this;
  }

  failNext(): this {
    this.#failNext = true;
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
    this.#failNext = false;
    this.#calls = 0;
    return this;
  }

  transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    this.#calls += 1;

    if (this.#failNext) {
      this.#failNext = false;
      return Promise.reject(new Error("FakeTranscriptionProvider: fallimento simulato"));
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
