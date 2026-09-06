import type { ProcedureDetail, ProcedurePitfall, RecordingState } from "@wikimylife/shared";
import { describe, expect, it } from "vitest";
import {
  avvisoDi,
  badgesOf,
  formatCosto,
  formatDurata,
  formatDurataAudio,
  formatQuando,
  pitfallsInOrdine,
  revisioneDa,
  sezioniDi,
} from "../../apps/web/src/format.js";

/**
 * Le regole di presentazione della Fase 4.
 *
 * Non sono dettagli grafici: quali avvisi compaiono, in che ordine si legge una
 * scheda e quando una domanda di revisione e' lecita sono decisioni di
 * prodotto, e si provano qui invece che a occhio nel browser.
 */

const ADESSO = new Date("2026-03-01T12:00:00.000Z");

function pitfall(descrizione: string, gravita: ProcedurePitfall["gravita"]): ProcedurePitfall {
  return { id: descrizione, descrizione, gravita };
}

describe("badgesOf", () => {
  it("segnala una scheda da rivedere", () => {
    expect(badgesOf({ status: "DA_RIVEDERE", obsoleta: false }).map((b) => b.kind)).toEqual([
      "revisione",
    ]);
  });

  it("segnala una scheda obsoleta anche se e' completa", () => {
    // Completa vuol dire "il modello ha capito tutto", non "e' ancora vera".
    expect(badgesOf({ status: "COMPLETA", obsoleta: true }).map((b) => b.kind)).toEqual([
      "obsoleta",
    ]);
  });

  it("mostra i due avvisi insieme: dicono due cose diverse", () => {
    expect(badgesOf({ status: "DA_RIVEDERE", obsoleta: true }).map((b) => b.kind)).toEqual([
      "revisione",
      "obsoleta",
    ]);
  });

  it("mette per primo cio' che cambia la decisione di aprire la scheda", () => {
    const kinds = badgesOf({ status: "ESTRAZIONE_FALLITA", obsoleta: true }).map((b) => b.kind);

    expect(kinds[0]).toBe("fallita");
  });

  it("non mette nessun avviso su una scheda completa e recente", () => {
    expect(badgesOf({ status: "COMPLETA", obsoleta: false })).toEqual([]);
  });

  it("dice che una scheda appena registrata sta ancora nascendo", () => {
    expect(badgesOf({ status: "BOZZA_AUDIO", obsoleta: false }).map((b) => b.kind)).toEqual([
      "elaborazione",
    ]);
  });
});

describe("pitfallsInOrdine", () => {
  it("porta in cima le bloccanti", () => {
    // Chi legge in fila allo sportello arriva alla terza riga, non alla decima.
    const ordinate = pitfallsInOrdine([
      pitfall("nota", "NOTA"),
      pitfall("fastidio", "FASTIDIO"),
      pitfall("bloccante", "BLOCCANTE"),
    ]);

    expect(ordinate.map((p) => p.descrizione)).toEqual(["bloccante", "fastidio", "nota"]);
  });

  it("a parita' di gravita' conserva l'ordine del racconto", () => {
    const ordinate = pitfallsInOrdine([
      pitfall("prima", "BLOCCANTE"),
      pitfall("seconda", "BLOCCANTE"),
    ]);

    expect(ordinate.map((p) => p.descrizione)).toEqual(["prima", "seconda"]);
  });

  it("non modifica l'array ricevuto", () => {
    const originale = [pitfall("nota", "NOTA"), pitfall("bloccante", "BLOCCANTE")];
    pitfallsInOrdine(originale);

    expect(originale.map((p) => p.descrizione)).toEqual(["nota", "bloccante"]);
  });
});

describe("formatCosto", () => {
  it("converte i centesimi in euro", () => {
    expect(formatCosto(1650)?.replace(/\u00a0/g, " ")).toBe("16,50 €");
  });

  it("distingue «gratis» da «non lo so»", () => {
    // Zero e' un'informazione; `null` e' la sua assenza, e scrivere "0,00 €"
    // dove nessuno ha detto niente sarebbe inventarsi un dato.
    expect(formatCosto(0)).not.toBeNull();
    expect(formatCosto(null)).toBeNull();
  });
});

