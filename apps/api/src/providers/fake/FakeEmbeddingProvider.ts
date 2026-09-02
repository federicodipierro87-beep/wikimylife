import {
  EMBEDDING_DIMENSIONS,
  deterministicUnitVector,
  type EmbeddingProvider,
} from "@wikimylife/shared";

/**
 * Embedding deterministici, senza rete e senza chiave API.
 *
 * Usa la stessa funzione del seed, quindi un vettore calcolato qui e uno
 * calcolato dal seed sullo stesso testo coincidono: e' cio' che rende
 * verificabile il confronto di similarita' nei test.
 *
 * La dimensione predefinita e' 1536 e non e' una comodita': combacia con la
 * colonna `vector(1536)` della migration. Il test unitario che la asserisce
 * blocca oggi un cambio di modello che domani produrrebbe un errore di Postgres
 * al primo inserimento.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly model: string;
  readonly dimensions: number;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? "fake-deterministic-v1";
    this.dimensions = options?.dimensions ?? EMBEDDING_DIMENSIONS;
  }

  embed(text: string): Promise<number[]> {
    return Promise.resolve(deterministicUnitVector(text, this.dimensions));
  }

  embedMany(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => deterministicUnitVector(t, this.dimensions)));
  }
}
