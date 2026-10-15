import type { RecordingDraftAdapter } from "@wikimylife/shared";
import { describe, expect, it } from "vitest";
import {
  SILENZIO_BOZZA_MS,
  concatena,
  creaScrittoreBozza,
  recuperaBozze,
} from "../../apps/web/src/recording/bozze.js";
import { InMemoryBozze } from "../support/InMemoryBozze.js";
import { InMemoryUploadQueue } from "../support/InMemoryUploadQueue.js";

/**
 * Le bozze: cio' che resta di una registrazione che non e' arrivata allo stop.
 *
 * Due errori opposti, e ogni gruppo li prova tutti e due. Recuperare troppo poco
 * e' il difetto di prima: il racconto interrotto dallo schermo bloccato sparisce.
 * Recuperare troppo e' quello nuovo: mettere in coda meta' di un vocale che
 * un'altra scheda sta ancora registrando, o un secondo di audio rimasto dopo uno
 * stop riuscito.
 */

const INIZIO = Date.parse("2026-10-15T09:00:00.000Z");

function pezzo(seq: number, byte: number, at: number) {
  return { seq, data: new Uint8Array([byte]), mimeType: "audio/webm", at };
}

async function conBozza(
  bozze: InMemoryBozze,
  id: string,
  pezzi: readonly { seq: number; byte: number; at: number }[],
): Promise<void> {
  for (const p of pezzi) {
    await bozze.append({ ...pezzo(p.seq, p.byte, p.at), draftId: id, startedAt: INIZIO });
  }
}

