import type { RecordingState } from "@wikimylife/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createUploader,
  isExhausted,
  metadataOf,
  type Uploader,
} from "../../apps/web/src/recording/uploader.js";
import { InMemoryUploadQueue } from "../support/InMemoryUploadQueue.js";

/**
 * Lo svuotamento della coda offline.
 *
 * E' la parte della Fase 4 dove un errore costa un dato dell'utente: qui dentro
 * c'e' l'unica copia di un audio registrato senza campo. Le prove sono scritte
 * attorno a questo — che niente si perda, che niente si carichi due volte, e
 * che un elemento rotto non tenga in ostaggio quelli dietro.
 */

const RECORDED_AT = "2026-03-01T10:15:00.000Z";

interface Chiamata {
  readonly filename: string | undefined;
  readonly mimeType: string;
  readonly bytes: number;
}

interface Harness {
  readonly queue: InMemoryUploadQueue;
  readonly chiamate: Chiamata[];
  online: boolean;
  /** Errori da sollevare, per nome file, in coda. */
  readonly guasti: Map<string, string>;
  /** Eseguita all'inizio di ogni upload: permette di far cadere la rete. */
  onCall?: ((filename: string | undefined) => void) | undefined;
  readonly uploader: Uploader;
}

function harness(overrides: { maxAttempts?: number } = {}): Harness {
  const queue = new InMemoryUploadQueue();
  const chiamate: Chiamata[] = [];
  const guasti = new Map<string, string>();

  const h: Harness = {
    queue,
    chiamate,
    online: true,
    guasti,
    uploader: createUploader({
      queue,
      isOnline: () => h.online,
      ...(overrides.maxAttempts === undefined ? {} : { maxAttempts: overrides.maxAttempts }),
      client: {
        async createRecording(input): Promise<RecordingState> {
          const filename = input.filename;
          chiamate.push({
            filename,
            mimeType: input.metadata.mimeType,
            bytes: input.audio.size,
          });
          h.onCall?.(filename);
          const guasto = filename === undefined ? undefined : guasti.get(filename);
          if (guasto !== undefined) {
            throw new Error(guasto);
          }
          return Promise.resolve({ id: `rec-${String(filename)}` } as RecordingState);
        },
      },
    }),
  };

  return h;
}

let h: Harness;

beforeEach(() => {
  h = harness();
});

async function accoda(id: string, bytes = 8): Promise<void> {
  await h.queue.enqueue({
    id,
    audio: new Uint8Array(bytes).fill(1),
    mimeType: "audio/webm",
    durationMs: 12_000,
    recordedAt: RECORDED_AT,
    latitude: 45.07,
    longitude: 7.68,
    placeLabel: "Torino",
    deviceLocale: "it-IT",
    capturedOffline: true,
  });
}

describe("metadataOf", () => {
  it("ricostruisce i metadati della §2 da cio' che la coda ha conservato", async () => {
    await accoda("a");
    const [item] = h.queue.snapshot();

    expect(item).toBeDefined();
    expect(item === undefined ? null : metadataOf(item)).toEqual({
      recordedAt: RECORDED_AT,
      durationMs: 12_000,
      mimeType: "audio/webm",
      capturedOffline: true,
      deviceLocale: "it-IT",
      latitude: 45.07,
      longitude: 7.68,
      placeLabel: "Torino",
    });
  });

  it("conserva `capturedOffline`, che il server non puo' dedurre", async () => {
    // Arriva dal dispositivo e da nessun altro: al server la richiesta appare
    // online comunque, perche' e' arrivata.
    await accoda("a");
    const [item] = h.queue.snapshot();

    expect(item?.capturedOffline).toBe(true);
  });
});

describe("drain — il caso felice", () => {
  it("carica tutto e lascia la coda vuota", async () => {
    await accoda("a");
    await accoda("b");

    const report = await h.uploader.drain();

    expect(report.uploaded).toEqual(["rec-a", "rec-b"]);
    expect(report.remaining).toBe(0);
    expect(await h.queue.size()).toBe(0);
  });

  it("carica in ordine di accodamento", async () => {
    // La piu' vecchia per prima: e' quella che l'utente aspetta da piu' tempo.
    await accoda("prima");
    await accoda("seconda");
    await accoda("terza");

    await h.uploader.drain();

    expect(h.chiamate.map((c) => c.filename)).toEqual(["prima", "seconda", "terza"]);
  });

  it("manda i byte e il mime type che aveva conservato", async () => {
    await accoda("a", 4096);

    await h.uploader.drain();

    expect(h.chiamate[0]).toEqual({ filename: "a", mimeType: "audio/webm", bytes: 4096 });
  });

  it("non lascia in coda cio' che il server ha accettato", async () => {
    await accoda("a");

    await h.uploader.drain();

    expect(h.queue.removed).toEqual(["a"]);
  });
});

