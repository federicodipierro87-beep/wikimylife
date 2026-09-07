import type { AppConfig } from "@wikimylife/api/config";

/**
 * Quando la scopa deve passare — cioe' quasi mai, e mai mentre c'e' da fare.
 *
 * Sta in un modulo suo per la stessa ragione di `cli/sweepArgs.ts`: l'entry
 * point del worker finisce con un `await main()` e non e' importabile, e questa
 * e' l'unica decisione del ciclo che possa sbagliarsi in silenzio. Una passata
 * che parte quando non dovrebbe non da' nessun errore: cancella file, e i file
 * sono di qualcuno.
 */

export type SweepMode = AppConfig["sweep"]["mode"];

export interface StatoScopa {
  /** `spento`, `elenca` o `cancella`. Si veda `SWEEP_MODE`. */
  readonly mode: SweepMode;
  /** L'orologio del worker, adesso. */
  readonly adesso: number;
  /** Da quando in poi si puo' tentare. */
  readonly nonPrimaDi: number;
  /** Se il giro di elaborazione appena finito non ha trovato niente da fare. */
  readonly codaVuota: boolean;
}

/**
 * Tre condizioni, e la seconda e' quella che non e' ovvia.
 *
 * 1. **La scopa e' accesa.** `spento` e' il default, e con `spento` questo
 *    file non fa assolutamente niente.
 *
 * 2. **La coda e' vuota.** Una passata su un bucket vero dura minuti, e per
 *    tutti quei minuti il worker non elabora: chi ha appena caricato un vocale
 *    starebbe ad aspettare la pulizia della spazzatura di ieri. La scopa e' la
 *    cosa meno urgente che questo processo faccia, e l'unico caso in cui non
 *    passerebbe mai e' un worker perennemente in arretrato — che e' un
 *    problema piu' grande di qualche megabyte non recuperato, e si vede da
 *    altri numeri.
 *
 * 3. **E' passato abbastanza tempo.** Contato dalla fine dell'ultima passata e
 *    non da un orario del giorno: non c'e' niente da sincronizzare con
 *    nient'altro, e un orario fisso farebbe partire insieme tutte le repliche.
 */
export function toccaSpazzare(stato: StatoScopa): boolean {
  if (stato.mode === "spento") {
    return false;
  }
  if (!stato.codaVuota) {
    return false;
  }
  return stato.adesso >= stato.nonPrimaDi;
}
