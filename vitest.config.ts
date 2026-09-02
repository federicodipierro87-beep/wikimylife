import { defineConfig } from "vitest/config";

/**
 * Due project, con una differenza che conta: il primo gira senza Docker.
 *
 *   unit         nessun database, nessuna rete. `npm test`.
 *   integration  Postgres vero con pgvector. `npm run test:integration`.
 *
 * Separati e non filtrati per nome file perche' la promessa deve essere
 * verificabile: se `npm test` avesse bisogno di un container, il primo
 * contributo di chiunque comincerebbe con mezz'ora di setup.
 *
 * `singleThread` sull'integrazione: i test condividono un database e fanno
 * TRUNCATE fra loro. In parallelo si cancellerebbero i dati a vicenda. Il
 * parallelismo vero si otterrebbe con uno schema per worker; e' un costo che si
 * paga quando la suite sara' lenta, non prima.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/integration/globalSetup.ts"],
          // Vitest non carica `.env` da solo, e i worker sono thread con la
          // propria copia di process.env: serve in entrambi i posti.
          setupFiles: ["tests/integration/helpers/env.ts"],
          pool: "threads",
          poolOptions: { threads: { singleThread: true } },
          // argon2 e le migration non sono veloci: il default di 5s non basta.
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
