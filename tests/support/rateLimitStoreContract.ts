import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RateLimitStore } from "../../apps/api/src/services/ports/RateLimitStore.js";

/**
 * Le regole che ogni deposito del limitatore deve rispettare, chiunque sia.
 *
 * Esiste perche' l'aritmetica della finestra e' scritta due volte: una in
 * TypeScript per i test che girano senza Docker, e una in SQL per la
 * produzione. Due scritture della stessa regola divergono, e questa
 * divergerebbe in silenzio — il limitatore continuerebbe a rispondere 429 a
 * qualcuno, e nessun test si accorgerebbe che la finestra non si riapre piu' o
 * che si riapre troppo presto.
 *
 * Percio' le regole stanno scritte una volta sola, qui, e girano contro
 * entrambe: `tests/unit/rateLimit.test.ts` le passa la Map,
 * `tests/integration/rateLimitStore.test.ts` le passa Postgres. Le proprieta'
 * che solo Postgres puo' avere — l'atomicita' fra due richieste simultanee —
 * stanno invece nel file di integrazione, perche' chiedere alla Map di
 * dimostrarle sarebbe chiederle di mentire.
 *
 * Le chiavi le genera questa funzione, con un UUID per ogni caso: contro un
 * database vero i casi condividono la tabella, e una chiave fissa farebbe
 * dipendere il secondo test dal primo — cioe' il tipo di guasto che si presenta
 * come «passa da solo, fallisce nella suite».
 */

const MINUTO = 60_000;

export function contrattoRateLimitStore(
  nome: string,
  crea: () => RateLimitStore | Promise<RateLimitStore>,
): void {
  describe(`${nome}: il contratto del deposito`, () => {
    const chiave = (): string => `contratto ${randomUUID()}`;

    it("il primo tentativo di una chiave e' il numero uno", async () => {
      const store = await crea();
      const esito = await store.hit({ key: chiave(), windowMs: MINUTO, at: 1_000 });
      expect(esito.count).toBe(1);
      expect(esito.resetAt).toBe(1_000 + MINUTO);
    });

    it("i tentativi successivi salgono di uno", async () => {
      const store = await crea();
      const key = chiave();
      const conteggi: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        conteggi.push((await store.hit({ key, windowMs: MINUTO, at: 1_000 + i })).count);
      }
      expect(conteggi).toEqual([1, 2, 3, 4]);
    });

    it("la fine della finestra non si sposta a ogni tentativo", async () => {
      // Se si spostasse sarebbe un token bucket scritto male: chi bussa senza
      // sosta rimanderebbe in avanti la propria riapertura per sempre, e il
      // limite diventerebbe un blocco definitivo.
      const store = await crea();
      const key = chiave();
      const primo = await store.hit({ key, windowMs: MINUTO, at: 1_000 });
      const dopo = await store.hit({ key, windowMs: MINUTO, at: 30_000 });
      expect(dopo.resetAt).toBe(primo.resetAt);
    });

    it("scaduta la finestra si riparte da uno, con una finestra nuova", async () => {
      const store = await crea();
      const key = chiave();
      await store.hit({ key, windowMs: MINUTO, at: 1_000 });
      await store.hit({ key, windowMs: MINUTO, at: 2_000 });

      const dopo = await store.hit({ key, windowMs: MINUTO, at: 1_000 + MINUTO });
      expect(dopo.count).toBe(1);
      expect(dopo.resetAt).toBe(1_000 + MINUTO + MINUTO);
    });

    it("un millisecondo prima della scadenza la finestra e' ancora quella", async () => {
      // Il confine e' `<=`: alle 1_000 + MINUTO la finestra e' chiusa, un
      // millisecondo prima no. Provarlo da entrambi i lati e' l'unico modo di
      // accorgersi che una delle due implementazioni ha messo il segno di
      // traverso.
      const store = await crea();
      const key = chiave();
      await store.hit({ key, windowMs: MINUTO, at: 1_000 });
      const dopo = await store.hit({ key, windowMs: MINUTO, at: 1_000 + MINUTO - 1 });
      expect(dopo.count).toBe(2);
    });

    it("due chiavi sono due conteggi", async () => {
      const store = await crea();
      const a = chiave();
      const b = chiave();
      await store.hit({ key: a, windowMs: MINUTO, at: 1_000 });
      await store.hit({ key: a, windowMs: MINUTO, at: 1_000 });
      const soloUno = await store.hit({ key: b, windowMs: MINUTO, at: 1_000 });
      expect(soloUno.count).toBe(1);
    });

    it("la pulizia toglie le finestre chiuse", async () => {
      const store = await crea();
      const key = chiave();
      await store.hit({ key, windowMs: MINUTO, at: 1_000 });

      await store.purgeExpired(1_000 + MINUTO);

      // Ripartire da uno e' l'unica prova osservabile che la riga sia sparita:
      // il deposito non sa dire cosa contiene, e non deve.
      const dopo = await store.hit({ key, windowMs: MINUTO, at: 1_000 + MINUTO });
      expect(dopo.count).toBe(1);
    });

    it("la pulizia non tocca le finestre ancora aperte", async () => {
      // La regola che rende la pulizia innocua: se sbagliasse verso, il modo di
      // azzerare il proprio conteggio sarebbe aspettare la richiesta numero
      // cinquecento di qualcun altro.
      const store = await crea();
      const key = chiave();
      await store.hit({ key, windowMs: MINUTO, at: 1_000 });

      await store.purgeExpired(30_000);

      const dopo = await store.hit({ key, windowMs: MINUTO, at: 31_000 });
      expect(dopo.count).toBe(2);
    });
  });
}
