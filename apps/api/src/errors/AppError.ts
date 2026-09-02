import { ErrorCode, type ErrorCode as ErrorCodeType, type ValidationIssue } from "@wikimylife/shared";

/**
 * L'unico errore che i servizi di dominio hanno il diritto di lanciare.
 *
 * Porta un codice del contratto pubblico e uno stato HTTP. Non porta MAI stato
 * interno: `details` esiste solo per VALIDATION_FAILED, dove il dettaglio serve
 * davvero al client per correggere la richiesta.
 */
export class AppError extends Error {
  readonly code: ErrorCodeType;
  readonly status: number;
  readonly details: readonly ValidationIssue[] | undefined;
  /** Non esce mai in risposta: finisce solo nel log, accanto al requestId. */
  readonly context: Record<string, unknown> | undefined;

  constructor(params: {
    code: ErrorCodeType;
    message: string;
    status: number;
    details?: readonly ValidationIssue[] | undefined;
    context?: Record<string, unknown> | undefined;
  }) {
    super(params.message);
    this.name = "AppError";
    this.code = params.code;
    this.status = params.status;
    this.details = params.details;
    this.context = params.context;
  }

  static validationFailed(details: readonly ValidationIssue[]): AppError {
    return new AppError({
      code: ErrorCode.VALIDATION_FAILED,
      message: "La richiesta non e' valida",
      status: 400,
      details,
    });
  }

  static unauthorized(message = "Autenticazione richiesta"): AppError {
    return new AppError({ code: ErrorCode.UNAUTHORIZED, message, status: 401 });
  }

  static invalidCredentials(): AppError {
    // Messaggio identico per utente inesistente e password errata: distinguerli
    // regalerebbe a chi enumera indirizzi la conferma che un account esiste.
    return new AppError({
      code: ErrorCode.INVALID_CREDENTIALS,
      message: "Email o password non corretti",
      status: 401,
    });
  }

  static tokenInvalid(): AppError {
    return new AppError({
      code: ErrorCode.TOKEN_INVALID,
      message: "Token non valido",
      status: 401,
    });
  }

  static tokenExpired(): AppError {
    return new AppError({
      code: ErrorCode.TOKEN_EXPIRED,
      message: "Token scaduto",
      status: 401,
    });
  }

  static tokenReused(): AppError {
    return new AppError({
      code: ErrorCode.TOKEN_REUSED,
      message: "Refresh token gia' utilizzato: la sessione e' stata revocata",
      status: 401,
    });
  }

  static emailTaken(): AppError {
    return new AppError({
      code: ErrorCode.EMAIL_TAKEN,
      message: "Esiste gia' un account con questa email",
      status: 409,
    });
  }

  static signupDisabled(): AppError {
    return new AppError({
      code: ErrorCode.SIGNUP_DISABLED,
      message: "La registrazione e' chiusa",
      status: 403,
    });
  }

  /**
   * Distinti da VALIDATION_FAILED perche' il rimedio e' diverso: qui non si
   * corregge un campo, si manda un altro file. Un client che riprovasse la
   * stessa richiesta dopo un 400 avrebbe ragione; dopo questi due, no.
   */
  static payloadTooLarge(message: string): AppError {
    return new AppError({
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      message,
      status: 413,
    });
  }

  static unsupportedMediaType(message: string): AppError {
    return new AppError({
      code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      message,
      status: 415,
    });
  }

  /** Risorsa inesistente E risorsa altrui: dall'esterno devono coincidere. */
  static notFound(message = "Risorsa non trovata"): AppError {
    return new AppError({ code: ErrorCode.NOT_FOUND, message, status: 404 });
  }

  static serviceUnavailable(message = "Servizio non disponibile"): AppError {
    return new AppError({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message,
      status: 503,
    });
  }
}
