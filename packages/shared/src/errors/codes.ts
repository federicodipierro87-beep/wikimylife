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

  // Accesso con Google. Tre codici e non INVALID_CREDENTIALS per tutti, perche'
  // il rimedio e' diverso per ognuno e nessuno dei tre e' «riscrivi la
  // password»: il primo dice che questo server Google non lo conosce (la
  // schermata non deve mostrare il pulsante), il secondo che Google non ha
  // confermato niente (si riprova), il terzo che l'account Google esiste ma
  // non garantisce l'indirizzo, e con un indirizzo non garantito non si apre ne'
  // si collega nessun conto.
  "GOOGLE_DISABLED",
  "GOOGLE_TOKEN_INVALID",
  "GOOGLE_EMAIL_UNVERIFIED",

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
  GOOGLE_DISABLED: "GOOGLE_DISABLED",
  GOOGLE_TOKEN_INVALID: "GOOGLE_TOKEN_INVALID",
  GOOGLE_EMAIL_UNVERIFIED: "GOOGLE_EMAIL_UNVERIFIED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  RATE_LIMITED: "RATE_LIMITED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const satisfies Record<ErrorCode, ErrorCode>;
