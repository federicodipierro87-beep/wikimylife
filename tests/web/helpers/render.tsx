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
 */
export function montaConApi(client: ApiClient, ui: React.ReactNode): RenderResult {
  return renderRTL(<ApiProvider client={client}>{ui}</ApiProvider>);
}
