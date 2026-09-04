import { searchText } from "@wikimylife/shared";
import { describe, expect, it } from "vitest";

/**
 * Il testo da cui Postgres genera il `tsvector`.
 *
 * Vale la pena provarlo da solo perche' e' l'unico punto in cui si decide *cosa*
 * e' cercabile: la §7 chiede titolo, trigger, passi e trappole, e un campo
 * dimenticato qui non fa fallire niente — rende semplicemente invisibile alla
 * ricerca meta' di ogni scheda, senza un solo errore in log.
 */

const base = {
  titolo: "Richiedere il casellario giudiziale",
  trigger: "Quando un datore di lavoro chiede il certificato penale",
  esito: "Certificato del casellario giudiziale in PDF",
};

describe("searchText — cosa entra nell'indice", () => {
  it("include titolo, trigger ed esito", () => {
    const text = searchText(base);

    expect(text).toContain("casellario giudiziale");
    expect(text).toContain("certificato penale");
    expect(text).toContain("in PDF");
  });

  it("include l'azione e il dettaglio di ogni passo", () => {
    // La §7 nomina i passi esplicitamente: chi cerca "SPID" deve trovare la
    // scheda anche se la parola compare solo al terzo passo.
    const text = searchText({
      ...base,
      steps: [
        { ordine: 1, azione: "Accedere al portale", dettaglio: "Serve SPID di livello 2" },
        { ordine: 2, azione: "Pagare il bollo", dettaglio: null },
      ],
    });

    expect(text).toContain("Accedere al portale");
    expect(text).toContain("SPID di livello 2");
    expect(text).toContain("Pagare il bollo");
  });

  it("include prerequisiti, trappole e tag", () => {
    const text = searchText({
      ...base,
      prereqs: [{ descrizione: "Marca da bollo da 16 euro" }],
      pitfalls: [{ descrizione: "Lo sportello chiude alle 12:30" }],
      tag: ["burocrazia", "documenti"],
    });

    expect(text).toContain("Marca da bollo");
    expect(text).toContain("chiude alle 12:30");
    expect(text).toContain("burocrazia, documenti");
  });

  it("mette i passi in ordine, qualunque ordine abbia l'array", () => {
    // Le righe arrivano da Prisma ordinate, ma la funzione e' chiamata anche
    // sull'input di una PATCH, dove l'ordine e' quello che manda il client.
    const text = searchText({
      ...base,
      steps: [
        { ordine: 2, azione: "secondo" },
        { ordine: 1, azione: "primo" },
      ],
    });

    expect(text.indexOf("primo")).toBeLessThan(text.indexOf("secondo"));
  });

  it("non lascia righe vuote per i campi assenti", () => {
    // Righe vuote non rompono `to_tsvector`, ma rendono illeggibile la colonna
    // quando la si guarda per capire perche' una ricerca non trova.
    const text = searchText({ titolo: "Solo il titolo", trigger: null, esito: null });

    expect(text).toBe("Solo il titolo");
  });

  it("scarta le stringhe fatte di soli spazi", () => {
    const text = searchText({ ...base, prereqs: [{ descrizione: "   " }] });

    expect(text.split("\n").every((line) => line.trim() !== "")).toBe(true);
  });

  it("conserva le maiuscole", () => {
    // A differenza di `embeddingInput`, qui NON si normalizza: ci pensa il
    // dizionario italiano di Postgres, che oltre a minuscolare fa anche
    // stemming. Farlo due volte non aggiunge nulla e toglie leggibilita' alla
    // colonna.
    expect(searchText({ titolo: "SPID e CIE" })).toBe("SPID e CIE");
  });

  it("e' deterministico a parita' di ingresso", () => {
    const source = {
      ...base,
      steps: [{ ordine: 1, azione: "Accedere" }],
      tag: ["b", "a"],
    };

    expect(searchText(source)).toBe(searchText(source));
  });
});
