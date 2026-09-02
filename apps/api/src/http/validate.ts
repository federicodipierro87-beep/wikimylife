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
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) {
    return parsed.data;
  }

  const details: ValidationIssue[] = parsed.error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
    message: issue.message,
  }));

  throw AppError.validationFailed(details);
}
