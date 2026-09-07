import { searchQuerySchema } from "@wikimylife/shared";
import { Router, type RequestHandler } from "express";
import { authContext } from "../http/middleware/requireAuth.js";
import { parseQuery } from "../http/validate.js";
import type { SearchService } from "../services/search.service.js";

/**
 * La ricerca ibrida della §7, dietro una sola rotta.
 *
 * `q` minima di due caratteri: sotto, `websearch_to_tsquery` non trova nulla di
 * sensato e l'embedding di una lettera sola e' rumore che l'indice HNSW
 * restituisce comunque, ordinato. Meglio un 400 esplicito che una lista di
 * risultati casuali con un punteggio accanto.
 *
 * `offset` c'e', e arriva fino a `SEARCH_MAX_DEPTH`. Sfogliare una ricerca fusa
 * e' stabile solo perche' la finestra che i due canali restituiscono non dipende
 * da `limit`: la classifica e' la stessa a ogni pagina, e saltarne i primi venti
 * elementi vuol dire leggerne venti in meno, non venti in piu'. Il tetto non e'
 * una prudenza sul costo — le pagine costano tutte uguale — ma il confine oltre
 * il quale la fusione non ha piu' nulla da ordinare.
 */
export function createSearchRouter(deps: {
  searchService: SearchService;
  requireAuth: RequestHandler;
}): Router {
  const router = Router();

  router.use(deps.requireAuth);

  router.get("/", async (req, res) => {
    const { userId } = authContext(req);
    const query = parseQuery(searchQuerySchema, req.query);
    const result = await deps.searchService.search(userId, query);
    res.status(200).json(result);
  });

  return router;
}
