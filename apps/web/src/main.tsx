import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Elemento #root assente in index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Il service worker si registra dopo `load`, non prima.
 *
 * Registrarlo subito mette la sua installazione in concorrenza con il primo
 * disegno della pagina: l'app che si vede piu' tardi, in cambio di una cache
 * che serve solo alla visita successiva.
 *
 * In sviluppo non si registra affatto. Un service worker che serve il guscio da
 * cache mentre Vite sostituisce i moduli a caldo produce una pagina che mostra
 * codice di dieci minuti fa e nessun modo evidente di accorgersene.
 */
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Niente offline. L'app funziona lo stesso, e non c'e' niente da dire
      // all'utente su un guasto che non gli ha impedito nulla.
    });
  });
}
