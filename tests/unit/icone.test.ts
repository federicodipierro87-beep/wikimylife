import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FILE_PNG, PUBBLICA, ROOT, pixel, png, svg, type FilePng } from "../../scripts/icone.js";

/**
 * Le icone in git sono quelle che `scripts/icone.ts` disegnerebbe adesso.
 *
 * I tre file sono generati e versionati insieme: versionati perche' Netlify e,
 * domani, Capacitor li devono trovare senza eseguire niente; generati perche'
 * tre disegni tenuti allineati a mano smettono di esserlo al primo ritocco.
 * Questo file e' cio' che rende vera la seconda meta'.
 *
 * ## Si confrontano i pixel, non i byte
 *
 * I byte di un PNG dipendono dalla versione di zlib che l'ha compresso, e zlib
 * arriva con Node: un aggiornamento di Node cambierebbe i byte senza cambiare
 * un pixel, e questo test cadrebbe per un motivo che non e' un difetto. Si
 * decomprime e si confronta cio' che si vede.
 *
 * ## Il canale alfa si legge in due posti
 *
 * L'IHDR dice se l'immagine ha un canale alfa, ma un PNG RGB puo' avere lo
 * stesso una trasparenza, attraverso un blocco `tRNS` che dichiara un colore
 * come trasparente. Apple rifiuta tutte e due le forme, quindi si guardano
 * tutte e due.
 */

type Blocco = { tipo: string; dati: Buffer };

function blocchi(file: Buffer): Blocco[] {
  const out: Blocco[] = [];
  let i = 8;
  while (i < file.length) {
    const lunghezza = file.readUInt32BE(i);
    const tipo = file.toString("latin1", i + 4, i + 8);
    out.push({ tipo, dati: file.subarray(i + 8, i + 8 + lunghezza) });
    i += 12 + lunghezza;
  }
  return out;
}

function ihdr(file: Buffer): {
  larghezza: number;
  altezza: number;
  bit: number;
  colore: number;
} {
  const dati = blocchi(file).find((b) => b.tipo === "IHDR")?.dati;
  if (dati === undefined) {
    throw new Error("PNG senza IHDR");
  }
  return {
    larghezza: dati.readUInt32BE(0),
    altezza: dati.readUInt32BE(4),
    bit: dati[8] ?? -1,
    colore: dati[9] ?? -1,
  };
}

/**
 * I pixel RGB di un PNG scritto da `png()`: solo il filtro 0, che e' l'unico
 * che lo script usa. Una riga con un altro filtro fa lanciare invece di essere
 * letta male, cosi' un PNG ripassato da un ottimizzatore esterno si vede come
 * tale e non come «pixel diversi».
 */
function decodifica(file: Buffer, larghezza: number, altezza = larghezza): Uint8Array {
  const compressi = Buffer.concat(
    blocchi(file)
      .filter((b) => b.tipo === "IDAT")
      .map((b) => b.dati),
  );
  const grezzo = inflateSync(compressi);
  const riga = larghezza * 3;
  expect(grezzo.length).toBe((riga + 1) * altezza);
  const out = new Uint8Array(riga * altezza);
  for (let y = 0; y < altezza; y += 1) {
    const filtro = grezzo[y * (riga + 1)];
    if (filtro !== 0) {
      throw new Error(`riga ${String(y)} con filtro ${String(filtro)}`);
    }
    out.set(grezzo.subarray(y * (riga + 1) + 1, (y + 1) * (riga + 1)), y * riga);
  }
  return out;
}

function inGit(percorso: string): Buffer {
  return readFileSync(join(ROOT, percorso));
}

/**
 * Il colore del pixel che contiene il punto (x, y) del `viewBox` a 512, dentro
 * il quadrato in cui il file mette il disegno: tutta l'immagine per un'icona,
 * il centro per uno splash.
 */
