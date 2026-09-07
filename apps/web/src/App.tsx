import { formatDurataAudio, formatQuando } from "./format";
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
 *
 * L'unica eccezione e' l'avviso di registrazione non salvata, che segue le
 * stesse coordinate ma non e' altrettanto discreto: e' l'unico stato dell'app
 * in cui chiudere la scheda perde qualcosa per sempre.
 */
function BarraBassa(): React.JSX.Element {
  const capture = useCapture();
  const route = useRoute();

  return (
    <>
      {/* Impilati insieme perche' capitano insieme: una registrazione che non
          si e' potuta salvare non ferma la coda che si sta caricando. */}
      <div className="avvisi-bassi">
        <NonSalvata />

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
      </div>

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

/**
 * L'audio che il telefono non ha voluto scrivere.
 *
 * Tre pulsanti e nessuna scorciatoia: nessuno dei tre e' quello «giusto», e
 * sceglierlo per l'utente vorrebbe dire buttare la sua registrazione o tenerla
 * in memoria per sempre. Il primo — riprovare — c'e' solo quando e' mancato lo
 * spazio, perche' e' l'unico caso in cui premerlo puo' cambiare qualcosa: se
 * IndexedDB non c'e' proprio, riprovare fallisce identico.
 *
 * `role="alert"` e non `status`: interrompere la lettura e' proporzionato,
 * perche' e' l'unico avviso dell'app che non aspetta.
 */
function NonSalvata(): React.JSX.Element | null {
  const capture = useCapture();
  const reg = capture.nonSalvata;
  if (reg === null) {
    return null;
  }

  return (
    <div className="non-salvata" role="alert">
      <p className="non-salvata__motivo">{reg.motivo}</p>
      <p className="non-salvata__quando muto">
        {formatDurataAudio(reg.durationMs)} · registrata {formatQuando(reg.recordedAt)}.
        L&apos;audio c&apos;e&apos; ancora, ma solo finche&apos; l&apos;app resta aperta.
      </p>
      <div className="non-salvata__azioni">
        {reg.spazio && (
          <button
            type="button"
            className="bottone"
            onClick={() => {
              void capture.riscrivi();
            }}
          >
            Riprova a salvare
          </button>
        )}
        <button
          type="button"
          className="bottone"
          onClick={() => {
            capture.scarica();
          }}
        >
          Scarica il file
        </button>
        <button
          type="button"
          className="bottone bottone--piatto"
          onClick={() => {
            capture.scarta();
          }}
        >
          Scarta
        </button>
      </div>
    </div>
  );
}
