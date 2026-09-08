import {
  PROCEDURE_PAGE_SIZE,
  SEARCH_PAGE_SIZE,
  type AuthSession,
  type ProcedureDetail,
  type ProcedureList,
  type ProcedureSummary,
  type RecordingState,
  type RedactionProposal,
  type RedactionReport,
  type SearchHit,
  type SearchResult,
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
 * Una riga dell'elenco: la scheda vista da fuori.
 *
 * Diciannove campi, e il predefinito e' quello senza nessuno dei bollini: non
 * obsoleta, senza dati sensibili, `COMPLETA`, mai eseguita. Un caso che vuole
 * uno di quei riquadri lo chiede, e chi legge sa che gli altri mancano per
 * scelta e non per distrazione.
 *
 * Sta prima di `unaScheda` perche' `unaScheda` la usa: `ProcedureDetail` e'
 * `ProcedureSummary` piu' quindici campi, ed erano scritti due volte. Copiare
 * significa che il giorno in cui il sommario prende un campo nuovo, meta' dei
 * test lo hanno e meta' no — e nessuno sa quale meta' senza contarli.
 */
export function unaVoce(campi: Partial<ProcedureSummary> = {}): ProcedureSummary {
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
    ...campi,
  };
}

/**
 * Una scheda completa e senza niente di notevole.
 *
 * Trentaquattro campi, di cui un test ne guarda due. I primi diciannove sono
 * quelli di `unaVoce`; qui si aggiungono solo i quindici che il dettaglio ha in
 * piu'.
 *
 * Le liste sono vuote tranne `steps`, che ne ha uno: una scheda senza nemmeno
 * un passo non e' un caso limite interessante, e' una scheda che l'estrazione
 * non avrebbe mai prodotto.
 */
export function unaScheda(campi: Partial<ProcedureDetail> = {}): ProcedureDetail {
  return {
    ...unaVoce(),
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

/**
 * Una pagina dell'elenco.
 *
 * `total` non ha un valore fisso come gli altri campi: quando il caso non lo
 * scrive vale il numero di voci passate, cioe' «questa e' tutta la roba che
 * c'e'». Un `total: 1` predefinito accanto a una lista di tre voci sarebbe una
 * risposta che il server non manderebbe mai, e i test di paginazione
 * ragionerebbero su un'aritmetica impossibile.
 *
 * Chi vuole la pagina di mezzo scrive `total` a mano, ed e' esattamente li' che
 * il caso diventa interessante.
 */
export function unElenco(campi: Partial<ProcedureList> = {}): ProcedureList {
  const items = campi.items ?? [unaVoce()];
  return {
    items,
    total: items.length,
    limit: PROCEDURE_PAGE_SIZE,
    offset: 0,
    ...campi,
  };
}

/** Una scheda trovata dalla ricerca: la voce dell'elenco piu' il perche'. */
export function unRisultato(campi: Partial<SearchHit> = {}): SearchHit {
  return {
    ...unaVoce(),
    score: 0.5,
    matchedBy: "TESTO",
    ...campi,
  };
}

/**
 * Una risposta della ricerca.
 *
 * `hasMore: false` e `offset: 0` di predefinito, che e' il caso in cui la
 * paginazione non si disegna affatto: chi la vuole la chiede, e nel caso si
 * legge subito quale delle due cose l'ha fatta comparire.
 */
export function unaRicerca(campi: Partial<SearchResult> = {}): SearchResult {
  return {
    q: "casellario",
    items: [unRisultato()],
    limit: SEARCH_PAGE_SIZE,
    offset: 0,
    hasMore: false,
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
