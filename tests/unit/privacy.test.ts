import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `privacy.html` nomina ogni terzo a cui il codice manda qualcosa.
 *
 * La pagina e' una promessa fatta a chi usa l'app e ad Apple, che la legge alla
 * revisione. Il modo in cui diventa falsa non e' che qualcuno la riscrive male:
 * e' che qualcuno aggiunge un fornitore — un secondo modello di trascrizione,
 * un servizio di mappe diverso — e la pagina resta com'era. Nessun test cade,
 * il deploy riesce, e l'elenco dei terzi e' incompleto.
 *
 * ## Come si trova un terzo
 *
 * Si cercano gli URL `https://` scritti come inizio di un letterale — dopo una
 * virgoletta, un apice o un backtick — nei sorgenti che girano: API, worker,
 * web e shared, saltando le righe di commento. I commenti ne citano altri (un
 * esempio di origine Netlify in `env.ts`, fra due backtick che somigliano a un
 * letterale), e contarli vorrebbe dire pretendere nella pagina cose che il
 * codice non chiama.
 *
 * Una riga e' di commento se, tolti gli spazi, comincia con `*`, `/*` o `//`.
 * Non si tolgono i commenti a meta' riga: il `//` di `https://` e' dentro ogni
 * URL, e uno stripper ingenuo li cancellerebbe tutti. Il prezzo delle due
 * scelte: un URL costruito a pezzi, senza `https://` in testa a una stringa, o
 * scritto su una riga che comincia come un commento, qui non si vede.
 *
 * Ogni host trovato deve stare in `TERZI`, che dice con che nome la pagina lo
 * chiama. Un host nuovo senza voce fa cadere il caso: e' il punto in cui chi lo
 * ha aggiunto scopre che c'e' una pagina da aggiornare.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const PUBBLICA = join(ROOT, "apps", "web", "public");
const PAGINA = readFileSync(join(PUBBLICA, "privacy.html"), "utf8");

/**
 * La pagina senza i commenti HTML, cioe' cio' che chi la apre legge davvero.
 *
 * Il commento in testa a `privacy.html` cita Nominatim e i file da cui ogni
 * frase e' stata verificata: cercare i nomi nel sorgente intero vorrebbe dire
 * accontentarsi di un terzo nominato solo in un commento, che non lo dice a
 * nessuno. E' successo: una mutazione che toglieva Nominatim dalla tabella e'
 * sopravvissuta per questo.
 */
const VISIBILE = PAGINA.replace(/<!--[\s\S]*?-->/g, "");

const SORGENTI = ["apps/api/src", "apps/worker/src", "apps/web/src", "packages/shared/src"];

/** L'host, e il nome con cui la pagina deve chiamarlo. */
const TERZI: Record<string, string> = {
  "api.openai.com": "OpenAI",
  "api.anthropic.com": "Anthropic",
  "nominatim.openstreetmap.org": "Nominatim",
  // Il ripiego di `S3StorageProvider` quando manca un endpoint: AWS. In
  // produzione l'endpoint c'e' ed e' il bucket di Railway, ed e' Railway che la
  // pagina deve nominare. Se un giorno il bucket passasse davvero ad AWS, questa
  // riga e la pagina andrebbero cambiate insieme — e nessun test lo saprebbe,
  // perche' l'endpoint vero sta in un pannello e non nel codice.
  "s3.": "Railway",
};

function file(cartella: string): string[] {
  const out: string[] = [];
  for (const voce of readdirSync(cartella)) {
    const percorso = join(cartella, voce);
    if (statSync(percorso).isDirectory()) {
      out.push(...file(percorso));
    } else if (/\.tsx?$/.test(voce)) {
      out.push(percorso);
    }
  }
  return out;
}

