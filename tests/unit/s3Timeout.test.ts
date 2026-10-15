import { afterEach, describe, expect, it, vi } from "vitest";
import { S3StorageProvider } from "../../apps/api/src/providers/S3StorageProvider.js";

/**
 * Il bucket che non risponde.
 *
 * Senza un timeout, un `get` appeso ferma il worker per tutto il tempo che
 * decide la rete, e il recupero delle righe abbandonate scambia quel worker
 * fermo per uno morto. Qui si prova che la richiesta finisce comunque, e
 * l'errore opposto: che una risposta arrivata in tempo non venga interrotta.
 *
 * Un `fetch` finto e non MinIO, perche' un server che *non* risponde non si
 * ottiene da un container sano, e il timeout vero di due minuti si sostituisce
 * con quello che il costruttore accetta apposta.
 */

const CONFIG = {
  bucket: "wikimylife-test",
  region: "us-east-1",
  accessKeyId: "chiave",
  secretAccessKey: "segreto",
  endpoint: "http://bucket.invalid",
  forcePathStyle: true,
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Un `fetch` che non risponde mai, e si arrende solo se glielo chiedono. */
function fetchMuto(): void {
  vi.stubGlobal("fetch", (_url: URL, init: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  });
}

describe("il timeout dello storage S3", () => {
  it("un bucket che non risponde fa fallire il get invece di fermarlo per sempre", async () => {
    fetchMuto();
    const storage = new S3StorageProvider(CONFIG, () => new Date(), 20);

    await expect(storage.get("utente/vocale.webm")).rejects.toThrow();
  });

  it("e lo stesso vale per il put, che sta sotto ogni caricamento", async () => {
    fetchMuto();
    const storage = new S3StorageProvider(CONFIG, () => new Date(), 20);

    await expect(
      storage.put({ key: "utente/vocale.webm", data: new Uint8Array([1]), mimeType: "audio/webm" }),
    ).rejects.toThrow();
  });

  it("una risposta che arriva in tempo non viene interrotta", async () => {
    vi.stubGlobal("fetch", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    const storage = new S3StorageProvider(CONFIG, () => new Date(), 1000);

    await expect(storage.get("utente/vocale.webm")).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });
});
