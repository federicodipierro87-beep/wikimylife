import type { z } from "zod";
import { AUTH_STORAGE_KEYS, type SecureStorageAdapter } from "../adapters/secureStorage.js";
import { errorBodySchema, type ValidationIssue } from "../errors/body.js";
import { ErrorCode, type ErrorCode as ErrorCodeType } from "../errors/codes.js";
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
  readonly schema: z.ZodType<T>;
  readonly auth: boolean;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
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

  async function send<T>(opts: RequestOptions<T>, allowRetry: boolean): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (opts.auth && accessToken !== null) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    const init: RequestInit = {
      method: opts.method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
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
        return send(opts, false);
      }

      if (opts.auth && response.status === 401) {
        await clear();
        options.onSessionExpired?.();
      }
      throw error;
    }

    const payload: unknown = await response.json();
    const parsed = opts.schema.safeParse(payload);
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
  };
}