function colore(rgb: Uint8Array, f: FilePng, x: number, y: number): number[] {
  const px = Math.floor((f.larghezza - f.disegno) / 2 + (x / 512) * f.disegno);
  const py = Math.floor((f.altezza - f.disegno) / 2 + (y / 512) * f.disegno);
  const i = (py * f.larghezza + px) * 3;
  return [rgb[i] ?? -1, rgb[i + 1] ?? -1, rgb[i + 2] ?? -1];
}

/**
 * Il tipo di colore 2 dell'IHDR: RGB, nessun alfa. Scritto qui e non importato
 * dallo script, perche' e' proprio il valore che lo script potrebbe sbagliare:
 * importato, si muoverebbe insieme a lui e il caso passerebbe sempre.
 */
const RGB_SENZA_ALFA = 2;

const FONDO = [0x10, 0x14, 0x18];
const ROSSO = [0xe5, 0x48, 0x4d];
const BIANCO = [0xf4, 0xf6, 0xf8];

describe("icona.svg", () => {
  it("e' quella che lo script scriverebbe", () => {
    // Git su Windows puo' averlo riscritto con CRLF: l'a capo non e' il
    // disegno, e confrontarlo farebbe cadere il test su una macchina e non
    // sull'altra.
    const scritto = readFileSync(join(PUBBLICA, "icona.svg"), "utf8").replace(/\r\n/g, "\n");
    expect(scritto).toBe(svg());
  });

  it("tiene gli angoli arrotondati, che nella favicon nessuno aggiunge al posto nostro", () => {
    expect(svg()).toMatch(/<rect width="512" height="512" rx="96"/);
  });
});

