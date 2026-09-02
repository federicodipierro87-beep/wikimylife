import {
  detectedTypeValues,
  prereqTypeValues,
  refTypeValues,
  scopeValues,
  severityValues,
  type ExtractionContext,
} from "@wikimylife/shared";

/**
 * Prompt di estrazione — sezione 4.2 della specifica, alla lettera.
 *
 * File dedicato e versionato: il giorno in cui il prompt cambia nasce
 * `extraction.v2.ts` accanto a questo, che resta. Serve perche' ogni
 * `Recording` porta scritto in `extractionModel` con quale versione e' stato
 * elaborato: senza il testo esatto di quella versione ancora leggibile, quel
 * campo direbbe qualcosa di non piu' verificabile, e il riprocessamento dello
 * storico promesso dalla §6 sarebbe impossibile.
 *
 * NOTA SULLE ACCENTATE. Nel resto del repository i commenti evitano gli accenti
 * (`perche'`, `cosi'`) per non dipendere dalla codifica del terminale. Qui no:
 * questo e' testo che va a un modello, e "e'" al posto di "è" sarebbe una
 * modifica al prompt. La specifica dice "alla lettera", e alla lettera si
 * intende anche la punteggiatura.
 */

export const EXTRACTION_PROMPT_VERSION = "extraction.v1";

/**
 * §4.2 verbatim. I cinque segnaposto `{...}` sono quelli della specifica e
 * vengono sostituiti da `renderExtractionPrompt`.
 */
export const EXTRACTION_PROMPT_TEMPLATE = `Sei un estrattore di procedure. Ricevi la trascrizione di una nota vocale in cui
una persona racconta, subito dopo averla vissuta, come ha portato a termine
qualcosa: una pratica burocratica, un'operazione di lavoro, una riparazione
domestica.

Il tuo compito è convertirla nel JSON del contratto fornito. Non parli con
l'utente, non spieghi, non aggiungi testo prima o dopo il JSON.

REGOLE

1. Non inventare nulla. Se un'informazione non è nel parlato, il campo vale null
   o resta un array vuoto. È molto meglio un campo vuoto che un dettaglio
   verosimile ma falso: l'utente rileggerà questa scheda tra due anni fidandosi.

2. Non arricchire con conoscenza tua. Se la persona dice "sono andato all'ufficio
   postale" non aggiungere orari, requisiti o costi che sai da altre fonti.
   Questa scheda vale proprio perché contiene solo l'esperienza reale.

3. Riordina, non riassumere. Il parlato è disordinato: la persona torna indietro,
   si corregge, aggiunge un pezzo alla fine. Ricostruisci l'ordine cronologico
   reale dei passi. Se si autocorregge ("no scusa, prima la marca da bollo"),
   vince l'ultima versione.

4. Il titolo è verbo all'infinito più oggetto, come lo cercherebbe l'utente tra
   due anni. "Richiedere il casellario giudiziale", non "Ufficio postale" né
   "La mia esperienza al casellario".

5. Il trigger è la situazione che fa nascere il bisogno, non la procedura stessa.
   Se non è esplicito, deducilo solo quando è ovvio, altrimenti null.

6. Le trappole sono la parte di maggior valore. Cerca frasi come "attenzione che",
   "l'errore che ho fatto", "non te lo dicono", "la prossima volta". Marcale
   BLOCCANTE se hanno impedito o rimandato il risultato.

7. Distingui prerequisiti da passi. Il prerequisito è ciò che devi avere PRIMA di
   iniziare; il passo è un'azione da compiere.

8. Importi in centesimi interi: 16 euro → 1600.

9. Metti contieneDatiSensibili a true se compaiono password, codici fiscali,
   numeri di documento, dati di salute, nomi di clienti o dettagli interni di
   un'azienda.

10. Se il testo non descrive una procedura ripetibile, imposta tipoRilevato a
    NOTA_SEMPLICE, compila solo titolo e trigger e lascia il resto vuoto.

11. Mantieni la lingua e le parole dell'utente. Non tradurre e non alzare il
    registro: se dice "sportello", scrivi "sportello", non "front office".

CONTESTO DISPONIBILE
Data e ora della registrazione: {recordedAt}
Luogo rilevato via GPS: {placeLabel}
Ambiti già usati dall'utente: {existingScopes}
Tag già esistenti dell'utente: {existingTags}

Usa i tag esistenti quando calzano, invece di crearne di nuovi quasi identici.
Il luogo GPS va usato solo per riempire luogo.nome se l'utente non lo nomina;
in quel caso metti confermatoDaGps a true.

TRASCRIZIONE
{transcript}`;

/**
 * §4.2: "Temperatura bassa (0–0.2): qui non serve creatività."
 * Zero e non 0.2: fra due valori entrambi conformi si sceglie quello che rende
 * l'estrazione piu' riproducibile, che e' cio' che serve per riprocessare lo
 * storico e ottenere lo stesso risultato.
 */
export const EXTRACTION_TEMPERATURE = 0;

/**
 * Cosa scrivere nei segnaposto quando il dato non c'e'.
 *
 * Un segnaposto lasciato vuoto produrrebbe `Luogo rilevato via GPS:` seguito da
 * niente, e un modello che legge una riga monca tende a riempirla da solo —
 * esattamente cio' che la regola 1 vieta. Una parentesi esplicita e' un'assenza
 * dichiarata, non un vuoto da interpretare.
 */
const ASSENTE = "(non disponibile)";
const NESSUNO = "(nessuno)";

