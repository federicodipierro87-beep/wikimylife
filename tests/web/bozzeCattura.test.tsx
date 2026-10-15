import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CaptureProvider,
  useCapture,
  type Capture,
} from "../../apps/web/src/recording/CaptureProvider";
import { SILENZIO_BOZZA_MS } from "../../apps/web/src/recording/bozze";
import type { InMemoryBozze } from "../support/InMemoryBozze";
import type { InMemoryUploadQueue } from "../support/InMemoryUploadQueue";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { montaConApi } from "./helpers/render";

/**
 * Le bozze attraverso il `CaptureProvider` vero.
 *
 * `bozze.test.ts` prova le decisioni; questo file prova che il provider le
 * prende nei momenti giusti, che e' dove un difetto non si vedrebbe da nessun
 * altro posto: una bozza mai scritta, o mai buttata dopo uno stop riuscito,
 * sembra identica a una che funziona finche' lo schermo non si blocca — o
 * finche' il recupero non mette in coda un secondo di audio rimasto indietro.
 *
 * I due archivi IndexedDB sono sostituiti da quelli in memoria, condivisi con
 * il test perche' possa guardarci dentro. `MediaRecorder` e' un finto che
 * consegna un pezzo quando glielo si chiede, con un `Blob` vero. Il dispositivo
 * e' offline, cosi' l'uploader non svuota la coda mentre la si guarda.
 */

const condivisi = vi.hoisted(() => ({
  bozze: undefined as InMemoryBozze | undefined,
  coda: undefined as InMemoryUploadQueue | undefined,
}));

vi.mock("../../apps/web/src/recording/IndexedDbBozze", () => ({
  IndexedDbBozze: function IndexedDbBozze() {
    return condivisi.bozze;
  },
}));

vi.mock("../../apps/web/src/recording/IndexedDbUploadQueue", () => ({
  IndexedDbUploadQueue: function IndexedDbUploadQueue() {
    return condivisi.coda;
  },
}));

class MediaRecorderFinto {
  static ultimo: MediaRecorderFinto | null = null;
  static isTypeSupported(): boolean {
    return false;
  }
  readonly mimeType = "audio/webm";
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor() {
    MediaRecorderFinto.ultimo = this;
  }
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
    queueMicrotask(() => {
      this.onstop?.();
    });
  }
  /** Un pezzo di un secondo, come lo consegna il browser. */
  emetti(...byte: number[]): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(byte)]) });
  }
}

let bozze: InMemoryBozze;
let coda: InMemoryUploadQueue;

beforeEach(async () => {
  const { InMemoryBozze } = await import("../support/InMemoryBozze");
  const { InMemoryUploadQueue } = await import("../support/InMemoryUploadQueue");
  bozze = new InMemoryBozze();
  coda = new InMemoryUploadQueue();
  condivisi.bozze = bozze;
  condivisi.coda = coda;

  vi.stubGlobal("MediaRecorder", MediaRecorderFinto);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
  });
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (_ok: PositionCallback, ko: PositionErrorCallback): void => {
        ko({ code: 3, message: "", PERMISSION_DENIED: 1 } as GeolocationPositionError);
      },
    },
  });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  MediaRecorderFinto.ultimo = null;
});

function montaLaCattura(): () => Capture {
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
  return () => {
    if (preso === null) {
      throw new Error("Il provider non ha reso disponibile un Capture");
    }
    return preso;
  };
}

function registratore(): MediaRecorderFinto {
  const r = MediaRecorderFinto.ultimo;
  if (r === null) {
    throw new Error("nessun MediaRecorder costruito");
  }
  return r;
}

