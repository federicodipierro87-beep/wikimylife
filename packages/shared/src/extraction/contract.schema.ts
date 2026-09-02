import { z } from "zod";
import {
  detectedTypeValues,
  prereqTypeValues,
  refTypeValues,
  scopeValues,
  severityValues,
} from "../enums.js";

/**
 * Contratto di output dell'LLM — sezione 4.1 della specifica.
 *
 * Questo file e' l'UNICA fonte di verita': i tipi TypeScript si ricavano con
 * `z.infer`, non si scrivono a mano (vedi contract.ts).
 *
 * Due regole di traduzione, entrambe deliberate:
 *
 * 1. `.strict()` ovunque. Un campo in piu' significa che il prompt e il
 *    contratto hanno divergato: meglio saperlo subito che scoprirlo fra sei
 *    mesi su una colonna silenziosamente vuota.
 *
 * 2. `.nullable()` e MAI `.optional()` dove il contratto dice `"string | null"`.
 *    La chiave deve esserci. Cosi' "il modello ha capito che non e' deducibile"
 *    (valore null) resta distinguibile da "il modello si e' dimenticato il
 *    campo" (chiave assente) — e la seconda e' un difetto del prompt, non un
 *    dato mancante.
 *
 * ATTENZIONE — Zod qui valida solo la FORMA.
 * Le regole della §5 (ordine dei passi contiguo, titolo sotto gli 80 caratteri,
 * importi non negativi, soglia di confidenza) sono validazione di DOMINIO e
 * arrivano in Fase 2. Confondere i due livelli renderebbe impossibile fare
 * esattamente cio' che la specifica chiede: salvare in `DA_RIVEDERE` un JSON
 * formalmente valido ma incompleto.
 */

export const prerequisitoSchema = z
  .object({
    descrizione: z.string(),
    tipo: z.enum(prereqTypeValues),
    obbligatorio: z.boolean(),
  })
  .strict();

export const passoSchema = z
  .object({
    ordine: z.number().int(),
    azione: z.string(),
    dettaglio: z.string().nullable(),
    durataStimataMin: z.number().int().nullable(),
  })
  .strict();

export const trappolaSchema = z
  .object({
    descrizione: z.string(),
    gravita: z.enum(severityValues),
  })
  .strict();

export const costoSchema = z
  .object({
    descrizione: z.string(),
    importoCent: z.number().int(),
    valuta: z.string(),
  })
  .strict();

export const luogoSchema = z
  .object({
    nome: z.string().nullable(),
    dettaglio: z.string().nullable(),
    confermatoDaGps: z.boolean(),
  })
  .strict();

export const riferimentoSchema = z
  .object({
    tipo: z.enum(refTypeValues),
    valore: z.string(),
  })
  .strict();

export const extractionMetaSchema = z
  .object({
    confidenzaGlobale: z.number(),
    campiIncerti: z.array(z.string()),
    domandeSuggerite: z.array(z.string()),
    contieneDatiSensibili: z.boolean(),
    tipoRilevato: z.enum(detectedTypeValues),
  })
  .strict();

export const extractionContractSchema = z
  .object({
    titolo: z.string().nullable(),
    trigger: z.string().nullable(),
    esito: z.string().nullable(),
    validitaEsito: z.string().nullable(),

    prerequisiti: z.array(prerequisitoSchema),
    passi: z.array(passoSchema),
    trappole: z.array(trappolaSchema),
    costi: z.array(costoSchema),

    durataTotaleStimataMin: z.number().int().nullable(),

    luogo: luogoSchema,
    riferimenti: z.array(riferimentoSchema),

    tag: z.array(z.string()),
    ambitoSuggerito: z.enum(scopeValues).nullable(),

    _meta: extractionMetaSchema,
  })
  .strict();
