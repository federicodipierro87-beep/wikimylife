/**
 * Carica `.env` per i test di integrazione.
 *
 * Vitest non lo fa: legge `.env` solo per `import.meta.env` di Vite, che non
 * esiste in un test Node. E l'API non aiuta, perche' `loadConfig()` chiama
 * `process.loadEnvFile()` troppo tardi — il `globalSetup` ha gia' bisogno di
 * `DATABASE_URL_TEST` per applicare le migration.
 *
 * Va importato in due punti diversi: nel `globalSetup`, che gira nel processo
 * principale, e come `setupFiles` del project, perche' i worker di Vitest sono
 * thread separati con la propria copia di `process.env`. Caricarlo in un posto
 * solo funzionerebbe finche' qualcuno non cambia `pool`.
 */

let loaded = false;

export function loadTestEnv(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  try {
    process.loadEnvFile();
  } catch {
    // Nessun .env: in CI le variabili arrivano dall'ambiente. Se manca anche
    // li', il messaggio utile lo da' il globalSetup, non questo file.
  }
}

loadTestEnv();
