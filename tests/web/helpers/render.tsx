import type { ApiClient } from "@wikimylife/shared";
import { render as renderRTL, type RenderResult } from "@testing-library/react";
import { ApiProvider } from "../../../apps/web/src/api";

/**
 * Montare una schermata con il client che il caso ha scelto.
 *
 * Tre righe di involucro, e valgono per la ragione per cui esistono i tre
 * `helpers/` dell'integrazione: la parte noiosa non deve stare nel test,
 * altrimenti la si legge venti volte e non si legge mai cio' che il test dice.
 *
 * `SessionProvider` NON e' qui dentro. Le schermate coperte da questi file non
 * leggono la sessione — sono gia' dietro il controllo di `App` — e avvolgerle
 * comunque avrebbe fatto partire una `restoreSession()` che nessuna di esse ha
 * chiesto: una chiamata in piu' da insegnare al finto, in ogni caso, per una
 * cosa che quella schermata non fa. Chi prova `LoginScreen` la sessione se la
 * monta, perche' li' e' l'oggetto del test.
 *
 * Il provider passa da `wrapper` e non da un elemento scritto a mano intorno a
 * `ui`, e la differenza si vede solo usando `rerender`: quello restituito da
 * Testing Library rimpiazza tutta la radice, quindi con l'involucro scritto a
 * mano il secondo render perderebbe il provider e la schermata cadrebbe su
 * «useApi fuori da ApiProvider». Con `wrapper` l'involucro viene rimesso da
 * solo, e cambiare una prop a un componente montato — che e' l'unico modo di
 * provare cosa succede quando il padre gliela cambia — resta una riga.
 */
export function montaConApi(client: ApiClient, ui: React.ReactElement): RenderResult {
  return renderRTL(ui, {
    wrapper: ({ children }) => <ApiProvider client={client}>{children}</ApiProvider>,
  });
}