export function renderExtractionPrompt(input: {
  readonly transcript: string;
  readonly context: ExtractionContext;
}): string {
  const { context } = input;

  const substitutions: Record<string, string> = {
    "{recordedAt}": context.recordedAt,
    "{placeLabel}": context.placeLabel ?? ASSENTE,
    "{existingScopes}":
      context.existingScopes.length > 0 ? context.existingScopes.join(", ") : NESSUNO,
    "{existingTags}":
      context.existingTags.length > 0 ? context.existingTags.join(", ") : NESSUNO,
    "{transcript}": input.transcript,
  };

  let out = EXTRACTION_PROMPT_TEMPLATE;
  for (const [placeholder, value] of Object.entries(substitutions)) {
    // `split`/`join` e non `replace` con una regex: la trascrizione e' testo
    // dell'utente e potrebbe contenere `$&` o `$1`, che in una stringa di
    // sostituzione hanno un significato speciale e sparirebbero.
    out = out.split(placeholder).join(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema del tool per lo structured output
// ---------------------------------------------------------------------------

/**
 * §4.2: "Da implementare con structured output / tool use, non con parsing di
 * testo libero."
 *
 * Questo e' il contratto §4.1 tradotto in JSON Schema. E' una seconda scrittura
 * della stessa forma gia' descritta da Zod in `packages/shared`, e le due
 * possono divergere: a impedirlo c'e' `tests/unit/extractionPrompt.test.ts`,
 * che confronta chiavi obbligatorie ed enum fra i due. Derivarlo dallo schema
 * Zod avrebbe richiesto `zod-to-json-schema`, cioe' una dipendenza in piu' per
 * un file che cambia una volta per versione del prompt.
 */

export interface JsonSchemaNode {
  readonly type?: string | readonly string[] | undefined;
  readonly description?: string | undefined;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly items?: JsonSchemaNode | undefined;
  /** `null` e' ammesso: un enum nullable deve elencare anche il null. */
  readonly enum?: readonly (string | null)[] | undefined;
  readonly additionalProperties?: boolean | undefined;
}

const nullableString: JsonSchemaNode = { type: ["string", "null"] };
const nullableInteger: JsonSchemaNode = { type: ["integer", "null"] };

function object(
  properties: Readonly<Record<string, JsonSchemaNode>>,
  description?: string,
): JsonSchemaNode {
  return {
    type: "object",
    ...(description === undefined ? {} : { description }),
    properties,
    // Tutte le chiavi sono obbligatorie, anche quelle che valgono `null`:
    // e' la stessa scelta di `.nullable()` invece di `.optional()` fatta in Zod.
    // "il modello ha capito che non e' deducibile" e "il modello se n'e'
    // dimenticato" devono restare due cose diverse.
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function array(items: JsonSchemaNode, description?: string): JsonSchemaNode {
  return {
    type: "array",
    ...(description === undefined ? {} : { description }),
    items,
  };
}

export const EXTRACTION_INPUT_SCHEMA: JsonSchemaNode = object({
  titolo: {
    type: ["string", "null"],
    description: "Verbo all'infinito piu' oggetto. Meno di 80 caratteri.",
  },
  trigger: {
    type: ["string", "null"],
    description: "La situazione che fa nascere il bisogno, non la procedura stessa.",
  },
  esito: nullableString,
  validitaEsito: nullableString,

  prerequisiti: array(
    object({
      descrizione: { type: "string" },
      tipo: { type: "string", enum: prereqTypeValues },
      obbligatorio: { type: "boolean" },
    }),
    "Cio' che serve avere PRIMA di iniziare.",
  ),

  passi: array(
    object({
      ordine: { type: "integer", description: "Contiguo a partire da 1." },
      azione: { type: "string" },
      dettaglio: nullableString,
      durataStimataMin: nullableInteger,
    }),
    "Le azioni da compiere, in ordine cronologico reale.",
  ),

  trappole: array(
    object({
      descrizione: { type: "string" },
      gravita: { type: "string", enum: severityValues },
    }),
    "BLOCCANTE se hanno impedito o rimandato il risultato.",
  ),

  costi: array(
    object({
      descrizione: { type: "string" },
      importoCent: { type: "integer", description: "Centesimi interi: 16 euro vale 1600." },
      valuta: { type: "string", description: "Codice ISO 4217, es. EUR." },
    }),
  ),

  durataTotaleStimataMin: nullableInteger,

  luogo: object({
    nome: nullableString,
    dettaglio: nullableString,
    confermatoDaGps: {
      type: "boolean",
      description: "true solo se il nome viene dal GPS e non dal parlato.",
    },
  }),

  riferimenti: array(
    object({
      tipo: { type: "string", enum: refTypeValues },
      valore: { type: "string" },
    }),
  ),

  tag: array({ type: "string" }, "Riusa i tag esistenti quando calzano."),
  // `null` compare anche nell'enum e non solo in `type`: un enum che non lo
  // elenca rende il valore `null` invalido, e i due vincoli si applicano
  // entrambi.
  ambitoSuggerito: { type: ["string", "null"], enum: [...scopeValues, null] },

  _meta: object({
    confidenzaGlobale: { type: "number", description: "Fra 0 e 1." },
    campiIncerti: array({ type: "string" }),
    domandeSuggerite: array({ type: "string" }),
    contieneDatiSensibili: { type: "boolean" },
    tipoRilevato: { type: "string", enum: detectedTypeValues },
  }),
});

export const EXTRACTION_TOOL = {
  name: "registra_procedura",
  description:
    "Registra la procedura estratta dalla trascrizione, conforme al contratto. " +
    "Ogni campo non deducibile dal parlato vale null.",
  input_schema: EXTRACTION_INPUT_SCHEMA,
} as const;
