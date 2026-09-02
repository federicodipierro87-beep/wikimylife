/**
 * Codici di errore dell'API. Sono contratto pubblico: i client fanno branching
 * su questi, non sui messaggi (che sono per gli umani e possono cambiare).
 */
export const errorCodeValues = [
  // Validazione al confine HTTP. L'unico codice che porta `details`.
  "VALIDATION_FAILED",

  // Autenticazione
  "UNAUTHORIZED",
  "INVALID_CREDENTIALS",
  "EMAIL_TAKEN",
  "SIGNUP_DISABLED",
  "TOKEN_INVALID",
  "TOKEN_EXPIRED",
  /**
   * Un refresh token gia' ruotato e' stato riusato: la famiglia intera e' stata
   * revocata. Il client deve rifare login da zero.
   */
  "TOKEN_REUSED",

  // Risorse
  "NOT_FOUND",
  "CONFLICT",

  // Caricamento dell'audio (§1). Distinti da VALIDATION_FAILED perche' il
  // rimedio e' diverso: qui non si corregge un campo, si manda un altro file.
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",

  // Infrastruttura
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof errorCodeValues)[number];

export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  EMAIL_TAKEN: "EMAIL_TAKEN",
  SIGNUP_DISABLED: "SIGNUP_DISABLED",
  TOKEN_INVALID: "TOKEN_INVALID",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_REUSED: "TOKEN_REUSED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  RATE_LIMITED: "RATE_LIMITED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const satisfies Record<ErrorCode, ErrorCode>;
