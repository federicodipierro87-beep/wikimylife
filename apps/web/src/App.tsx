import { CaptureProvider, useCapture } from "./recording/CaptureProvider";
import { navigate, useRoute } from "./router";
import type { Route } from "./routes";
import { DetailScreen } from "./screens/DetailScreen";
import { ListScreen } from "./screens/ListScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { RecordScreen } from "./screens/RecordScreen";
import { RedactionScreen } from "./screens/RedactionScreen";
import { ReviewScreen } from "./screens/ReviewScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { SessionProvider, useSession } from "./session";

/**
 * Il guscio dell'app.
 *
 * `CaptureProvider` sta sopra il router e non dentro la schermata di
 * registrazione, di proposito: la coda di upload deve svuotarsi anche mentre
 * l'utente sta leggendo una scheda, e l'indicatore deve restare visibile
 * ovunque. Montarlo dentro `RecordScreen` avrebbe fermato i caricamenti a ogni
 * cambio di pagina.
 */

export function App(): React.JSX.Element {
  return (
    <SessionProvider>
      <Radice />
    </SessionProvider>
  );
}

function Radice(): React.JSX.Element {
  const { state } = useSession();

  if (state.kind === "sconosciuta") {
    // Nessun testo: e' il decimo di secondo in cui si controlla il refresh
    // token. Scriverci «Carico…» produrrebbe un lampo di testo peggiore del
    // vuoto.
    return <div className="avvio" aria-busy="true" />;
  }

  if (state.kind === "assente") {
    return <LoginScreen />;
  }

  return (
    <CaptureProvider>
      <Schermate />
      <BarraBassa />
    </CaptureProvider>
  );
}

function Schermate(): React.JSX.Element {
  const route: Route = useRoute();

  switch (route.name) {
    case "registra":
      return <RecordScreen />;
    case "cerca":
      return <SearchScreen />;
    case "scheda":
      return <DetailScreen id={route.id} />;
    case "revisione":
      return <ReviewScreen id={route.id} />;
    case "redazione":
      return <RedactionScreen id={route.id} />;
    case "lista":
      return <ListScreen />;
  }
}

/**
 * La barra in basso: il pulsante di registrazione e lo stato della coda.
 *
 * In basso e non in alto perche' si usa con il pollice. E' anche il posto dove
 * l'indicatore di upload non blocca niente: la §2 chiede che il caricamento sia
 * «non bloccante», che in pratica vuol dire «visibile senza essere un dialogo».
 */
function BarraBassa(): React.JSX.Element {
  const capture = useCapture();
  const route = useRoute();

  return (
    <>
      {capture.inCoda > 0 && (
        <div className="coda" role="status">
          <span>
            {capture.online
              ? `Carico ${String(capture.inCoda)} registrazion${capture.inCoda === 1 ? "e" : "i"}…`
              : `${String(capture.inCoda)} in attesa di rete`}
          </span>
          {capture.online && (
            <button
              type="button"
              className="bottone bottone--piatto"
              onClick={() => {
                void capture.riprova();
              }}
            >
              Riprova
            </button>
          )}
        </div>
      )}

      <nav className="barra">
        <button
          type="button"
          className={`barra__voce ${route.name === "lista" ? "barra__voce--attiva" : ""}`}
          onClick={() => {
            navigate({ name: "lista" });
          }}
        >
          Procedure
        </button>

        <button
          type="button"
          className="barra__registra"
          onClick={() => {
            navigate({ name: "registra" });
          }}
          aria-label="Registra"
        >
          <span aria-hidden="true">●</span>
        </button>

        <button
          type="button"
          className={`barra__voce ${route.name === "cerca" ? "barra__voce--attiva" : ""}`}
          onClick={() => {
            navigate({ name: "cerca" });
          }}
        >
          Cerca
        </button>
      </nav>
    </>
  );
}
