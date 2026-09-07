import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFileStorageProvider } from "../../apps/api/src/providers/LocalFileStorageProvider.js";
import { FakeStorageProvider } from "../../apps/api/src/providers/fake/FakeStorageProvider.js";

/**
 * `list` e' l'unica operazione dello storage che nessuna rotta usa.
 *
 * Serve a chi raccoglie gli oggetti che nessuna riga nomina piu', e chi
 * raccoglie poi cancella: un elenco che dimentica una chiave e' spazzatura che
 * resta, un elenco che ne inventa una e' un audio che sparisce. Le due
 * implementazioni non hanno niente in comune — una legge una `Map`, l'altra il
 * filesystem — quindi qui si prova che rispondano alla stessa domanda nello
 * stesso modo.
 */

const AUDIO = new Uint8Array([1, 2, 3]);

describe("FakeStorageProvider.list", () => {
  it("elenca cio' che e' stato caricato, con dimensione e data", async () => {
    const orologio = new Date("2026-03-01T10:00:00.000Z");
    const storage = new FakeStorageProvider("memory://test", () => orologio);
    await storage.put({ key: "u1/a.webm", data: AUDIO, mimeType: "audio/webm" });

    const pagina = await storage.list();

    expect(pagina.objects).toEqual([
      {
        key: "u1/a.webm",
        sizeBytes: 3,
        lastModified: "2026-03-01T10:00:00.000Z",
      },
    ]);
    expect(pagina.continuationToken).toBeUndefined();
  });

  it("su uno storage vuoto risponde un elenco vuoto, non un errore", async () => {
    const pagina = await new FakeStorageProvider().list();
    expect(pagina.objects).toEqual([]);
    expect(pagina.continuationToken).toBeUndefined();
  });

  it("filtra per prefisso", async () => {
    const storage = new FakeStorageProvider();
    await storage.put({ key: "u1/a.webm", data: AUDIO, mimeType: "audio/webm" });
    await storage.put({ key: "u2/b.webm", data: AUDIO, mimeType: "audio/webm" });

    const pagina = await storage.list({ prefix: "u1/" });

    expect(pagina.objects.map((o) => o.key)).toEqual(["u1/a.webm"]);
  });

  it("pagina, e il segnalibro dell'ultima pagina e' assente", async () => {
    const storage = new FakeStorageProvider();
    storage.pageSize = 2;
    for (const n of [1, 2, 3, 4, 5]) {
      await storage.put({ key: `u1/${String(n)}.webm`, data: AUDIO, mimeType: "audio/webm" });
    }

    const raccolte: string[] = [];
    let token: string | undefined;
    let giri = 0;
    do {
      const pagina = await storage.list({ continuationToken: token });
      raccolte.push(...pagina.objects.map((o) => o.key));
      token = pagina.continuationToken;
      giri += 1;
    } while (token !== undefined && giri < 10);

    expect(giri).toBe(3);
    expect(raccolte).toEqual([
      "u1/1.webm",
      "u1/2.webm",
      "u1/3.webm",
      "u1/4.webm",
      "u1/5.webm",
    ]);
  });

  it("non ripete e non salta quando le pagine dividono esattamente", async () => {
    // Il caso in cui l'ultima pagina e' piena: un fuori-di-uno qui produce un
    // giro in piu' che chiede la pagina dopo la fine, o una chiave persa.
    const storage = new FakeStorageProvider();
    storage.pageSize = 2;
    for (const n of [1, 2, 3, 4]) {
      await storage.put({ key: `u1/${String(n)}.webm`, data: AUDIO, mimeType: "audio/webm" });
    }

    const prima = await storage.list();
    const seconda = await storage.list({ continuationToken: prima.continuationToken });

    expect(prima.objects).toHaveLength(2);
    expect(seconda.objects).toHaveLength(2);
    expect(seconda.continuationToken).toBeUndefined();
  });

  it("touch sposta indietro la data senza toccare i byte", async () => {
    const storage = new FakeStorageProvider();
    await storage.put({ key: "u1/a.webm", data: AUDIO, mimeType: "audio/webm" });
    storage.touch("u1/a.webm", new Date("2020-01-01T00:00:00.000Z"));

    const pagina = await storage.list();

    expect(pagina.objects[0]?.lastModified).toBe("2020-01-01T00:00:00.000Z");
    expect(pagina.objects[0]?.sizeBytes).toBe(3);
    expect(await storage.get("u1/a.webm")).toEqual(AUDIO);
  });
});

describe("LocalFileStorageProvider.list", () => {
  let root: string;
  let storage: LocalFileStorageProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "wikimylife-list-"));
    storage = new LocalFileStorageProvider(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("elenca i file dentro le sottocartelle con la chiave, non con il percorso", async () => {
    await storage.put({ key: "u1/a.webm", data: AUDIO, mimeType: "audio/webm" });
    await storage.put({ key: "u2/b.m4a", data: AUDIO, mimeType: "audio/mp4" });

    const pagina = await storage.list();

    // Barre in avanti anche su Windows: la stessa chiave deve combaciare con
    // quella scritta nel database da un sistema operativo qualunque.
    expect([...pagina.objects.map((o) => o.key)].sort()).toEqual(["u1/a.webm", "u2/b.m4a"]);
    expect(pagina.objects.every((o) => o.sizeBytes === 3)).toBe(true);
  });

  it("non elenca le cartelle", async () => {
    await mkdir(join(root, "vuota"), { recursive: true });
    await storage.put({ key: "u1/a.webm", data: AUDIO, mimeType: "audio/webm" });

    const pagina = await storage.list();

    expect(pagina.objects.map((o) => o.key)).toEqual(["u1/a.webm"]);
  });

  it("su una radice che non esiste ancora risponde vuoto invece di sollevare", async () => {
    // Prima del primo caricamento la cartella non c'e'. Non e' un guasto: e'
    // uno storage vuoto, ed e' la risposta esatta.
    const mai = new LocalFileStorageProvider(join(root, "mai-creata"));
    expect(await mai.list()).toEqual({ objects: [], continuationToken: undefined });
  });

  it("filtra per prefisso", async () => {
    await storage.put({ key: "u1/a.webm", data: AUDIO, mimeType: "audio/webm" });
    await storage.put({ key: "u2/b.webm", data: AUDIO, mimeType: "audio/webm" });

    const pagina = await storage.list({ prefix: "u2/" });

    expect(pagina.objects.map((o) => o.key)).toEqual(["u2/b.webm"]);
  });

  it("legge la data di modifica del file", async () => {
    const path = join(root, "u1");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "a.webm"), AUDIO);

    const pagina = await storage.list();

    // Non si confronta con un istante fisso — il filesystem decide lui la
    // risoluzione — ma dev'essere una data leggibile e recente.
    const quando = Date.parse(pagina.objects[0]?.lastModified ?? "");
    expect(Number.isNaN(quando)).toBe(false);
    expect(Date.now() - quando).toBeLessThan(60_000);
  });

  it("non pagina: risponde tutto in una volta", async () => {
    for (const n of [1, 2, 3]) {
      await storage.put({ key: `u1/${String(n)}.webm`, data: AUDIO, mimeType: "audio/webm" });
    }
    const pagina = await storage.list();
    expect(pagina.objects).toHaveLength(3);
    expect(pagina.continuationToken).toBeUndefined();
  });
});
