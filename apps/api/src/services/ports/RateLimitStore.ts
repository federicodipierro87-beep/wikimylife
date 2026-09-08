/**
 * Dove stanno i conteggi del limitatore.
 *
 * ## Una porta per una cosa sola, e la ragione e' l'atomicita'
 *
 * L'interfaccia potrebbe sembrare troppo stretta — non c'e' un `leggi`, non
 * c'e' uno `scrivi` — ed e' stretta apposta. Un deposito che sapesse leggere e
 * scrivere separatamente inviterebbe il chiamante a fare
 * `leggi` → `+1` → `scrivi`, e fra le due meta' di quella sequenza ci sta
 * comodamente la richiesta di un'altra replica: due tentativi letti come uno.
 * Un conteggio che perde tentativi li perde proprio quando ne arrivano tanti
 * insieme, cioe' nell'unico momento in cui questo codice serve a qualcosa.
 *
 * Percio' `hit` fa tutto in una volta e restituisce il risultato: incrementare
 * e' un'operazione, non due, e chi implementa la porta deve renderla tale — su
 * Postgres e' un `INSERT ... ON CONFLICT DO UPDATE`, in memoria e' banale
 * perche' non c'e' `await` in mezzo.
 *
 * ## La finestra la decide il deposito
 *
 * Anche «la finestra e' scaduta, riparti da uno» sta qui dentro e non nel
 * middleware, per lo stesso motivo: e' una lettura seguita da una decisione, e
 * una decisione presa fuori arriverebbe tardi. Il prezzo e' che la regola
 * esiste due volte — in SQL e nella versione in memoria — e per questo le due
 * si provano con lo stesso identico contratto
 * (`tests/support/rateLimitStoreContract.ts`), l'una in `npm test` e l'altra
 * contro Postgres vero.
 *
 * ## Il tempo arriva da fuori
 *
 * `at` e' un parametro e non `now()` dentro la query. Due repliche hanno due
 * orologi, quindi in teoria la finestra potrebbe muoversi di qualche
 * millisecondo a seconda di chi serve la richiesta; in pratica la deriva fra
 * due macchine sincronizzate e' molto sotto il secondo, e la finestra dura un
 * minuto. In cambio l'intera regola si prova senza aspettare il tempo vero.
 */

export interface RateLimitWindow {
  /** Quanti tentativi contati nella finestra corrente, questo compreso. */
  readonly count: number;
  /** Istante in cui la finestra si chiude, in millisecondi. */
  readonly resetAt: number;
}

export interface RateLimitHit {
  /** «{ip} {metodo} {rotta}»: la compone il middleware, il deposito non la legge. */
  readonly key: string;
  readonly windowMs: number;
  /** Adesso, secondo chi chiama. */
  readonly at: number;
}

export interface RateLimitStore {
  /**
   * Conta un tentativo e dice a che punto e' la finestra.
   *
   * Se la finestra della chiave e' gia' chiusa ne apre una nuova e restituisce
   * `count: 1`. Se non c'era nessuna finestra, uguale. Non esiste un modo di
   * chiedere il conteggio senza consumarne uno, ed e' voluto: chi guarda senza
   * contare sta scrivendo una corsa.
   */
  hit(input: RateLimitHit): Promise<RateLimitWindow>;

  /**
   * Toglie le finestre gia' chiuse alla data indicata.
   *
   * Senza, resta una riga per ogni IP che abbia mai provato a entrare: una
   * perdita lenta e silenziosa, del tipo che si manifesta dopo mesi. Non e'
   * urgente e non e' esatta — una riga scaduta che sopravvive non fa danno,
   * perche' il prossimo `hit` la riapre da uno.
   */
  purgeExpired(at: number): Promise<void>;
}
