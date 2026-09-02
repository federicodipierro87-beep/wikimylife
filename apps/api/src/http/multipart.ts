import {
  MAX_AUDIO_BYTES,
  RECORDING_UPLOAD_FIELDS,
  captureMetadataSchema,
  isAcceptedAudioMimeType,
  type CaptureMetadata,
} from "@wikimylife/shared";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { AppError } from "../errors/AppError.js";
import type { UploadedAudio } from "../services/recordings.service.js";
import { parseBody } from "./validate.js";

/**
 * Parsing del multipart senza dipendenze.
 *
 * `Response.formData()` fa parte di Node dalla 18 (e' l'undici incorporato, lo
 * stesso parser che usa `fetch`) e restituisce oggetti `File` veri, con nome,
 * tipo e byte. Confezionare il corpo grezzo in una `Response` e chiedere a lei
 * di interpretarlo costa una riga e sostituisce `busboy` o `multer`.
 *
 * La differenza non e' solo il peso della dipendenza: un parser di multipart e'
 * codice che tocca byte non fidati prima di qualunque autenticazione, quindi e'
 * superficie d'attacco. Averne uno solo, quello del runtime, gia' aggiornato
 * dalle patch di Node, e' meglio che averne due.
 *
 * Il limite si applica DUE volte, di proposito: `express.raw` ferma il flusso
 * prima di riempire la memoria, il controllo sul `File` prende il caso in cui
 * il multipart contenga piu' parti e nessuna singola sfori.
 */

/** Spazio per intestazioni, boundary e la parte dei metadati. */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/**
 * Legge il corpo grezzo di una richiesta multipart.
 *
 * `type: () => true` perche' il rifiuto del content-type sbagliato lo fa il
 * gestore, con un 415 del contratto: lasciandolo a `express.raw` la richiesta
 * arriverebbe con `req.body` vuoto e il messaggio d'errore parlerebbe di un
 * campo mancante invece che del vero problema.
 */
export function rawUploadBody(): RequestHandler {
  const raw = express.raw({
    type: () => true,
    limit: MAX_AUDIO_BYTES + MULTIPART_OVERHEAD_BYTES,
  });

  return function readRawBody(req: Request, res: Response, next: NextFunction): void {
    raw(req, res, (error: unknown) => {
      if (error === undefined || error === null) {
        next();
        return;
      }
      if (
        typeof error === "object" &&
        "type" in error &&
        (error as { type?: unknown }).type === "entity.too.large"
      ) {
        next(
          AppError.payloadTooLarge(
            `L'audio supera il limite di ${String(Math.floor(MAX_AUDIO_BYTES / (1024 * 1024)))} MB.`,
          ),
        );
        return;
      }
      next(error);
    });
  };
}

export interface RecordingUpload {
  readonly audio: UploadedAudio;
  readonly metadata: CaptureMetadata;
}

function requireMultipart(req: Request): void {
  const contentType = req.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw AppError.unsupportedMediaType(
      "Il caricamento richiede multipart/form-data con le parti 'audio' e 'metadata'.",
    );
  }
}

export async function parseRecordingUpload(req: Request): Promise<RecordingUpload> {
  requireMultipart(req);

  const body: unknown = req.body;
  if (!(body instanceof Uint8Array) || body.byteLength === 0) {
    throw AppError.validationFailed([{ path: [], message: "Corpo della richiesta vuoto" }]);
  }

  let form: FormData;
  try {
    form = await new Response(body, {
      headers: { "content-type": req.get("content-type") ?? "" },
    }).formData();
  } catch {
    // Un multipart malformato non e' un errore di dominio e non e' colpa
    // nostra: e' una richiesta che non si riesce nemmeno a leggere.
    throw AppError.validationFailed([
      { path: [], message: "Corpo multipart non interpretabile" },
    ]);
  }

  const rawMetadata = form.get(RECORDING_UPLOAD_FIELDS.metadata);
  if (typeof rawMetadata !== "string") {
    throw AppError.validationFailed([
      {
        path: [RECORDING_UPLOAD_FIELDS.metadata],
        message: "Parte 'metadata' mancante: attesa una stringa JSON",
      },
    ]);
  }

  let parsedMetadata: unknown;
  try {
    parsedMetadata = JSON.parse(rawMetadata);
  } catch {
    throw AppError.validationFailed([
      { path: [RECORDING_UPLOAD_FIELDS.metadata], message: "JSON dei metadati non valido" },
    ]);
  }

  // Parametro di tipo esplicito: `captureMetadataSchema` ha dei `.default()`,
  // quindi input e output differiscono e l'inferenza sceglierebbe l'input —
  // dove `capturedOffline` e' ancora opzionale. Qui serve l'output, cioe' il
  // valore con i default gia' applicati.
  const metadata = parseBody<CaptureMetadata>(captureMetadataSchema, parsedMetadata);

  const audio = form.get(RECORDING_UPLOAD_FIELDS.audio);
  if (audio === null || typeof audio === "string") {
    throw AppError.validationFailed([
      { path: [RECORDING_UPLOAD_FIELDS.audio], message: "Parte 'audio' mancante" },
    ]);
  }

  if (audio.size === 0) {
    throw AppError.validationFailed([
      { path: [RECORDING_UPLOAD_FIELDS.audio], message: "L'audio e' vuoto" },
    ]);
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    throw AppError.payloadTooLarge(
      `L'audio pesa ${String(audio.size)} byte, il limite e' ${String(MAX_AUDIO_BYTES)}.`,
    );
  }

  // Il tipo autorevole e' quello DICHIARATO nei metadati, non quello della
  // parte multipart: e' il valore che finisce in `Recording.mimeType` ed e'
  // quello su cui l'utente puo' rispondere. Il browser mette in `File.type`
  // cio' che gli pare (spesso stringa vuota per un Blob costruito a mano),
  // quindi fidarsene renderebbe il comportamento dipendente dal client.
  if (!isAcceptedAudioMimeType(metadata.mimeType)) {
    throw AppError.unsupportedMediaType(`Formato audio non supportato: ${metadata.mimeType}`);
  }

  const bytes = new Uint8Array(await audio.arrayBuffer());

  return { audio: { bytes, mimeType: metadata.mimeType }, metadata };
}
