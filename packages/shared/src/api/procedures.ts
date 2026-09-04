import { z } from "zod";
import {
  cardStatusValues,
  outcomeValues,
  prereqTypeValues,
  refTypeValues,
  scopeValues,
  severityValues,
  visibilityValues,
} from "../enums.js";

/**
 * Contratto HTTP della lettura, della modifica e della ricerca delle schede.
 *
 * Come per registrazioni e autenticazione, gli stessi schemi valgono sui due
 * lati: le rotte validano l'ingresso, il client tipizzato valida cio' che torna.
 */

// ---------------------------------------------------------------------------
// Obsolescenza (§7)
// ---------------------------------------------------------------------------

/**
 * Oltre questa eta' di `ultimaVerifica` la scheda si mostra con un avviso.
 *
 * Un anno, come chiede il brief. La §7 parla di tre anni; vince la soglia piu'
 * stretta, perche' il costo di un falso positivo e' un avviso di troppo, quello
 * di un falso negativo e' una persona che si presenta a uno sportello con la
 * lista di documenti sbagliata.
 *
 * Il flag e' calcolato dal server e non dal client: e' l'unico modo perche' web
 * e mobile dicano la stessa cosa, e perche' cambiarlo non richieda di
 * aggiornare le app.
 */
export const OBSOLESCENZA_GIORNI = 365;

const MS_PER_GIORNO = 24 * 60 * 60 * 1000;

/**
 * `ultimaVerifica === null` NON e' obsoleta.
 *
 * Sembra il contrario del buon senso, ma una scheda mai verificata e' gia'
 * segnalata dal suo stato — `DA_RIVEDERE`, oppure una `Execution` con esito
 * `CAMBIATA` che l'ha riportata li' (§8). Marcarla anche obsoleta significhebbe
 * mostrare due avvisi per lo stesso fatto, e il secondo avviso e' quello che
 * insegna a ignorare il primo.
 */
export function isObsoleta(ultimaVerifica: Date | null, adesso: Date): boolean {
  if (ultimaVerifica === null) {
    return false;
  }
  return adesso.getTime() - ultimaVerifica.getTime() > OBSOLESCENZA_GIORNI * MS_PER_GIORNO;
}

// ---------------------------------------------------------------------------
// Righe figlie
// ---------------------------------------------------------------------------

export const stepSchema = z
  .object({
    id: z.string(),
    ordine: z.number().int(),
    azione: z.string(),
    dettaglio: z.string().nullable(),
    durataStimataMin: z.number().int().nullable(),
  })
  .strict();

export const prerequisiteSchema = z
  .object({
    id: z.string(),
    descrizione: z.string(),
    tipo: z.enum(prereqTypeValues),
    obbligatorio: z.boolean(),
  })
  .strict();

export const pitfallSchema = z
  .object({
    id: z.string(),
    descrizione: z.string(),
    gravita: z.enum(severityValues),
  })
  .strict();

export const costSchema = z
  .object({
    id: z.string(),
    descrizione: z.string(),
    importoCent: z.number().int(),
    valuta: z.string(),
  })
  .strict();

export const referenceSchema = z
  .object({
    id: z.string(),
    tipo: z.enum(refTypeValues),
    valore: z.string(),
  })
  .strict();

export const attachmentSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    mimeType: z.string(),
    didascalia: z.string().nullable(),
  })
  .strict();

export const executionSchema = z
  .object({
    id: z.string(),
    eseguitaIl: z.string(),
    esito: z.enum(outcomeValues),
    nota: z.string().nullable(),
  })
  .strict();

/**
 * La registrazione da cui la scheda e' nata, in forma ridotta.
 *
 * La trascrizione c'e' perche' la §3 e' esplicita: «la trascrizione grezza si
 * conserva e si mostra sempre». E' la sola prova di cosa aveva davvero detto
 * l'utente quando il modello ha capito un'altra cosa.
 */
