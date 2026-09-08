import type { PrismaClient } from "@prisma/client";
import type {
  RateLimitHit,
  RateLimitStore,
  RateLimitWindow,
} from "../services/ports/RateLimitStore.js";

/**
 * I conteggi del limitatore su Postgres, un'istruzione per tentativo.
 *
 * ## Perche' SQL grezzo e non `prisma.rateLimitBucket.upsert`
 *
 * L'`upsert` di Prisma non sa esprimere «se la finestra e' scaduta riparti da
 * uno, altrimenti aggiungi uno»: `update` prende valori, non espressioni che
 * guardino la riga com'era. Ottenerlo con Prisma vorrebbe dire leggere, poi
 * decidere, poi scrivere — tre viaggi e una corsa in mezzo, cioe' esattamente
 * cio' che questa classe esiste per evitare. Dieci righe di SQL fanno tutto in
 * un viaggio e senza corsa.
 *
 * ## Perche' e' atomico
 *
 * `ON CONFLICT ("key") DO UPDATE` prende il lock della riga in conflitto: due
 * richieste simultanee sulla stessa chiave si mettono in fila, e la seconda
 * legge il valore che la prima ha appena scritto. E' l'unica proprieta' che
 * questa classe deve avere piu' della versione in memoria, ed e' l'unica che la
 * versione in memoria non potrebbe provare: `tests/integration` la prova con
 * venti richieste in parallelo, contando che il totale sia venti e non meno.
 *
 * Nel `DO UPDATE`, `"RateLimitBucket"."resetAt"` e' il valore vecchio della
 * riga — quello prima di questa istruzione — mentre `EXCLUDED` sarebbe quello
 * che si stava inserendo. E' la distinzione da cui dipende tutto il `CASE`, e
 * confonderle darebbe un limitatore che non scade mai.
 */
export class PrismaRateLimitStore implements RateLimitStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async hit(input: RateLimitHit): Promise<RateLimitWindow> {
    const adesso = new Date(input.at);
    const nuovaFine = new Date(input.at + input.windowMs);

    const righe = await this.#prisma.$queryRaw<{ count: number; resetAt: Date }[]>`
      INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
      VALUES (${input.key}, 1, ${nuovaFine})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "RateLimitBucket"."resetAt" <= ${adesso} THEN 1
          ELSE "RateLimitBucket"."count" + 1
        END,
        "resetAt" = CASE
          WHEN "RateLimitBucket"."resetAt" <= ${adesso} THEN ${nuovaFine}
          ELSE "RateLimitBucket"."resetAt"
        END
      RETURNING "count", "resetAt"
    `;

    const riga = righe[0];
    if (riga === undefined) {
      // Irraggiungibile: un INSERT ... ON CONFLICT DO UPDATE restituisce sempre
      // una riga, perche' entrambi i rami ne scrivono una. Lanciare invece di
      // inventare un conteggio manda la richiesta sul ramo del guasto, dove il
      // middleware sa gia' cosa fare.
      throw new Error("INSERT sul limite dei tentativi non ha restituito niente");
    }

    return { count: riga.count, resetAt: riga.resetAt.getTime() };
  }

  async purgeExpired(at: number): Promise<void> {
    await this.#prisma.rateLimitBucket.deleteMany({
      where: { resetAt: { lte: new Date(at) } },
    });
  }
}
