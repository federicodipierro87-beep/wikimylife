/**
 * Configurazione del seed.
 *
 * Questo e' il SECONDO e ultimo punto del repository autorizzato a leggere
 * `process.env` — l'altro e' `apps/api/src/config/env.ts`. La guardia in
 * `tests/unit/guards.test.ts` fa fallire la suite se ne compare un terzo.
 *
 * Il seed non passa da `loadConfig()` dell'API perche' non ha bisogno del
 * segreto JWT ne' della configurazione dei provider: chiedergli quelle
 * variabili significherebbe non poter popolare il database senza prima aver
 * configurato l'autenticazione.
 */

try {
  process.loadEnvFile();
} catch {
  // Nessun .env: le variabili arrivano gia' dall'ambiente (CI, container).
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Variabile d'ambiente ${name} assente. Copia .env.example in .env prima di eseguire il seed.`,
    );
  }
  return value;
}

export interface SeedConfig {
  readonly databaseUrl: string;
  readonly userEmail: string;
  readonly userPassword: string;
}

export function loadSeedConfig(): SeedConfig {
  return {
    databaseUrl: required("DATABASE_URL"),
    // Default di sviluppo: il seed deve funzionare subito dopo un `git clone`.
    // In produzione il seed non gira, quindi non c'e' un default pericoloso da
    // dimenticare acceso.
    userEmail: process.env["SEED_USER_EMAIL"] ?? "demo@wikimylife.local",
    userPassword: process.env["SEED_USER_PASSWORD"] ?? "wikimylife-demo-2026",
  };
}

/**
 * Identificativi fissi.
 *
 * Sono la ragione per cui il seed e' idempotente: senza id stabili, ogni
 * esecuzione creerebbe un duplicato e `upsert` non avrebbe una chiave su cui
 * lavorare. Sono leggibili di proposito — in psql si riconosce a colpo d'occhio
 * cosa e' dato di prova e cosa no.
 */
export const SEED_IDS = {
  user: "seed-user",
  procedureA: "seed-proc-casellario",
  procedureB: "seed-proc-vpn",
  recordingA: "seed-rec-casellario",
  recordingOrphan: "seed-rec-orphan",
} as const;