describe("formatDurata", () => {
  it("sotto l'ora resta in minuti", () => {
    expect(formatDurata(45)).toBe("45 min");
  });

  it("sopra l'ora diventa un tempo invece che un numero", () => {
    expect(formatDurata(90)).toBe("1 h 30 min");
  });

  it("non scrive i minuti quando sono zero", () => {
    expect(formatDurata(120)).toBe("2 h");
  });

  it("sopra la giornata passa ai giorni", () => {
    // Molte procedure burocratiche durano settimane: "20160 min" non dice
    // niente a nessuno.
    expect(formatDurata(60 * 24 * 14)).toBe("14 giorni");
  });

  it("dice «1 giorno», non «1 giorni»", () => {
    expect(formatDurata(60 * 24)).toBe("1 giorno");
  });

  it("null resta null", () => {
    expect(formatDurata(null)).toBeNull();
  });
});

describe("formatDurataAudio", () => {
  it("mette lo zero davanti ai secondi", () => {
    expect(formatDurataAudio(65_000)).toBe("1:05");
  });

  it("parte da 0:00", () => {
    expect(formatDurataAudio(0)).toBe("0:00");
  });

  it("non mostra tempi negativi", () => {
    expect(formatDurataAudio(-1)).toBe("0:00");
  });
});

describe("formatQuando", () => {
  it("chiama «adesso» cio' che e' appena successo", () => {
    expect(formatQuando("2026-03-01T11:59:30.000Z", ADESSO)).toBe("adesso");
  });

  it("usa l'unita' piu' grande che ci sta", () => {
    expect(formatQuando("2026-02-26T12:00:00.000Z", ADESSO)).toBe("3 giorni fa");
  });

  it("sopra l'anno torna alla data assoluta", () => {
    // "14 mesi fa" si ritraduce in data a mente: tanto vale darla gia' fatta.
    expect(formatQuando("2024-01-15T12:00:00.000Z", ADESSO)).toMatch(/2024/);
  });

  it("null resta null", () => {
    expect(formatQuando(null, ADESSO)).toBeNull();
  });

  it("una data illeggibile non diventa «Invalid Date» in interfaccia", () => {
    expect(formatQuando("non-una-data", ADESSO)).toBeNull();
  });
});

describe("revisioneDa", () => {
  it("raccoglie le domande delle registrazioni di origine", () => {
    const r = revisioneDa([
      { campiIncerti: ["costi"], domandeSuggerite: ["Quanto hai pagato?"] },
    ]);

    expect(r).toEqual({ campiIncerti: ["costi"], domande: ["Quanto hai pagato?"] });
  });

  it("senza campi incerti non propone niente", () => {
    // Le domande sono la conseguenza dell'incertezza dichiarata: senza, sarebbe
    // un questionario a caso.
    const r = revisioneDa([{ campiIncerti: [], domandeSuggerite: ["Quanto hai pagato?"] }]);

    expect(r.domande).toEqual([]);
  });

  it("non ripete la stessa domanda arrivata da due vocali", () => {
    const r = revisioneDa([
      { campiIncerti: ["costi"], domandeSuggerite: ["Quanto?"] },
      { campiIncerti: ["costi"], domandeSuggerite: ["Quanto?"] },
    ]);

    expect(r.domande).toEqual(["Quanto?"]);
    expect(r.campiIncerti).toEqual(["costi"]);
  });

  it("ignora le registrazioni senza estrazione", () => {
    expect(revisioneDa([null])).toEqual({ campiIncerti: [], domande: [] });
  });
});

describe("sezioniDi", () => {
  function detail(over: Partial<ProcedureDetail>): ProcedureDetail {
    return {
      steps: [],
      prereqs: [],
      pitfalls: [],
      costs: [],
      refs: [],
      ...over,
    } as ProcedureDetail;
  }

  it("impone l'ordine della §4: prima cosa serve, poi cosa va storto, poi come si fa", () => {
    // Presentare i passi per primi vuol dire far arrivare alla riga «serve il
    // documento X» qualcuno che e' gia' uscito di casa senza.
    const sezioni = sezioniDi(
      detail({
        steps: [{ id: "s", ordine: 1, azione: "vai", dettaglio: null, durataStimataMin: null }],
        prereqs: [{ id: "p", descrizione: "carta", tipo: "DOCUMENTO", obbligatorio: true }],
        pitfalls: [pitfall("chiuso il lunedi'", "BLOCCANTE")],
      }),
    );

    expect(sezioni.map((s) => s.kind)).toEqual(["prereq", "pitfall", "step"]);
  });

  it("nasconde le sezioni vuote", () => {
    // «Prerequisiti (0)» insegna a scorrere via le intestazioni.
    const sezioni = sezioniDi(
      detail({
        steps: [{ id: "s", ordine: 1, azione: "vai", dettaglio: null, durataStimataMin: null }],
      }),
    );

    expect(sezioni.map((s) => s.kind)).toEqual(["step"]);
  });
});

