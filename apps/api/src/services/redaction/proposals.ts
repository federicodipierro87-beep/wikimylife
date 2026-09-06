import {
  applyRedactions,
  detectSensitive,
  type RedactionProposal,
  type SensitiveMatch,
  type UpdateProcedureBody,
} from "@wikimylife/shared";
import type { ProcedureDetailRow } from "../ports/ProcedureRepository.js";

/**
 * Da scheda a proposte di redazione, e ritorno (§9).
 *
 * Due funzioni pure e nessun accesso al database: `detectSensitive` sa leggere
 * un testo e non sa niente di schede, questo file sa quali testi ci sono in una
 * scheda e non sa niente di come si riconosce un IBAN. La divisione paga nel
 * momento in cui si aggiunge un campo alla scheda — si tocca solo
 * `campiRedigibili`, e i rilevatori restano provati dove sono.
 *
 * Il ritorno passa da `UpdateProcedureBody`, cioe' dalla stessa `PATCH` che usa
 * chiunque altro. Scrivere qui una via diretta al repository sarebbe stato piu'
 * corto e avrebbe scavalcato il ricalcolo di `searchText`: una scheda redatta
 * resterebbe cercabile per il codice fiscale che le e' stato tolto, e nessun
 * test l'avrebbe notato perche' nessuno cerca un codice fiscale.
 */

// ---------------------------------------------------------------------------
// Quali testi guardare
// ---------------------------------------------------------------------------

interface CampoTesto {
  /** Percorso nel documento: `titolo`, `steps.2.azione`. */
  readonly campo: string;
  /** Lo stesso, in italiano, per l'interfaccia. */
  readonly etichetta: string;
  readonly testo: string;
}

/**
 * Tutti i campi di testo libero di una scheda, in ordine di lettura.
 *
 * Non ci sono le trascrizioni delle registrazioni, e non e' una dimenticanza:
 * la trascrizione e' il verbale di cio' che l'utente ha detto, non un campo
 * della scheda. Riscriverla farebbe perdere la corrispondenza fra l'audio e il
 * suo testo, che e' l'unica cosa che permette di capire da dove e' uscita una
 * scheda sbagliata. La §9 parla di cio' che si condivide, e cio' che si
 * condivide e' la scheda.
 *
 * Non ci sono nemmeno le note delle esecuzioni: sono il diario privato di chi
 * ha eseguito la procedura, e non escono dalla scheda quando la scheda esce.
 */
export function campiRedigibili(row: ProcedureDetailRow): readonly CampoTesto[] {
  const campi: CampoTesto[] = [];

  const scalare = (campo: string, etichetta: string, testo: string | null): void => {
    if (testo !== null && testo.length > 0) {
      campi.push({ campo, etichetta, testo });
    }
  };

  scalare("titolo", "Titolo", row.titolo);
  scalare("trigger", "Quando serve", row.trigger);
  scalare("esito", "Cosa si ottiene", row.esito);
  scalare("validitaEsito", "Validita'", row.validitaEsito);
  scalare("clientLabel", "Cliente", row.clientLabel);
  scalare("luogoNome", "Luogo", row.luogoNome);
  scalare("luogoDettaglio", "Dettaglio del luogo", row.luogoDettaglio);

  row.steps.forEach((step, i) => {
    const numero = String(step.ordine);
    scalare(`steps.${String(i)}.azione`, `Passo ${numero} — azione`, step.azione);
    scalare(`steps.${String(i)}.dettaglio`, `Passo ${numero} — dettaglio`, step.dettaglio);
  });

  row.prereqs.forEach((p, i) => {
    scalare(`prereqs.${String(i)}.descrizione`, `Prerequisito ${String(i + 1)}`, p.descrizione);
  });

  row.pitfalls.forEach((p, i) => {
    scalare(`pitfalls.${String(i)}.descrizione`, `Trappola ${String(i + 1)}`, p.descrizione);
  });

  row.costs.forEach((c, i) => {
    scalare(`costs.${String(i)}.descrizione`, `Costo ${String(i + 1)}`, c.descrizione);
  });

  // I riferimenti sono il caso che merita di essere guardato: un `TELEFONO` che
  // contiene un numero di telefono non e' un errore, e' cio' che quel campo e'.
  // Proporlo lo stesso e' giusto — il centralino di un ufficio pubblico si
  // condivide, il cellulare della persona che ci lavora no, e la differenza non
  // la puo' vedere una regex. La §9 fa decidere all'utente, e questo e' uno dei
  // casi per cui lo fa fare a lui.
  row.refs.forEach((r, i) => {
    scalare(`refs.${String(i)}.valore`, `Riferimento ${String(i + 1)} (${r.tipo})`, r.valore);
  });

  return campi;
}

// ---------------------------------------------------------------------------
// Proposte
// ---------------------------------------------------------------------------

/** Quanti caratteri mostrare prima e dopo il dato, nel contesto. */
const FINESTRA = 40;

function contestoDi(testo: string, match: SensitiveMatch): string {
  const da = Math.max(0, match.start - FINESTRA);
  const a = Math.min(testo.length, match.end + FINESTRA);

  const prefisso = da > 0 ? "…" : "";
  const suffisso = a < testo.length ? "…" : "";

  return `${prefisso}${testo.slice(da, a)}${suffisso}`;
}

function idDi(campo: string, match: SensitiveMatch): string {
  return `${campo}:${String(match.start)}:${match.kind}`;
}