/** Gli host degli URL che aprono un letterale. Vedi «## Come si trova un terzo». */
function hostChiamati(testo: string): string[] {
  return testo
    .split(/\r?\n/)
    .filter((riga) => !/^\s*(\*|\/\*|\/\/)/.test(riga))
    .flatMap((riga) =>
      [...riga.matchAll(/["'`]https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1] ?? ""),
    );
}

const TROVATI = new Map<string, string>();
for (const cartella of SORGENTI) {
  for (const percorso of file(join(ROOT, cartella))) {
    for (const host of hostChiamati(readFileSync(percorso, "utf8"))) {
      TROVATI.set(host, relative(ROOT, percorso).split(sep).join("/"));
    }
  }
}

describe("privacy.html nomina i terzi", () => {
  it("ogni host che il codice chiama ha una voce in TERZI", () => {
    const senzaVoce = [...TROVATI].filter(([host]) => !(host in TERZI));
    expect(senzaVoce).toEqual([]);
  });

  it.each(Object.entries(TERZI))("%s compare nella pagina come %s", (_host, nome) => {
    expect(VISIBILE).toContain(nome);
  });

  it("nomina anche Netlify, che nessun sorgente chiama perche' e' lui a servirli", () => {
    // Il terzo che la scansione non puo' trovare: non e' una chiamata del
    // codice, e' l'hosting delle pagine. Vede l'IP di chiunque apra l'app.
    expect(VISIBILE).toContain("Netlify");
  });
});

describe("la scansione trova qualcosa", () => {
  // Il caso opposto: una scansione rotta trova zero host, e zero host non
  // hanno nessuna voce mancante.
  it("trova i quattro fornitori dove stanno", () => {
    expect(TROVATI.get("api.openai.com")).toMatch(/^apps\/api\/src\/providers\//);
    expect(TROVATI.get("api.anthropic.com")).toMatch(/^apps\/api\/src\/providers\//);
    expect(TROVATI.get("nominatim.openstreetmap.org")).toBe(
      "apps/web/src/recording/GeolocationAdapter.ts",
    );
    expect(TROVATI.has("s3.")).toBe(true);
  });

  it("legge i letterali e salta gli URL citati in mezzo a una frase", () => {
    expect(hostChiamati('const A = "https://uno.it/x";')).toEqual(["uno.it"]);
    expect(hostChiamati("const B = `https://due.it/${x}`;")).toEqual(["due.it"]);
    expect(hostChiamati(" * es. https://tre.it, in un commento")).toEqual([]);
    // Il caso che ha fatto nascere il filtro: backtick di Markdown in un JSDoc.
    expect(hostChiamati(" * `https://quattro.it/` con la barra")).toEqual([]);
    expect(hostChiamati('  // const C = "https://cinque.it";')).toEqual([]);
  });
});

describe("privacy.html sotto la CSP", () => {
  // `style-src 'self'` e `script-src 'self'` senza 'unsafe-inline': uno stile
  // o uno script dentro la pagina verrebbero scartati senza nessun errore
  // visibile se non nella console.
  it("non ha stili ne' script dentro la pagina", () => {
    // Senza commenti: quello in testa alla pagina spiega proprio perche' non
    // c'e' un `<style>`, e nominarlo non e' usarlo.
    expect(VISIBILE).not.toMatch(/<style|<script|\sstyle=/i);
    expect(VISIBILE).toContain('<link rel="stylesheet"');
  });

  it("i file che richiama esistono in public/", () => {
    const locali = [...PAGINA.matchAll(/(?:href|src)="\/([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(locali).toContain("privacy.css");
    expect(locali.filter((nome) => !existsSync(join(PUBBLICA, nome)))).toEqual([]);
  });
});

describe("privacy.html e la regola degli accenti", () => {
  it("scrive gli accenti come entita', non come caratteri", () => {
    // La regola del repo: niente accenti fuori dal Markdown. In HTML le
    // entita' li mostrano giusti senza metterli nel sorgente.
    const righe = PAGINA.split(/\r?\n/).filter((riga) => /[^\x00-\x7f]/.test(riga));
    expect(righe).toEqual([]);
    expect(PAGINA).toContain("&egrave;");
  });
});

describe("il collegamento dall'app", () => {
  it("punta a un file che il deploy pubblica", () => {
    // `tests/web` non ha `fs` e non puo' guardare `public/`: il legame fra
    // l'indirizzo nel componente e il file vero si prova qui, leggendo il
    // sorgente. Un `privacy.html` rinominato darebbe un 404 dentro l'app, e
    // nessun caso web se ne accorgerebbe perche' jsdom non segue i link.
    const sorgente = readFileSync(join(ROOT, "apps/web/src/screens/Privacy.tsx"), "utf8");
    const indirizzo = /INDIRIZZO_PRIVACY = "\/([^"]+)"/.exec(sorgente)?.[1];
    expect(indirizzo).toBe("privacy.html");
    expect(existsSync(join(PUBBLICA, indirizzo ?? "inesistente"))).toBe(true);
  });
});
