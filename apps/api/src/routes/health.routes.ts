import type { HealthResponse } from "@wikimylife/shared";
import { Router } from "express";

/**
 * `GET /health` — usato dallo health check di Railway e dalla pagina di
 * apps/web per dimostrare che il client tipizzato di shared funziona.
 *
 * Risponde 200 anche con il database giu': lo stato del processo e quello delle
 * sue dipendenze sono due cose diverse, e un 503 farebbe riavviare in ciclo
 * un'API perfettamente viva che sta solo aspettando Postgres.
 */
export function createHealthRouter(deps: {
  isDatabaseUp: () => Promise<boolean>;
  version: string;
  startedAt: Date;
  now: () => Date;
}): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const dbUp = await deps.isDatabaseUp();
    const body: HealthResponse = {
      status: dbUp ? "ok" : "degraded",
      db: dbUp ? "up" : "down",
      uptimeSeconds: Math.floor((deps.now().getTime() - deps.startedAt.getTime()) / 1000),
      version: deps.version,
    };
    res.status(200).json(body);
  });

  return router;
}
