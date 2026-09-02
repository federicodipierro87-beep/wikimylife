import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  costoSchema,
  detectedTypeValues,
  extractionContractSchema,
  extractionMetaSchema,
  luogoSchema,
  passoSchema,
  prereqTypeValues,
  prerequisitoSchema,
  refTypeValues,
  riferimentoSchema,
  scopeValues,
  severityValues,
  trappolaSchema,
  type ExtractionContext,
} from "@wikimylife/shared";
import { describe, expect, it } from "vitest";
import {
  EXTRACTION_INPUT_SCHEMA,
  EXTRACTION_PROMPT_TEMPLATE,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_TEMPERATURE,
  EXTRACTION_TOOL,
  renderExtractionPrompt,
  type JsonSchemaNode,
} from "../../apps/api/src/prompts/extraction.v1.js";

/**
 * Il prompt e lo schema del tool, verificati contro la specifica.
 *
 * Due cose che nessun compilatore puo' controllare:
 *
 *  1. "Il prompt di estrazione va preso ALLA LETTERA dalla sezione 4.2". Il
 *     test non contiene una seconda copia del testo — la rilegge da
 *     `wikimylife-schema.md`. Una copia sarebbe solo un terzo posto da tenere
 *     allineato a mano, e il primo a divergere in silenzio.
 *
 *  2. `EXTRACTION_INPUT_SCHEMA` e' il contratto §4.1 riscritto in JSON Schema,
 *     quindi puo' allontanarsi da Zod. Se succede, il modello risponde secondo
 *     uno schema e la validazione ne applica un altro: l'estrazione verrebbe
 *     rifiutata per un campo che nessuno gli aveva chiesto.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");

/** Il blocco fra ``` che segue il titolo della §4.2, normalizzato a LF. */
function promptFromSpec(): string {
  const spec = readFileSync(join(ROOT, "wikimylife-schema.md"), "utf8").replace(/\r\n/g, "\n");
  const heading = spec.indexOf("### 4.2 Prompt di estrazione");
  expect(heading).toBeGreaterThan(-1);

  const open = spec.indexOf("```", heading);
  const start = spec.indexOf("\n", open) + 1;
  const close = spec.indexOf("\n```", start);
  expect(close).toBeGreaterThan(start);

  return spec.slice(start, close);
}

describe("prompt §4.2 — alla lettera", () => {
  it("coincide carattere per carattere con la specifica", () => {
    // Compreso ogni accento: "e'" al posto di "è" sarebbe un prompt diverso.
    expect(EXTRACTION_PROMPT_TEMPLATE).toBe(promptFromSpec());
  });

  it("il test sta davvero leggendo la specifica", () => {
    // Senza questa asserzione, un percorso sbagliato renderebbe il confronto
    // di sopra un confronto fra due stringhe vuote.
    const dallaSpecifica = promptFromSpec();
    expect(dallaSpecifica.length).toBeGreaterThan(2000);
    expect(dallaSpecifica).toContain("Sei un estrattore di procedure.");
    expect(dallaSpecifica).toContain("11. Mantieni la lingua e le parole dell'utente.");
  });

  it("conserva le undici regole numerate", () => {
    for (let n = 1; n <= 11; n += 1) {
      expect(EXTRACTION_PROMPT_TEMPLATE).toContain(`\n${String(n)}. `);
    }
  });

  it("porta una versione che finisce in extractionModel", () => {
    expect(EXTRACTION_PROMPT_VERSION).toBe("extraction.v1");
  });

  it("usa una temperatura bassa come chiede la §4.2", () => {
    // "Temperatura bassa (0–0.2)". Zero, per rendere riproducibile il
    // riprocessamento dello storico.
    expect(EXTRACTION_TEMPERATURE).toBeGreaterThanOrEqual(0);
    expect(EXTRACTION_TEMPERATURE).toBeLessThanOrEqual(0.2);
  });
});