export function proposteDi(row: ProcedureDetailRow): readonly RedactionProposal[] {
  const proposte: RedactionProposal[] = [];

  for (const campo of campiRedigibili(row)) {
    for (const match of detectSensitive(campo.testo)) {
      proposte.push({
        id: idDi(campo.campo, match),
        kind: match.kind,
        campo: campo.campo,
        etichetta: campo.etichetta,
        valore: match.value,
        sostituzione: match.replacement,
        contesto: contestoDi(campo.testo, match),
      });
    }
  }

  return proposte;
}

// ---------------------------------------------------------------------------
// Applicazione
// ---------------------------------------------------------------------------

/** Il testo di ogni campo dopo aver applicato solo le proposte confermate. */
function testiRedatti(
  row: ProcedureDetailRow,
  confermate: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const risultato = new Map<string, string>();

  for (const campo of campiRedigibili(row)) {
    const accettati = detectSensitive(campo.testo).filter((m) =>
      confermate.has(idDi(campo.campo, m)),
    );
    if (accettati.length > 0) {
      risultato.set(campo.campo, applyRedactions(campo.testo, accettati));
    }
  }

  return risultato;
}

/**
 * Gli id proposti dalla scheda com'e' adesso.
 *
 * Il servizio lo usa per rifiutare una conferma che non corrisponde a niente
 * invece di ignorarla: una conferma che non si ritrova significa che il testo
 * e' cambiato fra la GET e la POST, e applicare in silenzio le altre vorrebbe
 * dire dire all'utente «fatto» dopo aver fatto qualcosa di diverso da cio' che
 * aveva guardato.
 */
export function idProposti(row: ProcedureDetailRow): ReadonlySet<string> {
  return new Set(proposteDi(row).map((p) => p.id));
}

/**
 * La `PATCH` equivalente alla redazione confermata.
 *
 * Gli array figli si mandano interi perche' la `PATCH` li sostituisce per
 * intero: mandare solo i passi toccati cancellerebbe gli altri. E' il tipo di
 * dettaglio che non si vede finche' la scheda non ha piu' di un passo.
 */
export function patchDiRedazione(
  row: ProcedureDetailRow,
  confermate: ReadonlySet<string>,
): UpdateProcedureBody {
  const redatti = testiRedatti(row, confermate);
  const testo = (campo: string, originale: string): string => redatti.get(campo) ?? originale;
  const testoOpzionale = (campo: string, originale: string | null): string | null =>
    redatti.get(campo) ?? originale;

  const toccaSteps = row.steps.some(
    (_, i) => redatti.has(`steps.${String(i)}.azione`) || redatti.has(`steps.${String(i)}.dettaglio`),
  );
  const toccaPrereqs = row.prereqs.some((_, i) => redatti.has(`prereqs.${String(i)}.descrizione`));
  const toccaPitfalls = row.pitfalls.some((_, i) => redatti.has(`pitfalls.${String(i)}.descrizione`));
  const toccaCosts = row.costs.some((_, i) => redatti.has(`costs.${String(i)}.descrizione`));
  const toccaRefs = row.refs.some((_, i) => redatti.has(`refs.${String(i)}.valore`));

  return {
    ...(redatti.has("titolo") ? { titolo: testo("titolo", row.titolo) } : {}),
    ...(redatti.has("trigger") ? { trigger: testoOpzionale("trigger", row.trigger) } : {}),
    ...(redatti.has("esito") ? { esito: testoOpzionale("esito", row.esito) } : {}),
    ...(redatti.has("validitaEsito")
      ? { validitaEsito: testoOpzionale("validitaEsito", row.validitaEsito) }
      : {}),
    ...(redatti.has("clientLabel")
      ? { clientLabel: testoOpzionale("clientLabel", row.clientLabel) }
      : {}),
    ...(redatti.has("luogoNome") ? { luogoNome: testoOpzionale("luogoNome", row.luogoNome) } : {}),
    ...(redatti.has("luogoDettaglio")
      ? { luogoDettaglio: testoOpzionale("luogoDettaglio", row.luogoDettaglio) }
      : {}),

    ...(toccaSteps
      ? {
          steps: row.steps.map((s, i) => ({
            azione: testo(`steps.${String(i)}.azione`, s.azione),
            dettaglio: testoOpzionale(`steps.${String(i)}.dettaglio`, s.dettaglio),
            durataStimataMin: s.durataStimataMin,
          })),
        }
      : {}),
    ...(toccaPrereqs
      ? {
          prereqs: row.prereqs.map((p, i) => ({
            descrizione: testo(`prereqs.${String(i)}.descrizione`, p.descrizione),
            tipo: p.tipo,
            obbligatorio: p.obbligatorio,
          })),
        }
      : {}),
    ...(toccaPitfalls
      ? {
          pitfalls: row.pitfalls.map((p, i) => ({
            descrizione: testo(`pitfalls.${String(i)}.descrizione`, p.descrizione),
            gravita: p.gravita,
          })),
        }
      : {}),
    ...(toccaCosts
      ? {
          costs: row.costs.map((c, i) => ({
            descrizione: testo(`costs.${String(i)}.descrizione`, c.descrizione),
            importoCent: c.importoCent,
            valuta: c.valuta,
          })),
        }
      : {}),
    ...(toccaRefs
      ? {
          refs: row.refs.map((r, i) => ({
            tipo: r.tipo,
            valore: testo(`refs.${String(i)}.valore`, r.valore),
          })),
        }
      : {}),
  };
}
