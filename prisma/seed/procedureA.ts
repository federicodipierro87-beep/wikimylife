import type { PrismaClient } from "@prisma/client";
import type { ExtractionContract } from "@wikimylife/shared";
import { extractionContractSchema } from "@wikimylife/shared";
import { SEED_IDS } from "./config.js";
import { createProcedure, type ProcedureBlueprint } from "./support.js";

/**
 * Procedura A — il caso felice completo.
 *
 * "Richiedere il casellario giudiziale": PERSONALE, COMPLETA, con tutte le
 * tabelle figlie popolate e due esecuzioni riuscite. E' la procedura su cui si
 * verifica a mano che le invarianti tornino e che l'operatore coseno risponda.
 */

const RECORDED_AT = new Date("2026-01-12T09:14:00.000Z");

const blueprint: ProcedureBlueprint = {
  id: SEED_IDS.procedureA,
  userId: SEED_IDS.user,
  titolo: "Richiedere il casellario giudiziale",
  trigger: "Quando un bando o un datore di lavoro chiede il certificato del casellario",
  esito: "Certificato del casellario giudiziale in PDF firmato digitalmente",
  validitaEsito: "Sei mesi dalla data di rilascio",
  luogoNome: "Procura della Repubblica",
  luogoDettaglio: "Ufficio locale del casellario, sportello 3 — oppure online su certificatipenali.giustizia.it",
  latitude: 45.4642,
  longitude: 9.19,
  scope: "PERSONALE",
  status: "COMPLETA",
  contieneDatiSensibili: false,
  tags: ["burocrazia", "documenti", "certificati"],

  prereqs: [
    { descrizione: "Documento d'identita' in corso di validita'", tipo: "DOCUMENTO", obbligatorio: true },
    { descrizione: "SPID di livello 2 o CIE con PIN", tipo: "CREDENZIALE", obbligatorio: true },
    {
      descrizione: "Marca da bollo da 16 euro, acquistabile in tabaccheria o online",
      tipo: "DENARO",
      obbligatorio: true,
    },
  ],

  // Ordini contigui a partire da 1: e' la regola della §5, e il test di
  // integrazione la verifica proprio su questi dati.
  steps: [
    {
      ordine: 1,
      azione: "Comprare la marca da bollo da 16 euro",
      dettaglio: "In tabaccheria; conservare il codice identificativo di 14 cifre, va trascritto nella domanda",
      durataStimataMin: 10,
    },
    {
      ordine: 2,
      azione: "Accedere a certificatipenali.giustizia.it con SPID",
      dettaglio: "Il portale accetta SPID livello 2; con CIE serve il lettore o l'app CieID",
      durataStimataMin: 5,
    },
    {
      ordine: 3,
      azione: "Compilare la richiesta scegliendo l'uso del certificato",
      dettaglio:
        "L'uso dichiarato cambia il costo: per alcuni usi previsti dalla legge il bollo non serve. Leggere l'elenco prima di pagare",
      durataStimataMin: 15,
    },
    {
      ordine: 4,
      azione: "Pagare i diritti con pagoPA e inserire il codice della marca da bollo",
      dettaglio: "3,80 euro di diritti di segreteria, carta o conto",
      durataStimataMin: 10,
    },
    {
      ordine: 5,
      azione: "Scaricare il PDF firmato dall'area riservata",
      dettaglio: "Arriva entro qualche giorno lavorativo; il portale manda una mail quando e' pronto",
      durataStimataMin: 5,
    },
  ],

  pitfalls: [
    {
      descrizione:
        "Sbagliare l'uso dichiarato rende il certificato inutilizzabile per quel bando: va rifatto e ripagato da capo",
      gravita: "BLOCCANTE",
    },
    {
      descrizione: "Lo sportello fisico della Procura riceve solo la mattina, e senza appuntamento la fila e' lunga",
      gravita: "FASTIDIO",
    },
  ],

  // 1600 + 380 = 1980. Il totale NON e' scritto qui: lo calcola computeInvariants.
  costs: [
    { descrizione: "Marca da bollo", importoCent: 1600, valuta: "EUR" },
    { descrizione: "Diritti di segreteria", importoCent: 380, valuta: "EUR" },
  ],

  refs: [
    { tipo: "URL", valore: "https://certificatipenali.giustizia.it" },
    { tipo: "UFFICIO", valore: "Procura della Repubblica — Ufficio casellario, sportello 3" },
  ],

  executions: [
    {
      eseguitaIl: new Date("2026-01-12T10:30:00.000Z"),
      esito: "FUNZIONATO",
      nota: "Prima volta, quella raccontata nella nota vocale",
    },
    {
      eseguitaIl: new Date("2026-06-03T08:45:00.000Z"),
      esito: "FUNZIONATO",
      nota: "Rifatto per il bando comunale, procedura identica",
    },
  ],
};

