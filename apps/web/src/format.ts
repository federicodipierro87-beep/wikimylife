import type {
  ProcedureDetail,
  ProcedurePitfall,
  ProcedureSummary,
  RecordingState,
} from "@wikimylife/shared";

/**
 * Le decisioni di presentazione, separate dai componenti.
 *
 * Qui non c'e' JSX di proposito: quali avvisi mostrare su una scheda e in che
 * ordine leggerne le sezioni sono regole di prodotto, e come tali si provano
 * con un `expect` invece che montando un albero React. E' anche il motivo per
 * cui questo file non tocca il DOM — i test unitari girano in Node.
 */

// ---------------------------------------------------------------------------
// Avvisi
// ---------------------------------------------------------------------------

export type BadgeKind = "revisione" | "obsoleta" | "fallita" | "elaborazione" | "archiviata";

export interface Badge {
  readonly kind: BadgeKind;
  readonly label: string;
}

/**
 * Gli avvisi di una scheda in lista, in ordine di urgenza.
 *
 * L'ordine non e' estetico: su uno schermo stretto si vede il primo e forse il
 * secondo. Davanti va cio' che cambia la decisione di aprirla — «questa scheda
 * potrebbe mentirti» prima di «questa scheda e' in archivio».
 *
 * `DA_RIVEDERE` e `obsoleta` possono comparire insieme: dicono due cose
 * diverse. La prima e' «il modello non era sicuro», la seconda «e' passato
 * troppo tempo dall'ultima volta che ha funzionato».
 */
export function badgesOf(p: Pick<ProcedureSummary, "status" | "obsoleta">): readonly Badge[] {
  const badges: Badge[] = [];

  if (p.status === "ESTRAZIONE_FALLITA") {
    badges.push({ kind: "fallita", label: "Estrazione fallita" });
  }
  if (p.status === "DA_RIVEDERE") {
    badges.push({ kind: "revisione", label: "Da rivedere" });
  }
  if (p.obsoleta) {
    badges.push({ kind: "obsoleta", label: "Da verificare" });
  }
  if (p.status === "BOZZA_AUDIO" || p.status === "IN_ELABORAZIONE") {
    badges.push({ kind: "elaborazione", label: "In elaborazione" });
  }
  if (p.status === "ARCHIVIATA") {
    badges.push({ kind: "archiviata", label: "Archiviata" });
  }

  return badges;
}

/**
 * Le trappole ordinate per gravita' decrescente.
 *
 * La §4 vuole le `BLOCCANTE` in evidenza, e "in evidenza" prima ancora che un
 * colore significa "in cima": chi legge una scheda mentre e' in fila allo
 * sportello arriva alla terza riga, non alla decima. A parita' di gravita'
 * l'ordine di arrivo si conserva — e' quello in cui l'utente le ha raccontate.
 */
const PESO_GRAVITA = { BLOCCANTE: 0, FASTIDIO: 1, NOTA: 2 } as const;

export function pitfallsInOrdine(
  pitfalls: readonly ProcedurePitfall[],
): readonly ProcedurePitfall[] {
  return [...pitfalls].sort((a, b) => PESO_GRAVITA[a.gravita] - PESO_GRAVITA[b.gravita]);
}

// ---------------------------------------------------------------------------
// Numeri e date
// ---------------------------------------------------------------------------

/** Centesimi in euro. `null` quando il costo non e' noto, che non e' zero. */
export function formatCosto(cent: number | null): string | null {
  if (cent === null) {
    return null;
  }
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(cent / 100);
}

/**
 * Minuti in una durata leggibile.
 *
 * "90 min" e' un numero da convertire mentalmente; "1 h 30 min" e' un tempo.
 * Sopra la giornata si passa ai giorni, perche' molte procedure burocratiche
 * durano settimane e "20160 min" non dice niente a nessuno.
 */
export function formatDurata(minuti: number | null): string | null {
  if (minuti === null) {
    return null;
  }
  if (minuti < 60) {
    return `${String(minuti)} min`;
  }
  if (minuti < 60 * 24) {
    const ore = Math.floor(minuti / 60);
    const resto = minuti % 60;
    return resto === 0 ? `${String(ore)} h` : `${String(ore)} h ${String(resto)} min`;
  }
  const giorni = Math.round(minuti / (60 * 24));
  return giorni === 1 ? "1 giorno" : `${String(giorni)} giorni`;
}

