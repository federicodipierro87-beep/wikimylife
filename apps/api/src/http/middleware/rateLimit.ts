import { ErrorCode } from "@wikimylife/shared";
import type { RequestHandler } from "express";
import { AppError } from "../../errors/AppError.js";

/**
 * Finestra fissa in memoria, una quarantina di righe, invece di
 * `express-rate-limit`.
 *
 * Non e' una questione di peso: e' che la difesa vera qui e' una sola password,
 * e un limitatore che sembra installato ma conta la cosa sbagliata e' peggio di
 * nessun limitatore, perche' toglie la voglia di guardarci dentro. Quaranta
 * righe si leggono; le opzioni di un pacchetto si copiano da uno snippet.
 *
 * FINESTRA FISSA E NON TOKEN BUCKET. Al confine fra due finestre si possono
 * fare 2n tentativi in un istante: e' il difetto noto di questo algoritmo, e
 * qui non conta niente. La differenza fra dieci e venti tentativi al minuto e'
 * irrilevante contro una password ragionevole; quella fra venti e diecimila e'
 * tutto, ed e' quella che questo codice compra.
 *
 * IN MEMORIA, E QUINDI PER PROCESSO. Con due repliche il limite raddoppia, e
 * con un redeploy si azzera. Il rimedio sarebbe Redis, cioe' un quarto servizio
 * da gestire, da pagare e da monitorare per proteggere l'account di una
 * persona: la sproporzione e' evidente e la scelta e' consapevole, non
 * dimenticata. Se un giorno gli utenti fossero mille, il posto dove cambiare
 * idea e' questo file e nessun altro.
 *
 * SI CONTA PER IP E PER ROTTA. Non per email: contare per email lascerebbe a
 * chi prova diecimila password su diecimila indirizzi la strada libera, e in
 * piu' darebbe a chiunque il modo di bloccare l'account altrui mandando
 * tentativi sbagliati a suo nome. L'IP e' imperfetto — un ufficio dietro NAT e'
 * un IP solo — ma sbaglia dalla parte giusta.
 */

export interface RateLimitOptions {
  /** Ampiezza della finestra. */
  readonly windowMs: number;
  /** Quante richieste sono ammesse in una finestra, per chiave. */
  readonly max: number;
  /**
   * Il tempo, iniettato. Un test che aspettasse davvero un minuto per provare
   * che la finestra si riapre sarebbe un test che nessuno esegue.
   */
  readonly now?: () => number;
}

interface Bucket {
  count: number;
  /** Istante in cui la finestra si chiude e il conteggio riparte da zero. */
  resetAt: number;
}

/**
 * Quando la memoria si libera.
 *
 * Senza, la mappa cresce di una voce per ogni IP che abbia mai chiamato: e' una
 * perdita di memoria lenta e silenziosa, del tipo che si manifesta dopo
 * settimane come un processo riavviato dall'host. La pulizia e' opportunistica
 * — si fa mentre si serve una richiesta, non con un `setInterval` che terrebbe
 * l'event loop vivo e ritarderebbe l'arresto pulito.
 */
const CLEANUP_EVERY = 500;

export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const now = options.now ?? Date.now;
  const buckets = new Map<string, Bucket>();
  let sinceCleanup = 0;

  function cleanup(at: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) {
        buckets.delete(key);
      }
    }
  }

  return (req, res, next) => {
    const at = now();

    sinceCleanup += 1;
    if (sinceCleanup >= CLEANUP_EVERY) {
      sinceCleanup = 0;
      cleanup(at);
    }

    // `req.ip` e non `remoteAddress`: dietro il proxy di Railway il secondo e'
    // sempre lo stesso indirizzo, e conterebbe tutto il traffico del mondo in
    // un'unica voce. Serve `trust proxy`, che l'app imposta.
    //
    // La rotta entra nella chiave perche' il limite di `/login` non deve
    // consumarsi con i tentativi di `/refresh`: sono due bersagli diversi e
    // due costi diversi.
    const key = `${req.ip ?? "sconosciuto"} ${req.method} ${req.baseUrl}${req.path}`;

    let bucket = buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= at) {
      bucket = { count: 0, resetAt: at + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, options.max - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - at) / 1000);

    // Dichiarate sempre, non solo quando si nega: un client che vede il limite
    // avvicinarsi puo' rallentare da solo, e chi indaga su un 429 sporadico ha
    // bisogno di vedere il conteggio anche nelle risposte riuscite.
    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    if (bucket.count > options.max) {
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
          context: { rateLimitKey: key, count: bucket.count },
        }),
      );
      return;
    }

    next();
  };
}