describe("recuperaBozze", () => {
  it("una bozza ferma da piu' della soglia diventa una registrazione in coda", async () => {
    const bozze = new InMemoryBozze();
    const coda = new InMemoryUploadQueue();
    await conBozza(bozze, "b1", [
      { seq: 0, byte: 1, at: INIZIO + 1_000 },
      { seq: 1, byte: 2, at: INIZIO + 2_000 },
    ]);

    const n = await recuperaBozze({
      bozze,
      coda,
      adesso: INIZIO + 2_000 + SILENZIO_BOZZA_MS,
      lingua: "it-IT",
    });

    expect(n).toBe(1);
    const [voce] = await coda.list();
    expect(voce).toMatchObject({
      id: "b1",
      mimeType: "audio/webm",
      durationMs: 2_000,
      recordedAt: new Date(INIZIO + 2_000).toISOString(),
      deviceLocale: "it-IT",
      latitude: null,
    });
    expect([...(voce?.audio ?? [])]).toEqual([1, 2]);
    expect(bozze.ids()).toEqual([]);
  });

  it("una bozza che ha scritto da poco e' di una registrazione viva, e non si tocca", async () => {
    // Un'altra scheda sta registrando adesso: metterne in coda meta' vorrebbe
    // dire, allo stop, due vocali dello stesso racconto.
    const bozze = new InMemoryBozze();
    const coda = new InMemoryUploadQueue();
    await conBozza(bozze, "viva", [{ seq: 0, byte: 1, at: INIZIO + 1_000 }]);

    const n = await recuperaBozze({
      bozze,
      coda,
      adesso: INIZIO + 1_000 + SILENZIO_BOZZA_MS - 1,
      lingua: null,
    });

    expect(n).toBe(0);
    expect(await coda.size()).toBe(0);
    expect(bozze.ids()).toEqual(["viva"]);
  });

  it("i pezzi si rimettono in ordine di numero, non di scrittura", async () => {
    const bozze = new InMemoryBozze();
    const coda = new InMemoryUploadQueue();
    await conBozza(bozze, "b1", [
      { seq: 2, byte: 3, at: INIZIO + 3_000 },
      { seq: 0, byte: 1, at: INIZIO + 1_000 },
      { seq: 1, byte: 2, at: INIZIO + 2_000 },
    ]);

    await recuperaBozze({ bozze, coda, adesso: INIZIO + 3_000 + SILENZIO_BOZZA_MS, lingua: null });

    const [voce] = await coda.list();
    expect([...(voce?.audio ?? [])]).toEqual([1, 2, 3]);
    // La durata dall'ultimo pezzo, anche se e' stato scritto per primo.
    expect(voce?.durationMs).toBe(3_000);
  });

  it("se la coda rifiuta, la bozza resta per il prossimo avvio", async () => {
    const bozze = new InMemoryBozze();
    const coda = new InMemoryUploadQueue();
    coda.enqueue = () => Promise.reject(new Error("quota esaurita"));
    await conBozza(bozze, "b1", [{ seq: 0, byte: 1, at: INIZIO }]);

    const n = await recuperaBozze({ bozze, coda, adesso: INIZIO + SILENZIO_BOZZA_MS, lingua: null });

    expect(n).toBe(0);
    expect(bozze.ids()).toEqual(["b1"]);
  });

  it("una bozza senza pezzi si butta senza mettere in coda niente", async () => {
    const buttate: string[] = [];
    const bozze: RecordingDraftAdapter = {
      append: () => Promise.resolve(),
      list: () =>
        Promise.resolve([
          { id: "vuota", mimeType: "audio/webm", startedAt: INIZIO, lastPieceAt: INIZIO, pieces: [] },
        ]),
      discard: (id) => {
        buttate.push(id);
        return Promise.resolve();
      },
      clear: () => Promise.resolve(),
    };
    const coda = new InMemoryUploadQueue();

    const n = await recuperaBozze({ bozze, coda, adesso: INIZIO + SILENZIO_BOZZA_MS, lingua: null });

    expect(n).toBe(0);
    expect(await coda.size()).toBe(0);
    expect(buttate).toEqual(["vuota"]);
  });

  it("un archivio illeggibile non lancia: vuol dire che non c'erano bozze", async () => {
    const bozze = new InMemoryBozze();
    bozze.listFallisce = true;

    await expect(
      recuperaBozze({ bozze, coda: new InMemoryUploadQueue(), adesso: INIZIO, lingua: null }),
    ).resolves.toBe(0);
  });

  it("la soglia sta fra qualche secondo di pezzi in ritardo e il minuto", () => {
    // Sotto: un browser che rallenta i timer di una scheda in secondo piano
    // consegna i pezzi a raffiche, e una registrazione viva sembrerebbe morta.
    // Sopra: chi riapre l'app subito dopo averla persa non ritroverebbe il
    // vocale fino al giro successivo.
    expect(SILENZIO_BOZZA_MS).toBeGreaterThanOrEqual(10_000);
    expect(SILENZIO_BOZZA_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("creaScrittoreBozza", () => {
  it("scrive ogni pezzo con l'id e l'inizio della registrazione", async () => {
    const bozze = new InMemoryBozze();
    const s = creaScrittoreBozza({ bozze, id: "b1", startedAt: INIZIO });

    s.pezzo(pezzo(0, 7, INIZIO + 1_000));
    s.chiudi();
    await s.butta().then(() => undefined);

    expect(bozze.registro[0]).toBe("append:b1:0");
  });

  it("la cancellazione aspetta le scritture gia' in fila", async () => {
    // Il caso dello stop: l'ultimo pezzo e' ancora in volo quando la
    // registrazione intera e' gia' in coda. Se la sua scrittura finisse dopo la
    // cancellazione, resterebbe una bozza di un secondo senza intestazione.
    const bozze = new InMemoryBozze();
    let sblocca: () => void = () => {};
    const bloccata = new Promise<void>((ok) => {
      sblocca = ok;
    });
    bozze.attesaAppend = () => bloccata;
    const s = creaScrittoreBozza({ bozze, id: "b1", startedAt: INIZIO });

    s.pezzo(pezzo(0, 1, INIZIO));
    const fatto = s.butta();
    sblocca();
    await fatto;

    expect(bozze.registro).toEqual(["append:b1:0", "discard:b1"]);
    expect(bozze.ids()).toEqual([]);
  });

  it("dopo butta un pezzo in ritardo non riapre la bozza", async () => {
    const bozze = new InMemoryBozze();
    const s = creaScrittoreBozza({ bozze, id: "b1", startedAt: INIZIO });

    await s.butta();
    s.pezzo(pezzo(9, 9, INIZIO + 9_000));
    await s.butta();

    expect(bozze.ids()).toEqual([]);
    expect(bozze.registro.filter((r) => r.startsWith("append"))).toEqual([]);
  });

  it("dopo chiudi la bozza resta com'era, che e' l'errore opposto di butta", async () => {
    // Lo stop la cui coda ha rifiutato l'audio: la bozza e' l'unica copia su
    // disco, e deve sopravvivere.
    const bozze = new InMemoryBozze();
    const s = creaScrittoreBozza({ bozze, id: "b1", startedAt: INIZIO });
    s.pezzo(pezzo(0, 1, INIZIO));
    s.chiudi();
    s.pezzo(pezzo(1, 2, INIZIO + 1_000));

    // Una scrittura qualsiasi accodata dopo: aspettarla vuol dire che la fila
    // e' stata percorsa tutta.
    await new Promise((ok) => setTimeout(ok, 0));

    expect(bozze.ids()).toEqual(["b1"]);
    expect(bozze.registro).toEqual(["append:b1:0"]);
  });

  it("una scrittura che fallisce non spezza la fila", async () => {
    const bozze = new InMemoryBozze();
    const s = creaScrittoreBozza({ bozze, id: "b1", startedAt: INIZIO });
    bozze.appendFallisce = true;
    s.pezzo(pezzo(0, 1, INIZIO));
    await new Promise((ok) => setTimeout(ok, 0));
    bozze.appendFallisce = false;
    s.pezzo(pezzo(1, 2, INIZIO + 1_000));

    await s.butta();

    expect(bozze.registro).toEqual(["append:b1:1", "discard:b1"]);
  });
});

describe("concatena", () => {
  it("mette i pezzi uno dopo l'altro, senza perdere byte", () => {
    expect([...concatena([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])])]).toEqual(
      [1, 2, 3],
    );
  });
});
