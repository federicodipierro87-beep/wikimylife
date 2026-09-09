import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import type { FamilyRegistry } from "../../services/ports/AuthRepository.js";
import type { Clock } from "../../services/ports/Clock.js";
import type { TokenIssuer } from "../../services/ports/TokenIssuer.js";

/**
 * Estrae il Bearer token, ne verifica la firma e chiede se la sessione da cui
 * proviene esiste ancora.
 *
 * Header `Authorization` e mai cookie di sessione: i cookie fuori dal browser
 * funzionano male, e l'app nativa deve parlare con questo stesso backend senza
 * modifiche.
 *
 * ## Perche' la firma non basta
 *
 * Un JWT valido dice «questo l'ho emesso io e non e' ancora scaduto». Non dice
 * «questa sessione e' ancora aperta», e le due cose smettono di coincidere
 * esattamente nel momento peggiore: quando qualcuno preme "esci" perche' ha
 * perso il telefono, o quando la reuse detection scopre un furto. Fermarsi alla
 * firma lasciava a chi aveva il token in mano fino a quindici minuti di accesso
 * pieno *dopo* che l'utente aveva fatto tutto cio' che l'app gli offre per
 * difendersi.
 *
 * ## Il prezzo, detto per intero
 *
 * Ogni richiesta autenticata paga una lettura indicizzata in piu'. E' il costo
 * che l'access token esisteva per evitare, quindi vale la pena essere precisi
 * su quanto sia: e' una riga su un indice, verso lo stesso Postgres che ogni
 * rotta protetta interroga comunque subito dopo per fare il proprio lavoro. Non
 * c'era nessuna richiesta autenticata che si concludesse senza toccare il
 * database; ora ne tocca una in piu'.
 *
 * L'alternativa era una cache in processo: quasi gratis, ma trasforma la revoca
 * da immediata a «entro qualche secondo», e con piu' repliche quel «qualche»
 * dipende da quale replica risponde. Una finestra piccola resta una finestra, e
 * questo middleware esiste per chiuderla, non per accorciarla.
 */

/**
 * `familyId` accanto a `userId`, e non solo lo userId.
 *
 * Per quasi tutte le rotte la famiglia non serve: le procedure sono
 * dell'utente, non del telefono. Serve all'unica rotta che deve distinguere
 * «questo dispositivo» da «tutti gli altri», e la risposta a quella domanda non
 * puo' arrivare dal corpo della richiesta — sarebbe il chiamante a dichiarare
 * quale sessione risparmiare, cioe' esattamente la cosa che non deve poter
 * scegliere. Qui invece e' il token stesso a dirlo, ed e' un token firmato di
 * cui la riga sopra ha appena verificato che la famiglia sia viva.
 */
declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; familyId: string };
    }
  }
}

export function createRequireAuth(deps: {
  tokens: TokenIssuer;
  clock: Clock;
  families: FamilyRegistry;
}): RequestHandler {
  return async function requireAuth(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const header = req.get("authorization");
    if (header === undefined) {
      next(AppError.unauthorized());
      return;
    }

    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || token === undefined || token.length === 0) {
      next(AppError.unauthorized("Header Authorization malformato"));
      return;
    }

    try {
      const claims = await deps.tokens.verifyAccessToken(token, deps.clock.now());

      // Dopo la firma e prima di `req.auth`: fra i due non deve passare niente
      // che assomigli a una richiesta autenticata.
      const viva = await deps.families.isFamilyActive(claims.familyId);
      if (!viva) {
        // UNAUTHORIZED e non TOKEN_REUSED: dal punto di vista del client questo
        // e' un 401 recuperabile, quindi prova una rotazione. La rotazione
        // fallisce — i refresh della famiglia sono revocati quanto l'access — e
        // a quel punto svuota tutto e mostra la schermata di ingresso. E' il
        // percorso giusto: chi ha chiuso la sessione altrove deve rientrare
        // dalla porta, non ricevere un errore che nessuna schermata sa gestire.
        next(AppError.unauthorized("Sessione chiusa"));
        return;
      }

      req.auth = { userId: claims.userId, familyId: claims.familyId };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Legge il contesto autenticato.
 *
 * Esiste per non spargere `req.auth!` nei gestori: l'unico modo di ottenere uno
 * userId e' passare da qui, e se il middleware non e' stato montato il
 * fallimento e' immediato e rumoroso invece di essere un `undefined` che scende
 * verso un servizio.
 *
 * Regola che ne discende, e che vale per tutte le fasi successive: lo userId
 * non arriva MAI a un servizio come parametro opzionale. La firma e'
 * `updateProcedure(userId, id, patch)`, il WHERE e' sempre composto, mai un
 * `findUnique` seguito da un `if`. Risorsa altrui: 404, non 403 — un 403
 * confermerebbe che quell'id esiste.
 */
export function authContext(req: Request): { userId: string; familyId: string } {
  const auth = req.auth;
  if (auth === undefined) {
    throw AppError.unauthorized();
  }
  return auth;
}
