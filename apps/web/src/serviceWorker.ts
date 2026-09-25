/**
 * Quando registrare il service worker, e quando no.
 *
 * Sta in un modulo suo e non in `main.tsx` perche' la decisione adesso ha tre
 * rami, e `main.tsx` non lo monta nessun test: la condizione scritta li'
 * sarebbe codice che nessuno esegue prima di un telefono.
 *
 * ## Dopo `load`, non prima
 *
 * Registrarlo subito mette la sua installazione in concorrenza con il primo
 * disegno della pagina: l'app che si vede piu' tardi, in cambio di una cache
 * che serve solo alla visita successiva.
 *
 * ## Non in sviluppo
 *
 * Un service worker che serve il guscio da cache mentre Vite sostituisce i
 * moduli a caldo produce una pagina che mostra codice di dieci minuti fa e
 * nessun modo evidente di accorgersene.
 *
 * ## Non dentro il guscio nativo
 *
 * Nell'app Android (e domani iOS) i file dell'app viaggiano dentro il
 * pacchetto, e li serve Capacitor da `https://localhost`: il guscio c'e' anche
 * senza rete, che e' tutto cio' per cui il service worker esiste. Registrarlo
 * lo stesso aggiungerebbe una seconda copia del guscio, in una cache che
 * sopravvive agli aggiornamenti dell'app, fra la WebView e i file veri — cioe'
 * un posto in piu' da cui servire una versione vecchia, senza nessun vantaggio.
 *
 * Il guscio si riconosce da `window.Capacitor`, che il lato nativo inietta
 * nella pagina prima che parta qualunque script: `@capacitor/core` non serve
 * importarlo, e `apps/web` resta un sito che non sa di essere avvolto finche'
 * non chiede.
 */

type FinestraConCapacitor = {
  readonly Capacitor?: { readonly isNativePlatform?: () => boolean };
};

export function inGuscioNativo(finestra: object): boolean {
  return (finestra as FinestraConCapacitor).Capacitor?.isNativePlatform?.() === true;
}

export function registraServiceWorker(ambiente: {
  readonly produzione: boolean;
  readonly finestra: Window;
}): void {
  const { produzione, finestra } = ambiente;
  if (!produzione || !("serviceWorker" in finestra.navigator) || inGuscioNativo(finestra)) {
    return;
  }
  finestra.addEventListener("load", () => {
    finestra.navigator.serviceWorker.register("/sw.js").catch(() => {
      // Niente offline. L'app funziona lo stesso, e non c'e' niente da dire
      // all'utente su un guasto che non gli ha impedito nulla.
    });
  });
}
