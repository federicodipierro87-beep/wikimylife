import { runNodeBin } from "./helpers/bin.js";
import { loadTestEnv } from "./helpers/env.js";

/**
 * Preparazione del database di test, una volta sola per esecuzione della suite.
 *
 * Tre scelte che vale la pena spiegare.
 *
 * `DATABASE_URL_TEST` e' obbligatoria e non ha default. Un default che punta a
 * `wikimylife` farebbe cancellare il database di sviluppo a chi dimentica di
 * configurarla: i test fanno TRUNCATE, e un TRUNCATE non chiede conferma.
 * Meglio un errore all'avvio con scritto cosa fare.
 *
 * `migrate deploy` e non `migrate dev`: applica le migration esistenti senza
 * mai generarne di nuove e senza shadow database. E' anche l'unico modo di
 * verificare che le migration versionate — quelle che gireranno in produzione —
 * bastino da sole a costruire lo schema. Se l'indice HNSW esistesse solo perche'
 * qualcuno l'ha creato a mano in sviluppo, `schema.test.ts` diventerebbe rosso
 * qui, che e' esattamente il punto.
 */

export default function setup(): void {
  loadTestEnv();
  const databaseUrl = process.env["DATABASE_URL_TEST"];

  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    throw new Error(
      [
        "DATABASE_URL_TEST non e' configurata.",
        "",
        "  1. Copy-Item .env.example .env",
        "  2. docker compose up -d",
        "  3. npm run test:integration",
        "",
        "Non c'e' un valore di default di proposito: i test fanno TRUNCATE, e un",
        "default che punta al database di sviluppo lo svuoterebbe in silenzio.",
      ].join("\n"),
    );
  }

  if (databaseUrl === process.env["DATABASE_URL"]) {
    throw new Error(
      "DATABASE_URL_TEST e DATABASE_URL puntano allo stesso database: i test lo svuoterebbero.",
    );
  }

  // Prisma legge DATABASE_URL, non DATABASE_URL_TEST: la sostituzione vive solo
  // in questo processo figlio, l'ambiente del test runner non cambia.
  runNodeBin("prisma", "prisma", ["migrate", "deploy"], {
    ...process.env,
    DATABASE_URL: databaseUrl,
  });
}
