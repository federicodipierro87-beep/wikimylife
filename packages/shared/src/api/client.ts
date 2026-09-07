import type { z } from "zod";
import { AUTH_STORAGE_KEYS, type SecureStorageAdapter } from "../adapters/secureStorage.js";
import { errorBodySchema, type ValidationIssue } from "../errors/body.js";
import { ErrorCode, type ErrorCode as ErrorCodeType } from "../errors/codes.js";
import {
  procedureDetailSchema,
  procedureListSchema,
  searchResultSchema,
  type CreateExecutionBodyInput,
  type ListProceduresQueryInput,
  type ProcedureDetail,
  type ProcedureList,
  type SearchQueryInput,
  type SearchResult,
  type UpdateProcedureBodyInput,
} from "./procedures.js";
import { redactionReportSchema, type RedactionReport } from "./redaction.js";
import {
  RECORDING_UPLOAD_FIELDS,
  pendingRecordingsSchema,
  recordingStateSchema,
  type CaptureMetadataInput,
  type PendingRecordings,
  type RecordingState,
} from "./recordings.js";
import {
  authSessionSchema,
  healthResponseSchema,
  logoutResponseSchema,
  meResponseSchema,
  type AuthSession,
  type HealthResponse,
  type LoginRequest,
  type MeResponse,
  type PublicUser,
  type SignupRequest,
} from "./schemas.js";

/**
 * Client HTTP tipizzato, costruito solo su `fetch`.
 *
 * `fetchImpl` e' iniettabile perche' i test non devono aprire socket e perche'
 * React Native ha la sua implementazione. Nessun riferimento a `window`: questo
 * file deve poter essere importato tal quale da un bundle nativo.
 *
 * L'access token vive in memoria, il refresh token nel `SecureStorageAdapter`.
 * Su 401 il client tenta UNA rotazione e ripete la richiesta; se anche quella
 * fallisce, svuota tutto — perche' se il refresh non e' valido siamo nel caso
 * TOKEN_REUSED e l'intera famiglia e' morta.
 */

export class ApiError extends Error {
  readonly code: ErrorCodeType;
  readonly status: number;
  readonly details: readonly ValidationIssue[] | undefined;

  constructor(params: {
    code: ErrorCodeType;
    message: string;
    status: number;
    details?: readonly ValidationIssue[] | undefined;
  }) {
    super(params.message);
    this.name = "ApiError";
    this.code = params.code;
    this.status = params.status;
    this.details = params.details;
  }
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly storage: SecureStorageAdapter;
  readonly fetchImpl?: FetchImpl | undefined;
  /** Notificata quando la sessione muore in modo irrecuperabile. */
  readonly onSessionExpired?: (() => void) | undefined;
}

interface RequestOptions<T> {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  /**
   * Alternativa a `body` per l'upload dell'audio. Il `Content-Type` NON si
   * imposta a mano: solo il runtime conosce il boundary che ha generato, e
   * scriverlo a mano produce un multipart che nessun parser sa leggere.
   */
  readonly form?: FormData | undefined;
  readonly schema: z.ZodType<T>;
  readonly auth: boolean;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * `URLSearchParams` e non una concatenazione: un tag con uno spazio o una `&`
 * dentro romperebbe la query string in silenzio, e i tag li scrive l'utente.
 * E' un globale standard, presente sia in Node sia nei browser sia in React
 * Native: non viola l'isomorfismo di questo pacchetto.
 */
function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

export interface ApiClient {
  health(): Promise<HealthResponse>;
  signup(input: SignupRequest): Promise<AuthSession>;
  login(input: LoginRequest): Promise<AuthSession>;
  me(): Promise<PublicUser>;
  /** Ruota esplicitamente. Di norma ci pensa il client da solo su 401. */
  refresh(): Promise<AuthSession>;
  logout(): Promise<void>;
  getAccessToken(): string | null;
  restoreSession(): Promise<PublicUser | null>;

