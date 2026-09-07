import { assistedKindValues, type RedactionField } from "@wikimylife/shared";

/**
 * Prompt della passata di redazione assistita — §9.
 *
 * Versionato come `extraction.v1` e per una ragione simile, anche se piu'
 * debole: qui non c'e' nessuna colonna che registri con quale versione una
 * scheda e' stata ripulita, perche' della redazione non resta traccia — e' il
 * punto della redazione. Ma il testo che si manda a un modello resta una parte
 * del comportamento del sistema, e cambiarlo in silenzio significa non poter
 * piu' dire perche' un mese fa questa passata proponeva un nome e oggi no.
 *
 * NOTA SULLE ACCENTATE. Come in `extraction.v1.ts`: questo e' testo che va a un
 * modello, e scriverlo senza accenti sarebbe scrivere un altro prompt.
 */

export const REDACTION_PROMPT_VERSION = "redaction.v1";

/**
 * Zero, come per l'estrazione. Qui la creatività non e' inutile, e' dannosa:
 * un modello che varia le sue risposte propone oggi un nome che ieri non aveva
 * proposto, e chi rilegge la stessa scheda due volte non capisce quale delle
 * due passate credere.
 */
export const REDACTION_TEMPERATURE = 0;

/**
 * Il prompt.
 *
 * Le istruzioni tirano tutte dalla stessa parte: **non proporre**. E' il verso
 * opposto a quello di un modello lasciato libero, che davanti a «trova i dati
 * personali» trova dati personali ovunque, e lo si vuole per lo stesso motivo
 * per cui i rilevatori deterministici passano da un checksum. I due errori non
 * costano uguale: un dato non proposto lo vede chi legge la scheda prima di
 * condividerla, un dato proposto a torto viene cancellato con un tocco insieme
 * agli altri e non torna piu'.
 *
 * L'esempio dei nomi propri che non sono persone non e' decorativo: un archivio
 * di pratiche burocratiche è pieno di «Agenzia delle Entrate», «Comune di
 * Torino», «Nuova Delibera», e sono esattamente le stringhe che assomigliano di
 * più a un nome e cognome.
 */
export const REDACTION_PROMPT_TEMPLATE = `Ricevi i campi di testo di una scheda che descrive una procedura: come si fa
qualcosa presso un ufficio, un'azienda o in casa. La scheda sta per essere
condivisa con altre persone.

Il tuo compito è segnalare le porzioni di testo che identificano una persona
specifica e che un formato automatico non può riconoscere: nomi e cognomi di
persone, indirizzi di abitazione, numeri di pratica o di tessera che sono
riferiti a qualcuno.

Codici fiscali, IBAN, indirizzi email e numeri di telefono NON ti riguardano:
sono già stati trovati da un altro strumento. Non ripeterli.

Regole, in ordine di importanza:

1. Nel dubbio, non segnalare. Chi rilegge la scheda vedrà ciò che ti è
   sfuggito, ma non vedrà ciò che hai segnalato a torto: lo cancellerà insieme
   al resto, e quel testo non tornerà più.

2. Segnala solo persone fisiche identificabili. NON sono dati personali:
   - i nomi di enti, uffici, aziende, sportelli ("Agenzia delle Entrate",
     "Comune di Torino", "ufficio anagrafe", "Poste Italiane");
   - i nomi di documenti, moduli, leggi e delibere ("Nuova Delibera",
     "modello F24", "Carta d'Identità Elettronica");
   - gli indirizzi di uffici pubblici e sedi aziendali, che si condividono;
   - i ruoli senza nome ("l'impiegato allo sportello 3", "il geometra").

3. Un indirizzo di abitazione va segnalato; l'indirizzo di un ufficio no. Se
   non è chiaro dal contesto di quale dei due si tratti, non segnalarlo.

4. Riporta il valore ESATTAMENTE come compare nel testo, carattere per
   carattere, senza correggere maiuscole, accenti o spaziatura. Se non
   corrisponde a una porzione letterale del campo verrà scartato.

5. Riporta la porzione più ampia che costituisce il dato: "Mario Rossi" e non
   "Mario" più "Rossi" separatamente.

6. Non riportare due volte lo stesso valore nello stesso campo: se compare più
   volte, verrà trovato ovunque compaia.

Tipi disponibili:
- NOME_PERSONA: nome, cognome o entrambi, di una persona fisica.
- INDIRIZZO: indirizzo di abitazione di una persona.
- IDENTIFICATIVO: numero di pratica, tessera, matricola o protocollo riferito a
  una persona specifica.
- ALTRO: un dato personale che non rientra nei precedenti. Usalo di rado.

Se non trovi niente, restituisci un elenco vuoto. È un esito normale e
frequente: la maggior parte delle schede descrive procedure e non persone.

I campi della scheda:

{campi}`;

const SEPARATORE = "\n";

/**
 * I campi, uno per riga, con il percorso davanti.
 *
 * JSON sarebbe stato piu' facile da rileggere per il modello, e piu' facile da
 * rompere: il testo di una scheda contiene virgolette e a capo, e serializzarlo
 * dentro un JSON dentro un prompt significa che il modello vede `\\"` e
 * `\\n` al posto dei caratteri veri — cioe' un testo che non e' quello su cui
 * poi si cercheranno i valori che ha risposto. Qui il testo passa com'e'.
 */
function rendiCampi(campi: readonly RedactionField[]): string {
  return campi.map((c) => `[${c.campo}]\n${c.testo}`).join(SEPARATORE + SEPARATORE);
}

export function renderRedactionPrompt(campi: readonly RedactionField[]): string {
  // `split`/`join` e non `replace`: il testo della scheda e' scritto
  // dall'utente e puo' contenere `$&` o `$1`, che in una stringa di
  // sostituzione hanno un significato speciale e sparirebbero.
  return REDACTION_PROMPT_TEMPLATE.split("{campi}").join(rendiCampi(campi));
}

// ---------------------------------------------------------------------------
// Schema del tool
// ---------------------------------------------------------------------------

/**
 * `campo` e' un enum ristretto ai campi mandati, non una stringa libera.
 *
 * Un modello che risponde `steps.2.azione` per una scheda con due passi manda
 * a vuoto la proposta, e a vuoto in silenzio: il server non trova il campo e
 * la butta, senza che nessuno sappia che quel nome era stato letto. Chiudere
 * l'insieme costa una riga e sposta l'errore dove si vede.
 */
export function redactionTool(campi: readonly RedactionField[]): {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
} {
  return {
    name: "segnala_dati_personali",
    description:
      "Segnala le porzioni di testo che identificano una persona fisica e che " +
      "nessun formato automatico può riconoscere. Un elenco vuoto è un esito valido.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["trovati"],
      properties: {
        trovati: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["campo", "valore", "kind"],
            properties: {
              campo: {
                type: "string",
                enum: campi.map((c) => c.campo),
                description: "Il percorso del campo in cui compare, fra quelli forniti.",
              },
              valore: {
                type: "string",
                description: "Il testo esatto, carattere per carattere, così come compare.",
              },
              kind: { type: "string", enum: assistedKindValues },
            },
          },
        },
      },
    },
  };
}
