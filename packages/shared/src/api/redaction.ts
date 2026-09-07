import { z } from "zod";
import { assistedKindValues, proposalOriginValues } from "../redaction/assisted.js";
import { sensitiveKindValues } from "../redaction/detect.js";

/**
 * Il contratto della passata di redazione (§9).
 *
 * Due rotte e non una, perche' la §9 chiede che le sostituzioni si facciano
 * «confermare una per una all'utente»: la lettura propone, la scrittura applica
 * solo cio' che e' stato confermato. Un'unica rotta che redigesse tutto in un
 * colpo sarebbe piu' corta da scrivere e da usare, e toglierebbe di mezzo
 * esattamente la cosa che la §9 vuole che ci sia — lo sguardo di qualcuno su
 * ogni singola sostituzione prima che avvenga.
 *
 * Il verso e' quello che conta: la redazione non e' una modifica che l'utente
 * descrive, e' una proposta che il server calcola e l'utente ratifica. Per
 * questo il corpo della POST non contiene testo — contiene solo gli
 * identificativi di cio' che si accetta.
 */

/**
 * L'identificativo di una proposta e' la sua posizione, non un numero
 * progressivo: `steps.2.azione:14:TELEFONO` dice campo, offset e tipo.
 *
 * E' deliberatamente derivato dal contenuto e non generato a caso, perche' non
 * esiste nessuna tabella dove conservare le proposte fra la GET e la POST. Il
 * server ricalcola le proposte sul testo com'e' in quel momento e accetta solo
 * gli id che ritrova: se qualcuno ha modificato la scheda nel frattempo, gli
 * offset non tornano, l'id non si ritrova e la POST fallisce invece di
 * cancellare un pezzo di testo diverso da quello che l'utente aveva guardato.
 *
 * Le proposte assistite hanno una forma piu' lunga —
 * `titolo:12:11:NOME_PERSONA:9f86d081` — perche' il ricalcolo li' non e'
 * possibile: richiamare il modello darebbe un elenco simile ma non identico, e
 * una conferma su cinque sparirebbe fra la GET e la POST per il solo fatto che
 * il modello ha cambiato idea. Al posto del ricalcolo c'e' l'impronta: campo,
 * offset, lunghezza e le prime cifre dello sha256 del valore. Il server rilegge
 * quei caratteri e li confronta con l'impronta, e applica solo se combaciano.
 * La garanzia e' la stessa di prima — non si cancella mai un testo diverso da
 * quello che l'utente ha guardato — ottenuta verificando invece che rifacendo.
 */
export const redactionProposalSchema = z
  .object({
    id: z.string().min(1),
    /**
     * I quattro tipi con un formato e i quattro senza, in un campo solo.
     *
     * Tenerli separati in due liste di proposte avrebbe costretto ogni pezzo di
     * interfaccia a saperlo, e la §9 chiede una passata, non due.
     */
    kind: z.enum([...sensitiveKindValues, ...assistedKindValues]),
    /**
     * Se dietro la proposta c'e' un checksum o un modello.
     *
     * L'interfaccia lo mostra e non lo nasconde dietro un ordinamento: una
     * proposta assistita e' un'ipotesi, e chi la conferma deve saperlo mentre la
     * conferma, non doverlo dedurre dal tipo.
     */
    origine: z.enum(proposalOriginValues),
    /** Il percorso nel documento: `titolo`, `steps.2.azione`, `refs.0.valore`. */
    campo: z.string().min(1),
    /** Lo stesso percorso in italiano, per l'interfaccia: «Passo 3 — azione». */
    etichetta: z.string().min(1),
    /** Il dato trovato, cosi' come compare. */
    valore: z.string().min(1),
    /** Cio' che lo sostituirebbe. */
    sostituzione: z.string().min(1),
    /**
     * Qualche parola prima e dopo, con il dato ancora dentro.
     *
     * Serve a rendere possibile il «una per una»: confermare una sostituzione
     * guardando solo il dato estratto dal suo contesto significa confermarla
     * alla cieca, ed e' proprio nel contesto che si vede se quel numero era il
     * cellulare di una persona o il centralino di un ufficio.
     */
    contesto: z.string(),
  })
  .strict();

/**
 * Se la meta' assistita ha girato, e se no perche'.
 *
 * Un `boolean` direbbe «no» allo stesso modo a chi non l'ha mai configurata e a
 * chi ce l'ha configurata e in questo momento non risponde. Sono due cose
 * diverse per chi guarda le proposte: nel primo caso l'elenco che ha davanti e'
 * completo per quel che questa installazione sa fare, nel secondo e' monco e
 * conviene riprovare fra un minuto prima di pubblicare.
 */
export const redactionAssistanceValues = ["ESEGUITA", "NON_CONFIGURATA", "NON_RIUSCITA"] as const;

export type RedactionAssistance = (typeof redactionAssistanceValues)[number];

export const redactionReportSchema = z
  .object({
    procedureId: z.string().min(1),
    proposte: z.array(redactionProposalSchema),
    assistenza: z.enum(redactionAssistanceValues),
    /**
     * Il flag della scheda, ripetuto qui perche' e' la ragione per cui questa
     * rotta viene chiamata e perche' cio' che l'utente deve decidere alla fine
     * riguarda lui: le proposte si applicano, il flag lo toglie una persona.
     */
    contieneDatiSensibili: z.boolean(),
  })
  .strict();

export const applyRedactionBodySchema = z
  .object({
    /**
     * Gli id confermati. Nessun testo: cio' che va scritto lo decide il server
     * rifacendo i conti, non il client mandandolo.
     *
     * Accettare del testo dal client renderebbe questa rotta un doppione della
     * `PATCH`, con la differenza di chiamarsi «redazione» — e sarebbe l'unico
     * modo di far passare per redazione una modifica qualunque.
     */
    conferme: z.array(z.string().min(1)).min(1).max(500),
  })
  .strict();

export type RedactionProposal = z.infer<typeof redactionProposalSchema>;
export type RedactionReport = z.infer<typeof redactionReportSchema>;
export type ApplyRedactionBody = z.infer<typeof applyRedactionBodySchema>;
