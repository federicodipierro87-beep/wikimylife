import {
  CardStatus,
  DetectedType,
  extractionContractSchema,
  type ExtractionContract,
  type ExtractionIssue,
  type Passo,
} from "@wikimylife/shared";

/**
 * Stadio 4 — validazione deterministica (§5).
 *
 * "controlli in codice — non affidati all'LLM per verificare sé stesso".
 * Questo modulo e' quindi codice puro: nessuna rete, nessun database, nessun
 * orologio. Entra un `unknown` (l'output integrale del modello), esce un
 * verdetto. E' cio' che lo rende testabile senza far girare niente, ed e' la
 * ragione per cui gli `issues` non hanno bisogno di una colonna: si
 * ricalcolano da `rawExtraction` ogni volta che servono.
 *
 * La deduplicazione, che pure sta nella §5, NON e' qui: ha bisogno del
 * database e degli embedding, quindi vive nella pipeline. Qui restano solo le
 * regole che si possono decidere guardando il JSON e basta.
 */

/**
 * Distinzione portante: un problema BLOCCANTE impedisce di creare la scheda,
 * uno non bloccante la fa nascere in `DA_RIVEDERE`.
 *
 * Serve perche' la specifica chiede due comportamenti diversi. "JSON non
 * conforme, altrimenti un solo retry poi `ESTRAZIONE_FALLITA`" e' un
 * fallimento; "se `confidenzaGlobale < 0.5` oppure `passi` è vuoto →
 * `DA_RIVEDERE`" e' una scheda che esiste e aspetta l'utente. Trattarli allo
 * stesso modo perderebbe dati nel primo caso o mostrerebbe schede vuote nel
 * secondo.
 */
export type ExtractionVerdict =
  | {
      readonly outcome: "RIFIUTATA";
      readonly contract: null;
      readonly cardStatus: null;
      readonly issues: readonly ExtractionIssue[];
    }
  | {
      readonly outcome: "ACCETTATA";
      readonly contract: ExtractionContract;
      readonly cardStatus: typeof CardStatus.COMPLETA | typeof CardStatus.DA_RIVEDERE;
      readonly issues: readonly ExtractionIssue[];
    };

export const ExtractionRule = {
  contrattoNonConforme: "contratto.non_conforme",
  titoloMancante: "titolo.mancante",
  titoloTroppoLungo: "titolo.troppo_lungo",
  passiVuoti: "passi.vuoti",
  passiOrdineNonContiguo: "passi.ordine_non_contiguo",
  costoImportoNegativo: "costi.importo_negativo",
  costoValutaNonIso: "costi.valuta_non_iso",
  confidenzaBassa: "meta.confidenza_bassa",
  confidenzaFuoriScala: "meta.confidenza_fuori_scala",
  tipoNonProcedura: "meta.tipo_non_procedura",
} as const;

/** §5: "titolo non vuoto e più corto di 80 caratteri". */
export const MAX_TITOLO_LENGTH = 80;

/** §5: "se `confidenzaGlobale < 0.5` [...] → stato `DA_RIVEDERE`". */
export const MIN_CONFIDENZA = 0.5;

/**
 * ISO 4217 e' tre lettere maiuscole. Non c'e' la tabella dei 180 codici attivi
 * di proposito: e' una lista che cambia (l'ultima volta nel 2024 con il codice
 * dello Zimbabwe) e che incorporata qui invecchierebbe in silenzio, iniziando a
 * rifiutare valute legittime. Il controllo di forma prende il caso che capita
 * davvero — "euro" o "EURO" al posto di "EUR" — senza pretendere di sapere
 * quali valute esistono oggi.
 */
const ISO_4217 = /^[A-Z]{3}$/;

function formatPath(segments: readonly (string | number)[]): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      out += `[${String(segment)}]`;
    } else {
      out += out === "" ? segment : `.${segment}`;
    }
  }
  return out;
}

function issue(
  rule: string,
  path: string,
  message: string,
  blocking: boolean,
): ExtractionIssue {
  return { rule, path, message, blocking };
}

/**
 * Rinumera i passi da 1 conservandone l'ordine relativo.
 *
 * Non e' cosmesi: `@@unique([procedureId, ordine])` rifiuta due passi con lo
 * stesso `ordine`, quindi un'estrazione che numera `1, 1, 3` non sarebbe
 * scrivibile affatto. Rinumerare permette di salvare comunque il contenuto —
 * che e' l'unica cosa non riproducibile — e di segnalare il problema con un
 * issue invece di perdere tutto.
 *
 * L'ordinamento e' stabile sul valore di `ordine` originale: si assume che il
 * modello abbia sbagliato a numerare, non a mettere in sequenza.
 */
