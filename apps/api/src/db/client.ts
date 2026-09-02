import { PrismaClient } from "@prisma/client";

export interface PrismaClientOptions {
  readonly databaseUrl: string;
  readonly logQueries?: boolean | undefined;
}

/**
 * L'URL arriva come parametro e non da `process.env`: e' cosi' che i test di
 * integrazione puntano a `wikimylife_test` senza toccare l'ambiente globale.
 */
export function createPrismaClient(options: PrismaClientOptions): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: options.databaseUrl } },
    log: options.logQueries === true ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

/** Usato da `GET /health`: la piu' economica delle verifiche di raggiungibilita'. */
export async function isDatabaseReachable(prisma: PrismaClient): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
