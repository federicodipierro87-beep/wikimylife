import type { SecureStorageAdapter } from "@wikimylife/shared";

/**
 * `SecureStorageAdapter` su `localStorage`.
 *
 * L'interfaccia sta in `packages/shared`, l'implementazione qui: e' la regola
 * che tiene shared importabile da React Native, dove al posto di localStorage
 * ci sara' il keychain e cambiera' solo questo file.
 *
 * "Secure" e' una promessa dell'interfaccia, non di questa implementazione:
 * localStorage e' leggibile da qualsiasi script della stessa origine. E' il
 * motivo per cui l'access token vive in memoria e solo il refresh token, che e'
 * revocabile e a rotazione singola, finisce qui.
 *
 * Ogni accesso e' protetto: in navigazione privata su Safari `localStorage`
 * esiste ma lancia in scrittura, e una sessione che non si puo' salvare deve
 * degradare a "resti collegato finche' non ricarichi", non a schermata bianca.
 */
export class WebSecureStorageAdapter implements SecureStorageAdapter {
  readonly #fallback = new Map<string, string>();
  readonly #prefix: string;

  constructor(prefix = "") {
    this.#prefix = prefix;
  }

  #key(key: string): string {
    return `${this.#prefix}${key}`;
  }

  get(key: string): Promise<string | null> {
    const k = this.#key(key);
    try {
      return Promise.resolve(window.localStorage.getItem(k));
    } catch {
      return Promise.resolve(this.#fallback.get(k) ?? null);
    }
  }

  set(key: string, value: string): Promise<void> {
    const k = this.#key(key);
    try {
      window.localStorage.setItem(k, value);
    } catch {
      this.#fallback.set(k, value);
    }
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    const k = this.#key(key);
    try {
      window.localStorage.removeItem(k);
    } catch {
      // niente da fare
    }
    this.#fallback.delete(k);
    return Promise.resolve();
  }
}
