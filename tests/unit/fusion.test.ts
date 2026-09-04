import { SearchMatch } from "@wikimylife/shared";
import { describe, expect, it } from "vitest";
import {
  RRF_K,
  confrontaPerRilevanza,
  fuseRankings,
} from "../../apps/api/src/services/search/fusion.js";

/**
 * La fusione dei due canali.
 *
 * E' una funzione pura, e questo e' il motivo per cui vive in TypeScript invece
 * che dentro una `FULL OUTER JOIN`: i casi che contano — accordo fra canali,
 * canale spento, pareggio — si provano qui con sei righe, non con un container.
 */

function ids(n: number, prefisso = "p"): { id: string; score: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefisso}-${String(i + 1)}`,
    score: 1 - i / 100,
  }));
}

describe("fuseRankings", () => {
  it("premia l'accordo fra i canali piu' dell'eccellenza in uno solo", () => {
    // E' l'intera ragione di essere di una ricerca ibrida: terza in entrambe
    // (2/63) batte prima in una sola (1/61).
    const fused = fuseRankings({
      fullText: [{ id: "solo-testo", score: 9 }, { id: "x", score: 8 }, { id: "accordo", score: 7 }],
      semantic: [{ id: "y", score: 0.9 }, { id: "z", score: 0.8 }, { id: "accordo", score: 0.7 }],
    });

    expect(fused[0]?.id).toBe("accordo");
    expect(fused[0]?.matchedBy).toBe(SearchMatch.ENTRAMBE);
  });

  it("etichetta correttamente il canale di provenienza", () => {
    const fused = fuseRankings({
      fullText: [{ id: "a", score: 1 }, { id: "c", score: 0.5 }],
      semantic: [{ id: "b", score: 0.9 }, { id: "c", score: 0.8 }],
    });

    const perId = new Map(fused.map((f) => [f.id, f.matchedBy]));
    expect(perId.get("a")).toBe(SearchMatch.TESTO);
    expect(perId.get("b")).toBe(SearchMatch.SEMANTICA);
    expect(perId.get("c")).toBe(SearchMatch.ENTRAMBE);
  });

  it("calcola il punteggio dalla posizione, non dal punteggio del canale", () => {
    // I due `score` in ingresso sono su scale incomparabili (ts_rank_cd contro
    // coseno): se entrassero nel calcolo, il canale con i numeri piu' grandi
    // vincerebbe sempre.
    const fused = fuseRankings({
      fullText: [{ id: "a", score: 0.0001 }],
      semantic: [{ id: "b", score: 0.95 }],
    });

    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(fused[1]?.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it("degrada senza rumore quando un canale e' vuoto", () => {
    // E' il caso reale del provider di embedding irraggiungibile.
    const fused = fuseRankings({ fullText: ids(3), semantic: [] });

    expect(fused.map((f) => f.id)).toEqual(["p-1", "p-2", "p-3"]);
    expect(fused.every((f) => f.matchedBy === SearchMatch.TESTO)).toBe(true);
  });

  it("restituisce la lista vuota quando nessun canale trova niente", () => {
    expect(fuseRankings({ fullText: [], semantic: [] })).toEqual([]);
  });

  it("a parita' di punteggio ordina in modo deterministico", () => {
    // Due ricerche identiche non devono rispondere in ordine diverso: senza un
    // criterio di spareggio l'ordine dipenderebbe dall'iterazione della Map.
    const input = {
      fullText: [{ id: "a", score: 1 }],
      semantic: [{ id: "b", score: 1 }],
    };

    expect(fuseRankings(input).map((f) => f.id)).toEqual(["a", "b"]);
    expect(fuseRankings(input).map((f) => f.id)).toEqual(fuseRankings(input).map((f) => f.id));
  });

  it("con k piccolo il primo posto pesa molto di piu'", () => {
    // La dimostrazione del perche' k = 60: smorza il vantaggio delle primissime
    // posizioni. Con k = 0 il primo prende 1 e il secondo 0.5.
    const conK0 = fuseRankings({ fullText: ids(2), semantic: [], k: 0 });
    const conK60 = fuseRankings({ fullText: ids(2), semantic: [] });

    const rapporto = (f: readonly { score: number }[]): number =>
      (f[0]?.score ?? 0) / (f[1]?.score ?? 1);

    expect(rapporto(conK0)).toBeCloseTo(2, 6);
    expect(rapporto(conK60)).toBeLessThan(1.02);
  });

  it("non duplica una scheda trovata da entrambi i canali", () => {
    const fused = fuseRankings({ fullText: ids(5), semantic: ids(5) });

    expect(fused).toHaveLength(5);
    expect(new Set(fused.map((f) => f.id)).size).toBe(5);
  });
});

describe("confrontaPerRilevanza", () => {
  const vecchia = new Date("2024-01-01T00:00:00.000Z");
  const recente = new Date("2026-01-01T00:00:00.000Z");

  it("ordina prima per rilevanza", () => {
    // La freschezza NON entra nel punteggio: una scheda verificata ieri ma che
    // parla d'altro deve restare sotto quella giusta di due anni fa.
    const risultato = confrontaPerRilevanza(
      { score: 0.01, ultimaVerifica: vecchia, volteEseguita: 0 },
      { score: 0.02, ultimaVerifica: recente, volteEseguita: 99 },
    );

    expect(risultato).toBeGreaterThan(0);
  });

  it("a parita' di rilevanza mette avanti la piu' fresca", () => {
    const risultato = confrontaPerRilevanza(
      { score: 0.02, ultimaVerifica: recente, volteEseguita: 0 },
      { score: 0.02, ultimaVerifica: vecchia, volteEseguita: 99 },
    );

    expect(risultato).toBeLessThan(0);
  });

  it("mette in fondo, fra i pari, la scheda mai verificata", () => {
    const risultato = confrontaPerRilevanza(
      { score: 0.02, ultimaVerifica: null, volteEseguita: 50 },
      { score: 0.02, ultimaVerifica: vecchia, volteEseguita: 0 },
    );

    expect(risultato).toBeGreaterThan(0);
  });

  it("usa volteEseguita solo come terzo criterio", () => {
    const risultato = confrontaPerRilevanza(
      { score: 0.02, ultimaVerifica: recente, volteEseguita: 1 },
      { score: 0.02, ultimaVerifica: recente, volteEseguita: 7 },
    );

    expect(risultato).toBeGreaterThan(0);
  });

  it("e' un ordinamento totale e stabile su una lista vera", () => {
    const righe = [
      { id: "c", score: 0.01, ultimaVerifica: recente, volteEseguita: 1 },
      { id: "a", score: 0.03, ultimaVerifica: null, volteEseguita: 0 },
      { id: "b", score: 0.01, ultimaVerifica: null, volteEseguita: 9 },
    ];

    expect([...righe].sort(confrontaPerRilevanza).map((r) => r.id)).toEqual(["a", "c", "b"]);
  });
});
