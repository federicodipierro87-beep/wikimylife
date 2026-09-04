import { SearchMatch, searchResultSchema, type EmbeddingProvider } from "@wikimylife/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../../apps/api/src/providers/fake/index.js";
import {
  createSearchService,
  type SearchService,
} from "../../apps/api/src/services/search.service.js";
import { FixedClock } from "../support/FixedClock.js";
import { InMemoryProcedureRepository } from "../support/InMemoryProcedureRepository.js";

/**
 * L'orchestrazione della ricerca, senza database.
 *
 * Cio' che si prova qui non e' che i due canali trovino le cose giuste — quello
 * dipende dagli indici veri e sta nei test di integrazione — ma le decisioni che
 * il servizio prende *attorno* ai canali: quanto chiede a ciascuno, cosa fa
 * quando uno cade, come rimette in ordine le righe che tornano.
 */

const USER = "user-1";
const NOW = new Date("2026-06-01T12:00:00.000Z");

interface Harness {
  readonly repo: InMemoryProcedureRepository;
  readonly clock: FixedClock;
  readonly degradi: unknown[];
  readonly service: SearchService;
}

function harness(embeddings: EmbeddingProvider = new FakeEmbeddingProvider({
  model: "fake",
  dimensions: 1536,
})): Harness {
  const repo = new InMemoryProcedureRepository();
  const clock = new FixedClock(NOW);
  const degradi: unknown[] = [];
  return {
    repo,
    clock,
    degradi,
    service: createSearchService({
      repo,
      embeddings,
      clock,
      onSemanticUnavailable: (error) => degradi.push(error),
    }),
  };
}

let h: Harness;

beforeEach(() => {
  h = harness();
});

describe("interrogazione dei canali", () => {
  it("chiede a ciascun canale piu' righe di quelle richieste", async () => {
    // Se al full-text si chiedessero solo 20 righe, una scheda ventunesima li' e
    // prima nella semantica risulterebbe SEMANTICA invece che ENTRAMBE: la
    // fusione non saprebbe nemmeno che il testo la contiene.
    await h.service.search(USER, { q: "casellario", limit: 20 });

    expect(h.repo.lastFullTextOptions?.limit).toBe(60);
    expect(h.repo.lastSemanticOptions?.limit).toBe(60);
  });

  it("mette un tetto: oltre, RRF non cambia le prime posizioni", async () => {
    await h.service.search(USER, { q: "casellario", limit: 50 });

    expect(h.repo.lastFullTextOptions?.limit).toBe(100);
  });

  it("propaga il filtro di ambito a entrambi i canali", async () => {
    await h.service.search(USER, { q: "vpn", scope: "LAVORO", limit: 20 });

    expect(h.repo.lastFullTextOptions?.scope).toBe("LAVORO");
    expect(h.repo.lastSemanticOptions?.scope).toBe("LAVORO");
  });
});

describe("degrado quando la semantica non e' disponibile", () => {
  it("risponde lo stesso, col solo full-text", async () => {
    // E' l'unica scelta difendibile: i dati sono gia' tutti in casa, e un
    // timeout di un servizio esterno non deve rendere inutilizzabile la
    // funzione principale dell'app.
    const rotto: EmbeddingProvider = {
      name: "rotto",
      model: "rotto",
      dimensions: 1536,
      embed: () => Promise.reject(new Error("timeout")),
      embedMany: () => Promise.reject(new Error("timeout")),
    };
    h = harness(rotto);
    const row = h.repo.seed({ userId: USER, titolo: "Richiedere il casellario" });
    h.repo.fullTextResult = [{ id: row.id, score: 0.4 }];

    const result = await h.service.search(USER, { q: "casellario", limit: 20 });

    expect(result.items.map((i) => i.id)).toEqual([row.id]);
    expect(result.items[0]?.matchedBy).toBe(SearchMatch.TESTO);
  });

  it("lascia una traccia del degrado", async () => {
    // Un provider giu' per un'ora deve essere visibile: altrimenti si scopre
    // solo dalle lamentele sulla qualita' dei risultati.
    const rotto: EmbeddingProvider = {
      name: "rotto",
      model: "rotto",
      dimensions: 1536,
      embed: () => Promise.reject(new Error("timeout")),
      embedMany: () => Promise.reject(new Error("timeout")),
    };
    h = harness(rotto);

    await h.service.search(USER, { q: "casellario", limit: 20 });

    expect(h.degradi).toHaveLength(1);
  });
});

