import { assistedKindValues, type RedactionField } from "@wikimylife/shared";
import { describe, expect, it } from "vitest";
import {
  REDACTION_PROMPT_TEMPLATE,
  REDACTION_PROMPT_VERSION,
  REDACTION_TEMPERATURE,
  redactionTool,
  renderRedactionPrompt,
} from "../../apps/api/src/prompts/redaction.v1.js";

/**
 * Il prompt della passata assistita — §9.
 *
 * A differenza di `extractionPrompt.test.ts` qui non c'e' nessuna specifica da
 * cui rileggere il testo: la §9 chiede una redazione «assistita dall'LLM» e non
 * detta le parole. Il che rende questo file piu' importante, non meno. Cio' che
 * si verifica non e' l'aderenza a una fonte, ma le due proprieta' da cui
 * dipende che le risposte del modello siano usabili:
 *
 *  1. il testo dei campi arriva al modello com'e', carattere per carattere.
 *     Il server ritrova i valori proposti cercandoli dentro quel testo; se il
 *     prompt lo avesse alterato — una virgoletta scappata, un `\n` diventato
 *     due caratteri — il modello risponderebbe con stringhe che nella scheda
 *     non esistono, e ogni proposta verrebbe scartata come allucinata.
 *
 *  2. il vocabolario del tool coincide con quello che il server sa leggere.
 *     Un `kind` in piu' nello schema JSON e' una proposta che muore in
 *     `AnthropicRedactionProvider`; un campo fuori dall'elenco e' una proposta
 *     che muore piu' avanti, in silenzio.
 */

interface JsonNode {
  readonly type?: string;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, JsonNode>>;
  readonly items?: JsonNode;
}

const CAMPI: readonly RedactionField[] = [
  { campo: "titolo", testo: "Pratica di Mario Rossi" },
  { campo: "steps.0.azione", testo: "Portare i documenti in via Verdi 3" },
];

function schemaDi(campi: readonly RedactionField[]): JsonNode {
  return redactionTool(campi).input_schema as JsonNode;
}

function nodo(node: JsonNode, ...percorso: readonly string[]): JsonNode {
  let corrente = node;
  for (const nome of percorso) {
    const prossimo = corrente.properties?.[nome];
    if (prossimo === undefined) {
      throw new Error(`Proprieta' assente dallo schema del tool: ${percorso.join(".")}`);
    }
    corrente = prossimo;
  }
  return corrente;
}

function trovati(campi: readonly RedactionField[]): JsonNode {
  const items = nodo(schemaDi(campi), "trovati").items;
  if (items === undefined) {
    throw new Error("`trovati` non e' un array");
  }
  return items;
}

describe("il prompt di redazione", () => {
  it("porta una versione stabile", () => {
    expect(REDACTION_PROMPT_VERSION).toBe("redaction.v1");
  });

  it("gira a temperatura zero", () => {
    // Non e' un dettaglio di qualita': chi rilegge la stessa scheda due volte
    // deve vedere le stesse proposte, altrimenti non sa a quale delle due
    // passate credere.
    expect(REDACTION_TEMPERATURE).toBe(0);
  });

  it("dice al modello di non ripetere cio' che i rilevatori trovano da soli", () => {
    // La meta' deterministica passa da un checksum; ripeterla qui vorrebbe dire
    // due proposte sullo stesso tratto, e il server ne scarterebbe una senza
    // che nessuno sappia perche' il modello e' stato pagato per produrla.
    expect(REDACTION_PROMPT_TEMPLATE).toContain("Codici fiscali, IBAN, indirizzi email");
    expect(REDACTION_PROMPT_TEMPLATE).toContain("Non ripeterli.");
  });

  it("mette per prima la regola che dice di non segnalare nel dubbio", () => {
    // L'ordine e' il messaggio: i due errori non costano uguale, e la prima
    // regola e' quella che il modello pesa di piu'.
    expect(REDACTION_PROMPT_TEMPLATE).toContain("\n1. Nel dubbio, non segnalare.");
  });

  it("dichiara normale l'elenco vuoto", () => {
    // Senza questa riga un modello davanti a «trova i dati personali» trova
    // dati personali comunque, perche' tornare a mani vuote sembra un
    // fallimento.
    expect(REDACTION_PROMPT_TEMPLATE).toContain("restituisci un elenco vuoto");
    expect(REDACTION_PROMPT_TEMPLATE).toContain("esito normale");
  });

  it("elenca i quattro tipi che il server sa leggere, e nessun altro", () => {
    for (const kind of assistedKindValues) {
      expect(REDACTION_PROMPT_TEMPLATE).toContain(`- ${kind}:`);
    }
  });
});

