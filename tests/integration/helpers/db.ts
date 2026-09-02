import { PrismaClient } from "@prisma/client";

/**
 * Il client dei test di integrazione.
 *
 * L'URL arriva da `DATABASE_URL_TEST` e viene passato esplicitamente al
 * costruttore. Non e' un dettaglio: se il client leggesse `DATABASE_URL`
 * dall'ambiente come fa di default, i test punterebbero al database di
 * sviluppo, e la prima `resetDatabase()` lo svuoterebbe.
 */

export function testDatabaseUrl(): string {
  const url = process.env["DATABASE_URL_TEST"];
  if (url === undefined || url.trim() === "") {
    throw new Error("DATABASE_URL_TEST assente: globalSetup avrebbe dovuto fermare la suite prima.");
  }
  return url;
}

let shared: PrismaClient | null = null;

/** Un solo client per processo: i test girano in un thread solo. */
export function testPrisma(): PrismaClient {
  shared ??= new PrismaClient({
    datasources: { db: { url: testDatabaseUrl() } },
    log: ["warn", "error"],
  });
  return shared;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (shared !== null) {
    await shared.$disconnect();
    shared = null;
  }
}

/**
 * Le tabelle nell'ordine in cui si svuotano.
 *
 * L'elenco e' scritto a mano invece che dedotto da `information_schema` per un
 * motivo: `TRUNCATE ... CASCADE` su una tabella dimenticata cancellerebbe anche
 * `_prisma_migrations`, e la migration successiva ripartirebbe da zero. Qui
 * `_prisma_migrations` non compare, e non puo' comparire per sbaglio.
 *
 * L'ordine e' quello dei figli prima dei genitori. `RESTART IDENTITY CASCADE`
 * lo renderebbe superfluo, ma un ordine esplicito documenta le dipendenze e
 * fallisce rumorosamente il giorno in cui una FK cambia direzione.
 */
const TABLES = [
  "TagOnProcedure",
  "Execution",
  "Attachment",
  "Reference",
  "Cost",
  "Pitfall",
  "Prerequisite",
  "Step",
  "Recording",
  "Procedure",
  "Tag",
  "RefreshToken",
  "User",
] as const;

export async function resetDatabase(prisma: PrismaClient = testPrisma()): Promise<void> {
  const list = TABLES.map((t) => `"public"."${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