describe("idratazione e ordinamento", () => {
  it("legge le righe solo per gli id sopravvissuti alla fusione", async () => {
    const righe = Array.from({ length: 5 }, (_, i) =>
      h.repo.seed({ userId: USER, titolo: `Scheda ${String(i + 1)}` }),
    );
    h.repo.fullTextResult = righe.map((r, i) => ({ id: r.id, score: 1 - i / 10 }));

    const result = await h.service.search(USER, { q: "scheda", limit: 2 });

    expect(result.items).toHaveLength(2);
  });

  it("ristabilisce l'ordine di rilevanza sulle righe lette", async () => {
    // Il repository restituisce di proposito in ordine arbitrario, come SQL.
    const primo = h.repo.seed({ userId: USER, titolo: "Primo" });
    const secondo = h.repo.seed({ userId: USER, titolo: "Secondo" });
    h.repo.fullTextResult = [
      { id: primo.id, score: 0.9 },
      { id: secondo.id, score: 0.1 },
    ];

    const result = await h.service.search(USER, { q: "x", limit: 20 });

    expect(result.items.map((i) => i.titolo)).toEqual(["Primo", "Secondo"]);
  });

  it("a parita' di rilevanza mette avanti la piu' fresca, poi la piu' eseguita", async () => {
    // Il pareggio e' realistico: due schede prime una per canale prendono lo
    // stesso punteggio RRF.
    const vecchia = h.repo.seed({
      userId: USER,
      titolo: "Vecchia",
      ultimaVerifica: new Date("2025-01-01T00:00:00.000Z"),
    });
    const fresca = h.repo.seed({
      userId: USER,
      titolo: "Fresca",
      ultimaVerifica: new Date("2026-05-01T00:00:00.000Z"),
    });
    h.repo.fullTextResult = [{ id: vecchia.id, score: 0.9 }];
    h.repo.semanticResult = [{ id: fresca.id, score: 0.9 }];

    const result = await h.service.search(USER, { q: "x", limit: 20 });

    expect(result.items.map((i) => i.titolo)).toEqual(["Fresca", "Vecchia"]);
  });

  it("salta senza lanciare una scheda sparita fra la query e l'idratazione", async () => {
    const viva = h.repo.seed({ userId: USER, titolo: "Viva" });
    h.repo.fullTextResult = [
      { id: viva.id, score: 0.9 },
      { id: "proc-cancellata", score: 0.8 },
    ];

    const result = await h.service.search(USER, { q: "x", limit: 20 });

    expect(result.items.map((i) => i.id)).toEqual([viva.id]);
  });
});

describe("risposta", () => {
  it("espone il flag di obsolescenza su ogni risultato", async () => {
    const row = h.repo.seed({
      userId: USER,
      ultimaVerifica: new Date("2024-01-01T00:00:00.000Z"),
    });
    h.repo.fullTextResult = [{ id: row.id, score: 0.5 }];

    const result = await h.service.search(USER, { q: "x", limit: 20 });

    expect(result.items[0]?.obsoleta).toBe(true);
  });

  it("restituisce una lista vuota quando nessun canale trova niente", async () => {
    const result = await h.service.search(USER, { q: "inesistente", limit: 20 });

    expect(result).toEqual({ q: "inesistente", items: [] });
  });

  it("e' conforme al contratto pubblico", async () => {
    const row = h.repo.seed({ userId: USER, tag: ["burocrazia"] });
    h.repo.fullTextResult = [{ id: row.id, score: 0.5 }];
    h.repo.semanticResult = [{ id: row.id, score: 0.8 }];

    const result = await h.service.search(USER, { q: "casellario", limit: 20 });

    expect(searchResultSchema.safeParse(result).success).toBe(true);
    expect(result.items[0]?.matchedBy).toBe(SearchMatch.ENTRAMBE);
  });
});
