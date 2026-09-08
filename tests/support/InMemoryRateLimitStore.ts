import type {
  RateLimitHit,
  RateLimitStore,
  RateLimitWindow,
} from "../../apps/api/src/services/ports/RateLimitStore.js";

/**
 * I conteggi del limitatore in una Map, per i test che girano senza Docker.
 *
 * E' un test double e non una configurazione di produzione: fino a poco fa
 * questa era l'unica implementazione, e stava dentro il middleware. Il difetto
 * per cui e' stata tolta di li' — un conteggio per processo non e' un limite —
 * qui non conta, perche' il processo e' uno e dura un test.
 *
 * L'aritmetica della finestra e' scritta due volte, qui e in SQL, e due
 * scritture della stessa regola divergono: e' il prezzo di poter provare il
 * middleware senza un database. Il prezzo si paga una volta sola facendo
 * girare a entrambe lo stesso contratto — `rateLimitStoreContract.ts` — di qua
 * in `npm test` e di la' contro Postgres vero.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();

  /** Quante finestre sono in piedi. Serve a provare che la pulizia pulisca. */
  get size(): number {
    return this.#buckets.size;
  }

  hit(input: RateLimitHit): Promise<RateLimitWindow> {
    let bucket = this.#buckets.get(input.key);
    if (bucket === undefined || bucket.resetAt <= input.at) {
      bucket = { count: 0, resetAt: input.at + input.windowMs };
      this.#buckets.set(input.key, bucket);
    }

    bucket.count += 1;
    return Promise.resolve({ count: bucket.count, resetAt: bucket.resetAt });
  }

  purgeExpired(at: number): Promise<void> {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= at) {
        this.#buckets.delete(key);
      }
    }
    return Promise.resolve();
  }
}

/**
 * Un deposito che non risponde, per il ramo in cui il database e' giu'.
 *
 * Il ramo esiste apposta e fa una cosa che sembra sbagliata — lascia passare —
 * quindi va provato, non dedotto.
 */
export class BrokenRateLimitStore implements RateLimitStore {
  readonly errore = new Error("il deposito non risponde");

  hit(): Promise<RateLimitWindow> {
    return Promise.reject(this.errore);
  }

  purgeExpired(): Promise<void> {
    return Promise.reject(this.errore);
  }
}
