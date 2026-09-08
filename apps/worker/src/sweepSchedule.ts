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
 * 1. **La scopa e' accesa.** Cioe' quasi sempre, da quando il default e'
 *    `elenca`: la prima condizione non e' piu' quella che ferma le passate, e
 *    a non toccare niente ci pensa `toccaCancellare` qui sotto. Con `spento`
 *    questo file non fa assolutamente niente.
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

/**
 * Se questa passata puo' chiamare `delete`, o soltanto guardare.
 *
 * Una riga, e un confronto che si scrive in tre caratteri. Sta qui, esportata e
 * provata, per un motivo solo: da quando il default e' `elenca` questo confronto
 * e' l'unica cosa che separa un'installazione che non ha mai sentito nominare
 * `SWEEP_MODE` da un `DELETE` sui file dei suoi utenti. Finche' stava in mezzo a
 * `index.ts` — che finisce con un `await main()` e non e' importabile — non
 * c'era modo di scrivere il test che dice che `elenca` non cancella.
 *
 * E' un'uguaglianza e non una negazione — `mode !== "elenca"` direbbe lo stesso
 * oggi — per la stessa ragione per cui `SWEEP_MODE` rifiuta i valori che non
 * conosce. Il giorno in cui i modi diventassero quattro, il quarto deve nascere
 * innocuo e va acceso qui a mano da chi ha deciso che debba cancellare; scritto
 * per esclusione nascerebbe con la scopa gia' in mano, e nessuno se ne
 * accorgerebbe leggendo il nuovo valore.
 */
export function toccaCancellare(mode: SweepMode): boolean {
  return mode === "cancella";
}