/** `mm:ss` per il contatore della registrazione e la durata dei vocali. */
export function formatDurataAudio(ms: number): string {
  const totale = Math.max(0, Math.floor(ms / 1000));
  const minuti = Math.floor(totale / 60);
  const secondi = totale % 60;
  return `${String(minuti)}:${String(secondi).padStart(2, "0")}`;
}

/**
 * Una data relativa in italiano.
 *
 * "3 giorni fa" si confronta a colpo d'occhio con "2 mesi fa"; "12/06/2026" no.
 * Sopra l'anno si torna alla data assoluta, dove il valore informativo e'
 * ricominciato a essere quello.
 */
export function formatQuando(iso: string | null, adesso = new Date()): string | null {
  if (iso === null) {
    return null;
  }
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) {
    return null;
  }

  const secondi = Math.round((adesso.getTime() - data.getTime()) / 1000);
  const distanza = Math.abs(secondi);

  if (distanza < 60) {
    return "adesso";
  }
  // Oltre l'anno il relativo smette di aiutare: "14 mesi fa" si ritraduce in
  // data a mente, tanto vale darla gia' fatta.
  if (distanza >= 365 * 86_400) {
    return new Intl.DateTimeFormat("it-IT", { dateStyle: "medium" }).format(data);
  }

  // Dalla piu' grande alla piu' piccola: vince la prima che ci sta dentro.
  const scale: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];

  const rtf = new Intl.RelativeTimeFormat("it-IT", { numeric: "auto" });
  for (const [unita, ampiezza] of scale) {
    if (distanza >= ampiezza) {
      return rtf.format(-Math.trunc(secondi / ampiezza), unita);
    }
  }

  return "adesso";
}

// ---------------------------------------------------------------------------
// Registrazioni non ancora diventate schede
// ---------------------------------------------------------------------------

export interface AvvisoRegistrazione {
  readonly kind: "attesa" | "lavorazione" | "ritento" | "ferma" | "duplicato";
  /** Cosa sta succedendo, in una riga. */
  readonly testo: string;
  /** Perche', quando c'e' un perche'. */
  readonly dettaglio: string | null;
  /** Se ha senso offrire «riprova»: cioe' se premerlo puo' cambiare qualcosa. */
  readonly riprovabile: boolean;
}

/**
 * Che cosa dire di una registrazione che non e' ancora una scheda.
 *
 * Il caso che giustifica questa funzione e' `ritento`. Una registrazione che ha
 * appena fallito resta in `BOZZA_AUDIO`, che e' lo stesso stato di una appena
 * caricata: guardando il solo `status` l'app direbbe «in attesa» per un'ora
 * dopo il terzo fallimento, cioe' mentirebbe due volte — nascondendo che
 * qualcosa e' andato storto, e facendo sembrare fermo un ciclo che sta
 * lavorando. La differenza sta in `nextAttemptAt`, che per questo e' nel
 * contratto.
 *
 * `riprovabile` non e' «il pulsante e' abilitato» ma «premerlo cambia
 * qualcosa». Durante un'attesa cambia: salta il backoff. In lavorazione no, e
 * su un duplicato nemmeno — la deduplicazione e' deterministica, quindi
 * rielaborare lo stesso audio ricade nello stesso verdetto, e un pulsante che
 * riporta al punto di partenza e' peggio di nessun pulsante.
 */
