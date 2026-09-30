import { createApiClient } from "@wikimylife/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { WebSecureStorageAdapter } from "./adapters/WebSecureStorageAdapter";
import { creaAccessoGoogle, GoogleContext, googleDisponibile } from "./google";
import { registraServiceWorker } from "./serviceWorker";
import "./styles.css";

/**
 * Qui si costruisce l'unico client vero, e da qui non esce come import.
 *
 * E' il composition root del frontend, e sta in `main.tsx` perche' e' gia' il
 * file dove il browser entra: `createRoot`, il service worker, il foglio di
 * stile. Un modulo che esporta un'istanza gia' costruita sembra la stessa cosa
 * e non lo e' — chiunque lo importi si porta dietro anche una `fetch` verso
 * `VITE_API_URL`, compreso un test che voleva solo montare un componente.
 *
 * `VITE_API_URL` e' la configurazione del frontend, perche' e' la cosa che il
 * frontend ha il diritto di sapere: ogni regola di prodotto vive nell'API.
 * Netlify ospita asset statici e redirect, nient'altro.
 *
 * `VITE_GOOGLE_CLIENT_ID` e' l'altra, ed e' della stessa natura: non e' una
 * regola ma un indirizzo — a quale applicazione Google chiedere il token. Non
 * e' un segreto (finisce comunque nell'HTML che Google disegna), e deve essere
 * uno dei `GOOGLE_CLIENT_IDS` dell'API, o i token che produce vengono
 * rifiutati come emessi per un altro.
 */
const apiClient = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? "http://localhost:3000",
  storage: new WebSecureStorageAdapter(),
});

const clientIdGoogle = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const google =
  clientIdGoogle !== undefined && googleDisponibile(clientIdGoogle, window)
    ? creaAccessoGoogle(clientIdGoogle, window)
    : null;

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Elemento #root assente in index.html");
}

createRoot(container).render(
  <StrictMode>
    <GoogleContext.Provider value={google}>
      <App client={apiClient} />
    </GoogleContext.Provider>
  </StrictMode>,
);

// Quando e perche' no — sviluppo, guscio nativo — sta in `serviceWorker.ts`.
registraServiceWorker({ produzione: import.meta.env.PROD, finestra: window });
