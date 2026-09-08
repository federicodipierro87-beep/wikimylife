import { describe, expect, it } from "vitest";
import {
  toccaCancellare,
  toccaSpazzare,
  type StatoScopa,
  type SweepMode,
} from "../../apps/worker/src/sweepSchedule.js";

/**
 * Le due decisioni periodiche del sistema che, se sbagliate, cancellano file.
 *
 * Un giro di polling in piu' non si vede; una passata della scopa che parte
 * quando non doveva non da' nessun errore e toglie roba da un bucket. Quindi
 * qui si prova soprattutto quando NON deve partire, e — da quando il default e'
 * `elenca` e la passata parte quasi sempre — soprattutto quando non deve
 * cancellare, che e' il caso normale.
 */

const ORE = 60 * 60 * 1000;
const ADESSO = Date.parse("2026-03-10T12:00:00.000Z");

function stato(overrides: Partial<StatoScopa> = {}): StatoScopa {
  return {
    mode: "cancella",
    adesso: ADESSO,
    nonPrimaDi: ADESSO - 1,
    codaVuota: true,
    ...overrides,
  };
}

describe("toccaSpazzare", () => {
  it("con tutte e tre le condizioni soddisfatte, passa", () => {
    expect(toccaSpazzare(stato())).toBe(true);
  });

  it("spenta non passa mai, nemmeno se sarebbe l'ora", () => {
    // Non e' piu' il default, ma e' la risposta che qualcuno ha scritto a mano
    // nel pannello: chi ha spento la scopa non deve vedersela passare lo
    // stesso perche' e' in ritardo di quattro giorni.
    expect(toccaSpazzare(stato({ mode: "spento", nonPrimaDi: ADESSO - 100 * ORE }))).toBe(false);
  });

  it("elenca passa come cancella: la differenza non e' qui", () => {
    // Sono la stessa passata, e costano lo stesso in tempo e in richieste. A
    // decidere se toccare qualcosa e' il servizio, non il calendario. Da quando
    // `elenca` e' il default, questo `true` e' anche cio' che fa la scopa un
    // processo che gira davvero invece di una variabile che nessuno imposta.
    expect(toccaSpazzare(stato({ mode: "elenca" }))).toBe(true);
  });

  it("non passa se c'e' ancora della coda da smaltire", () => {
    // Chi ha appena caricato un vocale non deve aspettare che il worker finisca
    // di pulire la spazzatura di ieri.
    expect(toccaSpazzare(stato({ codaVuota: false }))).toBe(false);
    // E nemmeno se e' in ritardo di giorni: la coda vince comunque.
    expect(
      toccaSpazzare(stato({ codaVuota: false, nonPrimaDi: ADESSO - 100 * ORE })),
    ).toBe(false);
  });

  it("non passa prima del tempo", () => {
    expect(toccaSpazzare(stato({ nonPrimaDi: ADESSO + 1 }))).toBe(false);
    expect(toccaSpazzare(stato({ nonPrimaDi: ADESSO + 24 * ORE }))).toBe(false);
  });

  it("all'istante esatto passa, invece di aspettare il giro dopo", () => {
    expect(toccaSpazzare(stato({ nonPrimaDi: ADESSO }))).toBe(true);
  });

  it("le tre condizioni sono cumulative", () => {
    // Nessuna delle tre da sola basta a far passare la scopa.
    const soloAccesa: SweepMode = "cancella";
    expect(
      toccaSpazzare({
        mode: soloAccesa,
        adesso: ADESSO,
        nonPrimaDi: ADESSO + ORE,
        codaVuota: false,
      }),
    ).toBe(false);
    expect(
      toccaSpazzare({ mode: "spento", adesso: ADESSO, nonPrimaDi: ADESSO - ORE, codaVuota: true }),
    ).toBe(false);
  });
});

/**
 * Il confronto che vale un bucket.
 *
 * Da quando `SWEEP_MODE` parte da `elenca`, la passata avviene in ogni
 * installazione senza che nessuno l'abbia chiesta, e l'unica cosa che la tiene
 * innocua e' il booleano che questa funzione restituisce. Non c'e' un test
 * d'integrazione che copra il worker — il suo entry point finisce con un
 * `await main()` — quindi se questa riga si rovescia, niente in tutta la suite
 * se ne accorge tranne quello che c'e' scritto qui sotto.
 */
describe("toccaCancellare", () => {
  it("solo «cancella» cancella", () => {
    expect(toccaCancellare("cancella")).toBe(true);
  });

  it("«elenca» — cioe' il default — guarda e non tocca", () => {
    // Il caso che rende accettabile aver acceso la scopa per tutti: un
    // deploy che non nomina `SWEEP_MODE` fa la passata intera, scrive nel
    // registro ogni orfano che avrebbe tolto, e non chiama `delete` nemmeno
    // una volta. Se questa riga diventasse `true`, la prima installazione col
    // `DATABASE_URL` di un altro ambiente perderebbe il bucket.
    expect(toccaCancellare("elenca")).toBe(false);
  });

  it("spento non cancella, per quanto ovvio sia", () => {
    // Con `spento` non ci si arriva nemmeno, perche' `toccaSpazzare` ha gia'
    // detto di no. Ma «non ci si arriva» e' una proprieta' dell'altro file, e
    // le due funzioni devono poter essere lette una senza l'altra.
    expect(toccaCancellare("spento")).toBe(false);
  });

  it("dei tre modi, cancella e' l'unico che cancella", () => {
    // Le stesse tre risposte dette in una riga sola, cosi' che la proprieta'
    // si legga come proprieta' e non come tre casi che per caso concordano:
    // di tutti i modi che esistono, uno e uno soltanto tocca i file.
    const tutti: readonly SweepMode[] = ["spento", "elenca", "cancella"];
    expect(tutti.filter(toccaCancellare)).toEqual(["cancella"]);
  });
});
