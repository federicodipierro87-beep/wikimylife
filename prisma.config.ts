import { defineConfig } from "prisma/config";

/**
 * Configurazione della CLI di Prisma.
 *
 * Sostituisce il blocco `package.json#prisma`, deprecato e in uscita con
 * Prisma 7.
 *
 * Con un file di configurazione Prisma NON carica piu' `.env` da solo: lo
 * facciamo qui con `process.loadEnvFile()` (Node >= 20.12), che e' anche il
 * motivo per cui `dotenv` non e' fra le dipendenze. Il `.env` puo' mancare —
 * su Railway le variabili arrivano dall'ambiente — quindi l'assenza non e' un
 * errore.
 */
try {
  process.loadEnvFile();
} catch {
  // Nessun .env: le variabili arrivano gia' dall'ambiente.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});
