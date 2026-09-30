import { ApiError, type PublicUser } from "@wikimylife/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useApi } from "./api";

/**
 * Chi sta usando l'app.
 *
 * Un contesto e non uno stato dentro `App`, perche' il logout deve poter
 * partire dall'ultima schermata della pila senza passare una callback per sei
 * livelli di props.
 *
 * L'access token non e' qui: vive dentro il client, in memoria, e nessun
 * componente ha motivo di leggerlo. Quello che i componenti devono sapere e'
 * solo se c'e' un utente.
 */

export type SessionState =
  | { readonly kind: "sconosciuta" }
  | { readonly kind: "assente" }
  | { readonly kind: "attiva"; readonly user: PublicUser };

export interface Session {
  readonly state: SessionState;
  login(email: string, password: string): Promise<void>;
  signup(email: string, password: string): Promise<void>;
  /** Entra, o si iscrive, con il token del pulsante di Google. */
  loginWithGoogle(idToken: string): Promise<void>;
  /**
   * Sostituisce l'utente della sessione con quello appena tornato dal server.
   *
   * Serve a un caso solo, ma e' un caso che si vede: chi e' entrato con Google
   * e si da' una password riceve un utente con `hasPassword: true`, e senza
   * questo la schermata dell'account continuerebbe a chiedergli Google fino
   * alla prossima apertura dell'app.
   */
  aggiornaUtente(user: PublicUser): void;
  logout(): Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const apiClient = useApi();
  const [state, setState] = useState<SessionState>({ kind: "sconosciuta" });

  useEffect(() => {
    let vivo = true;
    // `restoreSession` usa il refresh token che sta nello storage: e' cio' che
    // rende «resti collegato» vero anche dopo aver chiuso la scheda. Uno stato
    // `sconosciuta` iniziale evita il lampo di schermata di login a chi era
    // gia' dentro.
    apiClient
      .restoreSession()
      .then((user) => {
        if (vivo) {
          setState(user === null ? { kind: "assente" } : { kind: "attiva", user });
        }
      })
      .catch(() => {
        if (vivo) {
          setState({ kind: "assente" });
        }
      });
    return () => {
      vivo = false;
    };
  }, [apiClient]);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      const session = await apiClient.login({ email, password });
      setState({ kind: "attiva", user: session.user });
    },
    [apiClient],
  );

  const signup = useCallback(
    async (email: string, password: string): Promise<void> => {
      // `locale` dal dispositivo e non da un menu a tendina: e' la lingua che
      // lo stadio 2 passera' a Whisper, e chiederla a chi si sta registrando
      // significherebbe far scegliere un dettaglio tecnico.
      const session = await apiClient.signup({ email, password, locale: navigator.language });
      setState({ kind: "attiva", user: session.user });
    },
    [apiClient],
  );

  const loginWithGoogle = useCallback(
    async (idToken: string): Promise<void> => {
      // La lingua come nell'iscrizione: conta solo se il conto nasce adesso.
      const session = await apiClient.loginWithGoogle({ idToken, locale: navigator.language });
      setState({ kind: "attiva", user: session.user });
    },
    [apiClient],
  );

  const aggiornaUtente = useCallback((user: PublicUser): void => {
    setState((prima) => (prima.kind === "attiva" ? { kind: "attiva", user } : prima));
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiClient.logout();
    } catch {
      // Il server puo' essere irraggiungibile, o il refresh gia' scaduto. In
      // entrambi i casi l'utente ha chiesto di uscire e deve uscire: tenerlo
      // dentro perche' la richiesta di uscita e' fallita sarebbe assurdo.
    }
    setState({ kind: "assente" });
  }, [apiClient]);

  const value = useMemo<Session>(
    () => ({ state, login, signup, loginWithGoogle, aggiornaUtente, logout }),
    [state, login, signup, loginWithGoogle, aggiornaUtente, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) {
    throw new Error("useSession fuori da <SessionProvider>");
  }
  return session;
}

/** Il messaggio da mostrare, qualunque cosa sia arrivata dal `catch`. */
export function messaggioDi(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    // `fetch` fallisce cosi' quando non c'e' rete, e "Failed to fetch" non e'
    // una frase che si mostra a qualcuno.
    return error.message === "Failed to fetch"
      ? "Nessuna connessione. Riprova quando torni online."
      : error.message;
  }
  return "Qualcosa e' andato storto.";
}
