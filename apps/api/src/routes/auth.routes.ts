import {
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
}): Router {
  const router = Router();

  router.post("/signup", async (req, res) => {
    const input = parseBody(signupRequestSchema, req.body);
    const session = await deps.authService.signup(input);
    res.status(201).json(session);
  });

  router.post("/login", async (req, res) => {
    const input = parseBody(loginRequestSchema, req.body);
    const session = await deps.authService.login(input);
    res.status(200).json(session);
  });

  router.post("/refresh", async (req, res) => {
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

  router.get("/me", deps.requireAuth, async (req, res) => {
    const { userId } = authContext(req);
    const user = await deps.authService.me(userId);
    const body: MeResponse = { user };
    res.status(200).json(body);
  });

  return router;
}
