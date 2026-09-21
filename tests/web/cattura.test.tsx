import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CaptureProvider,
  useCapture,
  type Capture,
} from "../../apps/web/src/recording/CaptureProvider";
import { GeolocationAdapter } from "../../apps/web/src/recording/GeolocationAdapter";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { montaConApi } from "./helpers/render";

/**
 * Quanti cartelli chiede il telefono, e in che ordine.
 *
 * ## Perche' questo file esiste
 *
 * `CaptureProvider` non era montato da nessun test. Il motivo e' scritto in
 * `capturaFinta.tsx` ed e' buono: costruisce da se' un `MediaRecorder`, un GPS
 * e un IndexedDB, e montarlo per provare che un pulsante cambia etichetta
 * vorrebbe dire tre finti di hardware. Ma c'e' una cosa che vive **solo** li'
 * dentro e che nessun finto della schermata puo' vedere: l'ordine in cui
 * `start()` chiede i due permessi.
 *
 * Non e' una sfumatura. Per molti commit il `void (async …)` del GPS partiva
 * prima dell'`await` del registratore, quindi chi premeva il tasto rosso per
 * parlare si vedeva chiedere per prima cosa dove si trova. L'ha trovato una
 * registrazione vera su un iPhone — nessun test poteva, perche' nessun test
 * arrivava li'.
 *
 * ## Come si prova un ordine
 *
 * Con un array di marcatori riempito dai finti, non con due spie. Due
 * `toHaveBeenCalled` passano in qualunque ordine, cioe' passano anche contro
 * il difetto che questo file esiste per impedire. E' lo stesso ragionamento del
 * caso «`stop()` e poi `navigate()`» in `record.test.tsx`.
 *
 * I marcatori li scrivono `getUserMedia` e `geolocation.getCurrentPosition` —
 * i due globali veri del browser, non gli adattatori. Cosi' il caso non prova
 * che `start()` chiama due nostri metodi in un certo ordine, prova che il
 * telefono riceve le due domande in quell'ordine, che e' la cosa di cui si sta
 * parlando.
 *
 * ## L'unico finto di modulo, e perche'
 *
 * `IndexedDbUploadQueue` e' sostituito: in `jsdom` la variabile `indexedDB` non
 * esiste, e il giro di svuotamento della coda che il provider lancia al
 * montaggio finirebbe in una promessa rifiutata che nessuno raccoglie. Non e'
 * la coda l'oggetto del discorso, e un archivio finto che risponde «vuoto» la
 * toglie di mezzo senza raccontare niente di falso.
 */

vi.mock("../../apps/web/src/recording/IndexedDbUploadQueue", () => ({
  IndexedDbUploadQueue: class {
    size(): Promise<number> {
      return Promise.resolve(0);
    }
    list(): Promise<never[]> {
      return Promise.resolve([]);
    }
    enqueue(): Promise<void> {
      return Promise.resolve();
    }
    remove(): Promise<void> {
      return Promise.resolve();
    }
    markFailed(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

/** I tre codici di `GeolocationPositionError`, che in `jsdom` non c'e'. */
const NEGATO = 1;
const NON_DISPONIBILE = 2;
const SCADUTO = 3;

type Esito = "ok" | typeof NEGATO | typeof NON_DISPONIBILE | typeof SCADUTO;

/**
 * Un `navigator.geolocation` che risponde come gli si dice e conta le domande.
 *
 * Il conteggio e' il punto: la memoria di un rifiuto non si vede dal valore di
 * ritorno — `null` e' la risposta sia di un GPS che ha detto no sia di uno a
 * cui non si e' chiesto niente. Si vede solo da quante volte il browser e'
 * stato disturbato.
 */
function gpsFinto(
  esiti: readonly Esito[],
  ordine: string[] = [],
): { readonly chiamate: () => number } {
  let i = 0;
  let chiamate = 0;

  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (ok: PositionCallback, ko: PositionErrorCallback): void => {
        ordine.push("posizione");
        chiamate += 1;
        const esito = esiti[Math.min(i, esiti.length - 1)] ?? "ok";
        i += 1;
        if (esito === "ok") {
          ok({
            coords: {
              latitude: 45.07,
              longitude: 7.69,
              accuracy: 30,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null,
            },
            timestamp: 0,
          } as GeolocationPosition);
          return;
        }
        ko({ code: esito, message: "", PERMISSION_DENIED: 1 } as GeolocationPositionError);
      },
    },
  });

  return { chiamate: () => chiamate };
}

/** Un microfono che concede o nega, e scrive quando gli si e' chiesto. */
function microfonoFinto(concede: boolean, ordine: string[]): void {
  class MediaRecorderFinto {
    static isTypeSupported(): boolean {
      return false;
    }
    readonly mimeType = "audio/webm";
    start(): void {
      // niente: i pezzi non servono a nessun caso di questo file
    }
    stop(): void {
      // niente
    }
  }
  vi.stubGlobal("MediaRecorder", MediaRecorderFinto);

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: (): Promise<unknown> => {
        ordine.push("microfono");
        return concede
          ? Promise.resolve({ getTracks: () => [] })
          : Promise.reject(new Error("Permission denied"));
      },
    },
  });
}

/** Il `Capture` vero, quello che costruisce il provider e non un finto. */
function montaLaCattura(): { readonly cattura: () => Capture } {
  let preso: Capture | null = null;

  function Sonda(): React.JSX.Element {
    preso = useCapture();
    return <span />;
  }

  montaConApi(
    creaClienteFinto(),
    <CaptureProvider>
      <Sonda />
    </CaptureProvider>,
  );

  return {
    cattura: (): Capture => {
      if (preso === null) {
        throw new Error("Il provider non ha mai reso disponibile un Capture");
      }
      return preso;
    },
  };
}

