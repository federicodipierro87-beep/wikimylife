import { randomUUID } from "node:crypto";
import express, { type Express, type RequestHandler } from "express";
import { createErrorHandler, notFoundHandler } from "./errors/errorHandler.js";
import type { Logger } from "./logger.js";
import { createAuthRouter } from "./routes/auth.routes.js";
import { createHealthRouter } from "./routes/health.routes.js";
import type { AuthService } from "./services/auth.service.js";

/**
 * Costruisce l'app Express a partire dalle dipendenze gia' risolte.
 *
 * Non chiama `listen`. E' la differenza che permette ai test end-to-end di
 * avviarla su una porta effimera (`listen(0)`), leggere la porta assegnata e
 * parlarci con `fetch` — quindici righe che rendono inutile `supertest`, e in
 * piu' esercitano lo stack HTTP vero invece di un finto oggetto request.
 */

export interface AppDeps {
  readonly logger: Logger;
  readonly authService: AuthService;
  readonly requireAuth: RequestHandler;
  readonly isDatabaseUp: () => Promise<boolean>;
  readonly now: () => Date;
  readonly version: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  const startedAt = deps.now();

  app.disable("x-powered-by");
  // Dietro il proxy di Railway: senza, req.ip e' sempre quello del proxy.
  app.set("trust proxy", true);

  // Un id per richiesta: e' cio' che lega una risposta 500 anonima allo stack
  // che e' finito su stderr.
  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    res.setHeader("x-request-id", incoming ?? randomUUID());
    next();
  });

  app.use(express.json({ limit: "1mb" }));

  app.use(createHealthRouter({
    isDatabaseUp: deps.isDatabaseUp,
    version: deps.version,
    startedAt,
    now: deps.now,
  }));

  app.use(
    "/api/auth",
    createAuthRouter({ authService: deps.authService, requireAuth: deps.requireAuth }),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));

  return app;
}
