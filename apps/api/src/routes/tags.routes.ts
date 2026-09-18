import { listTagsQuerySchema } from "@wikimylife/shared";
import { Router, type RequestHandler } from "express";
import { authContext } from "../http/middleware/requireAuth.js";
import { parseQuery } from "../http/validate.js";
import type { ProceduresService } from "../services/procedures.service.js";

/**
 * Una rotta sola, e un file per lei.
 *
 * ## Perche' non sta in `procedures.routes.ts`
 *
 * La forma naturale sarebbe `GET /api/procedures/tags`, ed e' proprio quella
 * che non si puo' avere: quel router dichiara `router.get("/:id")`, e
 * `/procedures/tags` combacia con `:id`. Funzionerebbe solo dichiarando la
 * rotta delle categorie *prima* di quella del dettaglio — cioe' appoggiando la
 * correttezza all'ordine delle righe dentro un file, dove nessun tipo e nessun
 * test di quel file la difende. Il giorno in cui qualcuno riordina per
 * leggibilita', `/api/procedures/tags` comincia a rispondere «Scheda non
 * trovata» con l'id `tags`, e il messaggio non dice niente a nessuno.
 *
 * `/api/tags` non ha quel problema perche' non ha un `:id` sotto, e non ne
 * avra': le categorie non sono una risorsa indirizzabile — non hanno un id nel
 * contratto, si creano scrivendone il nome in una `PATCH` di scheda, e
 * spariscono da sole quando non le usa piu' nessuna scheda. Costa un file e una
 * riga di `app.use`.
 *
 * ## Perche' il servizio e' quello delle schede
 *
 * Perche' le categorie *sono* le schede guardate dall'altro verso: il conteggio
 * di una chip e' il totale della lista che la chip apre, e le due risposte
 * devono essere la stessa verita'. Un `TagsService` a parte avrebbe avuto il suo
 * repository, e due repository che contano le stesse righe sono due repository
 * che prima o poi le contano diversamente.
 */
export function createTagsRouter(deps: {
  proceduresService: ProceduresService;
  requireAuth: RequestHandler;
}): Router {
  const router = Router();

  router.use(deps.requireAuth);

  router.get("/", async (req, res) => {
    const { userId } = authContext(req);
    const query = parseQuery(listTagsQuerySchema, req.query);
    const elenco = await deps.proceduresService.listTags(userId, query);
    res.status(200).json(elenco);
  });

  return router;
}
