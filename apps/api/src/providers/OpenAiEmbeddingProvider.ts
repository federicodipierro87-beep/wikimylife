import type { EmbeddingProvider } from "@wikimylife/shared";
import { z } from "zod";
import { EMBEDDING_TIMEOUT_MS, postForJson } from "./http.js";

/**
 * Embedding per la deduplicazione (§5) e la ricerca semantica (§7).
 *
 * `dimensions` si manda esplicitamente anche quando coincide con il default del
 * modello. Non e' ridondanza: la colonna e' `vector(1536)`, e se un domani il
 * default di OpenAI cambiasse, l'assenza del parametro produrrebbe vettori di
 * lunghezza diversa che Postgres rifiuterebbe al primo INSERT — cioe' in
 * produzione, non qui. Con il parametro esplicito, un modello che non sa
 * accorciare fallisce subito e per la ragione giusta.
 */

const responseSchema = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
});

const ENDPOINT = "https://api.openai.com/v1/embeddings";

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly model: string;
  readonly dimensions: number;
  readonly #apiKey: string;

  constructor(options: { apiKey: string; model: string; dimensions: number }) {
    this.#apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const [first] = await this.embedMany([text]);
    if (first === undefined) {
      throw new Error("Risposta di embedding vuota");
    }
    return first;
  }

  async embedMany(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const payload = await postForJson({
      provider: this.name,
      url: ENDPOINT,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: [...texts],
        dimensions: this.dimensions,
      }),
      timeoutMs: EMBEDDING_TIMEOUT_MS,
    });

    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Risposta di embedding non interpretabile");
    }

    // L'ordine non e' garantito dal contratto dell'endpoint, `index` si':
    // affidarsi alla posizione nell'array significherebbe, nel caso peggiore,
    // associare a una procedura il vettore di un'altra.
    const byIndex = new Map(parsed.data.data.map((item) => [item.index, item.embedding]));

    return texts.map((_, index) => {
      const vector = byIndex.get(index);
      if (vector === undefined) {
        throw new Error(`Embedding mancante per l'elemento ${String(index)}`);
      }
      if (vector.length !== this.dimensions) {
        throw new Error(
          `Embedding di ${String(vector.length)} dimensioni, attese ${String(this.dimensions)}`,
        );
      }
      return vector;
    });
  }
}
