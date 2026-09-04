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

/**
 * Pavimento del canale semantico della §7.
 *
 * Una query ai vicini piu' prossimi non ha un concetto di «nessun risultato»:
 * `ORDER BY <=> LIMIT 20` restituisce venti schede anche se la piu' vicina non
 * c'entra niente. Senza questo filtro, cercare «criptovalute» in un archivio di
 * pratiche burocratiche restituisce venti pratiche burocratiche, ciascuna con
 * un punteggio RRF piccolo ma non nullo — e l'utente non ha modo di sapere che
 * l'archivio non contiene la risposta.
 *
 * Non e' una soglia di pertinenza: e' il confine sotto il quale due testi non
 * hanno *niente* in comune. Sui vettori di un modello reale due testi italiani
 * qualsiasi stanno gia' sopra 0.6 (vedi `search/fusion.ts`), quindi 0.5 in
 * produzione non toglie risultati veri; toglie solo il rumore di un canale che
 * per costruzione non sa tacere. Il valore va rimisurato quando ci sara' un
 * provider vero al posto del fake, ed e' per questo che ha un nome.
 */
export const SEARCH_MIN_SIMILARITY = 0.5;

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedMany(texts: readonly string[]): Promise<number[][]>;
}
