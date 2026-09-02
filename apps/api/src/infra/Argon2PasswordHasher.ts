import { hash, hashSync, verify } from "@node-rs/argon2";
import type { PasswordHasher } from "../services/ports/PasswordHasher.js";

/**
 * `Algorithm.Argon2id` di @node-rs/argon2 e' un `const enum` ambient, e con
 * `verbatimModuleSyntax` TypeScript rifiuta di leggerlo (non puo' inlinarne il
 * valore senza eliminare l'import). Il valore numerico e' parte dell'ABI
 * napi-rs e non cambia: si scrive qui, una volta, con il nome accanto.
 */
const ARGON2ID = 2;

/**
 * argon2id via `@node-rs/argon2`.
 *
 * Scelto rispetto a `argon2` perche' distribuisce binari napi precompilati:
 * niente node-gyp su Windows, niente toolchain di compilazione su Railway.
 * Se un giorno mancasse un prebuilt per una piattaforma di destinazione, il
 * ripiego e' `hash-wasm` e tocca solo questo file.
 *
 * Parametri: OWASP 2024 per argon2id — 19 MiB di memoria, 2 iterazioni,
 * parallelismo 1. Il costo dominante e' la memoria, che e' il punto: e' cio'
 * che rende sconveniente il cracking su GPU.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export class Argon2PasswordHasher implements PasswordHasher {
  readonly dummyHash: string;

  constructor(dummyHash?: string) {
    // Calcolato una volta all'avvio. La stringa di partenza non e' un segreto:
    // serve solo a produrre un hash valido contro cui bruciare lo stesso tempo
    // quando l'utente non esiste.
    this.dummyHash =
      dummyHash ?? hashSync("wikimylife::utente-inesistente", ARGON2_OPTIONS);
  }

  hash(plain: string): Promise<string> {
    return hash(plain, ARGON2_OPTIONS);
  }

  async verify(hashed: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashed, plain, ARGON2_OPTIONS);
    } catch {
      // Hash malformato o di un algoritmo diverso: e' un "no", non un 500.
      return false;
    }
  }
}
