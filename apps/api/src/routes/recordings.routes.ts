import { Router, type RequestHandler } from "express";
import { authContext } from "../http/middleware/requireAuth.js";
import { parseRecordingUpload, rawUploadBody } from "../http/multipart.js";
import type { RecordingsService } from "../services/recordings.service.js";

/**
 * Le tre rotte della §1.
 *
 * `POST` risponde **202**, non 201: i byte sono al sicuro e la riga esiste, ma
 * la scheda no — e potrebbe non esistere mai, se il testo si rivela un
 * duplicato. 201 prometterebbe una risorsa creata e finita; 202 dice
 * esattamente cio' che e' successo, e obbliga il client a fare polling su
 * `GET /:id` invece di assumere che il lavoro sia concluso.
 *
 * Lo `userId` non compare in nessun URL: viene dal token e basta. Un id in
 * rotta sarebbe una cosa in piu' da verificare a ogni chiamata, e prima o poi
 * qualcuno se ne dimenticherebbe.
 */
export function createRecordingsRouter(deps: {
  recordingsService: RecordingsService;
  requireAuth: RequestHandler;
}): Router {
  const router = Router();

  router.use(deps.requireAuth);

  router.post("/", rawUploadBody(), async (req, res) => {
    const { userId } = authContext(req);
    const upload = await parseRecordingUpload(req);
    const state = await deps.recordingsService.create(userId, upload);
    res.status(202).json(state);
  });

  router.get("/:id", async (req, res) => {
    const { userId } = authContext(req);
    const state = await deps.recordingsService.find(userId, req.params.id);
    res.status(200).json(state);
  });

  router.post("/:id/retry", async (req, res) => {
    const { userId } = authContext(req);
    const state = await deps.recordingsService.retry(userId, req.params.id);
    res.status(202).json(state);
  });

  return router;
}
