import { describe, expect, it } from "vitest";
import {
  avvisoSpazio,
  BYTE_AL_SECONDO,
  disponibili,
  MARGINE_BYTE,
  minutiResidui,
  valutaSpazio,
  type Spazio,
} from "../../apps/web/src/recording/spazio.js";

/**
 * Lo spazio che resta sul telefono.
 *
 * E' un conto che si sbaglia in due direzioni opposte e con costi diversi: un
 * avviso che non compare lascia registrare venti minuti che non si potranno
 * salvare, un avviso che compare sempre insegna a ignorarlo. La parte che conta
 * di piu' e' pero' un'altra — che «non lo so» non diventi mai «e' pieno», cioe'
 * che un browser senza `storage.estimate` non spaventi nessuno.
 */

/** Byte che corrispondono esattamente a `minuti` di parlato. */
function perMinuti(minuti: number): number {
  return minuti * 60 * BYTE_AL_SECONDO;
}

/** Una quota che lascia liberi esattamente `minuti`, margine compreso. */
function conMinuti(minuti: number): { usage: number; quota: number } {
  return { usage: 0, quota: perMinuti(minuti) + MARGINE_BYTE };
}

describe("disponibili", () => {
  it("toglie il margine", () => {
    // I browser rifiutano le scritture prima di arrivare alla quota dichiarata:
    // contare fino all'ultimo byte prometterebbe una registrazione che non
    // entra.
    expect(disponibili({ usage: 0, quota: MARGINE_BYTE + 1000 })).toBe(1000);
  });

  it("non scende sotto zero", () => {
    // `usage` puo' superare `quota`: succede dopo che il browser ha stretto la
    // quota su un dispositivo che si e' riempito. Un numero negativo qui
    // diventerebbe un conteggio di minuti negativo piu' avanti.
    expect(disponibili({ usage: 900, quota: 100 })).toBe(0);
  });
});

describe("minutiResidui", () => {
  it("arrotonda per difetto", () => {
    // Promettere il minuto che non c'e' e' l'unico errore che costa qualcosa.
    expect(minutiResidui(perMinuti(3) - 1)).toBe(2);
    expect(minutiResidui(perMinuti(3))).toBe(3);
  });
});

describe("valutaSpazio", () => {
  it("tace quando non sa", () => {
    // Safari senza `storage`, un contesto non sicuro, una `estimate()` che ha
    // lanciato: tre modi di non sapere, e nessuno di loro e' «pieno».
    expect(valutaSpazio(null)).toEqual<Spazio>({ kind: "ignoto" });
  });

  it("tace anche davanti a numeri che non sono numeri", () => {
    // `Infinity` arriva da implementazioni che dichiarano quota illimitata:
    // farlo passare produrrebbe `minuti` infiniti, che e' vero e inutile.
    expect(valutaSpazio({ usage: 0, quota: Number.POSITIVE_INFINITY }).kind).toBe("ignoto");
    expect(valutaSpazio({ usage: Number.NaN, quota: 100 }).kind).toBe("ignoto");
  });

  it("sta zitto finche' c'e' spazio in abbondanza", () => {
    expect(valutaSpazio(conMinuti(60)).kind).toBe("ok");
  });

  it("avvisa sotto i dieci minuti, dicendo quanti", () => {
    expect(valutaSpazio(conMinuti(4))).toEqual<Spazio>({ kind: "poco", minuti: 4 });
  });

  it("chiama pieno solo cio' che non tiene nemmeno un minuto", () => {
    expect(valutaSpazio(conMinuti(0)).kind).toBe("pieno");
    // Il confine: un minuto tondo e' ancora un avviso, non un pieno.
    expect(valutaSpazio(conMinuti(1)).kind).toBe("poco");
  });

  it("conta lo spazio gia' occupato", () => {
    // Una coda piena di audio non caricato e' esattamente il caso in cui questo
    // avviso serve, e `usage` e' il solo posto dove quella coda si vede.
    const quota = perMinuti(30) + MARGINE_BYTE;
    expect(valutaSpazio({ usage: perMinuti(25), quota })).toEqual<Spazio>({
      kind: "poco",
      minuti: 5,
    });
  });
});

describe("avvisoSpazio", () => {
  it("non dice niente quando non c'e' niente da dire", () => {
    expect(avvisoSpazio({ kind: "ignoto" })).toBeNull();
    expect(avvisoSpazio({ kind: "ok" })).toBeNull();
  });

  it("mette il numero di minuti nel testo", () => {
    expect(avvisoSpazio({ kind: "poco", minuti: 7 })).toContain("7 minuti");
  });

  it("accorda il singolare", () => {
    // «1 minuti» in una schermata che l'utente guarda ogni giorno.
    expect(avvisoSpazio({ kind: "poco", minuti: 1 })).toContain("1 minuto");
  });

  it("non vieta di registrare nemmeno quando e' pieno", () => {
    // La stima e' approssimata apposta: un divieto costruito sopra impedirebbe
    // di registrare a chi lo spazio ce l'ha, e una registrazione mai fatta e'
    // una perdita peggiore di un salvataggio fallito.
    const testo = avvisoSpazio({ kind: "pieno" });
    expect(testo).not.toBeNull();
    expect(testo).toContain("potrebbe");
  });
});
