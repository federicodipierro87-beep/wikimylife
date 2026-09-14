import {
  changePasswordRequestSchema,
  loginRequestSchema,
  logoutRequestSchema,
  refreshRequestSchema,
  revokeOtherSessionsRequestSchema,
  revokeSessionRequestSchema,
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
   * chi non e' ancora nessuno, e sono il bersaglio ovvio. `/password` e
   * `/sessions/revoke` e `/sessions/revoke-one` sono dietro `requireAuth` e si
   * limitano lo stesso, per due ragioni che si sommano: sono i posti in cui chi
   * ha rubato un access token puo' indovinare la password online, e ogni
   * tentativo costa un argon2 alla CPU dell'API — due, su `/password`, che
   * verifica e poi calcola — quindi martellarle costa a chi risponde piu' che a
   * chi martella.
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

  /**
   * `POST /sessions/revoke` e non `DELETE /sessions`.
   *
   * La cosa da fare sarebbe la seconda — si stanno cancellando delle sessioni —
   * se non fosse che serve mandare una password nel corpo, e un corpo su una
   * DELETE e' consentito dallo standard ma trattato male da meta' del mondo che
   * sta in mezzo: proxy che lo scartano, `fetch` che nelle vecchie versioni non
   * lo manda. Una password che sparisce per strada qui non da' un errore di
   * rete, da' un `VALIDATION_FAILED` che nessuno saprebbe spiegare.
   *
   * Sotto `rateLimit` per la ragione di `/password`, che qui vale identica: e'
   * una rotta autenticata che accetta una password, quindi e' un posto da cui
   * indovinarla online, e paga un argon2 per tentativo.
   *
   * Non risponde con una sessione, al contrario di `/password`: questa chiamata
   * non revoca i token di chi la fa, quindi non c'e' niente da consegnare in
   * cambio. Risponde con quanti dispositivi sono caduti.
   */
  router.post("/sessions/revoke", deps.rateLimit, deps.requireAuth, async (req, res) => {
    const { userId, familyId } = authContext(req);
    const input = parseBody(revokeOtherSessionsRequestSchema, req.body);
    const body = await deps.authService.revokeOtherSessions(userId, familyId, input);
    res.status(200).json(body);
  });

  /**
   * `POST /sessions/revoke-one`, con l'id nel corpo e non nel percorso.
   *
   * ## Perche' non `POST /sessions/:id/revoke`
   *
   * Perche' la chiave del limitatore e' costruita su `req.path`, che e' il
   * percorso *concreto* della richiesta e non lo schema della rotta
   * (`rateLimit.ts`). Con l'id nel percorso, ogni id aprirebbe un secchiello
   * nuovo: questa rotta accetta una password, e diventerebbe un oracolo senza
   * limite, perche' basta cambiare l'UUID a ogni tentativo per non incontrare
   * mai il 429. `DELETE /sessions/:id` cade per la stessa ragione, piu' quella
   * gia' scritta su `/sessions/revoke` a proposito dei corpi sulle DELETE.
   *
   * ## Perche' non e' `/sessions/revoke` con un campo facoltativo
   *
   * Perche' sarebbe un campo *assente* a decidere se il gesto ne chiude una o
   * tutte, e un corpo malformato sceglierebbe il ramo piu' distruttivo.
   *
   * `-one` e non `-single` o `/one`: il percorso deve leggersi accanto a
   * `/sessions/revoke` e dire in che cosa differisce, perche' i due si
   * scambiano di posto in un copia-incolla senza che niente smetta di compilare.
   */
  router.post("/sessions/revoke-one", deps.rateLimit, deps.requireAuth, async (req, res) => {
    const { userId, familyId } = authContext(req);
    const input = parseBody(revokeSessionRequestSchema, req.body);
    const body = await deps.authService.revokeSession(userId, familyId, input);
    res.status(200).json(body);
  });

  /**
   * `GET /sessions`, e sotto `requireAuth` soltanto.
   *
   * Fuori da `rateLimit` per la ragione gia' scritta per `/me`: non accetta
   * nessun segreto, quindi non c'e' niente da indovinare a colpi di richieste, e
   * non paga un argon2 per chiamata. Limitarla farebbe un solo danno vero —
   * spegnere l'elenco proprio a chi ricarica la schermata mentre cerca di capire
   * quale dispositivo scollegare.
   *
   * Convive con le altre due sotto `/sessions` senza contendergliele: verbo
   * diverso e percorsi diversi, tutti e tre letterali. E' anche il motivo per
   * cui l'id di `revoke-one` sta nel corpo: il commento di questa rotta
   * avvisava che «un giorno qualcuno scrivera' `router.get("/sessions/:id")` e
   * il primo a rompersi sara' l'altro», e con l'id nel corpo quel giorno non
   * arriva. Il caso che prova le tre combinazioni sbagliate sta
   * nell'integrazione, ed e' cresciuto insieme alle rotte.
   */
  router.get("/sessions", deps.requireAuth, async (req, res) => {
    const { userId, familyId } = authContext(req);
    const body = await deps.authService.listSessions(userId, familyId);
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
