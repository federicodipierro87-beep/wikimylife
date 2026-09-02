import {
  DEDUP_COSINE_THRESHOLD,
  EMBEDDING_DIMENSIONS,
  cosineSimilarity,
  deterministicUnitVector,
  embeddingInput,
  toVectorLiteral,
} from "@wikimylife/shared";
import { describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../../apps/api/src/providers/fake/FakeEmbeddingProvider.js";

/**
 * Vettori deterministici e provider fake.
 *
 * Il test che conta davvero e' quello sulla dimensione: 1536 e' la larghezza
 * della colonna `vector(1536)` creata dalla migration. Se qualcuno cambiasse
 * modello di embedding senza migrare, il sintomo sarebbe un errore di Postgres
 * al primo inserimento, in un worker, magari di notte. Qui e' un test rosso.
 */

function norm(v: readonly number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

describe("deterministicUnitVector", () => {
  it("ha la dimensione richiesta", () => {
    expect(deterministicUnitVector("qualcosa", 1536)).toHaveLength(1536);
    expect(deterministicUnitVector("qualcosa", 8)).toHaveLength(8);
  });

  it("ha norma 1", () => {
    expect(norm(deterministicUnitVector("richiedere il casellario", 1536))).toBeCloseTo(1, 10);
  });

  it("e' una funzione pura del testo", () => {
    expect(deterministicUnitVector("stesso testo", 64)).toEqual(
      deterministicUnitVector("stesso testo", 64),
    );
  });

  it("testi diversi danno vettori diversi", () => {
    expect(deterministicUnitVector("uno", 64)).not.toEqual(deterministicUnitVector("due", 64));
  });

  it("non contiene NaN ne' infiniti", () => {
    // Box-Muller con log(0) darebbe -Infinity e pgvector rifiuterebbe il valore.
    expect(deterministicUnitVector("", 1536).every(Number.isFinite)).toBe(true);
    expect(deterministicUnitVector("x".repeat(5000), 1536).every(Number.isFinite)).toBe(true);
  });

  it("rifiuta dimensioni non valide", () => {
    expect(() => deterministicUnitVector("x", 0)).toThrow(RangeError);
    expect(() => deterministicUnitVector("x", -1)).toThrow(RangeError);
    expect(() => deterministicUnitVector("x", 1.5)).toThrow(RangeError);
  });

  it("testi non correlati restano ben sotto la soglia di dedup", () => {
    // La proprieta' che rende usabile il seed: due procedure diverse non devono
    // sembrarsi duplicati. In 1536 dimensioni due direzioni casuali cadono
    // intorno a similarita' 0, con deviazione ~1/sqrt(1536) ≈ 0.026.
    const testi = [
      "Richiedere il casellario giudiziale",
      "Ripristinare la VPN aziendale dopo il cambio password",
      "Cambiare la guarnizione del rubinetto",
      "Disdire l'abbonamento del gas",
    ];

    for (let i = 0; i < testi.length; i += 1) {
      for (let j = i + 1; j < testi.length; j += 1) {
        const similarity = cosineSimilarity(
          deterministicUnitVector(String(testi[i]), EMBEDDING_DIMENSIONS),
          deterministicUnitVector(String(testi[j]), EMBEDDING_DIMENSIONS),
        );
        expect(Math.abs(similarity)).toBeLessThan(DEDUP_COSINE_THRESHOLD);
        expect(Math.abs(similarity)).toBeLessThan(0.2);
      }
    }
  });

  it("un vettore e' identico a se stesso", () => {
    const v = deterministicUnitVector("uguale", EMBEDDING_DIMENSIONS);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  it("cosineSimilarity rifiuta dimensioni incompatibili", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(RangeError);
  });
});

describe("toVectorLiteral", () => {
  it("produce la sintassi di pgvector", () => {
    expect(toVectorLiteral([1, -0.5, 0])).toBe("[1,-0.5,0]");
  });

  it("non contiene spazi ne' notazione che Postgres non accetti", () => {
    const literal = toVectorLiteral(deterministicUnitVector("x", 16));
    expect(literal.startsWith("[")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);
    expect(literal).not.toContain(" ");
  });
});

describe("embeddingInput", () => {
  it("compone titolo, trigger e tag", () => {
    expect(
      embeddingInput({ titolo: "Titolo", trigger: "Quando succede X", tag: ["b", "a"] }),
    ).toBe("Titolo\nQuando succede X\na, b");
  });

  it("l'ordine dei tag non cambia il risultato", () => {
    // I tag arrivano dal database senza ordine garantito: se contasse, lo
    // stesso record darebbe embedding diversi a seconda della query.
    const uno = embeddingInput({ titolo: "T", trigger: null, tag: ["zeta", "alfa"] });
    const due = embeddingInput({ titolo: "T", trigger: null, tag: ["alfa", "zeta"] });
    expect(uno).toBe(due);
  });

  it("normalizza maiuscole e spazi nei tag", () => {
    expect(embeddingInput({ titolo: "T", tag: ["  Burocrazia ", "VPN"] })).toBe(
      embeddingInput({ titolo: "T", tag: ["burocrazia", "vpn"] }),
    );
  });

  it("salta le parti assenti senza lasciare righe vuote", () => {
    expect(embeddingInput({ titolo: "Solo titolo" })).toBe("Solo titolo");
    expect(embeddingInput({ titolo: "T", trigger: "   ", tag: [] })).toBe("T");
  });
});

describe("FakeEmbeddingProvider", () => {
  it("produce vettori della larghezza della colonna vector(1536)", async () => {
    const provider = new FakeEmbeddingProvider();

    expect(provider.dimensions).toBe(1536);
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
    expect(await provider.embed("qualsiasi cosa")).toHaveLength(1536);
  });

  it("i vettori sono unitari", async () => {
    const provider = new FakeEmbeddingProvider();
    expect(norm(await provider.embed("qualsiasi cosa"))).toBeCloseTo(1, 10);
  });

  it("e' deterministico fra istanze diverse", async () => {
    const a = await new FakeEmbeddingProvider().embed("stesso testo");
    const b = await new FakeEmbeddingProvider().embed("stesso testo");
    expect(a).toEqual(b);
  });

  it("embedMany coincide con embed applicato uno a uno", async () => {
    const provider = new FakeEmbeddingProvider();
    const texts = ["uno", "due", "tre"];

    expect(await provider.embedMany(texts)).toEqual(
      await Promise.all(texts.map((t) => provider.embed(t))),
    );
  });
});
