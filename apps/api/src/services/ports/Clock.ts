/**
 * L'orologio come dipendenza.
 *
 * E' l'unico modo di testare la scadenza di un token senza fake timer globali,
 * che avvelenano l'intero processo di test e rendono i fallimenti dipendenti
 * dall'ordine di esecuzione.
 */
export interface Clock {
  now(): Date;
}
