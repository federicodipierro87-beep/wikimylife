import type {
  RedactionFinding,
  RedactionInput,
  RedactionProvider,
  RedactionSuggestions,
} from "@wikimylife/shared";

/**
 * Redazione assistita finta.
 *
 * A differenza di `FakeExtractionProvider`, `enqueue` accetta qui delle
 * `RedactionFinding` tipate e non `unknown`. Non e' una svista: li' i casi
 * interessanti sono quelli in cui il modello viola il contratto, perche' la §5
 * esiste apposta per deciderne la sorte; qui una risposta malformata muore
 * dentro `AnthropicRedactionProvider`, che la valida prima di restituirla, e
 * non arriva mai al servizio. Cio' che al servizio conviene testare e' l'altro
 * genere di errore — quello di un modello che risponde benissimo e dice cose
 * non vere: un valore che nella scheda non c'e', un campo che non esiste, lo
 * stesso tratto gia' trovato da un rilevatore deterministico. Sono tutte
 * `RedactionFinding` valide.
 *
 * Il comportamento predefinito e' l'elenco vuoto, e non per pigrizia: e' l'esito
 * piu' frequente anche in produzione, ed e' quello che deve restare invisibile
 * in tutti i test che della redazione assistita non si occupano.
 */
export class FakeRedactionProvider implements RedactionProvider {
  readonly name = "fake";
  readonly #queue: (readonly RedactionFinding[])[] = [];
  #failNext: { readonly error: unknown } | null = null;
  #calls = 0;
  #lastInput: RedactionInput | null = null;

  enqueue(findings: readonly RedactionFinding[]): this {
    this.#queue.push(findings);
    return this;
  }

  /** Come in `FakeExtractionProvider`: `error` sceglie quale guasto simulare. */
  failNext(error?: unknown): this {
    this.#failNext = { error: error ?? new Error("FakeRedactionProvider: fallimento simulato") };
    return this;
  }

  get calls(): number {
    return this.#calls;
  }

  get lastInput(): RedactionInput | null {
    return this.#lastInput;
  }

  /** Come in `FakeExtractionProvider`: una sola istanza per file di e2e. */
  reset(): this {
    this.#queue.length = 0;
    this.#failNext = null;
    this.#calls = 0;
    this.#lastInput = null;
    return this;
  }

  suggest(input: RedactionInput): Promise<RedactionSuggestions> {
    this.#calls += 1;
    this.#lastInput = input;

    const guasto = this.#failNext;
    if (guasto !== null) {
      this.#failNext = null;
      return Promise.reject(guasto.error);
    }

    return Promise.resolve({
      findings: this.#queue.shift() ?? [],
      model: "fake-redaction-v1",
      promptVersion: "redaction.v1",
    });
  }
}
