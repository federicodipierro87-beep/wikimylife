import {
  Scope,
  type ExtractionContract,
  type ExtractionInput,
  type ExtractionProvider,
  type ExtractionResult,
} from "@wikimylife/shared";

/**
 * Estrazione finta.
 *
 * `enqueue` accetta `unknown` di proposito: i casi che contano in Fase 2 sono
 * quelli in cui il modello restituisce qualcosa che NON rispetta il contratto
 * (campo mancante, ordine dei passi non contiguo, importi negativi). Se questo
 * fake potesse produrre solo output validi, non servirebbe a testare la
 * validazione della §5 — che e' l'unica cosa che deve testare.
 */
export class FakeExtractionProvider implements ExtractionProvider {
  readonly name = "fake";
  readonly #queue: unknown[] = [];
  #failNext = false;
  #calls = 0;
  #lastInput: ExtractionInput | null = null;

  enqueue(raw: unknown): this {
    this.#queue.push(raw);
    return this;
  }

  failNext(): this {
    this.#failNext = true;
    return this;
  }

  get calls(): number {
    return this.#calls;
  }

  get lastInput(): ExtractionInput | null {
    return this.#lastInput;
  }

  /** Come in `FakeTranscriptionProvider`: una sola istanza per file di e2e. */
  reset(): this {
    this.#queue.length = 0;
    this.#failNext = false;
    this.#calls = 0;
    this.#lastInput = null;
    return this;
  }

  extract(input: ExtractionInput): Promise<ExtractionResult> {
    this.#calls += 1;
    this.#lastInput = input;

    if (this.#failNext) {
      this.#failNext = false;
      return Promise.reject(new Error("FakeExtractionProvider: fallimento simulato"));
    }

    const queued = this.#queue.length > 0 ? this.#queue.shift() : this.#defaultFor(input);

    return Promise.resolve({
      raw: queued,
      model: "fake-extraction-v1",
      promptVersion: "extraction.v1",
    });
  }

  #defaultFor(input: ExtractionInput): ExtractionContract {
    const firstLine = input.transcript.split("\n")[0]?.trim() ?? "";
    const titolo = firstLine.length > 0 ? firstLine.slice(0, 79) : null;

    return {
      titolo,
      trigger: null,
      esito: null,
      validitaEsito: null,
      prerequisiti: [],
      passi: [],
      trappole: [],
      costi: [],
      durataTotaleStimataMin: null,
      luogo: {
        nome: input.context.placeLabel,
        dettaglio: null,
        confermatoDaGps: input.context.placeLabel !== null,
      },
      riferimenti: [],
      tag: [],
      ambitoSuggerito: Scope.PERSONALE,
      _meta: {
        // Sotto 0.5: con `passi` vuoto la §5 impone comunque DA_RIVEDERE, e il
        // comportamento predefinito del fake deve rispecchiarlo.
        confidenzaGlobale: 0.4,
        campiIncerti: ["passi"],
        domandeSuggerite: ["Quali passi hai seguito, in ordine?"],
        contieneDatiSensibili: false,
        tipoRilevato: "NOTA_SEMPLICE",
      },
    };
  }
}
