import type {
  AuthSession,
  ProcedureDetail,
  RecordingState,
  RedactionProposal,
  RedactionReport,
} from "@wikimylife/shared";

/**
 * Oggetti del contratto, costruiti da un caso che ne cura tre campi su venti.
 *
 * `RecordingState` ne ha diciotto e `.strict()`: scriverli tutti a ogni caso
 * avrebbe sepolto sotto quindici righe di `null` la sola riga che il test sta
 * dicendo — `status: "IN_ELABORAZIONE"`, per esempio. Il risultato pratico e'
 * che al secondo caso si copia il primo e si cambia un campo, e da li' in poi
 * nessuno sa piu' quali valori siano scelti e quali siano rimasti attaccati.
 *
 * Il predefinito e' il caso noioso: una registrazione appena caricata che non
 * ha mai fallito, un rapporto senza proposte. Ogni test scrive solo cio' che lo
 * rende diverso da quello, e diventa leggibile la differenza.
 *
 * `Partial<>` e non un costruttore con dieci parametri: chi legge il caso vede
 * il nome del campo accanto al valore, e non deve contare le virgole.
 */

export function unaRegistrazione(campi: Partial<RecordingState> = {}): RecordingState {
  return {
    id: "reg-1",
    status: "BOZZA_AUDIO",
    recordedAt: "2026-01-01T10:00:00.000Z",
    durationMs: 42_000,
    mimeType: "audio/webm",
    sizeBytes: 1024,
    capturedOffline: false,
    placeLabel: null,
    transcript: null,
    transcriptSource: null,
    procedureId: null,
    retryCount: 0,
    lastError: null,
    nextAttemptAt: null,
    duplicate: null,
    extraction: null,
    issues: [],
    updatedAt: "2026-01-01T10:00:00.000Z",
    ...campi,
  };
}

/**
 * Una scheda completa e senza niente di notevole.
 *
 * Trentaquattro campi, di cui un test ne guarda due. Il predefinito e' la
 * scheda che non ha nessuno dei bollini: non obsoleta, senza dati sensibili,
 * `COMPLETA`, mai eseguita — cosi' un caso che vuole uno di quei riquadri lo
 * chiede, e chi legge sa che gli altri non ci sono per scelta e non per caso.
 *
 * Le liste sono vuote tranne `steps`, che ne ha uno: una scheda senza nemmeno
 * un passo non e' un caso limite interessante, e' una scheda che l'estrazione
 * non avrebbe mai prodotto.
 */
export function unaScheda(campi: Partial<ProcedureDetail> = {}): ProcedureDetail {
  return {
    id: "proc-1",
    titolo: "Richiedere il casellario giudiziale",
    trigger: null,
    esito: null,
    scope: "PERSONALE",
    clientLabel: null,
    visibility: "PRIVATA",
    status: "COMPLETA",
    durataStimataMin: null,
    costoTotaleCent: null,
    luogoNome: null,
    ultimaVerifica: null,
    volteEseguita: 0,
    contieneDatiSensibili: false,
    obsoleta: false,
    numeroPassi: 1,
    tag: [],
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    validitaEsito: null,
    luogoDettaglio: null,
    latitude: null,
    longitude: null,
    forkedFromId: null,
    steps: [
      {
        id: "s1",
        ordine: 1,
        azione: "Andare in Procura",
        dettaglio: null,
        durataStimataMin: null,
      },
    ],
    prereqs: [],
    pitfalls: [],
    costs: [],
    refs: [],
    attachments: [],
    executions: [],
    recordings: [],
    ...campi,
  };
}

/** Il vocale da cui la scheda e' nata, nella forma ridotta del dettaglio. */
export function unVocale(
  campi: Partial<ProcedureDetail["recordings"][number]> = {},
): ProcedureDetail["recordings"][number] {
  return {
    id: "reg-1",
    recordedAt: "2026-01-01T10:00:00.000Z",
    durationMs: 42_000,
    transcript: "Sono andato in Procura e ho chiesto il casellario",
    ...campi,
  };
}

export function unaProposta(campi: Partial<RedactionProposal> = {}): RedactionProposal {
  return {
    id: "p1",
    kind: "EMAIL",
    origine: "CERTA",
    campo: "steps[0].testo",
    etichetta: "Passo 1",
    valore: "mario@example.com",
    sostituzione: "[email]",
    contesto: "scrivere a mario@example.com prima di andare",
    ...campi,
  };
}

export function unReport(campi: Partial<RedactionReport> = {}): RedactionReport {
  return {
    procedureId: "proc-1",
    proposte: [],
    assistenza: "NON_CONFIGURATA",
    contieneDatiSensibili: true,
    ...campi,
  };
}

export function unaSessione(): AuthSession {
  return {
    user: {
      id: "u1",
      email: "mario@example.com",
      locale: "it-IT",
      createdAt: "2026-01-01T10:00:00.000Z",
    },
    tokens: {
      accessToken: "a",
      refreshToken: "r",
      expiresIn: 900,
      tokenType: "Bearer",
    },
  };
}
