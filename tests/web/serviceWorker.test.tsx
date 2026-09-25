import { describe, expect, it, vi } from "vitest";
import { inGuscioNativo, registraServiceWorker } from "../../apps/web/src/serviceWorker";

/**
 * Il service worker: si registra sul sito in produzione, e in nessun altro
 * posto.
 *
 * Una finestra finta e non quella di jsdom, per due ragioni. jsdom non ha
 * `navigator.serviceWorker`, quindi ogni caso finirebbe nel ramo «il browser
 * non lo supporta» e nessuno proverebbe gli altri tre. E `load` sulla finestra
 * vera e' gia' scattato quando il caso parte: un ascoltatore aggiunto adesso
 * non verrebbe mai chiamato, e «registra dopo load» diventerebbe
 * indistinguibile da «non registra».
 */

type Finta = {
  readonly finestra: Window;
  readonly register: ReturnType<typeof vi.fn>;
  readonly scattaLoad: () => void;
  readonly ascoltatori: () => number;
};

function finestraFinta(opzioni: {
  readonly serviceWorker?: boolean;
  readonly capacitor?: { isNativePlatform?: () => boolean };
}): Finta {
  const register = vi.fn(() => Promise.resolve());
  const ascoltatori: (() => void)[] = [];
  const finestra = {
    navigator: opzioni.serviceWorker === false ? {} : { serviceWorker: { register } },
    addEventListener: (evento: string, fn: () => void) => {
      if (evento === "load") {
        ascoltatori.push(fn);
      }
    },
    ...(opzioni.capacitor === undefined ? {} : { Capacitor: opzioni.capacitor }),
  };
  return {
    finestra: finestra as unknown as Window,
    register,
    scattaLoad: () => {
      for (const fn of ascoltatori) {
        fn();
      }
    },
    ascoltatori: () => ascoltatori.length,
  };
}

describe("registraServiceWorker", () => {
  it("sul sito in produzione registra /sw.js, ma solo dopo load", () => {
    const f = finestraFinta({});
    registraServiceWorker({ produzione: true, finestra: f.finestra });

    expect(f.register).not.toHaveBeenCalled();
    f.scattaLoad();
    expect(f.register).toHaveBeenCalledWith("/sw.js");
  });

  it("in sviluppo non registra niente", () => {
    const f = finestraFinta({});
    registraServiceWorker({ produzione: false, finestra: f.finestra });
    f.scattaLoad();

    expect(f.ascoltatori()).toBe(0);
    expect(f.register).not.toHaveBeenCalled();
  });

  it("dentro il guscio nativo non registra niente, nemmeno in produzione", () => {
    const f = finestraFinta({ capacitor: { isNativePlatform: () => true } });
    registraServiceWorker({ produzione: true, finestra: f.finestra });
    f.scattaLoad();

    expect(f.ascoltatori()).toBe(0);
    expect(f.register).not.toHaveBeenCalled();
  });

  it("un Capacitor che dice di non essere nativo non basta a spegnerlo", () => {
    // Il caso opposto: `@capacitor/core` caricato in un browser espone
    // `window.Capacitor` con `isNativePlatform()` falso. Guardare solo la
    // presenza dell'oggetto spegnerebbe l'offline sul sito.
    const f = finestraFinta({ capacitor: { isNativePlatform: () => false } });
    registraServiceWorker({ produzione: true, finestra: f.finestra });
    f.scattaLoad();

    expect(f.register).toHaveBeenCalledWith("/sw.js");
  });

  it("un browser senza service worker non si rompe", () => {
    const f = finestraFinta({ serviceWorker: false });
    expect(() => {
      registraServiceWorker({ produzione: true, finestra: f.finestra });
    }).not.toThrow();
    expect(f.ascoltatori()).toBe(0);
  });

  it("una registrazione rifiutata non diventa un errore della pagina", async () => {
    const f = finestraFinta({});
    f.register.mockImplementation(() => Promise.reject(new Error("rifiutato")));
    registraServiceWorker({ produzione: true, finestra: f.finestra });
    f.scattaLoad();

    // Se il `catch` mancasse, la promessa rifiutata arriverebbe a Vitest come
    // rifiuto non gestito e il caso cadrebbe dopo la fine.
    await Promise.resolve();
    expect(f.register).toHaveBeenCalledTimes(1);
  });
});

describe("inGuscioNativo", () => {
  it("dice si' solo quando Capacitor dice di essere nativo", () => {
    expect(inGuscioNativo({ Capacitor: { isNativePlatform: () => true } })).toBe(true);
    expect(inGuscioNativo({ Capacitor: { isNativePlatform: () => false } })).toBe(false);
    expect(inGuscioNativo({ Capacitor: {} })).toBe(false);
    expect(inGuscioNativo({})).toBe(false);
  });
});