  /**
   * Carica l'audio. Risponde appena i byte sono al sicuro, non a elaborazione
   * finita: lo stato tornato e' `BOZZA_AUDIO`, l'avanzamento si segue con
   * `getRecording`.
   */
  createRecording(input: {
    readonly audio: Blob;
    readonly metadata: CaptureMetadataInput;
    readonly filename?: string | undefined;
  }): Promise<RecordingState>;
  /** Le registrazioni che non sono ancora diventate una scheda. */
  listPendingRecordings(): Promise<PendingRecordings>;
  getRecording(id: string): Promise<RecordingState>;
  /** Rimette in coda dalla trascrizione. */
  retryRecording(id: string): Promise<RecordingState>;
  /**
   * Cancella riga e audio, per davvero.
   *
   * E' l'opposto di `archiveProcedure`: li' il soft delete esiste proprio per
   * non buttare via le registrazioni collegate, qui la registrazione e' cio'
   * che si sta buttando via, e chiedere che la propria voce sparisca non si
   * soddisfa con un cambio di stato. Fallisce con `CONFLICT` finche' un worker
   * la sta elaborando.
   */
  deleteRecording(id: string): Promise<void>;
  /**
   * I byte originali, per il player della scheda.
   *
   * Torna un `Blob` e non un URL perche' l'audio e' protetto da
   * `Authorization`, e un tag `<audio src>` non manda intestazioni: chi chiama
   * ne fa un object URL, e si ricorda di revocarlo.
   */
  getRecordingAudio(id: string): Promise<Blob>;

  listProcedures(query?: ListProceduresQueryInput): Promise<ProcedureList>;
  getProcedure(id: string): Promise<ProcedureDetail>;
  updateProcedure(id: string, patch: UpdateProcedureBodyInput): Promise<ProcedureDetail>;
  /**
   * Soft delete: la scheda passa ad `ARCHIVIATA` e sparisce da liste e ricerca,
   * ma resta leggibile per id. Cancellare davvero significherebbe buttare via
   * anche le registrazioni collegate, che sono l'unico dato non riproducibile.
   */
  archiveProcedure(id: string): Promise<ProcedureDetail>;
  /** §8: un esito `CAMBIATA` riporta la scheda in `DA_RIVEDERE`. */
  recordExecution(id: string, body: CreateExecutionBodyInput): Promise<ProcedureDetail>;
  /**
   * §9: cosa il server proporrebbe di sostituire, senza sostituire niente.
   *
   * Si puo' chiamare quando si vuole e quante volte si vuole: e' una lettura.
   * Gli `id` che torna valgono per la scheda com'e' adesso — se qualcuno la
   * modifica nel frattempo, `applyRedaction` rifiuta invece di applicare a un
   * testo diverso da quello mostrato.
   */
  proposeRedaction(id: string): Promise<RedactionReport>;
  /**
   * §9: applica solo le sostituzioni confermate.
   *
   * Il corpo contiene gli `id` di `proposeRedaction` e nient'altro. Il testo
   * finale lo ricalcola il server: mandarglielo renderebbe questa chiamata una
   * `PATCH` travestita.
   */
  applyRedaction(id: string, conferme: readonly string[]): Promise<ProcedureDetail>;
  /** §7: full-text italiano e semantica pgvector, fusi. */
  search(query: SearchQueryInput): Promise<SearchResult>;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch: FetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const { storage, baseUrl } = options;

  let accessToken: string | null = null;
  /** Una sola rotazione in volo: due 401 paralleli non devono bruciare due token. */
  let inFlightRefresh: Promise<AuthSession> | null = null;

  async function persist(session: AuthSession): Promise<AuthSession> {
    accessToken = session.tokens.accessToken;
    await storage.set(AUTH_STORAGE_KEYS.refreshToken, session.tokens.refreshToken);
    return session;
  }

  async function clear(): Promise<void> {
    accessToken = null;
    await storage.remove(AUTH_STORAGE_KEYS.refreshToken);
    await storage.remove(AUTH_STORAGE_KEYS.accessToken);
  }

  async function toApiError(response: Response): Promise<ApiError> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const parsed = errorBodySchema.safeParse(payload);
    if (parsed.success) {
      return new ApiError({
        code: parsed.data.error.code,
        message: parsed.data.error.message,
        status: response.status,
        details: parsed.data.error.details,
      });
    }
    return new ApiError({
      code: ErrorCode.INTERNAL_ERROR,
      message: `Risposta di errore non conforme al contratto (HTTP ${String(response.status)})`,
      status: response.status,
    });
  }

  /**
   * Tutto cio' che accade prima di guardare il corpo: intestazioni, rotazione su
   * 401, traduzione dell'errore. Sta separato da `send` perche' non ogni
   * risposta e' JSON — l'audio originale sono byte, e deve passare per la stessa
   * gestione della sessione senza duplicarla.
   */
  async function execute(
    opts: Omit<RequestOptions<unknown>, "schema"> & { accept: string },
    allowRetry: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: opts.accept };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (opts.auth && accessToken !== null) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    const init: RequestInit = {
      method: opts.method,
      headers,
      ...(opts.form !== undefined
        ? { body: opts.form }
        : opts.body === undefined
          ? {}
          : { body: JSON.stringify(opts.body) }),
    };

