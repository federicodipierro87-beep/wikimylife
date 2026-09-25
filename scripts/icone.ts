import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";

/**
 * Le icone, disegnate una volta sola e scritte in ventinove file.
 *
 * `npm run icone` riscrive `apps/web/public/icona.svg`, `icona-1024.png` e
 * `apple-touch-icon.png`, e nel progetto Android le icone di cinque densita' e
 * gli undici splash (l'elenco e' `FILE_PNG`, in fondo). Escono tutti dalla
 * stessa `GEOMETRIA`, e `tests/unit/icone.test.ts` ridisegna tutto e lo
 * confronta con i file in git: cambiare il disegno a mano in uno solo fa cadere
 * quel test.
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
 * Il riquadro che contiene il microfono, tratti compresi, nelle unita' del
 * `viewBox`. Fuori da qui ogni campione e' fondo, e non serve calcolarlo.
 *
 * Ricavato dalla geometria e non scritto a numeri: un ritocco al disegno che lo
 * allargasse senza allargare il riquadro taglierebbe il microfono, e i pixel
 * diversi farebbero cadere il test — ma la causa sarebbe qui, lontana dal
 * ritocco.
 */
const RIQUADRO = {
  x0: GEOMETRIA.arco.cx - GEOMETRIA.arco.raggio - GEOMETRIA.tratto / 2,
  x1: GEOMETRIA.arco.cx + GEOMETRIA.arco.raggio + GEOMETRIA.tratto / 2,
  y0: GEOMETRIA.corpo.y,
  y1: GEOMETRIA.asta.y2 + GEOMETRIA.tratto / 2,
};

/**
 * I pixel di un'immagine `larghezza` per `altezza`, RGB senza alfa, riga per
 * riga, con il disegno a 512 ridotto a un quadrato di lato `disegno` al centro.
 * Tutto cio' che sta fuori da quel quadrato e' fondo: per un'icona il quadrato
 * e' l'immagine intera, per uno splash e' una parte.
 *
 * La media dei campioni si fa sui valori sRGB e non in luce lineare: e' cio' che
 * fa la maggior parte dei rasterizzatori per un'icona, e l'unico effetto e' un
 * bordo bianco-su-scuro un filo piu' sottile.
 *
 * ## La scorciatoia fuori dal riquadro
 *
 * Uno splash da 1920x1280 sono due milioni e mezzo di pixel, e a sedici
 * campioni ciascuno il test impiegherebbe decine di secondi a ridisegnare gli
 * undici splash. Ma il microfono ne occupa una parte piccola: un pixel che non
 * tocca `RIQUADRO` e' fondo senza bisogno di campionarlo, e il risultato e'
 * identico al byte, perche' sedici campioni di fondo fanno fondo.
 */
