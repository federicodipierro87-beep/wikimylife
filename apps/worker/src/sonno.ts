/**
 * Il sonno fra un giro di polling e l'altro, e la sveglia che lo interrompe.
 *
 * ## Il timer NON e' `unref`, ed e' l'intero motivo di questo file
 *
 * Un timer `unref` non tiene in vita il ciclo degli eventi. Mentre il worker
 * dorme non c'e' nient'altro che lo tenga — le connessioni di Prisma stanno nel
 * suo motore, non in un handle di libuv — quindi Node esce da solo al primo
 * giro a vuoto: `main()` a meta', nessun errore, e come unica traccia un avviso
 * su un `await` di primo livello mai risolto. In locale sembra che
 * `dev:worker` non faccia niente dopo cinque secondi; su un host che riavvia i
 * processi morti diventa un worker che elabora un batch per vita, e la coda
 * avanza abbastanza da non far sospettare niente.
 *
 * ## E allora serve la sveglia
 *
 * Il prezzo di un timer che tiene vivo il processo e' che un SIGTERM durante il
 * sonno aspetterebbe la fine dei cinque secondi. Sono la meta' della finestra
 * che un host lascia fra il SIGTERM e il SIGKILL, spesi ad aspettare un timer
 * che serviva solo a non interrogare il database troppo spesso.
 *
 * Un oggetto e non due funzioni di modulo: lo stato e' un timer in corso, e uno
 * stato condiviso da tutto il processo sarebbe indistinguibile da quello di un
 * test che gli gira accanto.
 */

export interface Sonno {
  /** Aspetta, a meno che qualcuno non suoni la sveglia prima. */
  dormi(ms: number): Promise<void>;
  /** Interrompe subito il sonno in corso. Senza sonno in corso non fa niente. */
  svegliati(): void;
}

export function creaSonno(): Sonno {
  let sveglia: (() => void) | undefined;

  return {
    dormi(ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          sveglia = undefined;
          resolve();
        }, ms);
        sveglia = (): void => {
          clearTimeout(timer);
          sveglia = undefined;
          resolve();
        };
      });
    },
    svegliati(): void {
      sveglia?.();
    },
  };
}