    const response = await doFetch(joinUrl(baseUrl, opts.path), init);

    if (!response.ok) {
      const error = await toApiError(response);
      const recoverable =
        opts.auth &&
        allowRetry &&
        response.status === 401 &&
        error.code !== ErrorCode.TOKEN_REUSED;

      if (recoverable) {
        try {
          await rotate();
        } catch {
          await clear();
          options.onSessionExpired?.();
          throw error;
        }
        return execute(opts, false);
      }

      if (opts.auth && response.status === 401) {
        await clear();
        options.onSessionExpired?.();
      }
      throw error;
    }

    return response;
  }

  async function send<T>(opts: RequestOptions<T>, allowRetry: boolean): Promise<T> {
    const { schema, ...rest } = opts;
    const response = await execute({ ...rest, accept: "application/json" }, allowRetry);

    const payload: unknown = await response.json();
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError({
        code: ErrorCode.INTERNAL_ERROR,
        message: `Risposta non conforme al contratto per ${opts.method} ${opts.path}`,
        status: response.status,
      });
    }
    return parsed.data;
  }

  async function rotate(): Promise<AuthSession> {
    if (inFlightRefresh !== null) {
      return inFlightRefresh;
    }
    inFlightRefresh = (async () => {
      const refreshToken = await storage.get(AUTH_STORAGE_KEYS.refreshToken);
      if (refreshToken === null) {
        throw new ApiError({
          code: ErrorCode.UNAUTHORIZED,
          message: "Nessun refresh token conservato",
          status: 401,
        });
      }
      const session = await send(
        {
          method: "POST",
          path: "/api/auth/refresh",
          body: { refreshToken },
          schema: authSessionSchema,
          auth: false,
        },
        false,
      );
      return persist(session);
    })();

    try {
      return await inFlightRefresh;
    } finally {
      inFlightRefresh = null;
    }
  }

  return {
    async health(): Promise<HealthResponse> {
      return send(
        { method: "GET", path: "/health", schema: healthResponseSchema, auth: false },
        false,
      );
    },

    async signup(input: SignupRequest): Promise<AuthSession> {
      const session = await send(
        {
          method: "POST",
          path: "/api/auth/signup",
          body: input,
          schema: authSessionSchema,
          auth: false,
        },
        false,
      );
      return persist(session);
    },

    async login(input: LoginRequest): Promise<AuthSession> {
      const session = await send(
        {
          method: "POST",
          path: "/api/auth/login",
          body: input,
          schema: authSessionSchema,
          auth: false,
        },
        false,
      );
      return persist(session);
    },

    async me(): Promise<PublicUser> {
      const response: MeResponse = await send(
        { method: "GET", path: "/api/auth/me", schema: meResponseSchema, auth: true },
        true,
      );
      return response.user;
    },

    refresh(): Promise<AuthSession> {
      return rotate();
    },

    async logout(): Promise<void> {
      const refreshToken = await storage.get(AUTH_STORAGE_KEYS.refreshToken);
      if (refreshToken !== null) {
        try {
          await send(
            {
              method: "POST",
              path: "/api/auth/logout",
              body: { refreshToken },
              schema: logoutResponseSchema,
              auth: false,
            },
            false,
          );
        } catch {
          // Il logout non fallisce mai lato client: lo stato locale si svuota
          // comunque. Un token gia' revocato e' esattamente cio' che volevamo.
        }
      }
      await clear();
    },

    getAccessToken(): string | null {
      return accessToken;
    },

    async restoreSession(): Promise<PublicUser | null> {
      const refreshToken = await storage.get(AUTH_STORAGE_KEYS.refreshToken);
      if (refreshToken === null) {
        return null;
      }
      try {
        const session = await rotate();
        return session.user;
      } catch {
        await clear();
        return null;
      }
    },

    createRecording(input: {
      audio: Blob;
      metadata: CaptureMetadataInput;
      filename?: string | undefined;
    }): Promise<RecordingState> {
      const form = new FormData();
      // I metadati come JSON in una parte sola: vedi captureMetadataSchema per
      // il motivo (in un multipart ogni campo e' una stringa, e "false" e' vero).
      form.append(RECORDING_UPLOAD_FIELDS.metadata, JSON.stringify(input.metadata));
      form.append(
        RECORDING_UPLOAD_FIELDS.audio,
        input.audio,
        input.filename ?? "registrazione",
      );

      return send(
        {
          method: "POST",
          path: "/api/recordings",
          form,
          schema: recordingStateSchema,
          auth: true,
        },
        true,
      );
    },

    listPendingRecordings(): Promise<PendingRecordings> {
      return send(
        {
          method: "GET",
          path: "/api/recordings",
          schema: pendingRecordingsSchema,
          auth: true,
        },
        true,
      );
    },

    getRecording(id: string): Promise<RecordingState> {
      return send(
        {
          method: "GET",
          path: `/api/recordings/${encodeURIComponent(id)}`,
          schema: recordingStateSchema,
          auth: true,
        },
        true,
      );
    },

    retryRecording(id: string): Promise<RecordingState> {
      return send(
        {
          method: "POST",
          path: `/api/recordings/${encodeURIComponent(id)}/retry`,
          schema: recordingStateSchema,
          auth: true,
        },
        true,
      );
    },

    async deleteRecording(id: string): Promise<void> {
      // `execute` e non `send`: un 204 non ha corpo, e `send` chiamerebbe
      // `response.json()` su una risposta vuota. La gestione della sessione,
      // rotazione su 401 compresa, resta identica — e' proprio per casi come
      // questo che `execute` sta scritto a parte. L'`Accept` resta JSON perche'
      // l'unica risposta con un corpo, qui, e' un errore.
      await execute(
        {
          method: "DELETE",
          path: `/api/recordings/${encodeURIComponent(id)}`,
          accept: "application/json",
          auth: true,
        },
        true,
      );
    },

    async getRecordingAudio(id: string): Promise<Blob> {
      const response = await execute(
        {
          method: "GET",
          path: `/api/recordings/${encodeURIComponent(id)}/audio`,
          accept: "audio/*",
          auth: true,
        },
        true,
      );
      return response.blob();
    },

    listProcedures(query: ListProceduresQueryInput = {}): Promise<ProcedureList> {
      return send(
        {
          method: "GET",
          path: `/api/procedures${queryString({
            scope: query.scope,
            status: query.status,
            tag: query.tag,
            limit: query.limit,
            offset: query.offset,
          })}`,
          schema: procedureListSchema,
          auth: true,
        },
        true,
      );
    },

    getProcedure(id: string): Promise<ProcedureDetail> {
      return send(
        {
          method: "GET",
          path: `/api/procedures/${encodeURIComponent(id)}`,
          schema: procedureDetailSchema,
          auth: true,
        },
        true,
      );
    },

    updateProcedure(id: string, patch: UpdateProcedureBodyInput): Promise<ProcedureDetail> {
      return send(
        {
          method: "PATCH",
          path: `/api/procedures/${encodeURIComponent(id)}`,
          body: patch,
          schema: procedureDetailSchema,
          auth: true,
        },
        true,
      );
    },

    archiveProcedure(id: string): Promise<ProcedureDetail> {
      return send(
        {
          method: "DELETE",
          path: `/api/procedures/${encodeURIComponent(id)}`,
          schema: procedureDetailSchema,
          auth: true,
        },
        true,
      );
    },

    recordExecution(id: string, body: CreateExecutionBodyInput): Promise<ProcedureDetail> {
      return send(
        {
          method: "POST",
          path: `/api/procedures/${encodeURIComponent(id)}/executions`,
          body,
          schema: procedureDetailSchema,
          auth: true,
        },
        true,
      );
    },

    proposeRedaction(id: string): Promise<RedactionReport> {
      return send(
        {
          method: "GET",
          path: `/api/procedures/${encodeURIComponent(id)}/redazione`,
          schema: redactionReportSchema,
          auth: true,
        },
        true,
      );
    },

    applyRedaction(id: string, conferme: readonly string[]): Promise<ProcedureDetail> {
      return send(
        {
          method: "POST",
          path: `/api/procedures/${encodeURIComponent(id)}/redazione`,
          body: { conferme: [...conferme] },
          schema: procedureDetailSchema,
          auth: true,
        },
        true,
      );
    },

    search(query: SearchQueryInput): Promise<SearchResult> {
      return send(
        {
          method: "GET",
          path: `/api/search${queryString({
            q: query.q,
            scope: query.scope,
            limit: query.limit,
            offset: query.offset,
          })}`,
          schema: searchResultSchema,
          auth: true,
        },
        true,
      );
    },
  };
}
