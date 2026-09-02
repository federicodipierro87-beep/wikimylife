import type { Clock } from "../../apps/api/src/services/ports/Clock.js";

/**
 * Orologio controllato dal test.
 *
 * L'alternativa sarebbe `vi.useFakeTimers()`, che sostituisce il tempo a tutto
 * il processo — comprese le librerie che non ci si aspetta, come il pool del
 * driver Postgres. Un `Clock` iniettato sposta il tempo solo dove serve, e
 * costa un'interfaccia con un metodo.
 */
export class FixedClock implements Clock {
  #current: Date;

  constructor(start: Date) {
    this.#current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.#current.getTime());
  }

  advanceSeconds(seconds: number): void {
    this.#current = new Date(this.#current.getTime() + seconds * 1000);
  }

  advanceDays(days: number): void {
    this.advanceSeconds(days * 24 * 60 * 60);
  }

  set(at: Date): void {
    this.#current = new Date(at.getTime());
  }
}
