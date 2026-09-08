import { ErrorCode } from "@wikimylife/shared";
import type { RequestHandler } from "express";
import { AppError } from "../../errors/AppError.js";
import type { RateLimitStore } from "../../services/ports/RateLimitStore.js";

/**
 * Finestra fissa, una cinquantina di righe, invece di `express-rate-limit`.
 *
 * Non e' una questione di peso: e' che la difesa vera qui e' una sola password,
 * e un limitatore che sembra installato ma conta la cosa sbagliata e' peggio di
 * nessun limitatore, perche' toglie la voglia di guardarci dentro. Cinquanta
 * righe si leggono; le opzioni di un pacchetto si copiano da uno snippet.
 *
 * FINESTRA FISSA E NON TOKEN BUCKET. Al confine fra due finestre si possono
 * fare 2n tentativi in un istante: e' il difetto noto di questo algoritmo, e
 * qui non conta niente. La differenza fra dieci e venti tentativi al minuto e'
 * irrilevante contro una password ragionevole; quella fra venti e diecimila e'
 * tutto, ed e' quella che questo codice compra.
 *
 * I CONTEGGI NON STANNO QUI. Stanno in un deposito iniettato, e in produzione
 * il deposito e' una tabella di Postgres: un conteggio nella memoria del
 * processo vale per quel processo, quindi con due repliche il tetto raddoppia e
 * ogni redeploy lo azzera. Questo file non sa quale deposito ha — si veda
 * `services/ports/RateLimitStore.ts`, dove sta anche il motivo per cui
 * l'aritmetica della finestra e' finita di la' invece che di qua.
 *
 * SI CONTA PER IP E PER ROTTA. Non per email: contare per email lascerebbe a
 * chi prova diecimila password su diecimila indirizzi la strada libera, e in
 * piu' darebbe a chiunque il modo di bloccare l'account altrui mandando
 * tentativi sbagliati a suo nome. L'IP e' imperfetto — un ufficio dietro NAT e'
 * un IP solo — ma sbaglia dalla parte giusta.
 *
 * SE IL DEPOSITO NON RISPONDE, SI PASSA. Il limite si spegne, e va detto forte
 * perche' suona come la scelta sbagliata. Non lo e': con il database giu',
 * `/login` non puo' comunque leggere `User` ne' verificare una password, quindi
 * non c'e' niente da forzare nella finestra in cui il limite manca. Negare
 * invece trasformerebbe un guasto del database in un secondo errore sulla
 * stessa richiesta, e renderebbe il limitatore un modo in piu' di rompersi.
 */

export interface RateLimitOptions {
  /** Ampiezza della finestra. */
  readonly windowMs: number;
  /** Quante richieste sono ammesse in una finestra, per chiave. */
  readonly max: number;
  /** Dove stanno i conteggi. In produzione: Postgres. */
  readonly store: RateLimitStore;
  /**
   * Il tempo, iniettato. Un test che aspettasse davvero un minuto per provare
   * che la finestra si riapre sarebbe un test che nessuno esegue.
   */
  readonly now?: () => number;
  /**
   * Chiamato quando il deposito non risponde, subito prima di lasciar passare
   * la richiesta.
   *
   * Un limite che si spegne in silenzio e' indistinguibile da un limite che non
   * e' mai stato acceso, e la differenza va cercata in un registro, non in un
   * grafico di tentativi che non sono stati contati.
   */
  readonly onErrore?: (error: unknown) => void;
}

/**
 * Ogni quante richieste si cancellano le finestre chiuse.
 *
 * Senza, resta una riga per ogni IP che abbia mai chiamato. La pulizia e'
 * opportunistica — si fa mentre si serve una richiesta, non con un
 * `setInterval` che terrebbe l'event loop vivo e ritarderebbe l'arresto pulito
 * a ogni deploy. Una su cinquecento paga una DELETE su un indice; le altre
 * quattrocentonovantanove non pagano niente.
 */
const CLEANUP_EVERY = 500;

export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const now = options.now ?? Date.now;
  let sinceCleanup = 0;

  // Express 5 inoltra da solo al gestore degli errori le promesse rifiutate di
  // un middleware, quindi qui non serve nessun `asyncHandler`: cio' che questa
  // funzione lascia scappare finisce dove finiscono gli altri 500.
  return async (req, res, next) => {
    const at = now();

    sinceCleanup += 1;
    if (sinceCleanup >= CLEANUP_EVERY) {
      sinceCleanup = 0;
      try {
        await options.store.purgeExpired(at);
      } catch (error) {
        // Non riguarda la richiesta in corso: le righe scadute restano dove
        // sono, non falsano nessun conteggio — il prossimo `hit` le riapre da
        // uno — e ci si riprova fra cinquecento richieste.
        options.onErrore?.(error);
      }
    }

    // `req.ip` e non `remoteAddress`: dietro il proxy di Railway il secondo e'
    // sempre lo stesso indirizzo, e conterebbe tutto il traffico del mondo in
    // un'unica voce. Serve `trust proxy`, che l'app imposta.
    //
    // La rotta entra nella chiave perche' il limite di `/login` non deve
    // consumarsi con i tentativi di `/refresh`: sono due bersagli diversi e
    // due costi diversi.
    const key = `${req.ip ?? "sconosciuto"} ${req.method} ${req.baseUrl}${req.path}`;

    let finestra;
    try {
      finestra = await options.store.hit({ key, windowMs: options.windowMs, at });
    } catch (error) {
      options.onErrore?.(error);
      // Senza intestazioni: non si sa a che punto sia il conteggio, e dichiarare
      // un residuo inventato e' peggio che non dichiararne nessuno.
      next();
      return;
    }

    const remaining = Math.max(0, options.max - finestra.count);
    const resetSeconds = Math.ceil((finestra.resetAt - at) / 1000);

    // Dichiarate sempre, non solo quando si nega: un client che vede il limite
    // avvicinarsi puo' rallentare da solo, e chi indaga su un 429 sporadico ha
    // bisogno di vedere il conteggio anche nelle risposte riuscite.
    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    if (finestra.count > options.max) {
      // `Retry-After` e' l'unica intestazione che un client rispetti davvero, e
      // senza di essa la PWA riproverebbe subito peggiorando le cose.
      res.setHeader("Retry-After", String(resetSeconds));
      next(
        new AppError({
          code: ErrorCode.RATE_LIMITED,
          message: `Troppi tentativi. Riprova fra ${String(resetSeconds)} secondi.`,
          status: 429,
          // Nel log, non nella risposta: dire "sei al tentativo 47" a chi sta
          // provando password gli direbbe anche quando ricominciare.
          context: { rateLimitKey: key, count: finestra.count },
        }),
      );
      return;
    }

    next();
  };
}