describe.each(FILE_PNG)("$percorso", (f) => {
  const file = inGit(f.percorso);

  it(`misura ${String(f.larghezza)} per ${String(f.altezza)}, a 8 bit per canale`, () => {
    expect(ihdr(file)).toMatchObject({ larghezza: f.larghezza, altezza: f.altezza, bit: 8 });
  });

  it("non ha il canale alfa, che Apple rifiuta", () => {
    expect(ihdr(file).colore).toBe(RGB_SENZA_ALFA);
  });

  it("non dichiara nemmeno un colore trasparente", () => {
    // La seconda forma di trasparenza: un RGB con `tRNS`. Vedi l'intestazione.
    expect(blocchi(file).map((b) => b.tipo)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  // Il 1024 sono sedici milioni di campioni: sotto una suite intera i 5s di
  // default si sforano, come succede gia' a `guards.test.ts`.
  it("ha i pixel che lo script disegnerebbe adesso", { timeout: 30_000 }, () => {
    const atteso = pixel(f.larghezza, f.altezza, f.disegno);
    const inFile = decodifica(file, f.larghezza, f.altezza);
    expect(Buffer.from(inFile).equals(Buffer.from(atteso))).toBe(true);
  });

  it("e' pieno fino agli angoli: fondo, non trasparente e non chiaro", () => {
    // Apple e Android arrotondano da se'. Un angolo gia' tondo vorrebbe dire
    // trasparenza, che l'IHDR ha appena escluso, oppure un colore sotto
    // l'angolo che si vedrebbe come un bordo dopo la maschera.
    const rgb = decodifica(file, f.larghezza, f.altezza);
    const ultimo = (f.larghezza * f.altezza - 1) * 3;
    expect([rgb[0], rgb[1], rgb[2]]).toEqual(FONDO);
    expect([rgb[ultimo], rgb[ultimo + 1], rgb[ultimo + 2]]).toEqual(FONDO);
  });

  it("contiene il microfono, e non soltanto il fondo", () => {
    // Il caso opposto a quello dei pixel uguali: uno script che non disegna
    // niente produrrebbe un quadrato scuro, identico a un file in git scuro
    // a sua volta. Qui si pretende il disegno, dove il file dice di metterlo.
    const rgb = decodifica(file, f.larghezza, f.altezza);
    expect(colore(rgb, f, 256, 200)).toEqual(ROSSO);
    expect(colore(rgb, f, 256, 364)).toEqual(BIANCO);
    // Il fondo del semicerchio, sotto il corpo: bianco, e fra i due il vuoto.
    expect(colore(rgb, f, 256, 336)).toEqual(BIANCO);
    expect(colore(rgb, f, 256, 300)).toEqual(FONDO);
  });
});

describe("gli splash", () => {
  it("mettono il microfono al centro, piu' piccolo dell'immagine", () => {
    // Senza, uno splash disegnato come un'icona — il microfono a tutta
    // altezza — passerebbe tutti i casi qui sopra, che leggono `disegno` dalla
    // stessa lista che lo decide.
    const splash = FILE_PNG.filter((f) => f.percorso.endsWith("/splash.png"));
    expect(splash).toHaveLength(11);
    for (const f of splash) {
      expect(f.disegno).toBe(Math.round(Math.min(f.larghezza, f.altezza) / 2));
    }
  });

  it("le icone invece sono il disegno intero", () => {
    const icone = FILE_PNG.filter((f) => !f.percorso.endsWith("/splash.png"));
    expect(icone).toHaveLength(17);
    for (const f of icone) {
      expect([f.larghezza, f.disegno]).toEqual([f.altezza, f.altezza]);
    }
  });
});

describe("il PNG che lo script scrive", () => {
  it("e' leggibile da cio' che lo legge in questo file", () => {
    // Senza questo, un `png()` rotto e un `decodifica()` rotto nello stesso
    // modo si darebbero ragione a vicenda sui file in git. Qui il PNG esce
    // fresco dallo script e deve tornare ai pixel da cui e' partito.
    const lato = 24;
    expect(Buffer.from(decodifica(png(lato), lato)).equals(Buffer.from(pixel(lato)))).toBe(true);
    // E rettangolare, dove larghezza e altezza scambiate si vedrebbero.
    const splash = png(30, 20, 10);
    expect(Buffer.from(decodifica(splash, 30, 20)).equals(Buffer.from(pixel(30, 20, 10)))).toBe(
      true,
    );
  });

  it("dichiara RGB senza alfa anche quando esce fresco", () => {
    // I casi sui file in git guardano il passato: uno script che da oggi
    // scrivesse RGBA li lascerebbe verdi fino al prossimo `npm run icone`.
    expect(ihdr(png(8)).colore).toBe(RGB_SENZA_ALFA);
    expect(ihdr(png(8))).toMatchObject({ larghezza: 8, altezza: 8, bit: 8 });
  });

  it("scrive il CRC giusto, che un lettore vero pretende", () => {
    // Il CRC di ogni blocco copre tipo e dati. Uno sbagliato non lo vede
    // nessuna delle funzioni di questo file, e lo vede ogni visualizzatore.
    const file = png(8);
    let i = 8;
    while (i < file.length) {
      const lunghezza = file.readUInt32BE(i);
      const atteso = file.readUInt32BE(i + 8 + lunghezza);
      expect(crcDi(file.subarray(i + 4, i + 8 + lunghezza))).toBe(atteso);
      i += 12 + lunghezza;
    }
  });
});

describe("index.html", () => {
  it("punta l'icona della schermata Home a un PNG che esiste", () => {
    const html = readFileSync(resolve(PUBBLICA, "..", "index.html"), "utf8");
    const href = /<link rel="apple-touch-icon" href="\/([^"]+)"/.exec(html)?.[1];
    expect(href).toBe("apple-touch-icon.png");
    expect(FILE_PNG.map((f) => f.percorso)).toContain(`apps/web/public/${String(href)}`);
  });
});

/**
 * Un CRC-32 scritto qui, e non `zlib.crc32`: e' la funzione che lo script usa
 * per scriverlo, e verificarla con se stessa non proverebbe niente.
 */
function crcDi(dati: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of dati) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