export function pixel(larghezza: number, altezza = larghezza, disegno = larghezza): Uint8Array {
  const scala = LATO / disegno;
  const ox = (larghezza - disegno) / 2;
  const oy = (altezza - disegno) / 2;
  const out = new Uint8Array(larghezza * altezza * 3);
  const n = CAMPIONI * CAMPIONI;
  for (let y = 0; y < altezza; y += 1) {
    const v0 = (y - oy) * scala;
    const fuoriY = v0 + scala < RIQUADRO.y0 || v0 > RIQUADRO.y1;
    for (let x = 0; x < larghezza; x += 1) {
      const i = (y * larghezza + x) * 3;
      const u0 = (x - ox) * scala;
      if (fuoriY || u0 + scala < RIQUADRO.x0 || u0 > RIQUADRO.x1) {
        out[i] = FONDO[0];
        out[i + 1] = FONDO[1];
        out[i + 2] = FONDO[2];
        continue;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < CAMPIONI; sy += 1) {
        for (let sx = 0; sx < CAMPIONI; sx += 1) {
          const [cr, cg, cb] = colore(
            (x - ox + (sx + 0.5) / CAMPIONI) * scala,
            (y - oy + (sy + 0.5) / CAMPIONI) * scala,
          );
          r += cr;
          g += cg;
          b += cb;
        }
      }
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
export function png(larghezza: number, altezza = larghezza, disegno = larghezza): Buffer {
  const rgb = pixel(larghezza, altezza, disegno);
  const riga = larghezza * 3;
  const grezzo = Buffer.alloc((riga + 1) * altezza);
  for (let y = 0; y < altezza; y += 1) {
    // Il byte 0 di ogni riga e' il filtro: 0, nessuno.
    grezzo.set(rgb.subarray(y * riga, (y + 1) * riga), y * (riga + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(larghezza, 0);
  ihdr.writeUInt32BE(altezza, 4);
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

/** Il colore del fondo in esadecimale, per chi lo deve scrivere altrove (Android). */
export const COLORE_FONDO = esadecimale(FONDO);

export type FilePng = {
  /** Dalla radice del repo, con le barre di Unix. */
  readonly percorso: string;
  readonly larghezza: number;
  readonly altezza: number;
  /** Il lato del quadrato in cui sta il disegno: l'immagine intera per un'icona. */
  readonly disegno: number;
};

function icona(percorso: string, lato: number): FilePng {
  return { percorso, larghezza: lato, altezza: lato, disegno: lato };
}

const RES = "apps/mobile/android/app/src/main/res";

/** Le cinque densita' di Android e il loro moltiplicatore rispetto a mdpi. */
const DENSITA = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
] as const;

/**
 * Le misure degli splash che il progetto generato da Capacitor si porta
 * dietro, in verticale; l'orizzontale e' lo stesso rovesciato. Sono le sue e
 * non scelte qui: si sostituiscono i file che ci sono, non se ne aggiungono.
 */
const SPLASH_VERTICALE: Record<(typeof DENSITA)[number][0], readonly [number, number]> = {
  mdpi: [320, 480],
  hdpi: [480, 800],
  xhdpi: [720, 1280],
  xxhdpi: [960, 1600],
  xxxhdpi: [1280, 1920],
};

/**
 * Lo splash e' fondo con il microfono al centro, in un quadrato grande meta'
 * del lato corto: quanto basta a riconoscerlo, senza che sembri un'icona
 * ingrandita.
 */
function splash(percorso: string, larghezza: number, altezza: number): FilePng {
  return { percorso, larghezza, altezza, disegno: Math.round(Math.min(larghezza, altezza) / 2) };
}

/**
 * Cosa scrive `npm run icone`, e dove. Il test legge la stessa lista.
 *
 * ## Le icone Android
 *
 * - `ic_launcher` e `ic_launcher_round`, 48dp: le usano solo Android 7 e 7.1,
 *   gli unici sotto l'API 26 che il progetto supporta (`minSdkVersion` 24).
 *   Sono quadrati pieni tutte e due: quella tonda vorrebbe gli angoli
 *   trasparenti, e questo script non scrive il canale alfa. Su quei due
 *   sistemi un launcher che chiede l'icona tonda la mostra quadrata.
 * - `ic_launcher_foreground`, 108dp: il primo piano dell'icona adattiva, da
 *   Android 8 in su. Il sistema la ritaglia nella forma che vuole il launcher
 *   e ne mostra con certezza solo il cerchio centrale di 66dp, cioe' il 30,6%
 *   del lato come raggio. Il microfono sta tutto entro 148 unita' dal centro
 *   su 512, il 28,9%: entra cosi' com'e', e un primo piano opaco con lo
 *   stesso fondo dello sfondo e' indistinguibile da uno trasparente.
 */
export const FILE_PNG: readonly FilePng[] = [
  // L'icona dell'App Store, e la sorgente da cui nasceranno quelle di iOS.
  icona("apps/web/public/icona-1024.png", 1024),
  // La schermata Home di iOS, per la PWA.
  icona("apps/web/public/apple-touch-icon.png", 180),
  ...DENSITA.flatMap(([nome, k]) => [
    icona(`${RES}/mipmap-${nome}/ic_launcher.png`, 48 * k),
    icona(`${RES}/mipmap-${nome}/ic_launcher_round.png`, 48 * k),
    icona(`${RES}/mipmap-${nome}/ic_launcher_foreground.png`, 108 * k),
  ]),
  ...DENSITA.flatMap(([nome]) => {
    const [l, a] = SPLASH_VERTICALE[nome];
    return [
      splash(`${RES}/drawable-port-${nome}/splash.png`, l, a),
      splash(`${RES}/drawable-land-${nome}/splash.png`, a, l),
    ];
  }),
  // Il ripiego senza qualificatori, che Capacitor genera orizzontale mdpi.
  splash(`${RES}/drawable/splash.png`, 480, 320),
];

export const ROOT = resolve(import.meta.dirname, "..");
export const PUBBLICA = join(ROOT, "apps", "web", "public");

function main(): void {
  writeFileSync(join(PUBBLICA, "icona.svg"), svg());
  for (const f of FILE_PNG) {
    writeFileSync(join(ROOT, f.percorso), png(f.larghezza, f.altezza, f.disegno));
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}