describe("renderRedactionPrompt", () => {
  it("sostituisce il segnaposto con i campi", () => {
    const out = renderRedactionPrompt(CAMPI);

    expect(out).not.toContain("{campi}");
    expect(out).toContain("[titolo]\nPratica di Mario Rossi");
    expect(out).toContain("[steps.0.azione]\nPortare i documenti in via Verdi 3");
  });

  it("manda il testo com'e', senza serializzarlo", () => {
    // E' la proprieta' da cui dipende tutto il resto: il server cerchera'
    // dentro `testo`, non dentro una sua versione con le virgolette scappate.
    // Un JSON.stringify qui avrebbe fatto vedere al modello `\"Nuova\"` e
    // `\n`, e le stringhe che avrebbe risposto non si sarebbero trovate.
    const testo = 'Chiedere la "Nuova Delibera"\ne poi il modello F24';
    const out = renderRedactionPrompt([{ campo: "note", testo }]);

    expect(out).toContain(testo);
    expect(out).not.toContain('\\"Nuova');
    expect(out).not.toContain("\\n");
  });

  it("non interpreta i caratteri speciali della sostituzione", () => {
    // `$&` e `$1` sparirebbero con String.replace, e il testo che il modello
    // vede non sarebbe piu' quello della scheda.
    const testo = "Il totale e' $& piu' $1, in tutto $$";
    const out = renderRedactionPrompt([{ campo: "note", testo }]);

    expect(out).toContain(testo);
  });

  it("lascia stare un segnaposto scritto dentro la scheda", () => {
    const out = renderRedactionPrompt([{ campo: "note", testo: "ho scritto {campi} per errore" }]);

    expect(out).toContain("ho scritto {campi} per errore");
  });

  it("separa i campi con una riga vuota", () => {
    // Senza lo stacco l'ultima riga di un campo e l'etichetta del successivo si
    // toccano, e il modello attribuisce il testo al campo sbagliato: la
    // proposta arriverebbe con un `campo` valido ma un valore che li' dentro
    // non c'e'.
    expect(renderRedactionPrompt(CAMPI)).toContain("Mario Rossi\n\n[steps.0.azione]");
  });

  it("regge una scheda senza campi", () => {
    // Il servizio non chiama il provider in questo caso, ma il prompt non deve
    // essere il posto in cui si scopre.
    expect(() => renderRedactionPrompt([])).not.toThrow();
  });
});

describe("lo schema del tool", () => {
  it("ha un nome stabile e vieta le chiavi in piu'", () => {
    const tool = redactionTool(CAMPI);

    expect(tool.name).toBe("segnala_dati_personali");
    expect(schemaDi(CAMPI).additionalProperties).toBe(false);
    expect(trovati(CAMPI).additionalProperties).toBe(false);
  });

  it("chiude `campo` sui soli campi mandati", () => {
    // Un modello che risponde `steps.2.azione` per una scheda con due passi
    // manda a vuoto la proposta, e a vuoto in silenzio. Con l'enum l'errore si
    // vede dove nasce.
    expect(nodo(trovati(CAMPI), "campo").enum).toEqual(["titolo", "steps.0.azione"]);
  });

  it("cambia l'elenco quando cambiano i campi", () => {
    // Se l'enum fosse calcolato una volta sola, la seconda scheda ereditrebbe
    // i campi della prima — che e' peggio di non averlo.
    expect(nodo(trovati([{ campo: "esito", testo: "x" }]), "campo").enum).toEqual(["esito"]);
  });

  it("chiude `kind` sugli stessi valori che il provider valida", () => {
    expect(nodo(trovati(CAMPI), "kind").enum).toEqual(assistedKindValues);
  });

  it("chiede tutte e tre le chiavi di ogni proposta", () => {
    // Una proposta senza `valore` non e' una proposta a meta': e' un tratto di
    // scheda che nessuno sa dove sia, e la §9 non cancella cio' che non ha
    // mostrato.
    expect(trovati(CAMPI).required).toEqual(["campo", "valore", "kind"]);
  });

  it("dice al modello che il valore va riportato esatto", () => {
    expect(nodo(trovati(CAMPI), "valore").description).toContain("carattere per carattere");
  });

  it("dichiara valido l'elenco vuoto anche nella descrizione del tool", () => {
    // Il prompt lo dice, ma la descrizione del tool e' cio' che il modello
    // rilegge nel momento in cui decide come compilarlo.
    expect(redactionTool(CAMPI).description).toContain("elenco vuoto");
  });
});
