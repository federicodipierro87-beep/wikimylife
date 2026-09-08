import {
  changePasswordRequestSchema,
  loginRequestSchema,
  logoutRequestSchema,
  refreshRequestSchema,
  signupRequestSchema,
  type LogoutResponse,
  type MeResponse,
} from "@wikimylife/shared";
import { Router, type RequestHandler } from "express";
import { authContext } from "../http/middleware/requireAuth.js";
import { parseBody } from "../http/validate.js";
import type { AuthService } from "../services/auth.service.js";

/**
 * Strato sottile: valida con Zod, chiama il servizio, serializza. Zero
 * condizioni di dominio — se qui comparisse un `if` che decide qualcosa sul
 * prodotto, sarebbe nel posto sbagliato.
 *
 * Nessun `try/catch`: Express 5 propaga i rejection dei handler async
 * all'error middleware da solo.
 */
export function createAuthRouter(deps: {
  authService: AuthService;
  requireAuth: RequestHandler;
  /**
   * Sta sulle rotte che accettano una password, autenticate o no.
   *
   * Le prime tre — `/signup`, `/login`, `/refresh` — accettano un segreto da
   * chi non e' ancora nessuno, e sono il bersaglio ovvio. `/password` e' dietro
   * `requireAuth` e lo si limita lo stesso, per due ragioni che si sommano: e'
   * l'unico posto in cui chi ha rubato un access token puo' indovinare la
   * password online, ed e' l'unica rotta che paga due argon2 per richiesta —
   * una verifica e un hash — quindi martellarla costa alla CPU dell'API molto
   * piu' che a chi la martella.
   *
   * Le finestre non si mescolano: la chiave del limitatore contiene la rotta,
   * quindi un cambio password non consuma i tentativi di `/login` e nessuno dei
   * due puo' esaurire l'altro.
   *
   * `/logout` ne resta fuori perche' martellarlo non da' niente a chi prova: il
   * token o e' valido — e allora sta revocando la propria sessione — o non lo
   * e', e la risposta e' identica. `/me` ne resta fuori perche' e' gia' dietro
   * `requireAuth`, non accetta nessun segreto, e limitarlo significherebbe far
   * cadere l'app di un utente legittimo che ricarica la pagina qualche volta di
   * troppo.
   */
  rateLimit: RequestHandler;
}): Router {
  const router = Router();

  router.post("/signup", deps.rateLimit, async (req, res) => {
    const input = parseBody(signupRequestSchema, req.body);
    const session = await deps.authService.signup(input);
    res.status(201).json(session);
  });

  router.post("/login", deps.rateLimit, async (req, res) => {
    const input = parseBody(loginRequestSchema, req.body);
    const session = await deps.authService.login(input);
    res.status(200).json(session);
  });

  // Un refresh token e' una credenziale come una password: se e' indovinabile,
  // e' indovinabile a colpi di richieste come tutto il resto.
  router.post("/refresh", deps.rateLimit, async (req, res) => {
    const input = parseBody(refreshRequestSchema, req.body);
    const session = await deps.authService.refresh(input.refreshToken);
    res.status(200).json(session);
  });

  router.post("/logout", async (req, res) => {
    const input = parseBody(logoutRequestSchema, req.body);
    await deps.authService.logout(input.refreshToken);
    const body: LogoutResponse = { ok: true };
    res.status(200).json(body);
  });

  /**
   * Risponde con una sessione intera e non con `{ ok: true }`.
   *
   * La chiamata ha appena revocato ogni token dell'utente, compresi quelli che
   * il client aveva in mano un istante fa: se tornasse un ok, il client
   * resterebbe con due credenziali morte e scoprirebbe di essere fuori alla
   * richiesta successiva. I token nuovi stanno nella risposta perche' e'
   * l'unico momento in cui si possono consegnare senza un secondo login.
   */
  router.post("/password", deps.rateLimit, deps.requireAuth, async (req, res) => {
    const { userId } = authContext(req);
    const input = parseBody(changePasswordRequestSchema, req.body);
    const session = await deps.authService.changePassword(userId, input);
    res.status(200).json(session);
  });

  router.get("/me", deps.requireAuth, async (req, res) => {
    const { userId } = authContext(req);
    const user = await deps.authService.me(userId);
    const body: MeResponse = { user };
    res.status(200).json(body);
  });

  return router;
}
