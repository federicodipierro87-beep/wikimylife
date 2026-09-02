import { z } from "zod";
import { errorCodeValues } from "./codes.js";

/**
 * Forma unica del corpo di errore dell'API:
 *
 *   { "error": { "code": "...", "message": "...", "details"?: [...] } }
 *
 * Lo schema sta in shared e non nell'API di proposito: il client tipizzato lo
 * usa per validare cio' che riceve, quindi un cambio di forma rompe la
 * compilazione di entrambi i lati nello stesso commit.
 *
 * `details` esiste solo per VALIDATION_FAILED. Un errore di autenticazione non
 * porta mai stato interno: dire "utente inesistente" invece di "credenziali
 * errate" e' un oracolo gratis per chi enumera indirizzi.
 */

export const validationIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  })
  .strict();

export const errorBodySchema = z
  .object({
    error: z
      .object({
        code: z.enum(errorCodeValues),
        message: z.string(),
        details: z.array(validationIssueSchema).optional(),
      })
      .strict(),
  })
  .strict();

export type ValidationIssue = z.infer<typeof validationIssueSchema>;
export type ErrorBody = z.infer<typeof errorBodySchema>;
