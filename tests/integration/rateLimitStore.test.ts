import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaRateLimitStore } from "../../apps/api/src/infra/PrismaRateLimitStore.js";
import { contrattoRateLimitStore } from "../support/rateLimitStoreContract.js";
import { disconnectTestPrisma, testPrisma } from "./helpers/db.js";

/**
 * Il deposito del limitatore contro Postgres vero.
 *
 * Meta' di questo file non e' scritta qui: `contrattoRateLimitStore` e' lo
 * stesso identico elenco di regole che `tests/unit/rateLimit.test.ts` fa girare
 * contro la versione in memoria. E' l'unico modo di sapere che le due
 * implementazioni della finestra — una in TypeScript, una dentro un `CASE` in
 * SQL — dicano la stessa cosa: senza, la seconda potrebbe smettere di scadere e
 * `npm test` resterebbe verde.
 *
 * L'altra meta' e' quello che la Map non puo' provare, ed e' anche l'intera
 * ragione per cui questa tabella esiste: due richieste simultanee sulla stessa
 * chiave devono contare due, non una. In memoria e' garantito da come funziona
 * JavaScript — fra la lettura e la scrittura non c'e' `await` — e provarlo
 * sarebbe provare Node. Su un database e' garantito soltanto se l'istruzione e'
 * quella giusta, e l'istruzione sbagliata perde tentativi esattamente quando ne
 * arrivano tanti insieme: sotto attacco, cioe' nell'unico momento in cui il
 * limitatore serve a qualcosa.
 *
 * Le righe non si cancellano fra un caso e l'altro: ogni caso usa chiavi che
 * contengono un UUID, e `resetDatabase()` — che qui non serve — le porterebbe
 * via comunque insieme al resto.
 */

const MINUTO = 60_000;

afterAll(async () => {
  await disconnectTestPrisma();
});

contrattoRateLimitStore("su Postgres", () => new PrismaRateLimitStore(testPrisma()));

describe("il deposito su Postgres: cio' che una Map non puo' provare", () => {
  let store: PrismaRateLimitStore;

  beforeAll(() => {
    store = new PrismaRateLimitStore(testPrisma());
  });

  it("venti tentativi simultanei sulla stessa chiave contano venti", async () => {
    // Il test che giustifica `INSERT ... ON CONFLICT DO UPDATE` invece di
    // leggi-decidi-scrivi. Con tre viaggi separati, venti richieste in
    // parallelo leggerebbero quasi tutte lo stesso conteggio e il totale
    // finirebbe molto sotto venti — un limitatore che si lascia scavalcare
    // proprio da chi manda richieste in parallelo.
    const key = `parallelo ${crypto.randomUUID()}`;

    const esiti = await Promise.all(
      Array.from({ length: 20 }, () => store.hit({ key, windowMs: MINUTO, at: 1_000 })),
    );

    // Il totale e' esatto: nessun tentativo perso.
    expect(Math.max(...esiti.map((e) => e.count))).toBe(20);
    // E nessuno contato due volte: i venti conteggi sono i numeri da 1 a 20,
    // in un ordine qualsiasi.
    expect([...esiti.map((e) => e.count)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it("due depositi sullo stesso database sono lo stesso deposito", async () => {
    // La proprieta' per cui e' stato fatto tutto: due repliche dell'API sono
    // due processi, due `PrismaRateLimitStore`, un solo conteggio. Due istanze
    // sullo stesso database sono la versione piu' vicina a due repliche che si
    // possa mettere in un test.
    const replicaA = new PrismaRateLimitStore(testPrisma());
    const replicaB = new PrismaRateLimitStore(testPrisma());
    const key = `repliche ${crypto.randomUUID()}`;

    await replicaA.hit({ key, windowMs: MINUTO, at: 1_000 });
    await replicaB.hit({ key, windowMs: MINUTO, at: 1_000 });
    const terza = await replicaA.hit({ key, windowMs: MINUTO, at: 1_000 });

    expect(terza.count).toBe(3);
  });

  it("la finestra sopravvive al giro nel database senza perdere millisecondi", async () => {
    // `resetAt` va in una colonna TIMESTAMP(3) e torna indietro come Date. Se
    // il database arrotondasse al secondo, `RateLimit-Reset` sballerebbe di un
    // secondo intero e `Retry-After` con lui.
    const key = `precisione ${crypto.randomUUID()}`;
    const at = 1_700_000_000_123;
    const esito = await store.hit({ key, windowMs: MINUTO, at });
    expect(esito.resetAt).toBe(at + MINUTO);
  });

  it("la pulizia lascia in piedi le finestre di chiavi diverse ancora aperte", async () => {
    // La DELETE gira su tutta la tabella, non su una chiave: se il verso del
    // confronto fosse sbagliato, la richiesta numero cinquecento di chiunque
    // azzererebbe il conteggio di tutti gli altri.
    const vecchia = `vecchia ${crypto.randomUUID()}`;
    const nuova = `nuova ${crypto.randomUUID()}`;

    await store.hit({ key: vecchia, windowMs: MINUTO, at: 1_000 });
    await store.hit({ key: nuova, windowMs: MINUTO, at: 1_000 + MINUTO });

    await store.purgeExpired(1_000 + MINUTO);

    expect((await store.hit({ key: vecchia, windowMs: MINUTO, at: 1_000 + MINUTO })).count).toBe(1);
    expect((await store.hit({ key: nuova, windowMs: MINUTO, at: 1_000 + MINUTO })).count).toBe(2);
  });
});
