import { describe, expect, it } from "vitest";
import {
  toccaSpazzare,
  type StatoScopa,
  type SweepMode,
} from "../../apps/worker/src/sweepSchedule.js";

/**
 * L'unica decisione periodica del sistema che, se sbagliata, cancella file.
 *
 * Un giro di polling in piu' non si vede; una passata della scopa che parte
 * quando non doveva non da' nessun errore e toglie roba da un bucket. Quindi
 * qui si prova soprattutto quando NON deve partire — che e' quasi sempre.
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
    // Il default, e l'unica risposta che conta davvero: un'installazione che
    // non ha detto niente non deve trovarsi dei file in meno.
    expect(toccaSpazzare(stato({ mode: "spento", nonPrimaDi: ADESSO - 100 * ORE }))).toBe(false);
  });

  it("elenca passa come cancella: la differenza non e' qui", () => {
    // Sono la stessa passata, e costano lo stesso in tempo e in richieste. A
    // decidere se toccare qualcosa e' il servizio, non il calendario.
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