/**
 * Le registrazioni che non sono ancora schede.
 *
 * Il caso che conta e' `ritento`: una registrazione appena fallita ha lo stesso
 * `status` di una appena caricata, e distinguerle e' l'unica ragione per cui
 * `nextAttemptAt` sta nel contratto. Un test che guardasse solo lo stato
 * passerebbe anche con la funzione sbagliata.
 */
describe("avvisoDi", () => {
  function rec(over: Partial<RecordingState> = {}): RecordingState {
    return {
      id: "rec-1",
      status: "BOZZA_AUDIO",
      recordedAt: "2026-03-01T11:00:00.000Z",
      durationMs: 42_000,
      mimeType: "audio/webm",
      sizeBytes: 1024,
      capturedOffline: false,
      placeLabel: null,
      transcript: null,
      transcriptSource: null,
      procedureId: null,
      retryCount: 0,
      lastError: null,
      nextAttemptAt: null,
      duplicate: null,
      extraction: null,
      issues: [],
      updatedAt: "2026-03-01T11:00:00.000Z",
      ...over,
    };
  }

  const errore = { code: "TRASCRIZIONE_FALLITA", message: "Non sono riuscito a sentire l'audio.", at: "2026-03-01T11:59:00.000Z" };

  it("una registrazione appena caricata e' semplicemente in attesa", () => {
    const a = avvisoDi(rec(), ADESSO);
    expect(a?.kind).toBe("attesa");
    // Niente pulsante: non e' successo niente da riprovare, e offrirlo
    // suggerirebbe che qualcosa sia gia' andato storto.
    expect(a?.riprovabile).toBe(false);
  });

  it("distingue un'attesa dopo un fallimento da un'attesa e basta", () => {
    // Stesso `status` della prova precedente. Cambia solo `nextAttemptAt`.
    const a = avvisoDi(
      rec({ lastError: errore, nextAttemptAt: "2026-03-01T12:10:00.000Z" }),
      ADESSO,
    );
    expect(a?.kind).toBe("ritento");
    expect(a?.testo).toContain("Ci riprovo");
    expect(a?.dettaglio).toBe(errore.message);
    // Il pulsante salta il backoff: e' l'unica cosa che puo' ancora cambiare.
    expect(a?.riprovabile).toBe(true);
  });

  it("un'attesa gia' scaduta non torna a sembrare una registrazione nuova", () => {
    const a = avvisoDi(
      rec({ lastError: errore, nextAttemptAt: "2026-03-01T11:59:30.000Z" }),
      ADESSO,
    );
    expect(a?.kind).toBe("attesa");
    expect(a?.testo).toBe("Ci riprovo a momenti");
    expect(a?.riprovabile).toBe(true);
  });

  it("in lavorazione non si riprova", () => {
    // Un retry qui sarebbe rifiutato dal server, e il pulsante prometterebbe
    // qualcosa che non puo' mantenere.
    const a = avvisoDi(rec({ status: "IN_ELABORAZIONE" }), ADESSO);
    expect(a?.kind).toBe("lavorazione");
    expect(a?.riprovabile).toBe(false);
  });

  it("una registrazione ferma dice perche', con le parole del server", () => {
    const a = avvisoDi(rec({ status: "ESTRAZIONE_FALLITA", lastError: errore }), ADESSO);
    expect(a?.kind).toBe("ferma");
    expect(a?.dettaglio).toBe(errore.message);
    expect(a?.dettaglio).not.toContain("TRASCRIZIONE_FALLITA");
    expect(a?.riprovabile).toBe(true);
  });

  it("un duplicato indica la scheda a cui somiglia e non offre di riprovare", () => {
    // La deduplicazione e' deterministica: riprovare ricadrebbe nello stesso
    // verdetto, e un pulsante che riporta al punto di partenza e' peggio di
    // nessun pulsante.
    const a = avvisoDi(
      rec({
        status: "DUPLICATO_SOSPETTO",
        duplicate: { procedureId: "p-1", titolo: "Rinnovo del passaporto", similarity: 0.91 },
      }),
      ADESSO,
    );
    expect(a?.kind).toBe("duplicato");
    expect(a?.dettaglio).toContain("Rinnovo del passaporto");
    expect(a?.riprovabile).toBe(false);
  });

  it("una registrazione estratta non ha niente da dire in questa lista", () => {
    // Ha gia' la sua scheda: comparirebbe due volte dicendo la stessa cosa.
    expect(avvisoDi(rec({ status: "ESTRATTO", procedureId: "p-1" }), ADESSO)).toBeNull();
  });
});