describe("renderExtractionPrompt", () => {
  const context: ExtractionContext = {
    recordedAt: "2026-03-01T10:00:00.000Z",
    placeLabel: "Procura della Repubblica di Torino",
    existingScopes: ["PERSONALE", "LAVORO"],
    existingTags: ["burocrazia", "certificati"],
  };

  it("sostituisce tutti e cinque i segnaposto", () => {
    const out = renderExtractionPrompt({ transcript: "Sono andato in Procura.", context });

    for (const placeholder of [
      "{recordedAt}",
      "{placeLabel}",
      "{existingScopes}",
      "{existingTags}",
      "{transcript}",
    ]) {
      expect(out).not.toContain(placeholder);
    }

    expect(out).toContain("Data e ora della registrazione: 2026-03-01T10:00:00.000Z");
    expect(out).toContain("Luogo rilevato via GPS: Procura della Repubblica di Torino");
    expect(out).toContain("Ambiti già usati dall'utente: PERSONALE, LAVORO");
    expect(out).toContain("Tag già esistenti dell'utente: burocrazia, certificati");
    expect(out.endsWith("Sono andato in Procura.")).toBe(true);
  });

  it("dichiara le assenze invece di lasciare righe monche", () => {
    // Una riga che finisce con i due punti e il nulla invita il modello a
    // riempirla da solo, che e' esattamente cio' che la regola 1 vieta.
    const out = renderExtractionPrompt({
      transcript: "x",
      context: {
        recordedAt: context.recordedAt,
        placeLabel: null,
        existingScopes: [],
        existingTags: [],
      },
    });

    expect(out).toContain("Luogo rilevato via GPS: (non disponibile)");
    expect(out).toContain("Ambiti già usati dall'utente: (nessuno)");
    expect(out).toContain("Tag già esistenti dell'utente: (nessuno)");
  });

  it("non interpreta i caratteri speciali della trascrizione", () => {
    // `$&` e `$1` hanno un significato nella stringa di sostituzione di
    // String.replace: con quella implementazione sparirebbero dal prompt.
    const transcript = "Ho scritto $& e poi $1 e infine $$ sulla lavagna.";
    const out = renderExtractionPrompt({ transcript, context });

    expect(out.endsWith(transcript)).toBe(true);
  });

  it("non lascia che una trascrizione contenente un segnaposto lo faccia sparire", () => {
    // Il segnaposto arriva nel testo dell'utente, quindi dopo la sostituzione:
    // deve restare li' com'e', non essere risostituito.
    const out = renderExtractionPrompt({ transcript: "Dicevo {transcript} per scherzo", context });

    expect(out.endsWith("Dicevo {transcript} per scherzo")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parita' fra JSON Schema del tool e Zod
// ---------------------------------------------------------------------------

interface ZodLike {
  readonly shape: Readonly<Record<string, unknown>>;
}

function prop(node: JsonSchemaNode, name: string): JsonSchemaNode {
  const found = node.properties?.[name];
  if (found === undefined) {
    throw new Error(`Proprieta' assente dallo schema del tool: ${name}`);
  }
  return found;
}

function items(node: JsonSchemaNode): JsonSchemaNode {
  if (node.items === undefined) {
    throw new Error("Nodo array senza items");
  }
  return node.items;
}

const root = EXTRACTION_INPUT_SCHEMA;
const arrayItems = (name: string): JsonSchemaNode => items(prop(root, name));

const OGGETTI: readonly { nome: string; json: JsonSchemaNode; zod: ZodLike }[] = [
  { nome: "radice", json: root, zod: extractionContractSchema },
  { nome: "prerequisiti[]", json: arrayItems("prerequisiti"), zod: prerequisitoSchema },
  { nome: "passi[]", json: arrayItems("passi"), zod: passoSchema },
  { nome: "trappole[]", json: arrayItems("trappole"), zod: trappolaSchema },
  { nome: "costi[]", json: arrayItems("costi"), zod: costoSchema },
  { nome: "riferimenti[]", json: arrayItems("riferimenti"), zod: riferimentoSchema },
  { nome: "luogo", json: prop(root, "luogo"), zod: luogoSchema },
  { nome: "_meta", json: prop(root, "_meta"), zod: extractionMetaSchema },
];

describe("EXTRACTION_INPUT_SCHEMA — parita' con il contratto Zod", () => {
  it.each(OGGETTI)("$nome ha le stesse chiavi di Zod", ({ json, zod }) => {
    expect(Object.keys(json.properties ?? {})).toEqual(Object.keys(zod.shape));
  });

  it.each(OGGETTI)("$nome dichiara obbligatoria ogni chiave", ({ json }) => {
    // Come `.nullable()` e mai `.optional()`: "non deducibile" e "dimenticato"
    // devono restare distinguibili anche nel canale verso il modello.
    expect(json.required).toEqual(Object.keys(json.properties ?? {}));
  });

  it.each(OGGETTI)("$nome vieta le chiavi in piu', come .strict()", ({ json }) => {
    expect(json.additionalProperties).toBe(false);
  });

  const ENUM: readonly { nome: string; json: JsonSchemaNode; atteso: readonly (string | null)[] }[] =
    [
      {
        nome: "prerequisiti[].tipo",
        json: prop(arrayItems("prerequisiti"), "tipo"),
        atteso: prereqTypeValues,
      },
      {
        nome: "trappole[].gravita",
        json: prop(arrayItems("trappole"), "gravita"),
        atteso: severityValues,
      },
      {
        nome: "riferimenti[].tipo",
        json: prop(arrayItems("riferimenti"), "tipo"),
        atteso: refTypeValues,
      },
      {
        nome: "_meta.tipoRilevato",
        json: prop(prop(root, "_meta"), "tipoRilevato"),
        atteso: detectedTypeValues,
      },
      {
        // Nullable: il null va elencato anche nell'enum, altrimenti i due
        // vincoli si contraddicono e il valore diventa impossibile.
        nome: "ambitoSuggerito",
        json: prop(root, "ambitoSuggerito"),
        atteso: [...scopeValues, null],
      },
    ];

  it.each(ENUM)("$nome elenca gli stessi valori degli enum di shared", ({ json, atteso }) => {
    expect(json.enum).toEqual(atteso);
  });

  it("marca nullable in JSON Schema esattamente i campi nullable in Zod", () => {
    // I quattro campi testuali della radice piu' la durata: gli stessi che
    // nel contratto §4.1 sono dichiarati `"string | null"`.
    for (const nome of ["titolo", "trigger", "esito", "validitaEsito"]) {
      expect(prop(root, nome).type).toEqual(["string", "null"]);
    }
    expect(prop(root, "durataTotaleStimataMin").type).toEqual(["integer", "null"]);
    for (const nome of ["nome", "dettaglio"]) {
      expect(prop(prop(root, "luogo"), nome).type).toEqual(["string", "null"]);
    }
  });

  it("chiede interi dove il contratto conta centesimi e posizioni", () => {
    // 16 euro valgono 1600: un `number` lascerebbe passare 1600.5.
    expect(prop(arrayItems("costi"), "importoCent").type).toBe("integer");
    expect(prop(arrayItems("passi"), "ordine").type).toBe("integer");
  });

  it("il tool ha un nome stabile e lo schema come input", () => {
    expect(EXTRACTION_TOOL.name).toBe("registra_procedura");
    expect(EXTRACTION_TOOL.input_schema).toBe(EXTRACTION_INPUT_SCHEMA);
  });
});
