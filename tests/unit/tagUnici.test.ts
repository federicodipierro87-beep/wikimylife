import {
  PROCEDURE_TAG_MAX,
  PROCEDURE_TAG_NAME_MAX,
  tagUnici,
  updateProcedureBodySchema,
} from "@wikimylife/shared";
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

/**
 * I due tetti delle categorie, che da adesso li legge anche una schermata.
 *
 * Stanno in questo file perche' e' l'unico che parli di tag nel contratto, e
 * non meritano un file da soli. Esistono perche' `PROCEDURE_TAG_MAX` non e' piu'
 * soltanto un `.max()` dentro uno schema: il riquadro delle categorie del
 * dettaglio lo legge per spegnere il pulsante *prima* di mandare una richiesta
 * che tornerebbe 400.
 *
 * I casi della schermata usano la costante simbolicamente, quindi si muovono
 * insieme a lei e non la difendono: se domani diventasse `3` resterebbero tutti
 * verdi, e l'app rifiuterebbe la quarta categoria senza che niente protesti.
 * Qui sotto c'e' l'unica cosa che una costante usata simbolicamente non puo'
 * provare da se': fra quali estremi ha senso, e cosa c'e' fuori da ognuno dei
 * due.
 */
describe("il tetto delle categorie, e quello di un nome", () => {
  it("la schermata e il contratto contano lo stesso numero di categorie", () => {
    // La proprieta' vera non e' «trenta»: e' che il numero da cui la schermata
    // spegne il pulsante sia *lo stesso* da cui il server risponde 400. Se i due
    // si separassero, ci sarebbe un pulsante acceso che manda una richiesta
    // rifiutata, o uno spento che nega qualcosa di permesso.
    const piene = Array.from({ length: PROCEDURE_TAG_MAX }, (_, i) => `c${String(i)}`);

    expect(updateProcedureBodySchema.safeParse({ tag: piene }).success).toBe(true);
    expect(updateProcedureBodySchema.safeParse({ tag: [...piene, "unaditroppo"] }).success).toBe(
      false,
    );
  });

  it("e quel numero sta fra dieci e cinquanta", () => {
    // Sotto i dieci il tetto smetterebbe di essere una difesa contro
    // un'estrazione andata storta e diventerebbe un limite sentito dall'utente,
    // che nessuna schermata gli ha mai annunciato. Sopra i cinquanta non
    // difenderebbe piu' da niente: una scheda con sessanta categorie non e'
    // categorizzata, e la riga delle chip in dashboard sarebbe un nastro
    // infinito.
    expect(PROCEDURE_TAG_MAX).toBeGreaterThanOrEqual(10);
    expect(PROCEDURE_TAG_MAX).toBeLessThanOrEqual(50);
  });

  it("un nome lungo quanto il tetto passa, e uno di un carattere in piu' no", () => {
    const giusto = "a".repeat(PROCEDURE_TAG_NAME_MAX);

    expect(updateProcedureBodySchema.safeParse({ tag: [giusto] }).success).toBe(true);
    expect(updateProcedureBodySchema.safeParse({ tag: [`${giusto}a`] }).success).toBe(false);
  });

  it("e la lunghezza di un nome sta fra venti e duecento", () => {
    // Sotto i venti si taglierebbero categorie legittime — «documenti della
    // macchina» sono ventiquattro caratteri. Sopra i duecento non e' piu' un
    // nome, e' una frase: comparirebbe come chip in dashboard e coprirebbe la
    // riga intera.
    expect(PROCEDURE_TAG_NAME_MAX).toBeGreaterThanOrEqual(20);
    expect(PROCEDURE_TAG_NAME_MAX).toBeLessThanOrEqual(200);
  });
});
