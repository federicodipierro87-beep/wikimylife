import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Le tre regole che nessun compilatore fa rispettare, verificate leggendo i
 * sorgenti.
 *
 * Perche' non ESLint: qui servono esattamente tre regole, due delle quali
 * (l'allowlist di `process.env`, i global vietati in shared) sarebbero comunque
 * custom. ESLint + typescript-eslint costano circa 40 MB di dipendenze, una
 * configurazione da mantenere e un secondo comando da ricordare. Questo file
 * costa un test che gira dentro `npm test`.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const SELF = resolve(import.meta.dirname, "guards.test.ts");

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  ".tsbuild",
  ".git",
  "migrations",
  "generated",
]);

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) {
        out.push(...collectSources(full));
      }
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Sostituisce i commenti con spazi, conservando le andate a capo.
 *
 * Non e' un vezzo: senza questo passaggio la guardia si punta contro se' stessa.
 * `packages/shared/src/adapters/recorder.ts` spiega nel proprio commento perche'
 * `MediaRecorder` sta in `apps/web` e non li'; `apps/api/src/db/client.ts`
 * documenta che l'URL NON arriva da `process.env`. Sono esattamente le frasi
 * che si vogliono trovare scritte, e una guardia che le vieta insegna solo a
 * non scrivere piu' commenti.
 *
 * Uno scanner e non una regex, perche' una regex taglierebbe
 * `"seed://audio/orfano.m4a"` a meta'. Le stringhe vanno attraversate, non
 * saltate. (Un `//` dentro un letterale regex confonderebbe ancora lo scanner;
 * nel repository non ce ne sono, e il costo di gestirlo non vale il caso.)
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  const blank = (ch: string): string => (ch === "\n" ? "\n" : ch === "\r" ? "\r" : " ");

  while (i < source.length) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out.push(blank(source[i] ?? ""));
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(blank(source[i] ?? ""));
        i += 1;
      }
      out.push("  ");
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out.push(ch);
      i += 1;
      while (i < source.length) {
        const c = source[i] ?? "";
        out.push(c);
        i += 1;
        if (c === "\\") {
          out.push(source[i] ?? "");
          i += 1;
          continue;
        }
        if (c === quote) {
          break;
        }
      }
      continue;
    }

    out.push(ch);
    i += 1;
  }

  return out.join("");
}

function read(file: string): { path: string; text: string; lines: string[] } {
  const text = stripComments(readFileSync(file, "utf8"));
  return { path: relative(ROOT, file).split(sep).join("/"), text, lines: text.split(/\r?\n/) };
}

function repoSources(): ReturnType<typeof read>[] {
  return [
    ...collectSources(join(ROOT, "packages")),
    ...collectSources(join(ROOT, "apps")),
    ...collectSources(join(ROOT, "prisma")),
    ...collectSources(join(ROOT, "tests")),
  ]
    .filter((f) => resolve(f) !== SELF)
    .map(read);
}

function sharedSources(): ReturnType<typeof read>[] {
  return collectSources(join(ROOT, "packages", "shared", "src")).map(read);
}

/** Righe di sole importazioni escluse: i falsi positivi vengono quasi tutti da li'. */
function offendingLines(
  files: readonly ReturnType<typeof read>[],
  pattern: RegExp,
): string[] {
  const found: string[] = [];
  for (const file of files) {
    file.lines.forEach((line, index) => {
      // La regex ha il flag g in alcuni casi: azzerare lastIndex e' obbligatorio.
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        found.push(`${file.path}:${String(index + 1)}  ${line.trim()}`);
      }
    });
  }
  return found;
}

