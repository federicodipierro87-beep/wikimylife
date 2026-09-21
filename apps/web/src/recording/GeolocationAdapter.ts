import type { Coordinates, LocationAdapter } from "@wikimylife/shared";

/**
 * `LocationAdapter` su `navigator.geolocation` e Nominatim.
 *
 * Nessun metodo lancia. La §2 dice che lo stadio 1 non fallisce mai, e il GPS
 * e' il candidato piu' probabile a farlo fallire: permesso negato, chiuso in un
 * capannone senza segnale, utente che non risponde al prompt. In tutti questi
 * casi la risposta e' `null` e la registrazione parte comunque — il posto e'
 * una comodita', l'audio e' il dato.
 *
 * Il reverse geocoding usa Nominatim di OpenStreetMap: nessuna chiave, nessun
 * account, nessuna fattura a consumo. E' anche il motivo per cui e' un extra e
 * non un requisito: se il servizio e' lento o giu', `placeLabel` resta nullo e
 * le coordinate — che sono il dato vero — sono gia' salve.
 *
 * ## Un «no» si ricorda, e dura quanto la pagina
 *
 * Fino a poco fa questo adattatore non ricordava niente: chi rispondeva «Non
 * consentire» si vedeva richiedere la posizione alla registrazione successiva,
 * e a quella dopo. Adesso un rifiuto spegne le richieste seguenti.
 *
 * La memoria sta in un campo dell'istanza e **non** in `localStorage`, ed e'
 * una scelta che viene da una misura fatta su un iPhone vero: su Safari i
 * permessi non sopravvivono al caricamento della pagina — riaprendo l'app il
 * cartello ricompare comunque. Un nostro ricordo scritto su disco
 * sopravviverebbe alla cosa che sta rispecchiando: il browser tornerebbe a
 * chiedere e noi avremmo smesso di domandare, cioe' posizione spenta per
 * sempre su quel dispositivo senza nessun posto da cui riaccenderla. Legata
 * all'istanza, invece, la memoria nasce e muore col provider — la stessa vita
 * del permesso che rispecchia — e non serve nessun gesto per dimenticarla.
 *
 * Si ricorda **solo** il rifiuto. Un capannone senza segnale e un timeout
 * scaduto sono guasti di adesso, non decisioni dell'utente: contarli come no
 * spegnerebbe la posizione per il resto della sessione a chi ha registrato una
 * volta in cantina.
 */

const DEFAULT_TIMEOUT_MS = 8000;
const GEOCODE_TIMEOUT_MS = 4000;
const NOMINATIM = "https://nominatim.openstreetmap.org/reverse";

/**
 * `GeolocationPositionError.PERMISSION_DENIED`, scritto come numero.
 *
 * La costante sta nel tipo ma non in `jsdom`, dove un test deve fabbricare
 * l'errore a mano: leggerla dal nome obbligherebbe il finto a ricopiarsela, e
 * un finto che ricopia le costanti della piattaforma finisce per provare se
 * stesso. Il numero lo fissa la specifica, non la prosa di nessuno.
 */
const PERMESSO_NEGATO = 1;

export class GeolocationAdapter implements LocationAdapter {
  /** `true` da quando l'utente ha detto di no. Vedi «## Un «no» si ricorda». */
  #rifiutata = false;

  isSupported(): boolean {
    return typeof navigator !== "undefined" && "geolocation" in navigator;
  }

  getCurrentPosition(
    options: { readonly timeoutMs?: number | undefined } = {},
  ): Promise<Coordinates | null> {
    if (!this.isSupported()) {
      return Promise.resolve(null);
    }

    // Ha gia' detto di no: richiedere sarebbe insistere, e la risposta la
    // sappiamo. Chi chiama non distingue questo caso da un GPS senza segnale,
    // ed e' giusto cosi': in tutti e due il posto non c'e'.
    if (this.#rifiutata) {
      return Promise.resolve(null);
    }

    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyMeters: position.coords.accuracy,
          });
        },
        (errore) => {
          if (errore.code === PERMESSO_NEGATO) {
            this.#rifiutata = true;
          }
          resolve(null);
        },
        {
          timeout,
          // Il GPS preciso puo' prendersi dieci secondi e un pezzo di batteria.
          // Per un'etichetta di luogo la cella telefonica basta e avanza.
          enableHighAccuracy: false,
          // Una posizione di un minuto fa e' la stessa: chi registra un vocale
          // non si e' spostato nel frattempo, e la cache risponde subito.
          maximumAge: 60_000,
        },
      );
    });
  }

  async reverseGeocode(coords: Coordinates): Promise<string | null> {
    const url = new URL(NOMINATIM);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(coords.latitude));
    url.searchParams.set("lon", String(coords.longitude));
    // Fermarsi al quartiere: la via e il numero civico sono un dato personale
    // che nessuna scheda ha bisogno di contenere.
    url.searchParams.set("zoom", "14");
    url.searchParams.set("accept-language", "it");

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        return null;
      }
      const payload: unknown = await response.json();
      return labelOf(payload);
    } catch {
      // Offline, timeout, rate limit, CORS. L'etichetta e' un extra.
      return null;
    }
  }
}

/**
 * L'etichetta breve dalla risposta di Nominatim.
 *
 * `display_name` sarebbe "Corso Vittorio Emanuele II, San Salvario, Torino,
 * Piemonte, 10125, Italia": illeggibile in una lista. Si prende il posto piu'
 * specifico che somiglia a un comune, e la citta' come contesto.
 */
function labelOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const address: unknown = (payload as { address?: unknown }).address;
  if (typeof address !== "object" || address === null) {
    return null;
  }

  const fields = address as Record<string, unknown>;
  const pick = (key: string): string | null => {
    const value = fields[key];
    return typeof value === "string" && value !== "" ? value : null;
  };

  const luogo =
    pick("city") ?? pick("town") ?? pick("village") ?? pick("municipality") ?? pick("county");
  const regione = pick("state") ?? pick("country");

  if (luogo === null) {
    return regione;
  }
  return regione === null || regione === luogo ? luogo : `${luogo}, ${regione}`;
}
