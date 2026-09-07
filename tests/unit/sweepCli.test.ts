import type { ListedObject } from "@wikimylife/shared";
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatOrfano,
  formatSummary,
  parseSweepArgs,
  SWEEP_USAGE,
} from "../../apps/api/src/cli/sweepArgs.js";
import type { SweepSummary } from "../../apps/api/src/services/storageSweep.service.js";

/**
 * Gli argomenti di un comando che cancella.
 *
 * Il rapporto stampato male fa perdere tempo; un argomento letto male sceglie un
 * altro insieme di file da cancellare. Per questo la maggior parte di questi
 * test sta sul rifiuto: `--prefix u1/` scritto con lo spazio deve fermare il
 * comando, non diventare «tutto il bucket».
 */

const GIORNO = 24 * 60 * 60 * 1000;

describe("parseSweepArgs", () => {
  it("senza argomenti guarda tutto e non cancella niente", () => {
    expect(parseSweepArgs([])).toEqual({
      kind: "ESEGUI",
      cancella: false,
      prefix: undefined,
      graceMs: GIORNO,
    });
  });

  it("cancella solo se glielo si dice per esteso", () => {
    expect(parseSweepArgs(["--cancella"])).toMatchObject({ kind: "ESEGUI", cancella: true });
  });

  it("legge prefisso e giorni", () => {
    expect(parseSweepArgs(["--prefix=u1/", "--giorni=7"])).toEqual({
      kind: "ESEGUI",
      cancella: false,
      prefix: "u1/",
      graceMs: 7 * GIORNO,
    });
  });

  it("accetta una soglia piu' corta di un giorno", () => {
    expect(parseSweepArgs(["--giorni=0.5"])).toMatchObject({ graceMs: GIORNO / 2 });
  });

  it("rifiuta un valore staccato dalla sua opzione", () => {
    // Il caso pericoloso: leggerlo come «nessun prefisso» passerebbe la scopa
    // sull'intero bucket a chi credeva di averla puntata su una cartella.
    expect(parseSweepArgs(["--prefix", "u1/"])).toMatchObject({ kind: "ERRORE" });
    expect(parseSweepArgs(["--giorni", "7"])).toMatchObject({ kind: "ERRORE" });
  });

  it("rifiuta un prefisso vuoto invece di intenderlo come tutto", () => {
    expect(parseSweepArgs(["--prefix="])).toMatchObject({ kind: "ERRORE" });
  });

  it("rifiuta una soglia che non e' un numero di giorni positivo", () => {
    // Zero e' vietato apposta: e' la soglia a difendere dall'audio che qualcuno
    // sta caricando in questo momento.
    for (const valore of ["0", "-1", "ieri", ""]) {
      expect(parseSweepArgs([`--giorni=${valore}`])).toMatchObject({ kind: "ERRORE" });
    }
  });

  it("rifiuta cio' che non conosce invece di ignorarlo", () => {
    expect(parseSweepArgs(["--dry-run"])).toMatchObject({ kind: "ERRORE" });
    expect(parseSweepArgs(["--cancella=si"])).toMatchObject({ kind: "ERRORE" });
    expect(parseSweepArgs(["u1/"])).toMatchObject({ kind: "ERRORE" });
  });

  it("un errore vince su un --cancella che lo precede", () => {
    // Nessuna esecuzione parziale: se una parte della riga non si capisce, non
    // si sa nemmeno su cosa si sarebbe eseguita.
    expect(parseSweepArgs(["--cancella", "--sbagliato"])).toMatchObject({ kind: "ERRORE" });
  });

  it("l'aiuto batte tutto il resto", () => {
    expect(parseSweepArgs(["--cancella", "--help"])).toEqual({ kind: "AIUTO" });
    expect(parseSweepArgs(["-h"])).toEqual({ kind: "AIUTO" });
    expect(SWEEP_USAGE).toContain("--cancella");
  });
});

describe("formatBytes", () => {
  it("dice i byte come sono finche' sono pochi", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("sale di unita' in potenze di 1024", () => {
    expect(formatBytes(1024)).toBe("1,0 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1,0 MiB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3,0 GiB");
  });
});

const orfano: ListedObject = {
  key: "u1/3f8a1b2c-1111-4222-8333-444455556666.webm",
  sizeBytes: 2048,
  lastModified: "2026-03-01T10:00:00.000Z",
};

const vuoto: SweepSummary = {
  esaminati: 0,
  nominati: 0,
  estranei: 0,
  troppoRecenti: 0,
  orfani: [],
  byteOrfani: 0,
  cancellati: 0,
  falliti: 0,
};

describe("il rapporto", () => {
  it("mette in una riga quando, quanto e quale", () => {
    expect(formatOrfano(orfano)).toContain("2026-03-01T10:00:00.000Z");
    expect(formatOrfano(orfano)).toContain("2,0 KiB");
    expect(formatOrfano(orfano)).toContain(orfano.key);
  });

  it("dice come cancellare, quando ha solo guardato", () => {
    const testo = formatSummary(
      { ...vuoto, esaminati: 1, orfani: [orfano], byteOrfani: 2048 },
      false,
    );
    expect(testo).toContain("--cancella");
    expect(testo).not.toContain("cancellati");
  });

  it("non propone di cancellare quando non c'e' niente da cancellare", () => {
    const testo = formatSummary({ ...vuoto, esaminati: 3, nominati: 3 }, false);
    expect(testo).not.toContain("--cancella");
  });

  it("conta i falliti solo se ce ne sono", () => {
    const bene = formatSummary({ ...vuoto, orfani: [orfano], cancellati: 1 }, true);
    expect(bene).toContain("cancellati");
    expect(bene).not.toContain("falliti");

    const male = formatSummary({ ...vuoto, orfani: [orfano], cancellati: 0, falliti: 1 }, true);
    expect(male).toContain("falliti");
  });
});
