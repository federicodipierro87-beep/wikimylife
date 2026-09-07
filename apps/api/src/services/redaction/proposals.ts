import {
  applyRedactions,
  assistedPlaceholder,
  detectSensitive,
  type AssistedKind,
  type RedactionFinding,
  type RedactionProposal,
  type SensitiveMatch,
  type TextSpan,
  type UpdateProcedureBody,
} from "@wikimylife/shared";
import { createHash } from "node:crypto";
import type { ProcedureDetailRow } from "../ports/ProcedureRepository.js";

/**
 * Da scheda a proposte di redazione, e ritorno (§9).
 *
 * Funzioni pure e nessun accesso al database: `detectSensitive` sa leggere un
 * testo e non sa niente di schede, questo file sa quali testi ci sono in una
 * scheda e non sa niente di come si riconosce un IBAN. La divisione paga nel
 * momento in cui si aggiunge un campo alla scheda — si tocca solo
 * `campiRedigibili`, e i rilevatori restano provati dove sono.
 *
 * Vale anche per la meta' assistita: nemmeno qui si chiama un modello. Il
 * provider parla altrove e passa di qui cio' che ha detto, come una lista di
 * stringhe; questo file decide dove stanno davvero nel testo, quali si
 * accavallano su cose gia' prese, e come si scrive un id che fra dieci minuti
 * si possa ancora verificare. Sono tutte cose che si provano senza rete.
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

function contestoDi(testo: string, tratto: { readonly start: number; readonly end: number }): string {
  const da = Math.max(0, tratto.start - FINESTRA);
  const a = Math.min(testo.length, tratto.end + FINESTRA);

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
        origine: "CERTA",
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
// La meta' assistita
// ---------------------------------------------------------------------------

/**
 * Quante cifre dello sha256 finiscono nell'id.
 *
 * Otto sono quattro miliardi di valori, contro le poche decine di proposte di
 * una scheda: la collisione che servirebbe per far passare una conferma per
 * un'altra non e' un rischio che valga altre ventiquattro cifre in ogni id.
 * L'impronta non protegge un segreto — il valore in chiaro sta nella risposta
 * della GET, perche' l'utente lo deve leggere — serve solo a riconoscere che
 * quei caratteri sono ancora quelli.
 */
const IMPRONTA_CIFRE = 8;

function improntaDi(valore: string): string {
  return createHash("sha256").update(valore, "utf8").digest("hex").slice(0, IMPRONTA_CIFRE);
}

function idAssistitoDi(campo: string, start: number, valore: string, kind: AssistedKind): string {
  return `${campo}:${String(start)}:${String(valore.length)}:${kind}:${improntaDi(valore)}`;
}

/**
 * Sotto i tre caratteri non si propone niente.
 *
 * Un modello che risponde «di» o «il» produce un elenco di trecento proposte
 * identiche fra loro, e la passata «una per una» diventa impraticabile — cioe'
 * il modo piu' rapido di far chiudere questa schermata a chi la sta usando.
 */
const MIN_LUNGHEZZA = 3;

/** Il tetto oltre il quale l'elenco non e' piu' una revisione ma un elenco. */
const MAX_PROPOSTE_ASSISTITE = 200;

const RE_PAROLA = /[\p{L}\p{N}]/u;

function attaccato(testo: string, indice: number): boolean {
  const carattere = testo[indice];
  return carattere !== undefined && RE_PAROLA.test(carattere);
}

/**
 * Dove compare `valore` dentro `testo`, per intero e non dentro un'altra parola.
 *
 * Il modello dice cosa ha visto, non dove: contare i caratteri e' la cosa che
 * un modello linguistico sbaglia piu' volentieri, e un offset sbagliato di due
 * posizioni toglie due lettere alla parola accanto dopo che l'utente ha
 * confermato guardando il testo giusto. Cercare la stringa costa niente ed e'
 * esatto.
 *
 * Il controllo sui bordi evita che «Rossi» si porti via mezzo «Rossini». Vale
 * solo dove il valore comincia o finisce con una lettera o una cifra: un
 * indirizzo che finisce con «, 12» non deve smettere di essere trovato perche'
 * dopo c'e' una virgola.
 */