export function normalizeSteps(passi: readonly Passo[]): Passo[] {
  return passi
    .map((passo, index) => ({ passo, index }))
    .sort((a, b) => (a.passo.ordine - b.passo.ordine) || (a.index - b.index))
    .map(({ passo }, index) => ({ ...passo, ordine: index + 1 }));
}

/** Le regole di dominio della §5, su un contratto gia' conforme allo schema. */
function domainIssues(contract: ExtractionContract): ExtractionIssue[] {
  const issues: ExtractionIssue[] = [];

  // --- titolo ---
  const titolo = contract.titolo?.trim() ?? "";
  if (titolo === "") {
    // Bloccante: `Procedure.titolo` e' NOT NULL e una scheda senza titolo non
    // e' ritrovabile in nessun modo. Meglio ESTRAZIONE_FALLITA, che resta
    // riprocessabile dalla trascrizione, che una riga inutilizzabile.
    issues.push(
      issue(
        ExtractionRule.titoloMancante,
        "titolo",
        "Il titolo e' assente o vuoto: la scheda non e' creabile.",
        true,
      ),
    );
  } else if (titolo.length >= MAX_TITOLO_LENGTH) {
    // Non bloccante, e il titolo NON viene troncato: tagliarlo a 80 caratteri
    // significherebbe decidere al posto dell'utente quale meta' buttare.
    issues.push(
      issue(
        ExtractionRule.titoloTroppoLungo,
        "titolo",
        `Il titolo ha ${String(titolo.length)} caratteri, il limite e' ${String(MAX_TITOLO_LENGTH)}.`,
        false,
      ),
    );
  }

  // --- passi ---
  if (contract.passi.length === 0) {
    issues.push(
      issue(ExtractionRule.passiVuoti, "passi", "Nessun passo estratto.", false),
    );
  } else {
    const ordini = contract.passi.map((p) => p.ordine);
    const atteso = ordini.map((_, i) => i + 1);
    const contiguo = ordini.every((value, i) => value === atteso[i]);
    if (!contiguo) {
      issues.push(
        issue(
          ExtractionRule.passiOrdineNonContiguo,
          "passi",
          `L'ordine dei passi e' ${ordini.join(", ")}: atteso ${atteso.join(", ")}. I passi verranno rinumerati.`,
          false,
        ),
      );
    }
  }

  // --- costi ---
  contract.costi.forEach((costo, index) => {
    if (costo.importoCent < 0) {
      issues.push(
        issue(
          ExtractionRule.costoImportoNegativo,
          formatPath(["costi", index, "importoCent"]),
          `Importo negativo (${String(costo.importoCent)}).`,
          false,
        ),
      );
    }
    if (!ISO_4217.test(costo.valuta)) {
      issues.push(
        issue(
          ExtractionRule.costoValutaNonIso,
          formatPath(["costi", index, "valuta"]),
          `Valuta "${costo.valuta}" non e' un codice ISO 4217 di tre lettere maiuscole.`,
          false,
        ),
      );
    }
  });

  // --- _meta ---
  const confidenza = contract._meta.confidenzaGlobale;
  if (!Number.isFinite(confidenza) || confidenza < 0 || confidenza > 1) {
    issues.push(
      issue(
        ExtractionRule.confidenzaFuoriScala,
        "_meta.confidenzaGlobale",
        `Confidenza ${String(confidenza)} fuori dall'intervallo 0-1.`,
        false,
      ),
    );
  } else if (confidenza < MIN_CONFIDENZA) {
    issues.push(
      issue(
        ExtractionRule.confidenzaBassa,
        "_meta.confidenzaGlobale",
        `Confidenza ${String(confidenza)} sotto la soglia di ${String(MIN_CONFIDENZA)}.`,
        false,
      ),
    );
  }

  if (contract._meta.tipoRilevato !== DetectedType.PROCEDURA) {
    // La regola 10 del prompt dice che una NOTA_SEMPLICE ha solo titolo e
    // trigger. La §5 non la nomina, ma il risultato — una scheda quasi vuota —
    // e' esattamente quello che `DA_RIVEDERE` esiste per rappresentare.
    // Segnalarlo con una regola propria evita che l'interfaccia debba dedurre
    // "sara' stata una nota" dall'assenza di passi.
    issues.push(
      issue(
        ExtractionRule.tipoNonProcedura,
        "_meta.tipoRilevato",
        `Il testo e' stato classificato ${contract._meta.tipoRilevato}, non PROCEDURA.`,
        false,
      ),
    );
  }

  return issues;
}

