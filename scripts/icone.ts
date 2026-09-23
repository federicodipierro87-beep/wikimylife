import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";

/**
 * Le icone, disegnate una volta sola e scritte in tre file.
 *
 * `npm run icone` riscrive `apps/web/public/icona.svg`, `icona-1024.png` e
 * `apple-touch-icon.png`. Tutti e tre escono dalla stessa `GEOMETRIA`, e
 * `tests/unit/icone.test.ts` ridisegna tutto e lo confronta con i file in git:
 * cambiare il disegno a mano in uno solo dei tre fa cadere quel test.
 *
 * ## Perche' un rasterizzatore scritto qui
 *
 * Nel repo non c'era nessuno strumento che trasformi un SVG in PNG, e le strade
 * pronte costano piu' di quanto rendono. `sharp` e `@resvg/resvg-js` portano un
 * binario nativo per piattaforma — cioe' un `npm ci` che puo' rompersi su
 * Windows, in CI o su Netlify — per disegnare tre forme. Un browser senza testa
 * pesa centinaia di MB. Il disegno sono un rettangolo, un rettangolo arrotondato,
 * un semicerchio e un segmento: la distanza da ciascuno si scrive in poche
 * righe, e `node:zlib` sa gia' comprimere e fare il CRC di un PNG.
 *
 * Il prezzo e' che questo file sa disegnare **solo** queste forme. Un'icona
 * nuova con una curva di Bezier vorrebbe o un pezzo di rasterizzatore in piu'
 * o, a quel punto, una dipendenza vera.
 *
 * ## Perche' i PNG sono quadrati pieni e l'SVG no
 *
 * Apple vuole il 1024x1024 **senza canale alfa**, e gli angoli arrotondati li
 * taglia lei con la sua maschera: un PNG con gli angoli gia' tondi avrebbe
 * bisogno della trasparenza per dirlo, cioe' proprio del canale vietato. Lo
 * stesso vale per `apple-touch-icon`, che iOS maschera da se'. L'SVG invece e'
 * la favicon del browser, dove nessuno arrotonda niente al posto nostro.
 *
 * ## Perche' serve un apple-touch-icon in PNG
 *
 * `index.html` puntava `apple-touch-icon` a `icona.svg`. Per quanto ne so Safari
 * non accetta un SVG per l'icona della schermata Home, e in quel caso usa uno
 * screenshot della pagina. **E' un ricordo, non una misura**: diventa vero o
 * falso la prossima volta che l'app si aggiunge alla Home da un iPhone. Il PNG
 * a 180 e' la misura che Apple documenta per gli iPhone con schermo Retina.
 */

type Rgb = readonly [number, number, number];

const FONDO: Rgb = [0x10, 0x14, 0x18];
const ROSSO: Rgb = [0xe5, 0x48, 0x4d];
const BIANCO: Rgb = [0xf4, 0xf6, 0xf8];

/** Il lato della tela, nelle unita' del `viewBox`. Ogni numero qui sotto e' in queste unita'. */
const LATO = 512;

/**
 * Il microfono. I numeri sono quelli che `icona.svg` aveva quando era scritto a
 * mano, riportati qui senza ritocchi: la favicon di oggi e quella di ieri sono
 * lo stesso disegno.
 */
export const GEOMETRIA = {
  /** Il raggio degli angoli del fondo, solo nell'SVG. */
  angoloFondo: 96,
  corpo: { x: 216, y: 120, larghezza: 80, altezza: 160, raggio: 40 },
  /** Il semicerchio di sotto, quello che abbraccia il corpo. */
  arco: { cx: 256, cy: 248, raggio: 88 },
  asta: { x: 256, y1: 336, y2: 392 },
  tratto: 24,
} as const;

// ---------------------------------------------------------------------------
// L'SVG
// ---------------------------------------------------------------------------

export function svg(): string {
  const { angoloFondo, corpo, arco, asta, tratto } = GEOMETRIA;
  const sinistra = arco.cx - arco.raggio;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LATO} ${LATO}" role="img" aria-label="WikiMyLife">
  <!--
    Generato da scripts/icone.ts, insieme ai due PNG che gli stanno accanto:
    si cambia la', non qui. tests/unit/icone.test.ts lo confronta con cio' che
    lo script produrrebbe, e un ritocco fatto a mano su questo file lo fa cadere.
  -->
  <rect width="${LATO}" height="${LATO}" rx="${angoloFondo}" fill="${esadecimale(FONDO)}" />
  <rect x="${corpo.x}" y="${corpo.y}" width="${corpo.larghezza}" height="${corpo.altezza}" rx="${corpo.raggio}" fill="${esadecimale(ROSSO)}" />
  <path
    d="M${sinistra} ${arco.cy}a${arco.raggio} ${arco.raggio} 0 0 0 ${2 * arco.raggio} 0"
    fill="none"
    stroke="${esadecimale(BIANCO)}"
    stroke-width="${tratto}"
    stroke-linecap="round"
  />
  <path d="M${asta.x} ${asta.y1}v${asta.y2 - asta.y1}" fill="none" stroke="${esadecimale(BIANCO)}" stroke-width="${tratto}" stroke-linecap="round" />
</svg>
`;
}

function esadecimale(colore: Rgb): string {
  return `#${colore.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Il rasterizzatore
// ---------------------------------------------------------------------------

/**
 * Distanza con segno da un rettangolo arrotondato: negativa dentro.
 *
 * E' la formula classica del «box arrotondato» (Inigo Quilez), scritta per un
 * rettangolo che non sta nell'origine.
 */
