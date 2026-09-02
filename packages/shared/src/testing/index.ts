import type { SecureStorageAdapter } from "../adapters/secureStorage.js";
import { Scope, Severity } from "../enums.js";
import type { ExtractionContract } from "../extraction/contract.js";

/**
 * Utilita' per i test, esportate da un subpath separato
 * (`@wikimylife/shared/testing`) e non dall'entry point principale: cosi' un
 * import distratto in un file di produzione non trascina fixture nel bundle.
 */

/** `SecureStorageAdapter` in memoria: per i test del client API. */
export function createInMemorySecureStorage(
  initial?: Readonly<Record<string, string>>,
): SecureStorageAdapter & { snapshot(): Record<string, string> } {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get(key: string): Promise<string | null> {
      return Promise.resolve(store.get(key) ?? null);
    },
    set(key: string, value: string): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },
    remove(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
    snapshot(): Record<string, string> {
      return Object.fromEntries(store);
    },
  };
}

/**
 * Estrazione conforme al contratto §4.1, sovrascrivibile campo per campo.
 * Serve soprattutto ai casi negativi: si parte da un oggetto valido e si rompe
 * una cosa sola, cosi' l'asserzione sul `path` dell'issue e' inequivocabile.
 */
export function buildExtractionContract(
  overrides: Partial<ExtractionContract> = {},
): ExtractionContract {
  const base: ExtractionContract = {
    titolo: "Richiedere il casellario giudiziale",
    trigger: "Mi hanno chiesto il certificato del casellario per una candidatura",
    esito: "Certificato rilasciato allo sportello",
    validitaEsito: "6 mesi",
    prerequisiti: [
      { descrizione: "Carta d'identita' valida", tipo: "DOCUMENTO", obbligatorio: true },
    ],
    passi: [
      {
        ordine: 1,
        azione: "Comprare la marca da bollo da 16 euro",
        dettaglio: "In tabaccheria, prima di andare in Procura",
        durataStimataMin: 10,
      },
      {
        ordine: 2,
        azione: "Consegnare il modulo allo sportello",
        dettaglio: null,
        durataStimataMin: 30,
      },
    ],
    trappole: [
      {
        descrizione: "Lo sportello chiude alle 12:00 e non lo scrivono da nessuna parte",
        gravita: Severity.BLOCCANTE,
      },
    ],
    costi: [{ descrizione: "Marca da bollo", importoCent: 1600, valuta: "EUR" }],
    durataTotaleStimataMin: 40,
    luogo: {
      nome: "Procura della Repubblica di Torino",
      dettaglio: "Ufficio casellario, piano terra",
      confermatoDaGps: false,
    },
    riferimenti: [{ tipo: "UFFICIO", valore: "Ufficio casellario, sportello 3" }],
    tag: ["burocrazia", "certificati"],
    ambitoSuggerito: Scope.PERSONALE,
    _meta: {
      confidenzaGlobale: 0.82,
      campiIncerti: [],
      domandeSuggerite: [],
      contieneDatiSensibili: false,
      tipoRilevato: "PROCEDURA",
    },
  };

  return { ...base, ...overrides };
}