export function avvisoDi(r: RecordingState, adesso = new Date()): AvvisoRegistrazione | null {
  if (r.status === "ESTRATTO") {
    // Ha gia' la sua scheda: comparirebbe due volte nella stessa lista.
    return null;
  }

  if (r.status === "IN_ELABORAZIONE") {
    return {
      kind: "lavorazione",
      testo: "La sto ascoltando…",
      dettaglio: null,
      riprovabile: false,
    };
  }

  if (r.status === "DUPLICATO_SOSPETTO") {
    return {
      kind: "duplicato",
      testo: "Sembra una cosa che mi avevi gia' raccontato",
      dettaglio:
        r.duplicate === null
          ? null
          : `Somiglia a «${r.duplicate.titolo}». Se e' la stessa procedura, aprila e aggiungi li' quello che e' cambiato.`,
      riprovabile: false,
    };
  }

  if (r.status === "ESTRAZIONE_FALLITA") {
    return {
      kind: "ferma",
      testo: "Non sono riuscito a ricavarne una scheda",
      // Il messaggio del server e non il codice: `TRASCRIZIONE_FALLITA` non e'
      // una frase, e chi legge non ha il codice sorgente accanto.
      dettaglio: r.lastError?.message ?? null,
      riprovabile: true,
    };
  }

  // Da qui in giu' e' BOZZA_AUDIO, che vuol dire due cose diverse.
  const attesa = r.nextAttemptAt === null ? null : new Date(r.nextAttemptAt);
  if (attesa !== null && !Number.isNaN(attesa.getTime()) && attesa.getTime() > adesso.getTime()) {
    return {
      kind: "ritento",
      testo: `Ci riprovo ${formatQuando(r.nextAttemptAt, adesso) ?? "a breve"}`,
      dettaglio: r.lastError?.message ?? null,
      riprovabile: true,
    };
  }

  return {
    kind: "attesa",
    // Un fallimento gia' scaduto e' ancora un fallimento: dirlo evita che una
    // registrazione al secondo giro sembri appena arrivata.
    testo: r.lastError === null ? "In attesa di essere elaborata" : "Ci riprovo a momenti",
    dettaglio: r.lastError?.message ?? null,
    riprovabile: r.lastError !== null,
  };
}

// ---------------------------------------------------------------------------
// Revisione (§ Fase 4)
// ---------------------------------------------------------------------------

export interface Revisione {
  readonly campiIncerti: readonly string[];
  readonly domande: readonly string[];
}

/**
 * Le domande da proporre in revisione, raccolte dalle registrazioni di origine.
 *
 * Sono suggerimenti e non un modulo da compilare: la §4 dice che l'utente puo'
 * ignorarle e la scheda resta valida com'e'. Quindi niente qui restituisce
 * "manca questo": restituisce "forse vuoi aggiungere quest'altro".
 *
 * Senza `campiIncerti` non ci sono domande, anche se il modello ne avesse
 * proposte: le domande sono la conseguenza dell'incertezza dichiarata, e senza
 * incertezza sarebbero un questionario a caso.
 */
export function revisioneDa(
  metas: readonly ({ campiIncerti: readonly string[]; domandeSuggerite: readonly string[] } | null)[],
): Revisione {
  const campiIncerti = new Set<string>();
  const domande = new Set<string>();

  for (const meta of metas) {
    if (meta === null || meta.campiIncerti.length === 0) {
      continue;
    }
    for (const campo of meta.campiIncerti) {
      campiIncerti.add(campo);
    }
    for (const domanda of meta.domandeSuggerite) {
      domande.add(domanda);
    }
  }

  return { campiIncerti: [...campiIncerti], domande: [...domande] };
}

// ---------------------------------------------------------------------------
// Lettura della scheda
// ---------------------------------------------------------------------------

export type SezioneKind = "prereq" | "pitfall" | "step" | "costo" | "ref";

export interface Sezione {
  readonly kind: SezioneKind;
  readonly titolo: string;
  readonly conteggio: number;
}

/**
 * L'ordine di lettura imposto dalla §4: prerequisiti, trappole, passi.
 *
 * E' l'ordine in cui servono, non quello in cui sono stati raccontati.
 * Presentare i passi per primi vuol dire far arrivare alla riga «serve il
 * documento X» qualcuno che e' gia' uscito di casa senza. Le sezioni vuote
 * spariscono: una scheda con «Prerequisiti (0)» insegna a scorrere via le
 * intestazioni.
 */
export function sezioniDi(p: ProcedureDetail): readonly Sezione[] {
  const tutte: readonly Sezione[] = [
    { kind: "prereq", titolo: "Cosa serve prima", conteggio: p.prereqs.length },
    { kind: "pitfall", titolo: "Attenzione a", conteggio: p.pitfalls.length },
    { kind: "step", titolo: "Come si fa", conteggio: p.steps.length },
    { kind: "costo", titolo: "Quanto costa", conteggio: p.costs.length },
    { kind: "ref", titolo: "Riferimenti", conteggio: p.refs.length },
  ];
  return tutte.filter((s) => s.conteggio > 0);
}
