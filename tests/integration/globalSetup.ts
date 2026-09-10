import { runNodeBin } from "./helpers/bin.js";
import { loadTestEnv } from "./helpers/env.js";
import { BucketDiTestAssente, svuotaIlBucket, testStorage } from "./helpers/storage.js";

/**
 * Preparazione del database e del bucket di test, una volta sola per esecuzione.
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
 *
 * Il bucket si controlla qui e non nel file che lo usa. Un `list` che non
 * risponde dice «fetch failed» dentro un `beforeAll`, cioe' la stessa frase con
 * cui si annuncerebbe un errore di firma: chiedendolo prima, la differenza fra
 * «MinIO non e' acceso» e «la richiesta e' sbagliata» resta leggibile.
 */

export default async function setup(): Promise<void> {
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

  await preparaIlBucket();
}

/**
 * Il bucket dev'esserci, dev'essere raggiungibile, e dev'essere vuoto.
 *
 * Vuoto all'inizio e non solo fra un caso e l'altro: una passata interrotta con
 * Ctrl-C lascia dentro cio' che aveva scritto, e il file successivo se lo
 * troverebbe nei conteggi il giorno dopo, in un'esecuzione che non ha fatto
 * niente di male. E' lo stesso motivo per cui `resetDatabase()` gira in
 * `beforeEach` e non solo dopo.
 */
async function preparaIlBucket(): Promise<void> {
  const storage = testStorage();

  try {
    await svuotaIlBucket(storage);
  } catch (errore: unknown) {
    if (errore instanceof BucketDiTestAssente) {
      throw errore;
    }
    throw new BucketDiTestAssente(
      `Il bucket dei test non risponde: ${errore instanceof Error ? errore.message : String(errore)}`,
    );
  }
}
