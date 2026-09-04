/**
 * Testo denormalizzato da cui Postgres genera il `tsvector` italiano (§7).
 *
 * L'equivalente testuale di `embeddingInput()`, e per la stessa ragione: se il
 * seed, la pipeline di ingestione e la modifica manuale componessero la stringa
 * in tre modi diversi, due schede identiche sarebbero cercabili in modo diverso
 * a seconda di come sono nate.
 *
 * La differenza con `embeddingInput()` non e' un dettaglio, e' il motivo per cui
 * la ricerca e' ibrida:
 *
 *  - l'embedding vede `titolo + trigger + tag`, cioe' *di cosa parla* la scheda,
 *    e trova per somiglianza di senso anche chi non azzecca una parola;
 *  - `searchText` vede anche passi, prerequisiti e trappole, cioe' *cosa c'e'
 *    scritto dentro*, e trova la parola esatta — "marca da bollo" al terzo
 *    passo, un codice fiscale, il nome di un ufficio.
 *
 * Cercare "quella cosa dove poi serviva la marca da bollo" funziona solo se
 * esistono entrambi: il primo canale capisce "quella cosa", il secondo trova
 * "marca da bollo".
 *
 * Il `tsvector` resta una colonna generata su questa stringa e non una colonna
 * mantenuta a mano: cosi' e' impossibile che vada fuori sincrono con
 * `searchText`, e l'unico punto di verita' applicativa e' questa funzione pura.
 */

export interface SearchTextStep {
  readonly ordine?: number | undefined;
  readonly azione: string;
  readonly dettaglio?: string | null | undefined;
}

export interface SearchTextSource {
  readonly titolo: string;
  readonly trigger?: string | null | undefined;
  readonly esito?: string | null | undefined;
  readonly steps?: readonly SearchTextStep[] | undefined;
  readonly prereqs?: readonly { readonly descrizione: string }[] | undefined;
  readonly pitfalls?: readonly { readonly descrizione: string }[] | undefined;
  readonly tag?: readonly string[] | undefined;
}

/**
 * Nessun `toLowerCase()`, a differenza dei tag in `embeddingInput()`: il
 * dizionario italiano di Postgres normalizza da solo, e togliere le maiuscole
 * qui distruggerebbe l'unica informazione che permette di riconoscere i nomi
 * propri se un domani si volesse usare `searchText` anche per altro.
 */
function push(parts: string[], value: string | null | undefined): void {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length > 0) {
    parts.push(trimmed);
  }
}

export function searchText(source: SearchTextSource): string {
  const parts: string[] = [];

  push(parts, source.titolo);
  push(parts, source.trigger);
  push(parts, source.esito);

  // I passi in ordine: l'ordine non conta per il `tsvector`, che e' un insieme
  // di lessemi, ma conta per chi legge la colonna in psql mentre indaga su un
  // risultato di ricerca che non si spiega.
  const steps = [...(source.steps ?? [])].sort((a, b) => (a.ordine ?? 0) - (b.ordine ?? 0));
  for (const step of steps) {
    push(parts, step.azione);
    push(parts, step.dettaglio);
  }

  for (const prereq of source.prereqs ?? []) {
    push(parts, prereq.descrizione);
  }

  for (const pitfall of source.pitfalls ?? []) {
    push(parts, pitfall.descrizione);
  }

  const tags = (source.tag ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (tags.length > 0) {
    parts.push(tags.join(", "));
  }

  return parts.join("\n");
}
