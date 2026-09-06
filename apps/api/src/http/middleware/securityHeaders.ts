import type { RequestHandler } from "express";

/**
 * Cinque intestazioni, non le quindici di `helmet`.
 *
 * Quel pacchetto e' pensato per un server che rende HTML. Questo rende solo
 * JSON e byte di audio: meta' dei suoi default proteggono da attacchi che
 * richiedono una pagina — e l'unica pagina di questo prodotto la serve Netlify,
 * dove la protezione va messa in `netlify.toml` e non qui. Installarlo
 * darebbe la sensazione di aver coperto il frontend senza averlo coperto, che
 * e' il modo piu' efficace di non tornarci mai piu' sopra.
 *
 * Restano le cinque che valgono anche per un'API.
 */
export function createSecurityHeaders(deps: {
  /**
   * HSTS solo dove c'e' davvero HTTPS. In sviluppo l'API sta su
   * `http://localhost`, e un browser che ricevesse HSTS da li' si rifiuterebbe
   * di parlare in chiaro con QUALUNQUE cosa su localhost per un anno — Vite
   * compreso, e per progetti che non c'entrano niente. Si disinnesca solo
   * svuotando a mano le impostazioni del sito.
   */
  readonly hsts: boolean;
}): RequestHandler {
  return (_req, res, next) => {
    // Il browser non deve indovinare il tipo. `nosniff` e' cio' che impedisce
    // che un audio caricato da un utente venga interpretato come HTML e
    // eseguito nell'origine dell'API.
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Questa API non va mai messa in un iframe: non ha interfaccia, quindi non
    // c'e' niente su cui fare clickjacking, e negarlo costa una riga.
    res.setHeader("X-Frame-Options", "DENY");

    // Un Referer verso un dominio esterno porterebbe con se' il percorso, e i
    // percorsi qui contengono id di registrazioni e di schede.
    res.setHeader("Referrer-Policy", "no-referrer");

    // Nessuna risorsa di questa origine puo' essere incorporata in un documento
    // di un'altra.
    //
    // Non contraddice il CORS, e vale la pena sapere perche': questa
    // intestazione blocca le richieste `no-cors` — quelle di `<img src>`,
    // `<script src>`, `<audio src>` — non quelle in modalita' CORS. La PWA sta
    // su un'altra origine ma chiede l'audio con `fetch` e un header
    // `Authorization`, quindi e' per forza CORS e passa.
    //
    // Il che vuol dire anche: il giorno in cui il player tornasse a
    // `<audio src={url}>` smetterebbe di funzionare, e questa riga sarebbe il
    // posto da guardare. Quel giorno non deve arrivare — un `src` diretto non
    // puo' portare il token, ed e' il motivo per cui il player scarica con
    // `fetch`.
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

    if (deps.hsts) {
      // Un anno, sottodomini inclusi. Niente `preload`: iscriversi alla lista
      // dei browser e' una decisione difficile da revocare, e non si prende di
      // sfuggita in un middleware.
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    next();
  };
}
