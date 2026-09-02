/**
 * Deposito del refresh token lato client.
 *
 * In web e' `localStorage`, in nativo sara' il keychain. Il client API della
 * §"predisposizione all'app nativa" dipende da questa interfaccia e non sa
 * quale delle due sta usando — motivo per cui l'autenticazione e' con header
 * `Authorization` e non con cookie di sessione: i cookie fuori dal browser
 * funzionano male.
 *
 * Asincrona anche dove l'implementazione e' sincrona: il keychain iOS non e'
 * sincrono, e cambiare la firma dopo costerebbe la riscrittura dei chiamanti.
 */

export interface SecureStorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const AUTH_STORAGE_KEYS = {
  accessToken: "wikimylife.accessToken",
  refreshToken: "wikimylife.refreshToken",
} as const;
