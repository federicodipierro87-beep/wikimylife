/**
 * Enum condivisi fra api, worker e web.
 *
 * Sono `const object` + union type, non `enum` di TypeScript e MAI un re-export
 * di `@prisma/client`: quel pacchetto trascina il runtime Prisma, che nel bundle
 * del browser non deve entrare nemmeno per sbaglio.
 *
 * La parita' con gli enum generati da Prisma e' garantita a compile time da
 * `apps/api/src/db/enum-parity.ts`, che non emette una riga di JavaScript.
 *
 * Ogni enum e' dichiarato due volte di proposito: la tupla `...Values` serve a
 * `z.enum()` (che pretende `[string, ...string[]]`), l'oggetto serve al codice
 * chiamante per non scrivere stringhe magiche.
 */

export const scopeValues = ["PERSONALE", "LAVORO", "CLIENTE"] as const;
export type Scope = (typeof scopeValues)[number];
export const Scope = {
  PERSONALE: "PERSONALE",
  LAVORO: "LAVORO",
  CLIENTE: "CLIENTE",
} as const satisfies Record<Scope, Scope>;

export const visibilityValues = ["PRIVATA", "CONDIVISA_TEAM", "PUBBLICA"] as const;
export type Visibility = (typeof visibilityValues)[number];
export const Visibility = {
  PRIVATA: "PRIVATA",
  CONDIVISA_TEAM: "CONDIVISA_TEAM",
  PUBBLICA: "PUBBLICA",
} as const satisfies Record<Visibility, Visibility>;

/**
 * Ciclo di vita della *scheda*. [D1] `ESTRAZIONE_FALLITA` e' citato nella §5
 * della specifica ma manca dall'enum della §6.
 */
export const cardStatusValues = [
  "BOZZA_AUDIO",
  "IN_ELABORAZIONE",
  "DA_RIVEDERE",
  "COMPLETA",
  "ARCHIVIATA",
  "ESTRAZIONE_FALLITA",
] as const;
export type CardStatus = (typeof cardStatusValues)[number];
export const CardStatus = {
  BOZZA_AUDIO: "BOZZA_AUDIO",
  IN_ELABORAZIONE: "IN_ELABORAZIONE",
  DA_RIVEDERE: "DA_RIVEDERE",
  COMPLETA: "COMPLETA",
  ARCHIVIATA: "ARCHIVIATA",
  ESTRAZIONE_FALLITA: "ESTRAZIONE_FALLITA",
} as const satisfies Record<CardStatus, CardStatus>;

/**
 * Ciclo di vita dell'*elaborazione* di una registrazione. [D2]
 * Disgiunto da CardStatus: assegnare l'uno dove serve l'altro deve essere un
 * errore di compilazione, non un bug scoperto in produzione.
 */
export const recordingStatusValues = [
  "BOZZA_AUDIO",
  "IN_ELABORAZIONE",
  "ESTRAZIONE_FALLITA",
  "ESTRATTO",
  "DUPLICATO_SOSPETTO",
] as const;
export type RecordingStatus = (typeof recordingStatusValues)[number];
export const RecordingStatus = {
  BOZZA_AUDIO: "BOZZA_AUDIO",
  IN_ELABORAZIONE: "IN_ELABORAZIONE",
  ESTRAZIONE_FALLITA: "ESTRAZIONE_FALLITA",
  ESTRATTO: "ESTRATTO",
  /**
   * [D9] Estrazione riuscita, validazione superata, scheda deliberatamente NON
   * creata: la §5 impone di proporre l'aggiornamento di quella esistente. E'
   * uno stato terminale in attesa di una decisione umana, non un fallimento.
   */
  DUPLICATO_SOSPETTO: "DUPLICATO_SOSPETTO",
} as const satisfies Record<RecordingStatus, RecordingStatus>;

export const prereqTypeValues = [
  "DOCUMENTO",
  "CREDENZIALE",
  "DENARO",
  "TEMPO",
  "PERSONA",
  "STRUMENTO",
  "ALTRO",
] as const;
export type PrereqType = (typeof prereqTypeValues)[number];
export const PrereqType = {
  DOCUMENTO: "DOCUMENTO",
  CREDENZIALE: "CREDENZIALE",
  DENARO: "DENARO",
  TEMPO: "TEMPO",
  PERSONA: "PERSONA",
  STRUMENTO: "STRUMENTO",
  ALTRO: "ALTRO",
} as const satisfies Record<PrereqType, PrereqType>;

export const severityValues = ["BLOCCANTE", "FASTIDIO", "NOTA"] as const;
export type Severity = (typeof severityValues)[number];
export const Severity = {
  BLOCCANTE: "BLOCCANTE",
  FASTIDIO: "FASTIDIO",
  NOTA: "NOTA",
} as const satisfies Record<Severity, Severity>;

export const refTypeValues = ["PERSONA", "URL", "TELEFONO", "UFFICIO", "SISTEMA"] as const;
export type RefType = (typeof refTypeValues)[number];
export const RefType = {
  PERSONA: "PERSONA",
  URL: "URL",
  TELEFONO: "TELEFONO",
  UFFICIO: "UFFICIO",
  SISTEMA: "SISTEMA",
} as const satisfies Record<RefType, RefType>;

export const outcomeValues = ["FUNZIONATO", "CAMBIATA", "FALLITA"] as const;
export type Outcome = (typeof outcomeValues)[number];
export const Outcome = {
  FUNZIONATO: "FUNZIONATO",
  CAMBIATA: "CAMBIATA",
  FALLITA: "FALLITA",
} as const satisfies Record<Outcome, Outcome>;

/**
 * `_meta.tipoRilevato` del contratto §4.1. Vive solo nel contratto di
 * estrazione: non e' una colonna, quindi non esiste in Prisma.
 */
export const detectedTypeValues = [
  "PROCEDURA",
  "NOTA_SEMPLICE",
  "NON_CLASSIFICABILE",
] as const;
export type DetectedType = (typeof detectedTypeValues)[number];
export const DetectedType = {
  PROCEDURA: "PROCEDURA",
  NOTA_SEMPLICE: "NOTA_SEMPLICE",
  NON_CLASSIFICABILE: "NON_CLASSIFICABILE",
} as const satisfies Record<DetectedType, DetectedType>;
