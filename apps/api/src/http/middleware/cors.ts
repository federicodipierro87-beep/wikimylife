import type { RequestHandler } from "express";

/**
 * CORS ristretto a una lista chiusa di origini.
 *
 * Trenta righe invece del pacchetto `cors`, per la stessa ragione per cui non
 * c'e' `dotenv`: di quel pacchetto servirebbe una sola opzione, e la sua
 * configurazione piu' comune — `origin: true`, che rimanda indietro qualsiasi
 * origine chieda — e' esattamente quella che qui non si deve poter scrivere
 * per sbaglio.
 *
 * ## Si rimanda l'origine, mai `*`
 *
 * `Access-Control-Allow-Origin: *` direbbe «chiunque puo' leggermi». E' falso:
 * possono leggere solo il dominio Netlify e, in sviluppo, Vite. Rimandare
 * l'origine che ha chiesto — dopo averla confrontata con la lista — dice la
 * verita', e resta corretto il giorno in cui l'autenticazione passasse dai
 * cookie, dove `*` e' proprio vietato.
 *
 * ## `Vary: Origin` anche quando l'origine non e' ammessa
 *
 * La risposta dipende da chi la chiede. Senza `Vary`, una cache condivisa —
 * la CDN davanti all'API, un proxy aziendale — potrebbe servire a un'origine
 * la risposta preparata per un'altra, con l'intestazione sbagliata attaccata.
 * Va messo sempre, anche sul ramo che nega, perche' e' il ramo che nega a
 * essere cacheabile per sbaglio.
 *
 * ## Niente `Allow-Credentials`
 *
 * I token viaggiano in `Authorization`, non nei cookie. Non c'e' autorita'
 * ambientale da proteggere, e dichiarare le credenziali costringerebbe a
 * garanzie che non servono.
 */

const METODI = "GET,POST,PATCH,DELETE,OPTIONS";
/**
 * `authorization` e `content-type` sono quelle vere. `x-request-id` c'e'
 * perche' il client puo' proporne uno, ed e' cio' che lega una segnalazione
 * dell'utente alla riga di log giusta.
 */
const INTESTAZIONI = "authorization,content-type,x-request-id";
/** Un giorno: il preflight di una PWA non cambia idea piu' spesso. */
const MAX_AGE = "86400";

export function createCors(deps: { readonly origins: readonly string[] }): RequestHandler {
  const ammesse = new Set(deps.origins);

  return (req, res, next) => {
    // Sempre: e' l'intestazione che protegge le cache, non quella che concede.
    res.setHeader("Vary", "Origin");

    const origin = req.get("origin");

    // Nessuna origine: stessa origine, oppure curl. Non c'e' niente da
    // dichiarare, e dichiararlo lo stesso confonderebbe soltanto.
    if (origin === undefined) {
      next();
      return;
    }

    if (!ammesse.has(origin)) {
      if (req.method === "OPTIONS") {
        // Un 403 esplicito invece di un 404 dal gestore delle rotte
        // inesistenti: la differenza si vede solo nei DevTools di chi sta
        // configurando il dominio, ed e' esattamente li' che serve.
        res.status(403).end();
        return;
      }
      // Senza intestazioni la risposta esiste ma il browser non la fa leggere.
      next();
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Expose-Headers", "x-request-id");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", METODI);
      res.setHeader("Access-Control-Allow-Headers", INTESTAZIONI);
      res.setHeader("Access-Control-Max-Age", MAX_AGE);
      // 204: il preflight non ha corpo, e non deve passare per le rotte.
      res.status(204).end();
      return;
    }

    next();
  };
}