describe("la bozza mentre si registra", () => {
  it("ogni pezzo consegnato finisce su disco prima dello stop", async () => {
    const cattura = montaLaCattura();
    await act(async () => {
      await cattura().start();
    });

    registratore().emetti(1);
    registratore().emetti(2);

    await waitFor(() => {
      expect(bozze.registro.filter((r) => r.startsWith("append"))).toHaveLength(2);
    });
    expect(bozze.ids()).toHaveLength(1);
    // Due pezzi distinti e in ordine, non due scritture sullo stesso numero.
    const [bozza] = await bozze.list();
    expect(bozza?.pieces.map((p) => [...p])).toEqual([[1], [2]]);
  });

  it("uno stop riuscito mette in coda la registrazione con l'id della bozza, e butta la bozza", async () => {
    const cattura = montaLaCattura();
    await act(async () => {
      await cattura().start();
    });
    registratore().emetti(1);
    await waitFor(() => {
      expect(bozze.ids()).toHaveLength(1);
    });
    const idBozza = bozze.ids()[0];

    await act(async () => {
      await cattura().stop();
    });

    await waitFor(() => {
      expect(bozze.ids()).toEqual([]);
    });
    expect((await coda.list()).map((v) => v.id)).toEqual([idBozza]);
  });

  it("uno stop la cui coda rifiuta l'audio lascia la bozza, che e' l'unica copia su disco", async () => {
    const cattura = montaLaCattura();
    await act(async () => {
      await cattura().start();
    });
    registratore().emetti(1);
    await waitFor(() => {
      expect(bozze.ids()).toHaveLength(1);
    });
    coda.enqueue = () => Promise.reject(new Error("quota esaurita"));

    await act(async () => {
      await expect(cattura().stop()).rejects.toThrow();
    });

    expect(bozze.ids()).toHaveLength(1);
    expect(bozze.registro.some((r) => r.startsWith("discard"))).toBe(false);
  });

  it("e scartare quell'audio butta anche la bozza", async () => {
    // Senza, il recupero rimetterebbe in coda al prossimo avvio il vocale che
    // l'utente ha appena deciso di buttare.
    const cattura = montaLaCattura();
    await act(async () => {
      await cattura().start();
    });
    registratore().emetti(1);
    await waitFor(() => {
      expect(bozze.ids()).toHaveLength(1);
    });
    coda.enqueue = () => Promise.reject(new Error("quota esaurita"));
    await act(async () => {
      await expect(cattura().stop()).rejects.toThrow();
    });

    act(() => {
      cattura().scarta();
    });

    await waitFor(() => {
      expect(bozze.ids()).toEqual([]);
    });
  });

  it("e riuscire a salvarlo dopo, butta la bozza", async () => {
    const cattura = montaLaCattura();
    await act(async () => {
      await cattura().start();
    });
    registratore().emetti(1);
    await waitFor(() => {
      expect(bozze.ids()).toHaveLength(1);
    });
    const accoda = coda.enqueue.bind(coda);
    coda.enqueue = () => Promise.reject(new Error("quota esaurita"));
    await act(async () => {
      await expect(cattura().stop()).rejects.toThrow();
    });

    coda.enqueue = accoda;
    await act(async () => {
      await cattura().riscrivi();
    });

    await waitFor(() => {
      expect(bozze.ids()).toEqual([]);
    });
    expect(await coda.size()).toBe(1);
  });

  it("svuotare la coda per il conto cancellato toglie anche le bozze", async () => {
    await bozze.append({
      draftId: "di-chi-se-ne-va",
      seq: 0,
      data: new Uint8Array([1]),
      mimeType: "audio/webm",
      at: Date.now(),
      startedAt: Date.now(),
    });
    const cattura = montaLaCattura();

    await act(async () => {
      await cattura().svuotaCoda();
    });

    expect(bozze.ids()).toEqual([]);
  });

  it("annullare butta la bozza", async () => {
    const cattura = montaLaCattura();
    await act(async () => {
      await cattura().start();
    });
    registratore().emetti(1);
    await waitFor(() => {
      expect(bozze.ids()).toHaveLength(1);
    });

    await act(async () => {
      await cattura().cancel();
    });

    await waitFor(() => {
      expect(bozze.ids()).toEqual([]);
    });
    expect(await coda.size()).toBe(0);
  });
});

describe("il recupero all'avvio", () => {
  it("una bozza abbandonata diventa una registrazione in coda", async () => {
    const vecchia = Date.now() - SILENZIO_BOZZA_MS - 1_000;
    await bozze.append({
      draftId: "persa",
      seq: 0,
      data: new Uint8Array([4, 2]),
      mimeType: "audio/webm",
      at: vecchia,
      startedAt: vecchia - 5_000,
    });

    montaLaCattura();

    await waitFor(async () => {
      expect((await coda.list()).map((v) => v.id)).toEqual(["persa"]);
    });
    expect(bozze.ids()).toEqual([]);
  });

  it("una bozza appena scritta, di un'altra scheda che registra, resta dov'e'", async () => {
    await bozze.append({
      draftId: "viva",
      seq: 0,
      data: new Uint8Array([1]),
      mimeType: "audio/webm",
      at: Date.now(),
      startedAt: Date.now() - 1_000,
    });

    const cattura = montaLaCattura();
    // Aspettare che il giro d'avvio sia finito: il conteggio della coda lo
    // aggiorna proprio quel giro, dopo il recupero.
    await waitFor(() => {
      expect(cattura().inCoda).toBe(0);
    });
    await act(async () => {
      await new Promise((ok) => setTimeout(ok, 0));
    });

    expect(await coda.size()).toBe(0);
    expect(bozze.ids()).toEqual(["viva"]);
  });
});
