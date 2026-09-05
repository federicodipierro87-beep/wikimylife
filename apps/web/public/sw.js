/**
 * Il service worker.
 *
 * Fa una cosa sola: tenere in cache il guscio dell'applicazione, cosi' che
 * aprirla senza rete mostri la schermata di registrazione invece del dinosauro
 * del browser. E' cio' che rende vera la promessa della §2 — «se manca la rete,
 * la registrazione si accoda» — perche' senza guscio in cache non c'e' nessun
 * pulsante da premere.
 *
 * ## `/api` non si mette MAI in cache
 *
 * E' la regola piu' importante di questo file. Una risposta di `/api` in cache
 * significherebbe mostrare la scheda di ieri come se fosse quella di oggi, o —
 * molto peggio — servire a un utente la lista di un altro rimasta nella cache
 * dello stesso browser. Le richieste all'API passano dritte alla rete, e se non
 * c'e' rete falliscono: e' l'applicazione a sapere cosa fare di un errore, non
 * il service worker.
 *
 * ## Rete prima, cache dopo, per il guscio
 *
 * L'opposto (cache prima) sarebbe piu' veloce e servirebbe una versione vecchia
 * dell'app finche' non si chiude ogni scheda aperta. Con un deploy che puo'
 * cambiare il contratto HTTP sotto ai piedi del client, un'app vecchia che
 * parla con un'API nuova e' il tipo di guasto che nessuno riesce a riprodurre.
 *
 * Non e' generato da un plugin: sono sessanta righe, mentre `vite-plugin-pwa`
 * con Workbox porta con se' qualche megabyte e una configurazione da imparare
 * per ottenere le stesse due regole.
 */

const VERSIONE = "wikimylife-v1";
const GUSCIO = ["/", "/index.html", "/manifest.webmanifest", "/icona.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSIONE)
      .then((cache) => cache.addAll(GUSCIO))
      // `skipWaiting` senza aspettare che le vecchie schede si chiudano: due
      // versioni del guscio vive insieme sono la causa piu' comune di «a me
      // funziona» dopo un deploy.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((chiavi) =>
        Promise.all(chiavi.filter((k) => k !== VERSIONE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // Solo la nostra origine: un CDN o Nominatim li gestisce il browser.
  if (url.origin !== self.location.origin) {
    return;
  }

  // La regola che non si tocca.
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((risposta) => {
        // Solo le risposte buone: mettere in cache un 404 significa servirlo
        // per sempre, anche dopo che il file e' stato pubblicato davvero.
        if (risposta.ok && risposta.type === "basic") {
          const copia = risposta.clone();
          void caches.open(VERSIONE).then((cache) => cache.put(request, copia));
        }
        return risposta;
      })
      .catch(async () => {
        const inCache = await caches.match(request);
        if (inCache !== undefined) {
          return inCache;
        }
        // Navigazione senza rete e senza corrispondenza esatta: e' un'app a
        // pagina singola, quindi qualsiasi indirizzo si serve con il guscio.
        if (request.mode === "navigate") {
          const guscio = await caches.match("/index.html");
          if (guscio !== undefined) {
            return guscio;
          }
        }
        return Response.error();
      }),
  );
});
