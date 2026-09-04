import type { ValidationIssue } from "@wikimylife/shared";
import type { z } from "zod";
import { AppError } from "../errors/AppError.js";

/**
 * Validazione al confine HTTP.
 *
 * Le rotte non contengono una sola condizione di dominio: parsano e delegano.
 * Ogni corpo di richiesta passa da qui, sempre — anche quando "e' solo una
 * stringa".
 */
/**
 * Il terzo parametro di `ZodType` e' il tipo di INGRESSO, e qui vale `unknown`
 * di proposito: uno schema con dei `.default()` ha ingresso e uscita diversi, e
 * fissarli uguali (come farebbe `z.ZodType<T>`) escluderebbe proprio gli schemi
 * che applicano un default — cioe' quelli per cui la validazione serve di piu'.
 */
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }

  const details: ValidationIssue[] = parsed.error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
    message: issue.message,
  }));

  throw AppError.validationFailed(details);
}

export function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  return parse(schema, body);
}

/**
 * Stessa funzione, nome diverso, perche' la sorgente e' diversa e la differenza
 * si vede al punto di chiamata.
 *
 * Nella query string tutto arriva come stringa: gli schemi che la descrivono
 * usano `z.coerce` per i numeri, ed e' proprio per questo che il tipo di
 * ingresso resta `unknown`. `.strict()` fa fallire una chiave sconosciuta invece
 * di ignorarla: `?limti=5` deve dare 400, non silenziosamente venti risultati.
 */
export function parseQuery<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, query: unknown): T {
  return parse(schema, query);
}