describe("guardia: isomorfismo di packages/shared", () => {
  /**
   * Serve davvero, e il motivo e' sottile: `packages/shared/tsconfig.json` ha
   * `types: []`, quindi `process` e `Buffer` non compilano — bene. Ma `lib`
   * DEVE includere `DOM`, altrimenti mancano i tipi di `fetch`, che il client
   * API usa. E `DOM` porta con se' `document`, `window`, `localStorage`: il
   * compilatore li ACCETTEREBBE. In React Native esploderebbero a runtime.
   *
   * Confini di parola nel pattern: la specifica e' in italiano e "DOCUMENTO",
   * "documento", "navigatore" comparirebbero come falsi positivi.
   */
  const BROWSER_GLOBALS =
    /\b(?:window|document|localStorage|sessionStorage|navigator|indexedDB|MediaRecorder|alert)\b/;

  it("non usa nessun global del browser", () => {
    expect(offendingLines(sharedSources(), BROWSER_GLOBALS)).toEqual([]);
  });

  const NODE_ONLY = /\b(?:process|Buffer|__dirname|__filename)\b|["']node:|\brequire\s*\(/;

  it("non usa nessun global o modulo di Node", () => {
    expect(offendingLines(sharedSources(), NODE_ONLY)).toEqual([]);
  });

  it("dipende solo da zod", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "packages", "shared", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    // Una dipendenza in piu' qui e' il modo piu' probabile in cui shared
    // smettera' di essere consumabile da React Native, e succederebbe in
    // silenzio: `npm install` non avvisa.
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["zod"]);
  });

  it("non importa @prisma/client", () => {
    // Gli enum di shared sono const object scritti a mano, non riesportati da
    // Prisma. La parita' con lo schema e' garantita a compilazione da
    // apps/api/src/db/enum-parity.ts, che costa zero a runtime — mentre un
    // import di @prisma/client in shared trascinerebbe il client generato
    // dentro il bundle mobile.
    expect(offendingLines(sharedSources(), /@prisma\/client/)).toEqual([]);
  });
});

describe("guardia: divieto di any esplicito", () => {
  it("nessun any su tutto il repository", () => {
    // `: any`, `as any`, `<any>`, `any[]`. Un `any` esplicito annulla di fatto
    // tutte le opzioni strict del tsconfig nel punto in cui compare, e non
    // lascia traccia in nessun output del compilatore.
    const ANY = /(?::\s*any\b)|(?:\bas\s+any\b)|(?:<\s*any\s*>)|(?:\bany\[\])/;
    expect(offendingLines(repoSources(), ANY)).toEqual([]);
  });
});

describe("guardia: process.env centralizzato", () => {
  /**
   * L'allowlist e' corta di proposito. Una `process.env.QUALCOSA` sparsa in un
   * servizio e' una configurazione che non compare nello schema Zod di
   * `config/env.ts`, quindi non viene validata all'avvio, quindi si scopre
   * mancante in produzione — con un `undefined` che diventa la stringa
   * "undefined" da qualche parte.
   */
  const ALLOWED = new Set([
    "apps/api/src/config/env.ts",
    "prisma/seed/config.ts",
    "prisma.config.ts",
  ]);

  it("solo i file autorizzati leggono process.env", () => {
    const files = repoSources().filter(
      (f) => !ALLOWED.has(f.path) && !f.path.startsWith("tests/"),
    );
    expect(offendingLines(files, /process\.env\b/)).toEqual([]);
  });

  it("solo i file autorizzati chiamano process.loadEnvFile", () => {
    const files = repoSources().filter(
      (f) => !ALLOWED.has(f.path) && !f.path.startsWith("tests/"),
    );
    expect(offendingLines(files, /loadEnvFile/)).toEqual([]);
  });
});

describe("guardia: la guardia funziona", () => {
  /**
   * Un test che cerca stringhe passa anche quando non sta leggendo niente:
   * basta un percorso sbagliato e `[]` e' sempre vuoto. Queste due asserzioni
   * verificano che il collettore veda dei file e che il pattern sappia trovare
   * qualcosa quando c'e' davvero.
   */
  it("raccoglie i sorgenti attesi", () => {
    const paths = repoSources().map((f) => f.path);
    expect(paths.length).toBeGreaterThan(30);
    expect(paths).toContain("packages/shared/src/enums.ts");
    expect(paths).toContain("apps/api/src/services/auth.service.ts");
    expect(paths).toContain("prisma/seed.ts");
    expect(paths).not.toContain("tests/unit/guards.test.ts");
  });

  it("stripComments toglie i commenti e non tocca le stringhe", () => {
    // Se stripComments cancellasse troppo, ogni guardia passerebbe sempre.
    expect(stripComments('const a = "x"; // process.env.SEGRETO').trim()).toBe(
      'const a = "x";',
    );
    expect(stripComments('const u = "seed://audio/x.m4a";')).toBe(
      'const u = "seed://audio/x.m4a";',
    );
    expect(stripComments("const b = process.env.PORT;")).toBe("const b = process.env.PORT;");
  });

  it("stripComments conserva i numeri di riga", () => {
    expect(stripComments("uno\n/* due\ntre */\nquattro").split("\n")).toHaveLength(4);
  });

  it("trova process.env dove c'e' davvero", () => {
    const env = repoSources().filter((f) => f.path === "apps/api/src/config/env.ts");
    expect(env).toHaveLength(1);
    expect(offendingLines(env, /process\.env\b/).length).toBeGreaterThan(0);
  });
});