function occorrenzeDi(testo: string, valore: string): readonly number[] {
  const trovate: number[] = [];

  let da = 0;
  for (;;) {
    const start = testo.indexOf(valore, da);
    if (start < 0) {
      return trovate;
    }
    const end = start + valore.length;
    if (!attaccato(testo, start - 1) && !attaccato(testo, end)) {
      trovate.push(start);
    }
    // Avanza di uno e non di `valore.length`: due occorrenze possono
    // sovrapporsi, e saltarle vorrebbe dire non proporre la seconda.
    da = start + 1;
  }
}

/**
 * Le proposte che nascono da cio' che il modello dice di aver visto.
 *
 * Tre filtri, e nessuno dei tre e' facoltativo. Il primo: un valore che nel
 * campo non c'e' si butta, perche' un modello che si inventa una stringa si
 * inventerebbe altrettanto volentieri il punto dove sta. Il secondo: cio' che
 * un rilevatore ha gia' preso resta suo — un IBAN che il modello chiama
 * «identificativo» non deve diventare una seconda proposta sopra la prima, e
 * due sostituzioni sullo stesso tratto di testo lo lascerebbero a pezzi. Il
 * terzo: fra due proposte assistite che si sovrappongono vince la piu' lunga,
 * per la stessa ragione per cui vince nei rilevatori, cioe' che copre piu'
 * dato — «Mario Rossi» e non «Mario».
 */
export function proposteAssistiteDi(
  row: ProcedureDetailRow,
  findings: readonly RedactionFinding[],
): readonly RedactionProposal[] {
  const campi = new Map(campiRedigibili(row).map((c) => [c.campo, c]));
  const proposte: RedactionProposal[] = [];

  // Le piu' lunghe per prime, cosi' che siano loro a occupare il posto.
  const ordinati = [...findings].sort((a, b) => b.valore.length - a.valore.length);

  for (const [nomeCampo, campo] of campi) {
    const occupati: TextSpan[] = [...detectSensitive(campo.testo)];
    const nate: { readonly start: number; readonly proposta: RedactionProposal }[] = [];

    for (const finding of ordinati) {
      if (finding.campo !== nomeCampo || finding.valore.length < MIN_LUNGHEZZA) {
        continue;
      }

      for (const start of occorrenzeDi(campo.testo, finding.valore)) {
        const end = start + finding.valore.length;
        if (occupati.some((o) => start < o.end && o.start < end)) {
          continue;
        }

        const sostituzione = assistedPlaceholder[finding.kind];
        occupati.push({ start, end, replacement: sostituzione });
        nate.push({
          start,
          proposta: {
            id: idAssistitoDi(nomeCampo, start, finding.valore, finding.kind),
            kind: finding.kind,
            origine: "ASSISTITA",
            campo: nomeCampo,
            etichetta: campo.etichetta,
            valore: finding.valore,
            sostituzione,
            contesto: contestoDi(campo.testo, { start, end }),
          },
        });
      }
    }

    // Dentro il campo si legge in ordine di testo, non di lunghezza: l'ordine
    // di scorrimento e' quello con cui l'utente rilegge la scheda.
    proposte.push(...nate.sort((a, b) => a.start - b.start).map((n) => n.proposta));
  }

  return proposte.slice(0, MAX_PROPOSTE_ASSISTITE);
}

// ---------------------------------------------------------------------------
// Applicazione
// ---------------------------------------------------------------------------

/**
 * Cosa fare di un elenco di conferme arrivate dal client.
 *
 * Tre esiti e non due perche' i due modi di sbagliare vogliono due risposte
 * diverse. `SCADUTE` e' la scheda cambiata fra la lettura e la scrittura, ed e'
 * cio' che capita davvero: si rilegge e si riprova. `SOVRAPPOSTE` non puo'
 * capitare a un client che rimandi indietro gli id che ha ricevuto, perche' le
 * proposte non si sovrappongono mai per costruzione — dirlo con lo stesso
 * messaggio dell'altro caso manderebbe a rileggere le proposte chi ha un
 * problema che rileggerle non risolve.
 */
export type EsitoConferme =
  | { readonly kind: "OK"; readonly perCampo: ReadonlyMap<string, readonly TextSpan[]> }
  | { readonly kind: "SCADUTE"; readonly quante: number }
  | { readonly kind: "SOVRAPPOSTE" };

