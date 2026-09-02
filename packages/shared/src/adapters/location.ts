/**
 * GPS. La §2 lo chiama "la vincita nascosta": riempie il campo piu' noioso da
 * dettare senza chiedere niente all'utente.
 *
 * Ogni metodo puo' restituire `null`: il permesso negato non e' un errore, e'
 * un caso normale. Lo stadio 1 non fallisce mai — nemmeno per colpa del GPS.
 */

export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters?: number | undefined;
}

export interface LocationAdapter {
  isSupported(): boolean;
  /** `null` se il permesso e' negato o scade il timeout. */
  getCurrentPosition(options?: {
    readonly timeoutMs?: number | undefined;
  }): Promise<Coordinates | null>;
  /** Reverse geocoding. `null` se non disponibile. */
  reverseGeocode(coords: Coordinates): Promise<string | null>;
}