describe("drain — quando qualcosa va storto", () => {
  it("non lancia: un guasto di rete e' lo stato normale di questa coda", async () => {
    await accoda("a");
    h.guasti.set("a", "Failed to fetch");

    await expect(h.uploader.drain()).resolves.toMatchObject({ failed: 1 });
  });

  it("tiene l'audio in coda e registra l'errore", async () => {
    await accoda("a");
    h.guasti.set("a", "Failed to fetch");

    await h.uploader.drain();

    expect(h.queue.snapshot()).toHaveLength(1);
    expect(h.queue.snapshot()[0]).toMatchObject({ attempts: 1, lastError: "Failed to fetch" });
  });

  it("un elemento rotto non tiene in ostaggio quelli dietro", async () => {
    // Senza questo, un audio che il server rifiuta bloccherebbe per sempre
    // tutte le registrazioni successive.
    await accoda("rotta");
    await accoda("buona");
    h.guasti.set("rotta", "PAYLOAD_TOO_LARGE");

    const report = await h.uploader.drain();

    expect(report.uploaded).toEqual(["rec-buona"]);
    expect(h.queue.snapshot().map((i) => i.id)).toEqual(["rotta"]);
  });

  it("smette di provare dopo il numero massimo di tentativi", async () => {
    const hh = harness({ maxAttempts: 2 });
    h = hh;
    await accoda("a");
    hh.guasti.set("a", "sempre giu'");

    await hh.uploader.drain();
    await hh.uploader.drain();
    const terzo = await hh.uploader.drain();

    // Due tentativi veri, poi basta: il terzo giro non tocca la rete.
    expect(hh.chiamate).toHaveLength(2);
    expect(terzo.exhausted).toBe(1);
  });

  it("ma non cancella mai l'audio esaurito", async () => {
    // E' l'unica cosa che l'utente non puo' rifare. Smettere di riprovare e'
    // una decisione tecnica; buttarlo via sarebbe una decisione sua.
    const hh = harness({ maxAttempts: 1 });
    h = hh;
    await accoda("a");
    hh.guasti.set("a", "no");

    await hh.uploader.drain();
    await hh.uploader.drain();

    expect(hh.queue.snapshot()).toHaveLength(1);
    expect(hh.queue.removed).toEqual([]);
  });

  it("interrompe il giro se la rete cade a meta'", async () => {
    await accoda("a");
    await accoda("b");

    // La rete cade proprio mentre carica il primo elemento.
    h.guasti.set("a", "Failed to fetch");
    h.onCall = () => {
      h.online = false;
    };

    await h.uploader.drain();

    // Il secondo non e' stato nemmeno tentato: insistere offline consuma
    // batteria e basta.
    expect(h.chiamate.map((c) => c.filename)).toEqual(["a"]);
    expect(await h.queue.size()).toBe(2);
  });
});

describe("drain — offline e concorrenza", () => {
  it("offline non tocca la rete", async () => {
    await accoda("a");
    h.online = false;

    const report = await h.uploader.drain();

    expect(h.chiamate).toEqual([]);
    expect(report.remaining).toBe(1);
  });

  it("due svuotamenti insieme non caricano due volte lo stesso audio", async () => {
    // L'evento `online` e il pulsante «riprova» possono arrivare nello stesso
    // istante: senza il promise condiviso nascerebbero due schede gemelle.
    await accoda("a");

    const [primo, secondo] = await Promise.all([h.uploader.drain(), h.uploader.drain()]);

    expect(h.chiamate).toHaveLength(1);
    expect(primo).toBe(secondo);
  });

  it("finito il giro, `inFlight` torna nullo", async () => {
    await accoda("a");

    await h.uploader.drain();

    expect(h.uploader.inFlight()).toBeNull();
  });

  it("un secondo giro dopo il primo carica cio' che nel frattempo e' arrivato", async () => {
    await accoda("a");
    await h.uploader.drain();

    await accoda("b");
    const report = await h.uploader.drain();

    expect(report.uploaded).toEqual(["rec-b"]);
  });
});

describe("isExhausted", () => {
  it("e' falso finche' restano tentativi", async () => {
    await accoda("a");
    await h.queue.markFailed("a", "x");
    const [item] = h.queue.snapshot();

    expect(item === undefined ? null : isExhausted(item, 2)).toBe(false);
  });

  it("e' vero quando i tentativi sono finiti", async () => {
    await accoda("a");
    await h.queue.markFailed("a", "x");
    await h.queue.markFailed("a", "x");
    const [item] = h.queue.snapshot();

    expect(item === undefined ? null : isExhausted(item, 2)).toBe(true);
  });
});