function distanzaRettangolo(
  px: number,
  py: number,
  r: {
    x: number;
    y: number;
    larghezza: number;
    altezza: number;
    raggio: number;
  },
): number {
  const mezzaL = r.larghezza / 2;
  const mezzaA = r.altezza / 2;
  const qx = Math.abs(px - (r.x + mezzaL)) - (mezzaL - r.raggio);
  const qy = Math.abs(py - (r.y + mezzaA)) - (mezzaA - r.raggio);
  const fuori = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return fuori + Math.min(Math.max(qx, qy), 0) - r.raggio;
}

/**
 * Distanza dalla linea del semicerchio di sotto.
 *
 * Il semicerchio va da sinistra a destra passando per il basso — `sweep 0` nel
 * `path`, con la y che cresce verso il basso. Sotto il diametro la distanza e'
 * quella dalla circonferenza; sopra, e' quella dal capo piu' vicino, che con
 * `stroke-linecap="round"` e' esattamente cio' che disegna l'SVG.
 */
function distanzaArco(px: number, py: number): number {
  const { cx, cy, raggio } = GEOMETRIA.arco;
  if (py >= cy) {
    return Math.abs(Math.hypot(px - cx, py - cy) - raggio);
  }
  return Math.min(Math.hypot(px - (cx - raggio), py - cy), Math.hypot(px - (cx + raggio), py - cy));
}

/** Distanza da un segmento verticale. */
function distanzaAsta(px: number, py: number): number {
  const { x, y1, y2 } = GEOMETRIA.asta;
  const y = Math.min(Math.max(py, y1), y2);
  return Math.hypot(px - x, py - y);
}

/**
 * Il colore di un punto della tela, dipinto nell'ordine dell'SVG: l'ultimo che
 * copre il punto vince.
 */
function colore(px: number, py: number): Rgb {
  const mezzoTratto = GEOMETRIA.tratto / 2;
  if (distanzaAsta(px, py) <= mezzoTratto || distanzaArco(px, py) <= mezzoTratto) {
    return BIANCO;
  }
  if (distanzaRettangolo(px, py, GEOMETRIA.corpo) <= 0) {
    return ROSSO;
  }
  return FONDO;
}

/**
 * Campioni per lato di ogni pixel. Quattro per quattro fa sedici campioni, cioe'
 * diciassette livelli di copertura sul bordo: a 180 pixel non si distinguono da
 * un bordo vero, e a 1024 il bordo e' comunque un pixel su centinaia. Otto per
 * otto quadruplicherebbe il tempo del test per una differenza che nessuno vede.
 */
const CAMPIONI = 4;

/**
 * I pixel dell'icona, RGB senza alfa, riga per riga.
 *
 * La media dei campioni si fa sui valori sRGB e non in luce lineare: e' cio' che
 * fa la maggior parte dei rasterizzatori per un'icona, e l'unico effetto e' un
 * bordo bianco-su-scuro un filo piu' sottile.
 */
export function pixel(lato: number): Uint8Array {
  const scala = LATO / lato;
  const out = new Uint8Array(lato * lato * 3);
  for (let y = 0; y < lato; y += 1) {
    for (let x = 0; x < lato; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < CAMPIONI; sy += 1) {
        for (let sx = 0; sx < CAMPIONI; sx += 1) {
          const [cr, cg, cb] = colore(
            (x + (sx + 0.5) / CAMPIONI) * scala,
            (y + (sy + 0.5) / CAMPIONI) * scala,
          );
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const n = CAMPIONI * CAMPIONI;
      const i = (y * lato + x) * 3;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Il PNG
// ---------------------------------------------------------------------------

/** Tipo di colore 2 nell'IHDR: RGB, tre canali, nessun alfa. */
const PNG_RGB = 2;

function blocco(tipo: string, dati: Uint8Array): Buffer {
  const lunghezza = Buffer.alloc(4);
  lunghezza.writeUInt32BE(dati.length);
  const corpo = Buffer.concat([Buffer.from(tipo, "latin1"), dati]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([lunghezza, corpo, crc]);
}

/**
 * Un PNG RGB a 8 bit, senza filtri di riga.
 *
 * Senza filtri il file e' piu' grande del necessario — il filtro `Sub` su
 * un'icona a tinte piatte lo dimezzerebbe — ma resta sotto le decine di kB, e
 * un filtro in meno e' un pezzo di codice in meno da sbagliare.
 */
export function png(lato: number): Buffer {
  const rgb = pixel(lato);
  const riga = lato * 3;
  const grezzo = Buffer.alloc((riga + 1) * lato);
  for (let y = 0; y < lato; y += 1) {
    // Il byte 0 di ogni riga e' il filtro: 0, nessuno.
    grezzo.set(rgb.subarray(y * riga, (y + 1) * riga), y * (riga + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lato, 0);
  ihdr.writeUInt32BE(lato, 4);
  ihdr[8] = 8; // bit per canale
  ihdr[9] = PNG_RGB;
  // 10 compressione, 11 filtro, 12 interlacciamento: tutti 0, gia' cosi'.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    blocco("IHDR", ihdr),
    blocco("IDAT", deflateSync(grezzo, { level: 9 })),
    blocco("IEND", new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// I file
// ---------------------------------------------------------------------------

/** Cosa scrive `npm run icone`, e dove. Il test legge la stessa lista. */
export const FILE_PNG = [
  // L'icona dell'App Store, e la sorgente da cui Capacitor ricavera' le altre.
  { nome: "icona-1024.png", lato: 1024 },
  // La schermata Home di iOS, per la PWA.
  { nome: "apple-touch-icon.png", lato: 180 },
] as const;

export const PUBBLICA = resolve(import.meta.dirname, "..", "apps", "web", "public");

function main(): void {
  writeFileSync(join(PUBBLICA, "icona.svg"), svg());
  for (const { nome, lato } of FILE_PNG) {
    writeFileSync(join(PUBBLICA, nome), png(lato));
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}
