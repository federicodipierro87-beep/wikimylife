import { randomUUID } from "node:crypto";
import express, { type Express, type RequestHandler } from "express";
import { createErrorHandler, notFoundHandler } from "./errors/errorHandler.js";
import { createCors } from "./http/middleware/cors.js";
import { createRateLimit } from "./http/middleware/rateLimit.js";
import { createSecurityHeaders } from "./http/middleware/securityHeaders.js";
import type { Logger } from "./logger.js";
import { createAuthRouter } from "./routes/auth.routes.js";
import { createHealthRouter } from "./routes/health.routes.js";
import { createProceduresRouter } from "./routes/procedures.routes.js";
import { createRecordingsRouter } from "./routes/recordings.routes.js";
import { createSearchRouter } from "./routes/search.routes.js";
import type { AuthService } from "./services/auth.service.js";
import type { ProceduresService } from "./services/procedures.service.js";
import type { RecordingsService } from "./services/recordings.service.js";
import type { SearchService } from "./services/search.service.js";

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
  readonly recordingsService: RecordingsService;
  readonly proceduresService: ProceduresService;
  readonly searchService: SearchService;
  readonly requireAuth: RequestHandler;
  readonly isDatabaseUp: () => Promise<boolean>;
  readonly now: () => Date;
  readonly version: string;
  /** Origini ammesse dal CORS. Vuoto = nessuna chiamata cross-origin. */
  readonly corsOrigins: readonly string[];
  /** HSTS: solo dove l'API e' servita in HTTPS. Si veda securityHeaders.ts. */
  readonly hsts: boolean;
  /**
   * Tentativi ammessi per IP e per rotta sulle credenziali, in un minuto.
   *
   * Iniettato perche' i test end-to-end devono poterlo abbassare: provare il
   * limite vero significherebbe fare venti login falliti a colpi di argon2id,
   * e argon2id e' lento apposta.
   */
  readonly authRateLimit: { readonly windowMs: number; readonly max: number };
  /**
   * Salti di proxy da scartare per arrivare all'IP del client.
   *
   * E' il valore da cui dipende che `req.ip` sia falsificabile o no, e quindi
   * che il limite qui sopra conti qualcosa.
   */
  readonly trustProxyHops: number;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  const startedAt = deps.now();

  app.disable("x-powered-by");
  // Un numero, non `true`. `true` direbbe a Express di prendere il primo
  // indirizzo di `X-Forwarded-For`, che lo scrive il client: chiunque potrebbe
  // cambiarlo a ogni richiesta e avere un budget nuovo ogni volta. Con un numero
  // Express conta da destra, e conta le voci che ha aggiunto il proxy. Si veda
  // `TRUST_PROXY_HOPS` in config/env.ts.
  app.set("trust proxy", deps.trustProxyHops);

  // Un id per richiesta: e' cio' che lega una risposta 500 anonima allo stack
  // che e' finito su stderr.
  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    res.setHeader("x-request-id", incoming ?? randomUUID());
    next();
  });

  // Prima di tutto il resto: un preflight non deve attraversare il parser JSON
  // ne' l'autenticazione, e una risposta d'errore senza le intestazioni CORS
  // arriva al browser come un errore di rete, che non dice niente a nessuno.
  app.use(createCors({ origins: deps.corsOrigins }));

  // Dopo il CORS: un preflight non ha bisogno di sapere che l'API nega gli
  // iframe, e aggiungere intestazioni a un 204 vuoto non serve a nessuno.
  app.use(createSecurityHeaders({ hsts: deps.hsts }));

  app.use(express.json({ limit: "1mb" }));

  app.use(createHealthRouter({
    isDatabaseUp: deps.isDatabaseUp,
    version: deps.version,
    startedAt,
    now: deps.now,
  }));

  app.use(
    "/api/auth",
    createAuthRouter({
      authService: deps.authService,
      requireAuth: deps.requireAuth,
      // Quali rotte proteggere lo decide il router: sa lui quali portano
      // credenziali e quali no.
      rateLimit: createRateLimit(deps.authRateLimit),
    }),
  );

  app.use(
    "/api/recordings",
    createRecordingsRouter({
      recordingsService: deps.recordingsService,
      requireAuth: deps.requireAuth,
    }),
  );

  app.use(
    "/api/procedures",
    createProceduresRouter({
      proceduresService: deps.proceduresService,
      requireAuth: deps.requireAuth,
    }),
  );

  app.use(
    "/api/search",
    createSearchRouter({ searchService: deps.searchService, requireAuth: deps.requireAuth }),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));

  return app;
}
