import { extractionContractSchema } from "@wikimylife/shared";
import { buildExtractionContract } from "@wikimylife/shared/testing";
import { describe, expect, it } from "vitest";

/**
 * Contratto §4.1.
 *
 * I casi negativi verificano il PATH dell'issue, non solo che il parse
 * fallisca. Un test che si limita a `expect(result.success).toBe(false)` passa
 * anche quando lo schema rifiuta per il motivo sbagliato — e siccome i casi
 * negativi si scrivono modificando un oggetto valido, sbagliare il motivo e'
 * facilissimo.
 */

function paths(error: { issues: readonly { path: readonly PropertyKey[] }[] }): string[] {
  return error.issues.map((issue) => issue.path.join("."));
}

/**
 * Le chiavi rifiutate da `.strict()`.
 *
 * Zod segnala `unrecognized_keys` sull'OGGETTO che le contiene, non sul campo:
 * il `path` e' quello del genitore (`[]` alla radice, `["_meta"]` dentro
 * `_meta`) e i nomi stanno in `issue.keys`. Asserire su `path` soltanto
 * lascerebbe passare un test che non verifica quale chiave e' stata rifiutata.
 */
function unrecognized(error: { issues: readonly { code: string }[] }): { at: string; keys: string[] }[] {
  return error.issues
    .filter(
      (issue): issue is { code: "unrecognized_keys"; path: PropertyKey[]; keys: string[] } =>
        issue.code === "unrecognized_keys",
    )
    .map((issue) => ({ at: issue.path.join("."), keys: issue.keys }));
}

describe("extractionContractSchema", () => {
  it("accetta un'estrazione completa", () => {
    const result = extractionContractSchema.safeParse(buildExtractionContract());
    expect(result.success).toBe(true);
  });

  it("accetta null in ogni campo non deducibile dal parlato", () => {
    // §4: "Ogni campo non deducibile dal parlato vale null". Deve valere anche
    // tutto insieme: una nota da cui non si capisce niente resta un JSON valido
    // che finisce in DA_RIVEDERE, non un errore di parsing.
    const result = extractionContractSchema.safeParse(
      buildExtractionContract({
        titolo: null,
        trigger: null,
        esito: null,
        validitaEsito: null,
        durataTotaleStimataMin: null,
        ambitoSuggerito: null,
        prerequisiti: [],
        passi: [],
        trappole: [],
        costi: [],
        riferimenti: [],
        tag: [],
        luogo: { nome: null, dettaglio: null, confermatoDaGps: false },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rifiuta una chiave assente anche se il valore sarebbe stato null", () => {
    // La distinzione che giustifica .nullable() invece di .optional():
    // "non deducibile" (null) e' un dato, "dimenticato" (chiave assente) e' un
    // difetto del prompt.
    const { trigger: _omitted, ...senzaTrigger } = buildExtractionContract();
    const result = extractionContractSchema.safeParse(senzaTrigger);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(paths(result.error)).toContain("trigger");
    }
  });

  it("rifiuta una chiave sconosciuta al primo livello", () => {
    const result = extractionContractSchema.safeParse({
      ...buildExtractionContract(),
      priorita: "alta",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(unrecognized(result.error)).toEqual([{ at: "", keys: ["priorita"] }]);
    }
  });

  it("rifiuta una chiave sconosciuta dentro _meta", () => {
    const base = buildExtractionContract();
    const result = extractionContractSchema.safeParse({
      ...base,
      _meta: { ...base._meta, modelloUsato: "gpt-5" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(unrecognized(result.error)).toEqual([{ at: "_meta", keys: ["modelloUsato"] }]);
    }
  });

  it("segnala l'indice esatto del passo malformato", () => {
    const base = buildExtractionContract();
    const result = extractionContractSchema.safeParse({
      ...base,
      passi: [
        { ordine: 1, azione: "primo", dettaglio: null, durataStimataMin: null },
        { ordine: 2, azione: 42, dettaglio: null, durataStimataMin: null },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(paths(result.error)).toEqual(["passi.1.azione"]);
    }
  });

  it("rifiuta un ordine non intero", () => {
    const base = buildExtractionContract();
    const result = extractionContractSchema.safeParse({
      ...base,
      passi: [{ ordine: 1.5, azione: "mezzo passo", dettaglio: null, durataStimataMin: null }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(paths(result.error)).toEqual(["passi.0.ordine"]);
    }
  });

  it("rifiuta un valore fuori dall'enum di gravita", () => {
    const base = buildExtractionContract();
    const result = extractionContractSchema.safeParse({
      ...base,
      trappole: [{ descrizione: "attenzione", gravita: "GRAVE" }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(paths(result.error)).toEqual(["trappole.0.gravita"]);
    }
  });

  it("rifiuta un tipoRilevato non previsto dalla §4.1", () => {
    const base = buildExtractionContract();
    const result = extractionContractSchema.safeParse({
      ...base,
      _meta: { ...base._meta, tipoRilevato: "PROMEMORIA" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(paths(result.error)).toEqual(["_meta.tipoRilevato"]);
    }
  });

  it("non applica le regole di DOMINIO della §5", () => {
    // Questo test difende una decisione, non un comportamento accidentale.
    // Ordini 1, 2, 4 (non contigui), titolo lunghissimo, confidenza bassa:
    // formalmente valido, semanticamente incompleto. Deve passare, perche' la
    // specifica chiede di SALVARLO in DA_RIVEDERE. Se un giorno qualcuno
    // aggiungera' qui la validazione di dominio, questo test lo fermera'.
    const base = buildExtractionContract();
    const result = extractionContractSchema.safeParse({
      ...base,
      titolo: "t".repeat(300),
      passi: [
        { ordine: 1, azione: "uno", dettaglio: null, durataStimataMin: null },
        { ordine: 2, azione: "due", dettaglio: null, durataStimataMin: null },
        { ordine: 4, azione: "quattro", dettaglio: null, durataStimataMin: null },
      ],
      costi: [{ descrizione: "rimborso", importoCent: -500, valuta: "EUR" }],
      _meta: { ...base._meta, confidenzaGlobale: 0.1 },
    });

    expect(result.success).toBe(true);
  });
});