/**
 * Da un id alla porzione di testo che cancellerebbe, oggi.
 *
 * Le due forme si riconoscono dal numero di pezzi, e nessun percorso di campo
 * contiene i due punti — sono `titolo`, `steps.2.azione`, `refs.0.valore`.
 *
 * La forma corta si verifica rifacendo i conti: il rilevatore ripassa sul testo
 * com'e' adesso e l'id deve ritrovarsi fra i suoi. La forma lunga si verifica
 * rileggendo: quei caratteri, quella lunghezza, quell'impronta. Il risultato e'
 * lo stesso — o si cancella esattamente cio' che l'utente ha guardato, o non si
 * cancella niente — ma la seconda strada non chiede al modello di ripetersi,
 * cosa che un modello non sa fare.
 */
function trattoDi(row: ProcedureDetailRow, id: string): { campo: string; span: TextSpan } | null {
  const pezzi = id.split(":");
  const nomeCampo = pezzi[0];
  if (nomeCampo === undefined) {
    return null;
  }

  const campo = campiRedigibili(row).find((c) => c.campo === nomeCampo);
  if (campo === undefined) {
    return null;
  }

  if (pezzi.length === 3) {
    const match = detectSensitive(campo.testo).find((m) => idDi(nomeCampo, m) === id);
    return match === undefined ? null : { campo: nomeCampo, span: match };
  }

  if (pezzi.length === 5) {
    const [, grezzoStart, grezzaLunghezza, grezzoKind, impronta] = pezzi;
    if (
      grezzoStart === undefined ||
      grezzaLunghezza === undefined ||
      grezzoKind === undefined ||
      impronta === undefined
    ) {
      return null;
    }

    const sostituzione = assistedPlaceholder[grezzoKind as AssistedKind] as string | undefined;
    if (sostituzione === undefined) {
      return null;
    }

    const start = Number(grezzoStart);
    const lunghezza = Number(grezzaLunghezza);
    if (!Number.isInteger(start) || !Number.isInteger(lunghezza) || start < 0 || lunghezza <= 0) {
      return null;
    }

    const end = start + lunghezza;
    const valore = campo.testo.slice(start, end);
    // `slice` non si lamenta di uscire dal testo, restituisce cio' che trova:
    // senza questo controllo un id che punta oltre la fine passerebbe grazie
    // all'impronta di una stringa piu' corta di quella che dichiara.
    if (valore.length !== lunghezza || improntaDi(valore) !== impronta) {
      return null;
    }

    return { campo: nomeCampo, span: { start, end, replacement: sostituzione } };
  }

  return null;
}

/**
 * Le conferme, tradotte nei tratti da sostituire, oppure il motivo per cui no.
 *
 * Tutto o niente. Una conferma che non si ritrova significa che il testo e'
 * cambiato fra la GET e la POST: gli offset delle altre valgono per una
 * versione della scheda che non esiste piu', e applicarle lo stesso
 * cancellerebbe caratteri scelti guardando un altro testo.
 */
export function risolviConferme(
  row: ProcedureDetailRow,
  conferme: readonly string[],
): EsitoConferme {
  const perCampo = new Map<string, TextSpan[]>();
  let scadute = 0;

  for (const id of conferme) {
    const tratto = trattoDi(row, id);
    if (tratto === null) {
      scadute += 1;
      continue;
    }
    const gia = perCampo.get(tratto.campo) ?? [];
    gia.push(tratto.span);
    perCampo.set(tratto.campo, gia);
  }

  if (scadute > 0) {
    return { kind: "SCADUTE", quante: scadute };
  }

  // Due sostituzioni sullo stesso tratto lascerebbero il campo a pezzi:
  // `applyRedactions` lavora da destra a sinistra e non ha modo di accorgersi
  // che il secondo `end` cade dentro il primo segnaposto appena scritto.
  for (const spans of perCampo.values()) {
    const ordinati = [...spans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordinati.length; i += 1) {
      const precedente = ordinati[i - 1];
      const corrente = ordinati[i];
      if (precedente !== undefined && corrente !== undefined && corrente.start < precedente.end) {
        return { kind: "SOVRAPPOSTE" };
      }
    }
  }

  return { kind: "OK", perCampo };
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
  perCampo: ReadonlyMap<string, readonly TextSpan[]>,
): UpdateProcedureBody {
  const redatti = new Map<string, string>();
  for (const campo of campiRedigibili(row)) {
    const spans = perCampo.get(campo.campo);
    if (spans !== undefined && spans.length > 0) {
      redatti.set(campo.campo, applyRedactions(campo.testo, spans));
    }
  }
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
