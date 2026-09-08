import { defineConfig } from "vitest/config";

/**
 * Tre project, e la linea che conta e' una sola: quali girano senza Docker.
 *
 *   unit         nessun database, nessuna rete, ambiente node.
 *   web          le schermate React, ambiente jsdom. Niente Docker nemmeno qui.
 *   integration  Postgres vero con pgvector. `npm run test:integration`.
 *
 * `npm test` esegue i primi due insieme, perche' la promessa che conta e'
 * «clona ed esegui», non «esegui i test di questo strato». `web` e' un project
 * separato e non un file dentro `unit` per una ragione tecnica e non
 * organizzativa: l'ambiente e' una proprieta' del project, e `jsdom` costa
 * qualche decimo di secondo a file. Farlo pagare anche ai test che non toccano
 * il DOM sarebbe stato un rallentamento silenzioso su tutta la suite.
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
        // I sorgenti sono `.tsx` e li compila esbuild, che dentro Vitest c'e'
        // gia': non serve `@vitejs/plugin-react`. Quel plugin porta Babel e il
        // fast refresh, che in un test non ha niente da aggiornare.
        esbuild: { jsx: "automatic" },
        test: {
          name: "web",
          include: ["tests/web/**/*.test.tsx"],
          environment: "jsdom",
          // Smonta cio' che il caso ha montato. Senza, un componente che fa
          // polling continua a chiamare il finto del caso precedente, e il
          // fallimento arriva in un test che non c'entra.
          setupFiles: ["tests/web/helpers/setup.ts"],
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
