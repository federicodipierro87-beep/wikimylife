import { z } from "zod";
import { recordingStatusValues } from "../enums.js";
import { extractionContractSchema } from "../extraction/contract.schema.js";

/**
 * Contratto HTTP della pipeline di ingestione.
 *
 * Come per l'autenticazione, gli stessi schemi valgono sui due lati: le rotte
 * validano l'ingresso, il client tipizzato valida cio' che torna.
 */

/**
 * Metadati di cattura della §2.
 *
 * Viaggiano come parte `metadata` di un multipart, in JSON, accanto alla parte
 * `audio`. Un JSON e non otto campi di testo separati perche' in un multipart
 * ogni valore e' una stringa: `durationMs` arriverebbe come `"12000"` e
 * `capturedOffline` come `"false"` — che e' `true`. Coercizioni del genere sono
 * il posto in cui i bug si nascondono meglio.
 *
 * `sizeBytes` non c'e' di proposito: e' il server a misurare i byte ricevuti.
 * Un client che dichiara la propria dimensione dichiara qualcosa che il server
 * puo' verificare da solo, quindi non ha motivo di chiederglielo.
 */
export const captureMetadataSchema = z
  .object({
    /** ISO 8601. `offset: true` accetta `+02:00` oltre a `Z`. */
    recordedAt: z.string().datetime({ offset: true }),
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60 * 1000),
    mimeType: z.string().min(1).max(120),
    capturedOffline: z.boolean().default(false),
    /** §2: lingua attesa dallo STT. */
    deviceLocale: z.string().min(2).max(35).nullable().default(null),
    latitude: z.number().min(-90).max(90).nullable().default(null),
    longitude: z.number().min(-180).max(180).nullable().default(null),
    /** Da reverse geocoding sul dispositivo: riempie il luogo senza dettarlo. */
    placeLabel: z.string().max(300).nullable().default(null),
  })
  .strict();

/**
 * Esito di una singola regola della §5.
 *
 * Si chiama `Extraction`Issue e non `Validation`Issue perche' quel nome e' gia'
 * preso dagli errori di validazione HTTP (`errors/body.ts`), che sono un'altra
 * cosa: quelli dicono che la RICHIESTA e' malformata, questi che il MODELLO ha
 * prodotto qualcosa di imperfetto. Le due liste non vanno mai confuse.
 */
export const extractionIssueSchema = z
  .object({
    /** Identificatore stabile della regola, es. `passi.ordine_non_contiguo`. */
    rule: z.string(),
    /** Punto del contratto §4.1 a cui si riferisce, es. `costi[1].importoCent`. */
    path: z.string(),
    message: z.string(),
    /**
     * `true` = la scheda non si puo' creare (§5: stato `ESTRAZIONE_FALLITA`).
     * `false` = la scheda si crea in `DA_RIVEDERE`.
     */
    blocking: z.boolean(),
  })
  .strict();

/** Il "aggiorna quella esistente" della §5. */
export const duplicateSuggestionSchema = z
  .object({
    procedureId: z.string(),
    titolo: z.string(),
    /** Similarita' coseno misurata. Sopra 0.85 per definizione. */
    similarity: z.number(),
  })
  .strict();

export const recordingErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    /** ISO 8601. */
    at: z.string(),
  })
  .strict();

/**
 * Stato di avanzamento dell'elaborazione: la risposta di tutte e tre le rotte.
 *
 * Una sola forma per `POST`, `GET` e `retry` cosi' il client ha un tipo solo e
 * il polling non deve distinguere da dove viene la risposta.
 */
