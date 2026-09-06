import type { AuthConfig } from "../../apps/api/src/config/env.js";
import type { PasswordHasher } from "../../apps/api/src/services/ports/PasswordHasher.js";

/**
 * Configurazione di auth per i test unitari. TTL brevi e leggibili: 60 secondi
 * di access token e 7 giorni di refresh rendono ovvio, leggendo il test, di
 * quanto lo si sta facendo avanzare.
 */
export function testAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    accessSecret: "segreto-di-test-lungo-abbastanza-per-hs256",
    accessTokenTtlSeconds: 60,
    refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
    signupEnabled: true,
    // Il servizio di autenticazione non lo legge: il limite e' un middleware
    // HTTP, e questo campo sta in `AuthConfig` solo perche' e' li' che vive il
    // resto della configurazione delle credenziali. E' qui per il compilatore.
    rateLimit: { windowMs: 60_000, max: 10 },
    ...overrides,
  };
}

/**
 * Hasher finto e istantaneo.
 *
 * argon2id vero costa ~50 ms per operazione di proposito; moltiplicato per le
 * decine di login dei test unitari diventa una suite che nessuno lancia piu'.
 * Qui interessa la LOGICA (che si verifichi, che il ramo "utente inesistente"
 * verifichi comunque, che la password non finisca da nessuna parte in chiaro),
 * non la forza dell'hash: quella la garantisce il test di integrazione, che usa
 * l'implementazione vera.
 *
 * Il prefisso rende impossibile scambiare questo hash per uno reale se
 * finisse per errore in un database.
 */
export class FakePasswordHasher implements PasswordHasher {
  readonly dummyHash = "fake$dummy$0000000000";

  /** Quante verifiche sono state fatte: serve al test dell'oracolo temporale. */
  verifyCalls = 0;

  async hash(password: string): Promise<string> {
    return `fake$${password}$hashed`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    this.verifyCalls += 1;
    return hash === `fake$${password}$hashed`;
  }
}
