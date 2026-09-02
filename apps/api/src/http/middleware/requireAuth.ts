import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import type { Clock } from "../../services/ports/Clock.js";
import type { TokenIssuer } from "../../services/ports/TokenIssuer.js";

/**
 * Estrae e verifica il Bearer token.
 *
 * Header `Authorization` e mai cookie di sessione: i cookie fuori dal browser
 * funzionano male, e l'app nativa deve parlare con questo stesso backend senza
 * modifiche.
 */

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string };
    }
  }
}

export function createRequireAuth(deps: {
  tokens: TokenIssuer;
  clock: Clock;
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
      req.auth = { userId: claims.userId };
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
export function authContext(req: Request): { userId: string } {
  const auth = req.auth;
  if (auth === undefined) {
    throw AppError.unauthorized();
  }
  return auth;
}