export const recordingStateSchema = z
  .object({
    id: z.string(),
    status: z.enum(recordingStatusValues),

    recordedAt: z.string(),
    durationMs: z.number().int(),
    mimeType: z.string(),
    sizeBytes: z.number().int().nullable(),
    capturedOffline: z.boolean(),
    placeLabel: z.string().nullable(),

    /** §3: la trascrizione grezza si mostra all'utente, sempre. */
    transcript: z.string().nullable(),
    transcriptSource: z.string().nullable(),

    /** Valorizzato solo a stato `ESTRATTO`. */
    procedureId: z.string().nullable(),

    retryCount: z.number().int(),
    lastError: recordingErrorSchema.nullable(),

    /**
     * Quando il worker riprovera' da solo, se lo fara'.
     *
     * Sta nel contratto perche' senza di esso un'attesa e' indistinguibile da un
     * guasto: dopo il primo fallimento la registrazione resta in `BOZZA_AUDIO`
     * per un minuto senza che accada niente, e un'interfaccia che non sa dirlo
     * mostra «in attesa» per un minuto — cioe' invita a premere «riprova»
     * proprio mentre il tempo sta gia' facendo il suo lavoro. `null` vuol dire
     * che non c'e' un'attesa in corso: la riga e' prendibile adesso, oppure il
     * ciclo automatico ha smesso e tocca a un umano.
     */
    nextAttemptAt: z.string().nullable(),

    /** Valorizzato solo a stato `DUPLICATO_SOSPETTO`. */
    duplicate: duplicateSuggestionSchema.nullable(),

    /**
     * L'estrazione conforme al contratto, quando c'e'. E' cio' che permette
     * all'utente di decidere sul duplicato: senza vedere la scheda proposta,
     * "aggiorna quella esistente" sarebbe una domanda a scatola chiusa.
     */
    extraction: extractionContractSchema.nullable(),

    /**
     * Le regole della §5 non superate. Non sono conservate su database: la
     * validazione e' deterministica e pura, quindi si ricalcola da
     * `rawExtraction` a ogni lettura. Una colonna in piu' sarebbe solo un
     * secondo posto da cui andare fuori sincrono.
     */
    issues: z.array(extractionIssueSchema),

    updatedAt: z.string(),
  })
  .strict();

/**
 * Le registrazioni che non sono ancora diventate una scheda.
 *
 * Non pagina, e non e' una svista: e' una lista di cose in sospeso, e se e'
 * lunga il problema non e' che manca il pulsante «successive». `MAX` esiste
 * solo per non spedire un archivio intero a chi ha lasciato il worker spento
 * per un mese.
 */
export const pendingRecordingsSchema = z
  .object({
    items: z.array(recordingStateSchema),
  })
  .strict();

export type PendingRecordings = z.infer<typeof pendingRecordingsSchema>;

/** Quante se ne restituiscono al massimo. */
export const MAX_PENDING_RECORDINGS = 50;

export type CaptureMetadata = z.infer<typeof captureMetadataSchema>;
export type CaptureMetadataInput = z.input<typeof captureMetadataSchema>;
export type ExtractionIssue = z.infer<typeof extractionIssueSchema>;
export type DuplicateSuggestion = z.infer<typeof duplicateSuggestionSchema>;
export type RecordingError = z.infer<typeof recordingErrorSchema>;
export type RecordingState = z.infer<typeof recordingStateSchema>;

/** Nomi delle parti del multipart. Condivisi per non scriverli due volte. */
export const RECORDING_UPLOAD_FIELDS = {
  audio: "audio",
  metadata: "metadata",
} as const;

/**
 * Limite di dimensione dell'audio accettato dall'API.
 *
 * 25 MB e' il tetto di Whisper: accettare piu' di quanto lo stadio 2 sappia
 * elaborare significherebbe salvare audio destinati a fallire per sempre.
 */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Tipi di audio accettati. `MediaRecorder` nel browser produce webm/opus, un
 * recorder iOS produce m4a/aac; il resto e' la lista di cio' che Whisper
 * dichiara di saper leggere.
 */
export const ACCEPTED_AUDIO_MIME_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
] as const;

/**
 * Confronta ignorando i parametri: `MediaRecorder` manda
 * `audio/webm;codecs=opus`, non `audio/webm`.
 */
export function isAcceptedAudioMimeType(mimeType: string): boolean {
  const base = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return (ACCEPTED_AUDIO_MIME_TYPES as readonly string[]).includes(base);
}
