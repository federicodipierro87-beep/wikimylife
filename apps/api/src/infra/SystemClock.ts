import type { Clock } from "../services/ports/Clock.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
