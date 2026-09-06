import { useEffect, useState } from "react";
import { HOME, parseHash, toHash, type Route } from "./routes";

/**
 * Il router, in trenta righe e su `location.hash`.
 *
 * React Router pesa piu' di tutto il resto di questa applicazione, che ha
 * sei schermate e nessuna rotta annidata. E l'hash risolve gratis il
 * problema che altrimenti andrebbe risolto sul server: `/scheda/abc` su un
 * hosting statico e' un 404 al ricaricamento, e servirebbe una regola di
 * rewrite in piu' su Netlify. Con l'hash il documento e' sempre `index.html`.
 */

export function navigate(route: Route): void {
  window.location.hash = toHash(route);
}

/** Sostituisce la voce corrente invece di aggiungerne una. */
export function replace(route: Route): void {
  window.history.replaceState(null, "", toHash(route));
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Torna indietro se c'e' una storia, altrimenti alla lista. */
export function goBack(): void {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    navigate(HOME);
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
    };
  }, []);

  return route;
}
