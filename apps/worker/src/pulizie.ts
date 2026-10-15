/**
 * Un lavoro che il worker fa a intervalli, accanto alla coda.
 *
 * Il primo, e per ora l'unico, e' togliere le finestre scadute del limite dei
 * tentativi: righe con dentro un indirizzo IP, che la pagina della privacy
 * promette di cancellare «alla pulizia successiva». Fino a qui l'unica pulizia
 * la faceva l'API, una richiesta ogni cinquecento alle rotte limitate, con un
 * contatore per processo azzerato a ogni deploy: con il traffico di oggi
 * «successiva» poteva voler dire settimane. Il worker si sveglia da solo ogni
 * cinque secondi, quindi qui «successiva» ha un massimo.
 *
 * Sta in un modulo suo per la stessa ragione di `sweepSchedule.ts`: l'entry
 * point del worker finisce con un `await main()` e non e' importabile, e le due
 * decisioni che contano — quando tocca, e che cosa succede se fallisce — si
 * provano solo se stanno fuori da li'.
 *
 * Diversa dalla scopa in due punti, tutti e due voluti. Passa anche con la coda
 * piena: e' una `DELETE` su un indice, millisecondi, e non ruba niente a chi
 * aspetta la propria scheda. E passa subito all'avvio: la scopa aspetta un
 * intervallo perche' un worker che si riavvia in ciclo la ripeterebbe a ogni
 * riavvio, ma qui ripetere costa niente, e partire subito vuol dire che un
 * deploy non sposta la prossima pulizia di un intervallo intero.
 */

/**
 * Ogni quanto si tolgono le finestre scadute del limite dei tentativi.
 *
 * E' cio' che decide quanto a lungo resta nel database l'indirizzo IP di chi
 * ha provato a entrare: la finestra dura un minuto, poi la riga aspetta al piu'
 * questo intervallo. Non meno della finestra, perche' sotto quella si
 * cancellerebbe quasi sempre niente: la promessa della pagina della privacy non
 * diventerebbe piu' vera, solo piu' cara. Non piu' di un quarto d'ora, perche'
 * «alla pulizia successiva» deve voler dire un tempo che si possa dire a voce.
 */
export const PULIZIA_IP_OGNI_MS = 10 * 60_000;

export interface PuliziaPeriodica {
  /** La fa se e' il momento, e altrimenti non fa niente. Non lancia mai. */
  forse(): Promise<void>;
}

export function creaPuliziaPeriodica(opzioni: {
  readonly ogniMs: number;
  readonly adesso: () => number;
  readonly lavoro: () => Promise<void>;
  readonly onErrore: (error: unknown) => void;
}): PuliziaPeriodica {
  let nonPrimaDi = opzioni.adesso();

  return {
    async forse(): Promise<void> {
      if (opzioni.adesso() < nonPrimaDi) {
        return;
      }
      try {
        await opzioni.lavoro();
      } catch (error) {
        // Il database che non risponde: la coda se ne accorgera' per conto
        // suo, e qui non c'e' niente da riparare. Le righe scadute restano
        // dove sono e non falsano nessun conteggio.
        opzioni.onErrore(error);
      } finally {
        // Riarmata anche dopo un fallimento, e contando dalla fine: altrimenti
        // un database irraggiungibile diventerebbe un tentativo ogni cinque
        // secondi, lo stesso ragionamento della scopa.
        nonPrimaDi = opzioni.adesso() + opzioni.ogniMs;
      }
    },
  };
}