describe("l'ordine dei due cartelli", () => {
  it("il microfono si chiede prima della posizione", async () => {
    const ordine: string[] = [];
    microfonoFinto(true, ordine);
    gpsFinto([SCADUTO], ordine);
    const { cattura } = montaLaCattura();

    await act(async () => {
      await cattura().start();
    });

    // Non due `toHaveBeenCalled`: quelli passerebbero anche con l'ordine
    // invertito, che e' il difetto trovato sull'iPhone.
    expect(ordine).toEqual(["microfono", "posizione"]);
  });

  it("se il microfono e' negato, la posizione non si chiede affatto", async () => {
    const ordine: string[] = [];
    microfonoFinto(false, ordine);
    gpsFinto(["ok"], ordine);
    const { cattura } = montaLaCattura();

    await act(async () => {
      await expect(cattura().start()).rejects.toThrow();
    });

    // Un'app che non puo' registrare non ha nessun motivo di sapere dove sei.
    expect(ordine).toEqual(["microfono"]);
  });

  it("col microfono concesso la registrazione parte, e l'errore opposto non si verifica da solo", async () => {
    const ordine: string[] = [];
    microfonoFinto(true, ordine);
    gpsFinto([SCADUTO], ordine);
    const { cattura } = montaLaCattura();

    await act(async () => {
      await cattura().start();
    });

    // Senza questo, un `start()` che lanciasse sempre farebbe passare il primo
    // caso per un motivo sbagliato: l'ordine sarebbe giusto perche' non
    // succede niente.
    expect(cattura().state.kind).toBe("in-corso");
  });
});

/**
 * La memoria di un «no», che e' l'altra meta' dello stesso fastidio.
 *
 * Qui si prova l'adattatore da solo e non attraverso il provider: la proprieta'
 * riguarda due chiamate successive, e farle passare da due `start()` veri
 * vorrebbe dire anche uno `stop()` in mezzo con l'audio finto — rumore intorno
 * a una cosa che si dice in tre righe.
 */
describe("un «no» alla posizione si ricorda, e solo quello", () => {
  it("dopo un rifiuto la posizione non si richiede piu'", async () => {
    const gps = gpsFinto([NEGATO]);
    const adattatore = new GeolocationAdapter();

    expect(await adattatore.getCurrentPosition()).toBeNull();
    expect(await adattatore.getCurrentPosition()).toBeNull();

    // Due `null`, ma una domanda sola: il secondo `null` e' il nostro, non del
    // browser.
    expect(gps.chiamate()).toBe(1);
  });

  it("dopo un permesso si continua a chiedere, che e' l'errore opposto", async () => {
    const gps = gpsFinto(["ok"]);
    const adattatore = new GeolocationAdapter();

    expect(await adattatore.getCurrentPosition()).not.toBeNull();
    expect(await adattatore.getCurrentPosition()).not.toBeNull();

    // Una memoria troppo zelante spegnerebbe la posizione a chi l'ha concessa,
    // e nessun errore lo direbbe: il campo resterebbe semplicemente vuoto.
    expect(gps.chiamate()).toBe(2);
  });

  it("un timeout scaduto non e' un rifiuto", async () => {
    const gps = gpsFinto([SCADUTO, "ok"]);
    const adattatore = new GeolocationAdapter();

    expect(await adattatore.getCurrentPosition()).toBeNull();

    // Otto secondi passati vogliono dire «adesso no», non «mai piu'». Contarli
    // come rifiuto spegnerebbe il GPS per il resto della sessione a chi ha
    // registrato una volta in un garage.
    expect(await adattatore.getCurrentPosition()).not.toBeNull();
    expect(gps.chiamate()).toBe(2);
  });

  it("e nemmeno una posizione che non si riesce a determinare", async () => {
    const gps = gpsFinto([NON_DISPONIBILE, "ok"]);
    const adattatore = new GeolocationAdapter();

    expect(await adattatore.getCurrentPosition()).toBeNull();
    expect(await adattatore.getCurrentPosition()).not.toBeNull();
    expect(gps.chiamate()).toBe(2);
  });

  it("il rifiuto e' di questa istanza, e muore con lei", async () => {
    const gps = gpsFinto([NEGATO]);

    expect(await new GeolocationAdapter().getCurrentPosition()).toBeNull();
    expect(await new GeolocationAdapter().getCurrentPosition()).toBeNull();

    // Deliberato, e misurato: su Safari il permesso non sopravvive al
    // caricamento della pagina. Un ricordo scritto su disco vivrebbe piu' a
    // lungo della cosa che rispecchia — il browser tornerebbe a chiedere e noi
    // avremmo smesso di domandare, cioe' posizione spenta per sempre e nessun
    // posto da cui riaccenderla. Legata all'istanza, nasce e muore col
    // provider, che e' la stessa vita del permesso.
    expect(gps.chiamate()).toBe(2);
  });

  it("un rifiuto risponde «niente posizione», non un errore", async () => {
    gpsFinto([NEGATO]);
    const adattatore = new GeolocationAdapter();

    // La §2 dice che lo stadio 1 non fallisce mai. Se questo lanciasse,
    // `start()` non arriverebbe a `setState` e il tasto rosso non partirebbe
    // perche' l'utente ha detto no a una comodita'.
    await expect(adattatore.getCurrentPosition()).resolves.toBeNull();
  });
});