/**
 * Trascrizione realistica: parlato, non un elenco puntato letto ad alta voce.
 * Serve a rendere i dati di prova utili in Fase 2, quando qui passera' l'LLM
 * vero e si potra' confrontare la sua estrazione con quella sotto.
 */
const TRANSCRIPT = [
  "Allora, mi segno come si fa il casellario giudiziale perche' me lo richiederanno ancora.",
  "Serve quando ti chiedono il certificato penale, tipo per i bandi.",
  "Prima cosa: marca da bollo da sedici euro, la prendi dal tabaccaio, e ti tieni il codice, quello lungo,",
  "perche' poi te lo chiede il sito. Poi entri su certificati penali punto giustizia con lo SPID,",
  "compili la domanda, e li' attenzione: devi dire per cosa ti serve il certificato,",
  "e se sbagli quella parte il certificato non te lo accettano e devi rifare tutto, l'ho rischiato.",
  "Paghi tre euro e ottanta di segreteria con pagoPA e metti il codice del bollo.",
  "Poi dopo qualche giorno ti arriva la mail e scarichi il PDF firmato dall'area riservata.",
  "In tutto quarantacinque minuti di lavoro mio, piu' l'attesa. Vale sei mesi.",
].join(" ");

/**
 * `rawExtraction` coerente con la trascrizione E con la procedura creata sopra.
 * Passa da `extractionContractSchema.parse` prima di finire nel database: un
 * JSON di esempio che non rispetta il contratto e' peggio di nessun esempio,
 * perche' verrebbe copiato.
 */
const rawExtraction: ExtractionContract = extractionContractSchema.parse({
  titolo: blueprint.titolo,
  trigger: blueprint.trigger,
  esito: blueprint.esito,
  validitaEsito: blueprint.validitaEsito,
  prerequisiti: blueprint.prereqs.map((p) => ({ ...p })),
  passi: blueprint.steps.map((s) => ({ ...s })),
  trappole: blueprint.pitfalls.map((p) => ({ ...p })),
  costi: blueprint.costs.map((c) => ({ ...c })),
  durataTotaleStimataMin: 45,
  luogo: {
    nome: blueprint.luogoNome,
    dettaglio: blueprint.luogoDettaglio,
    confermatoDaGps: true,
  },
  riferimenti: blueprint.refs.map((r) => ({ ...r })),
  tag: [...blueprint.tags],
  ambitoSuggerito: blueprint.scope,
  _meta: {
    confidenzaGlobale: 0.91,
    campiIncerti: [],
    domandeSuggerite: [],
    contieneDatiSensibili: false,
    tipoRilevato: "PROCEDURA",
  },
});

export async function seedProcedureA(prisma: PrismaClient): Promise<void> {
  await createProcedure(prisma, blueprint);

  await prisma.recording.create({
    data: {
      id: SEED_IDS.recordingA,
      userId: SEED_IDS.user,
      audioUrl: "seed://audio/casellario.webm",
      mimeType: "audio/webm;codecs=opus",
      sizeBytes: 412_339,
      durationMs: 78_000,
      recordedAt: RECORDED_AT,
      capturedOffline: false,
      deviceLocale: "it-IT",
      latitude: blueprint.latitude,
      longitude: blueprint.longitude,
      placeLabel: "Milano",
      status: "ESTRATTO",
      transcript: TRANSCRIPT,
      transcriptSource: "fake-transcription",
      transcribedAt: new Date("2026-01-12T09:15:30.000Z"),
      rawExtraction,
      extractionModel: "fake-extraction",
      extractedAt: new Date("2026-01-12T09:16:10.000Z"),
      procedureId: SEED_IDS.procedureA,
    },
  });
}
