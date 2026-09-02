/**
 * Testo da cui si calcola l'embedding di una procedura: `titolo + trigger + tag`
 * (§7).
 *
 * `trigger` entra a peso pieno perche' e' la chiave di volta della ricerca: la
 * gente non cerca il nome della procedura, cerca il momento in cui si e'
 * ritrovata ("come si faceva quella cosa del certificato per il cliente").
 *
 * Vive in shared e non nel worker perche' la stessa identica funzione serve al
 * seed, alla deduplicazione della §5 e alla ricerca della §7. Se tre punti
 * costruissero l'input in tre modi diversi, gli embedding non sarebbero
 * confrontabili fra loro e la soglia 0.85 non vorrebbe dire niente.
 */

export interface EmbeddingInputSource {
  readonly titolo: string;
  readonly trigger?: string | null | undefined;
  readonly tag?: readonly string[] | undefined;
}

export function embeddingInput(source: EmbeddingInputSource): string {
  const parts: string[] = [];

  const titolo = source.titolo.trim();
  if (titolo.length > 0) {
    parts.push(titolo);
  }

  const trigger = source.trigger?.trim() ?? "";
  if (trigger.length > 0) {
    parts.push(trigger);
  }

  const tags = (source.tag ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
    // Ordinati: l'ordine dei tag e' un dettaglio di persistenza, non deve
    // cambiare il vettore.
    .sort();
  if (tags.length > 0) {
    parts.push(tags.join(", "));
  }

  return parts.join("\n");
}
