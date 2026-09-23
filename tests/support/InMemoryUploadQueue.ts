import type { QueuedRecording, UploadQueueAdapter } from "@wikimylife/shared";

/**
 * La coda di upload in memoria.
 *
 * Sostituisce IndexedDB nei test dell'uploader: la logica che conta — ordine,
 * tentativi, cosa resta dopo un fallimento — non ha niente a che vedere con il
 * database del browser, ed e' l'unica parte che vale la pena provare.
 *
 * L'ordine di inserimento e' l'ordine di uscita, come in IndexedDB con chiave
 * autoincrementale: la registrazione piu' vecchia si carica per prima, perche'
 * e' quella che l'utente aspetta da piu' tempo.
 */
export class InMemoryUploadQueue implements UploadQueueAdapter {
  readonly #items: QueuedRecording[] = [];
  /** Per verificare che l'uploader non chiami la rete due volte sullo stesso. */
  readonly removed: string[] = [];

  enqueue(item: Omit<QueuedRecording, "attempts" | "lastError">): Promise<void> {
    this.#items.push({ ...item, attempts: 0, lastError: null });
    return Promise.resolve();
  }

  list(): Promise<QueuedRecording[]> {
    return Promise.resolve([...this.#items]);
  }

  peek(): Promise<QueuedRecording | null> {
    return Promise.resolve(this.#items[0] ?? null);
  }

  markFailed(id: string, error: string): Promise<void> {
    const index = this.#items.findIndex((i) => i.id === id);
    if (index >= 0) {
      const current = this.#items[index];
      if (current !== undefined) {
        this.#items[index] = {
          ...current,
          attempts: current.attempts + 1,
          lastError: error,
        };
      }
    }
    return Promise.resolve();
  }

  remove(id: string): Promise<void> {
    const index = this.#items.findIndex((i) => i.id === id);
    if (index >= 0) {
      this.#items.splice(index, 1);
      this.removed.push(id);
    }
    return Promise.resolve();
  }

  size(): Promise<number> {
    return Promise.resolve(this.#items.length);
  }

  /**
   * Svuota, e segna quante volte e' stato chiesto.
   *
   * `cleared` e' un contatore e non un booleano perche' il caso da distinguere
   * non e' «e' stato chiamato» ma «e' stato chiamato quando non doveva»: la
   * coda si svuota alla cancellazione del conto e a nient'altro, e un errore in
   * quel percorso deve lasciarla dov'e'. Con un booleano, «non chiamato» e
   * «chiamato una volta di troppo dopo essere gia' stato svuotato» si
   * assomigliano.
   *
   * Non alimenta `removed`: quello serve a provare che l'uploader non carica
   * due volte lo stesso vocale, e riempirlo da qui vorrebbe dire far sembrare
   * caricati dei vocali che sono stati buttati.
   */
  cleared = 0;

  clear(): Promise<void> {
    this.cleared += 1;
    this.#items.length = 0;
    return Promise.resolve();
  }

  /** Solo per i test: lo stato attuale senza passare per le promise. */
  snapshot(): readonly QueuedRecording[] {
    return [...this.#items];
  }
}
