import {
  applyRedactionBodySchema,
  createExecutionBodySchema,
  deleteProcedureQuerySchema,
  emptyTrashQuerySchema,
  listProceduresQuerySchema,
  updateProcedureBodySchema,
} from "@wikimylife/shared";
import { Router, type RequestHandler } from "express";
import { authContext } from "../http/middleware/requireAuth.js";
import { parseBody, parseQuery } from "../http/validate.js";
import type { ProceduresService } from "../services/procedures.service.js";

/**
 * Le otto rotte sulle schede.
 *
 * Nessun `if` di dominio qui dentro: si prende lo `userId` dal token, si valida
 * l'ingresso con lo schema di `packages/shared` e si delega. Le regole della §8
 * e della §9 stanno nel servizio, dove si possono provare senza un server
 * acceso.
 *
 * ## Perche' `DELETE` risponde 200 e non 204
 *
 * Nel caso normale non cancella: archivia (`status = ARCHIVIATA`). Un 204
 * direbbe «non c'e' piu' niente da vedere», che li' e' falso — la scheda esiste,
 * e' leggibile con `?status=ARCHIVIATA` e si puo' riportare indietro con una
 * `PATCH`. Restituendo la scheda aggiornata il client ha subito lo stato vero,
 * senza una seconda chiamata per scoprire che il "cancellato" e' reversibile.
 *
 * Con `?definitivo=1` la stessa rotta cancella per davvero, e allora il 204 e'
 * la risposta giusta per la stessa ragione per cui prima era sbagliata: non
 * c'e' piu' niente da mandare indietro. Due rotte separate avrebbero significato
 * due percorsi da proteggere allo stesso modo e un `/:id/definitivo` che
 * qualsiasi lettore scambierebbe per una sotto-risorsa. E' un'opzione della
 * cancellazione, non un'altra cosa che si cancella.
 *
 * ## Perche' `POST /:id/executions` risponde 200 e non 201
 *
 * L'`Execution` viene creata davvero, ma non e' una risorsa indirizzabile: non
 * esiste `GET /executions/:id`, e un 201 senza `Location` e' una promessa a
 * vuoto. Cio' che interessa al chiamante e' l'*effetto* sulla scheda — un esito
 * `CAMBIATA` la riporta in `DA_RIVEDERE` — quindi la risposta e' la scheda.
 *
 * ## Perche' la redazione (§9) e' una `GET` e una `POST` sullo stesso percorso
 *
 * La §9 chiede che le sostituzioni si facciano «confermare una per una». Sono
 * due passi distinti nel tempo — il server propone, una persona guarda, il
 * server applica cio' che ha ricevuto indietro — e due passi distinti nel tempo
 * sono due chiamate. Una sola rotta che redigesse tutto avrebbe tolto di mezzo
 * l'unica cosa che la §9 chiede davvero: lo sguardo in mezzo.
 *
 * La `POST` non e' `PATCH` perche' non descrive uno stato desiderato: manda
 * degli identificativi e chiede al server di rifare i conti. E non e' `PUT`
 * perche' non e' idempotente in modo utile — rimandare le stesse conferme una
 * seconda volta fallisce con 409, dato che dopo la prima quelle proposte non
 * esistono piu'.
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

  /**
   * Svuotare il cestino.
   *
   * Sta prima di `/:id` perche' cosi' si legge accanto all'altra `DELETE`, non
   * perche' serva: Express non fa combaciare `/:id` con la collezione, e un id
   * vuoto finirebbe comunque qui anche invertendo le due righe. Il motivo per
   * cui una richiesta storta non diventa uno svuotamento e' un altro, e sta
   * nello schema: `emptyTrashQuerySchema` pretende `status=ARCHIVIATA` e
   * `definitivo=1`, due valori letterali che nessun errore di composizione
   * produce da solo.
   *
   * Risponde 200 con `{ cancellate, saltate }` e non 204: fra la lettura
   * dell'elenco e l'ultima cancellazione qualcuno puo' aver ripescato una
   * scheda dal cestino, e allora il cestino dopo lo svuotamento non e' vuoto.
   * Con un 204 quel cestino sembrerebbe un guasto.
   */
  router.delete("/", async (req, res) => {
    const { userId } = authContext(req);
    parseQuery(emptyTrashQuerySchema, req.query);
    const esito = await deps.proceduresService.emptyTrash(userId);
    res.status(200).json(esito);
  });

  router.delete("/:id", async (req, res) => {
    const { userId } = authContext(req);
    const { definitivo } = parseQuery(deleteProcedureQuerySchema, req.query);

    if (definitivo) {
      await deps.proceduresService.deleteForever(userId, req.params.id);
      res.status(204).end();
      return;
    }

    const scheda = await deps.proceduresService.archive(userId, req.params.id);
    res.status(200).json(scheda);
  });

  router.post("/:id/executions", async (req, res) => {
    const { userId } = authContext(req);
    const body = parseBody(createExecutionBodySchema, req.body);
    const scheda = await deps.proceduresService.addExecution(userId, req.params.id, body);
    res.status(200).json(scheda);
  });

  router.get("/:id/redazione", async (req, res) => {
    const { userId } = authContext(req);
    const report = await deps.proceduresService.proposeRedaction(userId, req.params.id);
    res.status(200).json(report);
  });

  router.post("/:id/redazione", async (req, res) => {
    const { userId } = authContext(req);
    const body = parseBody(applyRedactionBodySchema, req.body);
    const scheda = await deps.proceduresService.applyRedaction(userId, req.params.id, body);
    res.status(200).json(scheda);
  });

  return router;
}
