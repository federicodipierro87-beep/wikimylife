import type { AssistedKind } from "../redaction/assisted.js";

/**
 * Chi sa leggere una scheda e dire quali parole sono di qualcuno (§9).
 *
 * L'unico provider del progetto che possa non esserci. Trascrizione, estrazione
 * ed embedding stanno su un percorso che senza di loro non porta da nessuna
 * parte; questo sta accanto a una passata deterministica che funziona da sola.
 * Se manca, la redazione perde i nomi e tiene i codici fiscali — e' meno di
 * quanto si vorrebbe, ma e' esattamente cio' che c'era prima che questo port
 * esistesse, e non e' un guasto.
 */

export interface RedactionField {
  /** Il percorso nel documento: `titolo`, `steps.2.azione`. */
  readonly campo: string;
  readonly testo: string;
}

export interface RedactionInput {
  readonly campi: readonly RedactionField[];
}

/**
 * Un dato che il modello dice di aver visto.
 *
 * Non contiene offset, e la mancanza e' voluta: contare i caratteri e' proprio
 * cio' che un modello linguistico non sa fare, e un indice sbagliato di due
 * posizioni cancellerebbe due lettere di troppo dopo che l'utente ha confermato
 * guardando il testo giusto. Il valore invece e' verificabile — o quella
 * stringa nel campo c'e', e allora la posizione la trova il server cercandola,
 * o non c'e', e allora la proposta si butta.
 */
export interface RedactionFinding {
  readonly campo: string;
  readonly valore: string;
  readonly kind: AssistedKind;
}

export interface RedactionSuggestions {
  readonly findings: readonly RedactionFinding[];
  readonly model: string;
  readonly promptVersion: string;
}

export interface RedactionProvider {
  readonly name: string;
  suggest(input: RedactionInput): Promise<RedactionSuggestions>;
}
