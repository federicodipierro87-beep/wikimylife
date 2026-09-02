import type { HealthResponse } from "@wikimylife/shared";
import { ApiError } from "@wikimylife/shared";
import { useEffect, useState } from "react";
import { apiBaseUrl, apiClient } from "./api";

/**
 * Fase 1: una sola pagina, che chiama `/health` attraverso il client tipizzato
 * di `@wikimylife/shared`.
 *
 * Non e' una schermata di prodotto, e' una dimostrazione: shared si importa da
 * Vite senza alias, senza `tsconfig-paths` e senza polyfill, e i tipi della
 * risposta arrivano dallo stesso schema Zod che valida lato server. Se questa
 * pagina compila e funziona, il pacchetto e' consumabile anche da React Native.
 */

type State =
  | { kind: "loading" }
  | { kind: "ok"; health: HealthResponse }
  | { kind: "error"; message: string };

export function App(): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    apiClient
      .health()
      .then((health) => {
        if (!cancelled) {
          setState({ kind: "ok", health });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof ApiError
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.message
              : "Errore sconosciuto";
        setState({ kind: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="page">
      <h1>WikiMyLife</h1>
      <p className="lead">Fase 1 — fondamenta. Nessuna schermata di prodotto, ancora.</p>

      <section className="card">
        <h2>Stato dell&apos;API</h2>
        <p className="muted">
          <code>GET {apiBaseUrl}/health</code> via <code>@wikimylife/shared</code>
        </p>

        {state.kind === "loading" && <p>Verifica in corso…</p>}

        {state.kind === "error" && (
          <p className="bad">
            Non raggiungibile — {state.message}
            <br />
            <span className="muted">
              Avvia l&apos;API con <code>npm run dev:api</code>.
            </span>
          </p>
        )}

        {state.kind === "ok" && (
          <dl className="grid">
            <dt>status</dt>
            <dd className={state.health.status === "ok" ? "good" : "bad"}>
              {state.health.status}
            </dd>
            <dt>database</dt>
            <dd className={state.health.db === "up" ? "good" : "bad"}>{state.health.db}</dd>
            <dt>versione</dt>
            <dd>{state.health.version}</dd>
            <dt>uptime</dt>
            <dd>{state.health.uptimeSeconds}s</dd>
          </dl>
        )}
      </section>
    </main>
  );
}
