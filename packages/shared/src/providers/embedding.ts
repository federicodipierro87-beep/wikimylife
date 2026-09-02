/**
 * Un solo provider di embedding per due usi che sembrano diversi ma non lo
 * sono: la deduplicazione della §5 (coseno > 0.85) e la ricerca semantica della
 * §7. Stesso vettore, stesso input (`titolo + trigger + tag`), stessa colonna.
 * Due modelli distinti significherebbero due colonne, due indici e due modi di
 * sbagliare.
 */

/**
 * Accoppiata alla migration: la colonna e' `vector(1536)`.
 * Cambiare questo numero senza una migration produce un errore a runtime da
 * Postgres, non un dato sbagliato — ed e' il motivo per cui esiste il test
 * unitario sulla dimensione dei fake.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/** Soglia di deduplicazione della §5. */
export const DEDUP_COSINE_THRESHOLD = 0.85;

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedMany(texts: readonly string[]): Promise<number[][]>;
}
