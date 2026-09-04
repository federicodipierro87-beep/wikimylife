import {
  createExecutionBodySchema,
  listProceduresQuerySchema,
  updateProcedureBodySchema,
} from "@wikimylife/shared";
import { Router, type RequestHandler } from "express";
import { authContext } from "../http/middleware/requireAuth.js";
import { parseBody, parseQuery } from "../http/validate.js";
import type { ProceduresService } from "../services/procedures.service.js";

/**
 * Le cinque rotte sulle schede.
 *
 * Nessun `if` di dominio qui dentro: si prende lo `userId` dal token, si valida
 * l'ingresso con lo schema di `packages/shared` e si delega. Le regole della §8
 * e della §9 stanno nel servizio, dove si possono provare senza un server
 * acceso.
 *
 * ## Perche' `DELETE` risponde 200 e non 204
 *
 * Non cancella: archivia (`status = ARCHIVIATA`). Un 204 direbbe «non c'e' piu'
 * niente da vedere», che qui e' falso — la scheda esiste, e' leggibile con
 * `?status=ARCHIVIATA` e si puo' riportare indietro con una `PATCH`.
 * Restituendo la scheda aggiornata il client ha subito lo stato vero, senza una
 * seconda chiamata per scoprire che il "cancellato" e' reversibile.
 *
 * ## Perche' `POST /:id/executions` risponde 200 e non 201
 *
 * L'`Execution` viene creata davvero, ma non e' una risorsa indirizzabile: non
 * esiste `GET /executions/:id`, e un 201 senza `Location` e' una promessa a
 * vuoto. Cio' che interessa al chiamante e' l'*effetto* sulla scheda — un esito
 * `CAMBIATA` la riporta in `DA_RIVEDERE` — quindi la risposta e' la scheda.
 */
export function createProceduresRouter(deps: {
  proceduresService: ProceduresService;
  requireAuth: RequestHandler;
}): Router {
  const router = Router();

  router.use(deps.requireAuth);

  router.get("/", async (req, res) => {
    const { userId } = authContext(req);
    const query = parseQuery(listProceduresQuerySchema, req.query);
    const page = await deps.proceduresService.list(userId, query);
    res.status(200).json(page);
  });

  router.get("/:id", async (req, res) => {
    const { userId } = authContext(req);
    const scheda = await deps.proceduresService.find(userId, req.params.id);
    res.status(200).json(scheda);
  });

  router.patch("/:id", async (req, res) => {
    const { userId } = authContext(req);
    const patch = parseBody(updateProcedureBodySchema, req.body);
    const scheda = await deps.proceduresService.update(userId, req.params.id, patch);
    res.status(200).json(scheda);
  });

  router.delete("/:id", async (req, res) => {
    const { userId } = authContext(req);
    const scheda = await deps.proceduresService.archive(userId, req.params.id);
    res.status(200).json(scheda);
  });

  router.post("/:id/executions", async (req, res) => {
    const { userId } = authContext(req);
    const body = parseBody(createExecutionBodySchema, req.body);
    const scheda = await deps.proceduresService.addExecution(userId, req.params.id, body);
    res.status(200).json(scheda);
  });

  return router;
}
