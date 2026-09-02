import { createApiClient, type ApiClient } from "@wikimylife/shared";
import { WebSecureStorageAdapter } from "./adapters/WebSecureStorageAdapter";

/**
 * Unica istanza del client API.
 *
 * `VITE_API_URL` e' l'unica configurazione del frontend, perche' e' l'unica
 * cosa che il frontend ha il diritto di sapere: ogni regola di prodotto vive
 * nell'API. Netlify ospita asset statici e redirect, nient'altro.
 */
const baseUrl: string = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export const apiClient: ApiClient = createApiClient({
  baseUrl,
  storage: new WebSecureStorageAdapter(),
});

export const apiBaseUrl = baseUrl;