export const procedureRecordingSchema = z
  .object({
    id: z.string(),
    recordedAt: z.string(),
    durationMs: z.number().int(),
    transcript: z.string().nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Scheda
// ---------------------------------------------------------------------------

/**
 * La forma corta: liste e risultati di ricerca.
 *
 * Contiene tutto cio' che serve a decidere se aprire la scheda e niente di
 * piu': una lista di cento procedure con dentro i passi di ognuna sarebbe una
 * risposta da centinaia di kilobyte per mostrare centinaia di titoli.
 */
export const procedureSummarySchema = z
  .object({
    id: z.string(),
    titolo: z.string(),
    trigger: z.string().nullable(),
    esito: z.string().nullable(),

    scope: z.enum(scopeValues),
    clientLabel: z.string().nullable(),
    visibility: z.enum(visibilityValues),
    status: z.enum(cardStatusValues),

    durataStimataMin: z.number().int().nullable(),
    costoTotaleCent: z.number().int().nullable(),
    luogoNome: z.string().nullable(),

    ultimaVerifica: z.string().nullable(),
    volteEseguita: z.number().int(),
    contieneDatiSensibili: z.boolean(),
    /** Calcolato dal server: vedi `isObsoleta`. */
    obsoleta: z.boolean(),

    numeroPassi: z.number().int(),
    tag: z.array(z.string()),

    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const procedureDetailSchema = procedureSummarySchema
  .extend({
    validitaEsito: z.string().nullable(),
    luogoDettaglio: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    forkedFromId: z.string().nullable(),

    steps: z.array(stepSchema),
    prereqs: z.array(prerequisiteSchema),
    pitfalls: z.array(pitfallSchema),
    costs: z.array(costSchema),
    refs: z.array(referenceSchema),
    attachments: z.array(attachmentSchema),
    executions: z.array(executionSchema),
    recordings: z.array(procedureRecordingSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

export const PROCEDURE_PAGE_SIZE = 20;
export const PROCEDURE_PAGE_SIZE_MAX = 100;

/**
 * I filtri arrivano dalla query string, dove tutto e' stringa: da qui
 * `z.coerce` su `limit` e `offset`, e nessun booleano.
 */
export const listProceduresQuerySchema = z
  .object({
    scope: z.enum(scopeValues).optional(),
    /**
     * Quando manca, la lista esclude le ARCHIVIATE — e' cio' che rende il
     * `DELETE` un soft delete percepibile come una cancellazione. Chiederle
     * esplicitamente resta possibile: e' il cestino.
     */
    status: z.enum(cardStatusValues).optional(),
    tag: z.string().min(1).max(60).optional(),
    limit: z.coerce.number().int().min(1).max(PROCEDURE_PAGE_SIZE_MAX).default(PROCEDURE_PAGE_SIZE),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const procedureListSchema = z
  .object({
    items: z.array(procedureSummarySchema),
    /** Il totale che soddisfa i filtri, non quello della pagina. */
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Modifica
// ---------------------------------------------------------------------------

export const stepInputSchema = z
  .object({
    azione: z.string().min(1).max(2000),
    dettaglio: z.string().max(4000).nullable().default(null),
    durataStimataMin: z.number().int().min(0).max(60 * 24 * 365).nullable().default(null),
  })
  .strict();

export const prereqInputSchema = z
  .object({
    descrizione: z.string().min(1).max(2000),
    tipo: z.enum(prereqTypeValues).default("ALTRO"),
    obbligatorio: z.boolean().default(true),
  })
  .strict();

export const pitfallInputSchema = z
  .object({
    descrizione: z.string().min(1).max(2000),
    gravita: z.enum(severityValues).default("NOTA"),
  })
  .strict();

export const costInputSchema = z
  .object({
    descrizione: z.string().min(1).max(500),
    importoCent: z.number().int(),
    valuta: z.string().length(3).default("EUR"),
  })
  .strict();

export const referenceInputSchema = z
  .object({
    tipo: z.enum(refTypeValues),
    valore: z.string().min(1).max(1000),
  })
  .strict();

/**
 * Gli stati che l'utente puo' assegnare a mano.
 *
 * `BOZZA_AUDIO`, `IN_ELABORAZIONE` ed `ESTRAZIONE_FALLITA` appartengono alla
 * pipeline, non a lui: sono le tre facce del «questa scheda sta nascendo». Un
 * `PATCH` che potesse rimettere una scheda finita in `IN_ELABORAZIONE`
 * descriverebbe un lavoro che nessun worker sta facendo.
 */
export const editableCardStatusValues = ["DA_RIVEDERE", "COMPLETA", "ARCHIVIATA"] as const;
export type EditableCardStatus = (typeof editableCardStatusValues)[number];

/**
 * Corpo del `PATCH`. Ogni campo e' opzionale, e l'assenza significa «non
 * toccare»: e' la differenza fra `PATCH` e `PUT`.
 *
 * Le liste figlie si sostituiscono per intero. Un formato di patch granulare
 * (aggiungi il passo 3, sposta il 4) chiederebbe al client di conoscere gli id
 * delle righe e di gestire i conflitti fra due schede aperte; sostituire
 * l'array intero e' l'unica semantica che non ha casi limite. La contiguita'
 * degli `ordine` la garantisce il server rinumerando, cosi' il client non deve
 * nemmeno mandare il campo.
 *
 * Non ci sono `costoTotaleCent`, `volteEseguita` e `ultimaVerifica`: sono
 * derivati (da `costs` il primo, dalle `Execution` gli altri due). Un campo
 * derivato scrivibile e' un invito a farlo mentire.
 */
export const updateProcedureBodySchema = z
  .object({
    titolo: z.string().min(1).max(200).optional(),
    trigger: z.string().max(2000).nullable().optional(),
    esito: z.string().max(2000).nullable().optional(),
    validitaEsito: z.string().max(500).nullable().optional(),

    durataStimataMin: z.number().int().min(0).max(60 * 24 * 365).nullable().optional(),

    luogoNome: z.string().max(300).nullable().optional(),
    luogoDettaglio: z.string().max(500).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),

    scope: z.enum(scopeValues).optional(),
    clientLabel: z.string().max(200).nullable().optional(),
    visibility: z.enum(visibilityValues).optional(),
    status: z.enum(editableCardStatusValues).optional(),
    contieneDatiSensibili: z.boolean().optional(),

    tag: z.array(z.string().min(1).max(60)).max(30).optional(),
    steps: z.array(stepInputSchema).max(100).optional(),
    prereqs: z.array(prereqInputSchema).max(50).optional(),
    pitfalls: z.array(pitfallInputSchema).max(50).optional(),
    costs: z.array(costInputSchema).max(50).optional(),
    refs: z.array(referenceInputSchema).max(50).optional(),
  })
  .strict()
  // Un `PATCH {}` non e' un errore di dominio ma quasi certamente e' un errore
  // del chiamante, e risponderebbe 200 senza aver fatto niente.
  .refine((body) => Object.keys(body).length > 0, {
    message: "Il corpo del PATCH non contiene nessun campo da modificare",
  });

// ---------------------------------------------------------------------------
// Esecuzioni (§8)
// ---------------------------------------------------------------------------

/**
 * `eseguitaIl` e' opzionale perche' il caso normale e' «adesso», ma esiste
 * perche' il caso vero e' «me ne sono ricordato stasera».
 */
export const createExecutionBodySchema = z
  .object({
    esito: z.enum(outcomeValues),
    nota: z.string().max(2000).nullable().default(null),
    eseguitaIl: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Ricerca (§7)
// ---------------------------------------------------------------------------

/**
 * Da quale dei due canali e' arrivato il risultato.
 *
 * Non e' un dettaglio di debug: e' cio' che permette a un'interfaccia di dire
 * «contiene le tue parole» invece di «somiglia a quello che cerchi», e a chi
 * tara la ricerca di capire quale dei due indici sta facendo il lavoro.
 */
export const searchMatchValues = ["TESTO", "SEMANTICA", "ENTRAMBE"] as const;
export type SearchMatch = (typeof searchMatchValues)[number];
export const SearchMatch = {
  TESTO: "TESTO",
  SEMANTICA: "SEMANTICA",
  ENTRAMBE: "ENTRAMBE",
} as const satisfies Record<SearchMatch, SearchMatch>;

export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_PAGE_SIZE_MAX = 50;

export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(300),
    scope: z.enum(scopeValues).optional(),
    limit: z.coerce.number().int().min(1).max(SEARCH_PAGE_SIZE_MAX).default(SEARCH_PAGE_SIZE),
  })
  .strict();

export const searchHitSchema = procedureSummarySchema
  .extend({
    /**
     * Punteggio di fusione (RRF). Confrontabile solo dentro la stessa risposta:
     * non e' una percentuale di pertinenza e non ha un massimo teorico utile.
     */
    score: z.number(),
    matchedBy: z.enum(searchMatchValues),
  })
  .strict();

export const searchResultSchema = z
  .object({
    q: z.string(),
    items: z.array(searchHitSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------

export type ProcedureStep = z.infer<typeof stepSchema>;
export type ProcedurePrerequisite = z.infer<typeof prerequisiteSchema>;
export type ProcedurePitfall = z.infer<typeof pitfallSchema>;
export type ProcedureCost = z.infer<typeof costSchema>;
export type ProcedureReference = z.infer<typeof referenceSchema>;
export type ProcedureAttachment = z.infer<typeof attachmentSchema>;
export type ProcedureExecution = z.infer<typeof executionSchema>;
export type ProcedureRecording = z.infer<typeof procedureRecordingSchema>;

export type ProcedureSummary = z.infer<typeof procedureSummarySchema>;
export type ProcedureDetail = z.infer<typeof procedureDetailSchema>;
export type ProcedureList = z.infer<typeof procedureListSchema>;

export type ListProceduresQuery = z.infer<typeof listProceduresQuerySchema>;
export type ListProceduresQueryInput = z.input<typeof listProceduresQuerySchema>;

export type UpdateProcedureBody = z.infer<typeof updateProcedureBodySchema>;
export type UpdateProcedureBodyInput = z.input<typeof updateProcedureBodySchema>;

export type StepInput = z.infer<typeof stepInputSchema>;
export type PrereqInput = z.infer<typeof prereqInputSchema>;
export type PitfallInput = z.infer<typeof pitfallInputSchema>;
export type CostInput = z.infer<typeof costInputSchema>;
export type ReferenceInput = z.infer<typeof referenceInputSchema>;

export type CreateExecutionBody = z.infer<typeof createExecutionBodySchema>;
export type CreateExecutionBodyInput = z.input<typeof createExecutionBodySchema>;

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchQueryInput = z.input<typeof searchQuerySchema>;
export type SearchHit = z.infer<typeof searchHitSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