/**
 * Valida l'output integrale del modello.
 *
 * Due livelli in cascata: prima la forma (Zod, §4.1), poi il dominio (§5). Se
 * la forma non regge non si passa al dominio, perche' non ci sarebbe niente su
 * cui applicarlo.
 */
export function validateExtraction(raw: unknown): ExtractionVerdict {
  const parsed = extractionContractSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      outcome: "RIFIUTATA",
      contract: null,
      cardStatus: null,
      issues: parsed.error.issues.map((zodIssue) =>
        issue(
          ExtractionRule.contrattoNonConforme,
          formatPath(zodIssue.path),
          zodIssue.message,
          true,
        ),
      ),
    };
  }

  const contract = parsed.data;
  const issues = domainIssues(contract);

  if (issues.some((i) => i.blocking)) {
    return { outcome: "RIFIUTATA", contract: null, cardStatus: null, issues };
  }

  return {
    outcome: "ACCETTATA",
    contract,
    // Qualunque regola non superata manda la scheda in revisione. La §5 nomina
    // esplicitamente solo confidenza e passi vuoti, ma elenca gli altri
    // controlli come controlli: un controllo che fallisce senza conseguenze non
    // sarebbe un controllo, e `DA_RIVEDERE` e' l'unico stato che significa
    // "esiste, ma qualcuno la guardi".
    cardStatus: issues.length === 0 ? CardStatus.COMPLETA : CardStatus.DA_RIVEDERE,
    issues,
  };
}

/** Quando nessuna bloccante sa parlare italiano. */
const FORMA_ILLEGGIBILE = "Il modello ha risposto in un formato che non so leggere.";

/**
 * Traduce un verdetto RIFIUTATA nella frase che leggera' chi ha registrato.
 *
 * ## Perche' esiste
 *
 * Il messaggio scritto su `Recording.lastErrorMessage` non resta nei log:
 * attraversa `recordingErrorSchema.message`, arriva in
 * `RecordingState.lastError`, e `format.ts` lo mette nel `dettaglio` che la
 * lista delle registrazioni in sospeso stampa sotto il titolo dell'avviso.
 * Prima qui c'era una frase sola per tutti i rifiuti — «Estrazione non conforme
 * al contratto dopo N tentativi» — che nominava un contratto che l'utente non
 * ha mai visto. Il motivo vero era gia' calcolato, dentro le issue, e veniva
 * buttato via.
 *
 * ## Solo le bloccanti
 *
 * Una regola NON bloccante, per definizione, non e' il motivo per cui ci si e'
 * fermati: la scheda con quella sola sarebbe nata in `DA_RIVEDERE`. Elencarla
 * accanto a quella che blocca farebbe sembrare che bloccasse anche lei.
 *
 * Il prezzo e' che a volte si legge il sintomo invece della causa: un'estrazione
 * classificata `NON_CLASSIFICABILE` non ha titolo, quindi blocca su
 * `titolo.mancante` mentre `meta.tipo_non_procedura` — che spiega il perche' —
 * resta non bloccante e muta. E' un prezzo accettato: la trascrizione grezza si
 * stampa comunque sotto il messaggio (§3), e di solito da sola racconta il
 * resto.
 *
 * ## Perche' i messaggi di Zod non si citano
 *
 * Le issue del primo livello portano `zodIssue.message`, e senza un `errorMap`
 * — non ce n'e' uno — quella e' prosa inglese di libreria: «Expected string,
 * received null». Sostituirebbe una frase italiana inutile con una inglese
 * inutile, e appenderebbe cio' che legge l'utente al testo di un terzo, che puo'
 * riscriverlo in una versione minore senza che nessun test se ne accorga. E' la
 * stessa ragione per cui `definitivo.ts` non classifica gli errori leggendone il
 * corpo. Quindi per quel ramo una frase fissa, e i dettagli restano dove servono
 * a chi ripara: nel log e negli `issues` del contratto.
 */
export function motivoDelRifiuto(issues: readonly ExtractionIssue[]): string {
  const bloccanti = issues.filter((i) => i.blocking);
  const nostre = bloccanti.filter((i) => i.rule !== ExtractionRule.contrattoNonConforme);

  if (nostre.length > 0) {
    return nostre.map((i) => i.message).join(" ");
  }

  if (bloccanti.length > 0) {
    return FORMA_ILLEGGIBILE;
  }

  /* c8 ignore next 3 -- `validateExtraction` non produce mai una RIFIUTATA
     senza almeno una bloccante: il ramo Zod ne crea una per issue, quello di
     dominio ci arriva solo con `some(blocking)`. */
  return "Non sono riuscito a ricavarne una scheda.";
}
