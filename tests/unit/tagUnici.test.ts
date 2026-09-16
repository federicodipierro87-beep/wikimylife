import { tagUnici } from "@wikimylife/shared";
import { describe, expect, it } from "vitest";

/**
 * La ripulitura dei tag prima della scrittura.
 *
 * Vale la pena provarla da sola perche' il difetto che previene non si vede in
 * nessun test di schema: `updateProcedureBodySchema` accetta `["casa","casa"]`
 * senza battere ciglio, e il rifiuto arriva da Postgres — un P2002 su
 * `@@id([procedureId, tagId])`, cioe' un 500 in faccia a chi ha premuto salva.
 */

describe("tagUnici — cosa toglie e cosa conserva", () => {
  it("due nomi uguali diventano uno", () => {
    expect(tagUnici(["casa", "casa"])).toEqual(["casa"]);
  });

  it("due nomi diversi restano due", () => {
    // L'errore opposto: una dedup troppo zelante svuoterebbe le categorie di
    // ogni scheda, e nessun vincolo del database protesterebbe.
    expect(tagUnici(["casa", "ufficio"])).toEqual(["casa", "ufficio"]);
  });

  it("lo spazio intorno non fa due categorie", () => {
    // Senza `trim`, " casa" e "casa" sono due `Tag` distinti nel database ma la
    // stessa parola sullo schermo: l'utente vedrebbe due chip identiche.
    expect(tagUnici([" casa", "casa "])).toEqual(["casa"]);
  });

  it("una stringa di soli spazi non e' una categoria", () => {
    expect(tagUnici(["casa", "   ", "ufficio"])).toEqual(["casa", "ufficio"]);
  });

  it("una lista di soli vuoti diventa una lista vuota, non una lista con un vuoto", () => {
    expect(tagUnici(["", "  "])).toEqual([]);
  });

  it("l'ordine e' quello in cui sono arrivati, non alfabetico", () => {
    // Deliberato: l'ordine in cui il modello ha proposto i tag e' il suo giudizio
    // su quale conta di piu'. Ordinare qui lo butterebbe via.
    expect(tagUnici(["ufficio", "auto", "casa"])).toEqual(["ufficio", "auto", "casa"]);
  });

  it("di due ripetuti sopravvive il primo arrivato, con la sua posizione", () => {
    expect(tagUnici(["casa", "auto", "casa", "ufficio"])).toEqual(["casa", "auto", "ufficio"]);
  });

  it("le maiuscole restano due categorie, e non e' una dimenticanza", () => {
    // Prezzo dichiarato: i tag sono il vocabolario dell'utente e la §4.2 li
    // rimette dentro il prompt, quindi non si riscrivono. Se un giorno si
    // decidesse il contrario, questo caso deve cadere e far leggere il perche'.
    expect(tagUnici(["Casa", "casa"])).toEqual(["Casa", "casa"]);
  });

  it("non modifica la lista che riceve", () => {
    const originale = ["casa", "casa"];
    tagUnici(originale);
    expect(originale).toEqual(["casa", "casa"]);
  });
});
