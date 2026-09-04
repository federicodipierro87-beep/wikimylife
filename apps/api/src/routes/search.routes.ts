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
 * Non c'e' `offset`: la seconda pagina di una ricerca fusa non e' stabile —
 * l'ordine dipende dalle due liste intere, e ripetere la query per saltare i
 * primi venti significa rifare entrambe le interrogazioni e la fusione. Se
 * servira' un "carica altri", si fara' allargando `limit`.
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
