import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * I file di deploy, letti da un test invece che da una piattaforma.
 *
 * `netlify.toml` e i due `railway.toml` sono documentazione eseguibile da
 * qualcun altro: nessun comando di questo repository li apre, quindi un refuso
 * dentro `startCommand` o un `healthcheckPath` che non esiste si scoprono al
 * primo deploy — e si scoprono male, perche' il build risulta riuscito e il
 * servizio non riceve traffico. La CI prova i comandi di build; non prova i
 * file che li invocano.
 *
 * Cio' che si puo' verificare da qui e' preciso e limitato: che ogni nome
 * citato esista davvero da questa parte. Non che Railway lo interpreti come
 * pensiamo — quello lo dice solo Railway.
 *
 * ## Perche' non un parser TOML
 *
 * Servirebbe una dipendenza per leggere tre file di cinquanta righe scritti da
 * noi, con la forma che vogliamo noi. Le funzioni qui sotto ne coprono il
 * sottoinsieme che serve, e l'ultimo `describe` verifica che stiano leggendo
 * qualcosa: un estrattore rotto restituisce liste vuote, e una lista vuota
 * supera qualunque asserzione «tutti gli elementi sono validi».
 */

const ROOT = resolve(import.meta.dirname, "..", "..");

function leggi(percorso: string): string {
  return readFileSync(join(ROOT, percorso), "utf8");
}

/**
 * Toglie i commenti `#`, rispettando le virgolette.
 *
 * Ingenuamente si taglierebbe a ogni `#`, e la `Content-Security-Policy` di
 * Netlify non ne contiene — oggi. Il giorno che ne contenesse uno, il taglio
 * ingenuo accorcerebbe la direttiva in silenzio e il test continuerebbe a
 * passare su una stringa monca.
 */
function senzaCommenti(testo: string): string {
  return testo
    .split(/\r?\n/)
    .map((riga) => {
      let virgolette = false;
      for (let i = 0; i < riga.length; i += 1) {
        const ch = riga[i];
        if (ch === '"') {
          virgolette = !virgolette;
        } else if (ch === "#" && !virgolette) {
          return riga.slice(0, i);
        }
      }
      return riga;
    })
    .join("\n");
}

/**
 * Le assegnazioni `chiave = "valore"`, raccolte per chiave.
 *
 * Multimappa e non mappa: in `netlify.toml` `for` e `Cache-Control` compaiono
 * in piu' blocchi `[[headers]]`, e tenere solo l'ultimo vorrebbe dire non
 * controllare gli altri.
 */
function scalari(testo: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const riga of senzaCommenti(testo).split("\n")) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(riga);
    if (m !== null) {
      const [, chiave = "", valore = ""] = m;
      out.set(chiave, [...(out.get(chiave) ?? []), valore]);
    }
  }
  return out;
}

/** Il primo valore di una chiave, o `null`. Comodo dove la chiave e' unica. */
function scalare(testo: string, chiave: string): string | null {
  return scalari(testo).get(chiave)?.[0] ?? null;
}

/** Un array di stringhe su piu' righe, come `watchPatterns`. */
function elenco(testo: string, chiave: string): string[] | null {
  const pulito = senzaCommenti(testo);
  const inizio = pulito.indexOf(`${chiave} = [`);
  if (inizio < 0) {
    return null;
  }
  const fine = pulito.indexOf("]", inizio);
  if (fine < 0) {
    return null;
  }
  return [...pulito.slice(inizio, fine).matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
}

/** Ogni `npm run <nome>` che la piattaforma eseguirebbe davvero. */
function comandiNpm(testo: string): string[] {
  return [...senzaCommenti(testo).matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1] ?? "");
}

const NETLIFY = leggi("netlify.toml");
const RAILWAY_API = leggi("apps/api/railway.toml");
const RAILWAY_WORKER = leggi("apps/worker/railway.toml");
const CI = leggi(".github/workflows/ci.yml");

const SCRIPTS = Object.keys(
  (JSON.parse(leggi("package.json")) as { scripts: Record<string, string> }).scripts,
);

function script(nome: string): string {
  const valore = (JSON.parse(leggi("package.json")) as { scripts: Record<string, string> }).scripts[
    nome
  ];
  if (valore === undefined) {
    throw new Error(`script inesistente: ${nome}`);
  }
  return valore;
}

describe("i comandi citati esistono", () => {
  it.each([
    ["netlify.toml", NETLIFY],
    ["apps/api/railway.toml", RAILWAY_API],
    ["apps/worker/railway.toml", RAILWAY_WORKER],
    [".github/workflows/ci.yml", CI],
  ])("%s non invoca script inesistenti", (_nome, testo) => {
    // Rinominare uno script in package.json e' un'operazione che sembra
    // interna: il compilatore non se ne accorge, i test nemmeno, e il deploy
    // muore su `Missing script`.
    const mancanti = comandiNpm(testo).filter((c) => !SCRIPTS.includes(c));
    expect(mancanti).toEqual([]);
  });

  it("i tre build della CI sono quelli delle piattaforme", () => {
    // La CI serve a scoprire un build rotto prima del deploy: se i comandi
    // divergono, prova qualcos'altro e la rassicurazione e' falsa.
    const inCi = new Set(comandiNpm(CI));
    for (const testo of [NETLIFY, RAILWAY_API, RAILWAY_WORKER]) {
      const build = scalare(testo, "buildCommand") ?? scalare(testo, "command") ?? "";
      for (const comando of comandiNpm(build)) {
        expect(inCi).toContain(comando);
      }
    }
  });
});

describe("cio' che si avvia e' cio' che si costruisce", () => {
  it.each([
    ["start:api", "apps/api"],
    ["start:worker", "apps/worker"],
  ])("%s lancia un file che quel build produce", (nome, app) => {
    const comando = script(nome);
    const m = /node ([A-Za-z0-9/_.-]+\.js)/.exec(comando);
    expect(m).not.toBeNull();
    const compilato = m?.[1] ?? "";

    // `dist/index.js` esiste solo dopo il build, quindi non lo si puo'
    // cercare: cio' che si controlla e' il sorgente da cui verra', passando
    // per le due opzioni del tsconfig che decidono la corrispondenza. Se un
    // giorno `outDir` cambiasse, questo test fallisce invece di continuare a
    // guardare un percorso che non esiste piu'.
    const tsconfig = JSON.parse(leggi(`${app}/tsconfig.json`)) as {
      compilerOptions: { outDir: string; rootDir: string };
    };
    expect(tsconfig.compilerOptions.outDir).toBe("./dist");
    expect(tsconfig.compilerOptions.rootDir).toBe("./src");

    const sorgente = compilato.replace("/dist/", "/src/").replace(/\.js$/, ".ts");
    expect(existsSync(join(ROOT, sorgente))).toBe(true);
  });

  it("start:api applica le migration e start:worker no", () => {
    // Due processi che fanno `migrate deploy` insieme si contendono
    // `_prisma_migrations`, e chi perde muore all'avvio. E' scritto nei
    // commenti dei due file; qui e' un'asserzione.
    expect(script("start:api")).toContain("prisma migrate deploy");
    expect(script("start:worker")).not.toContain("migrate");
  });
});

describe("lo health check di Railway", () => {
  it("punta a una rotta che l'API espone", () => {
    const percorso = scalare(RAILWAY_API, "healthcheckPath");
    expect(percorso).not.toBeNull();

    // Railway manda traffico alla versione nuova solo quando questa risponde
    // qui. Un refuso non rompe niente in modo visibile: il deploy resta
    // «in corso» finche' non scade, e poi torna indietro.
    const rotte = leggi("apps/api/src/routes/health.routes.ts");
    expect(rotte).toContain(`router.get("${String(percorso)}"`);
  });

  it("il worker non ne dichiara nessuno", () => {
    // Il worker non ascolta su nessuna porta: Railway aspetterebbe una
    // risposta HTTP che non arriva mai e dichiarerebbe fallito un deploy
    // riuscito.
    expect(scalare(RAILWAY_WORKER, "healthcheckPath")).toBeNull();
  });
});

describe("i watchPatterns", () => {
  it.each([
    ["apps/api/railway.toml", RAILWAY_API],
    ["apps/worker/railway.toml", RAILWAY_WORKER],
  ])("%s guarda cartelle che esistono", (_nome, testo) => {
    const patterns = elenco(testo, "watchPatterns") ?? [];
    expect(patterns.length).toBeGreaterThan(0);

    // Un refuso qui non produce nessun errore: il servizio semplicemente non
    // riparte piu', per sempre, e il sintomo e' «il deploy non prende le
    // modifiche» settimane dopo.
    const inesistenti = patterns.filter((p) => {
      const base = p.replace(/\/?\*\*?.*$/, "");
      return base !== "" && !existsSync(join(ROOT, base));
    });
    expect(inesistenti).toEqual([]);
  });

  it("il worker guarda anche l'API, da cui dipende", () => {
    // `apps/worker/src/index.ts` importa `@wikimylife/api`: una correzione
    // nell'ingestione, che vive li', non arriverebbe mai al processo che la
    // esegue.
    expect(leggi("apps/worker/src/index.ts")).toContain("@wikimylife/api");
    expect(elenco(RAILWAY_WORKER, "watchPatterns")).toContain("apps/api/**");
  });

  it("entrambi guardano shared e il lockfile", () => {
    for (const testo of [RAILWAY_API, RAILWAY_WORKER]) {
      const patterns = elenco(testo, "watchPatterns") ?? [];
      expect(patterns).toContain("packages/shared/**");
      expect(patterns).toContain("package-lock.json");
    }
  });
});

describe("netlify", () => {
  it("pubblica la cartella che Vite scrive", () => {
    const base = scalare(NETLIFY, "base");
    const publish = scalare(NETLIFY, "publish");
    const outDir = /outDir:\s*"([^"]+)"/.exec(leggi("apps/web/vite.config.ts"))?.[1];

    expect(outDir).not.toBeUndefined();
    // Le due parti stanno in file diversi e nessuno le confronta: se non
    // combaciano il deploy riesce e pubblica una cartella vuota, cioe' un 404
    // su tutto.
    expect(join(base ?? "", publish ?? "")).toBe(join("apps/web", outDir ?? ""));
  });

  it("intesta solo file che esistono", () => {
    const percorsi = (scalari(NETLIFY).get("for") ?? []).filter((p) => !p.includes("*"));
    expect(percorsi.length).toBeGreaterThan(0);

    // `sw.js` con `Cache-Control: no-cache` e' cio' che fa arrivare gli
    // aggiornamenti della PWA. Se il file cambiasse nome, l'intestazione
    // resterebbe su un percorso morto e nessuno se ne accorgerebbe: il deploy
    // riesce, l'app smette solo di aggiornarsi.
    const mancanti = percorsi.filter((p) => {
      const nome = p.replace(/^\//, "");
      return (
        !existsSync(join(ROOT, "apps/web/public", nome)) && !existsSync(join(ROOT, "apps/web", nome))
      );
    });
    expect(mancanti).toEqual([]);
  });

  it("la CSP non concede unsafe-inline ne' unsafe-eval", () => {
    // La build non contiene un solo script o stile inline, ed e' fragile: la
    // concessione si aggiunge in un secondo per far sparire un errore di
    // console, e non si toglie piu'.
    const csp = scalare(NETLIFY, "Content-Security-Policy") ?? "";
    expect(csp).not.toBe("");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("la CSP lascia passare i blob, che servono al player", () => {
    // Il player scarica l'audio con `fetch` — quell'URL vuole un header
    // Authorization che un `src` non puo' portare — e lo passa a `<audio>` come
    // object URL. Senza `blob:` la riproduzione si rompe e il motivo compare
    // solo nella console.
    expect(scalare(NETLIFY, "Content-Security-Policy") ?? "").toContain("media-src 'self' blob:");
  });

  it("usa la stessa versione di Node del resto", () => {
    // La CI legge `.nvmrc` apposta per non avere il numero in due posti;
    // Netlify non sa leggerlo, quindi il numero e' in due posti lo stesso.
    // Questa e' l'unica cosa che li tiene insieme.
    expect(scalare(NETLIFY, "NODE_VERSION")).toBe(leggi(".nvmrc").trim());
  });
});

describe("la guardia funziona", () => {
  /**
   * Ogni asserzione qui sopra ha la forma «tutti gli elementi di questa lista
   * sono validi», e una lista vuota le supera tutte. Se un estrattore smettesse
   * di leggere — un formato cambiato, un percorso sbagliato — l'intero file
   * diventerebbe verde e inutile senza dirlo.
   */
  it("scalari legge le assegnazioni, anche indentate e ripetute", () => {
    expect(scalare(NETLIFY, "publish")).toBe("apps/web/dist");
    expect(scalare(RAILWAY_API, "startCommand")).toBe("npm run start:api");
    expect((scalari(NETLIFY).get("for") ?? []).length).toBeGreaterThan(3);
  });

  it("elenco legge un array su piu' righe", () => {
    expect((elenco(RAILWAY_API, "watchPatterns") ?? []).length).toBeGreaterThan(3);
    expect(elenco(RAILWAY_API, "chiaveInesistente")).toBeNull();
  });

  it("comandiNpm trova i comandi dove ci sono", () => {
    expect(comandiNpm(NETLIFY)).toContain("build:web");
    expect(comandiNpm(RAILWAY_WORKER)).toContain("start:worker");
  });

  it("senzaCommenti taglia i commenti e non le virgolette", () => {
    expect(senzaCommenti('a = "b" # nota').trim()).toBe('a = "b"');
    // Il caso per cui la funzione esiste invece di essere uno `split("#")`.
    expect(senzaCommenti('csp = "img-src #hash"').trim()).toBe('csp = "img-src #hash"');
    expect(senzaCommenti("# tutta commento").trim()).toBe("");
  });

  it("comandiNpm ignora i comandi nominati nei commenti", () => {
    // I due `railway.toml` spiegano nei commenti cosa fanno gli script che
    // invocano. Contarli non sarebbe sbagliato — esistono — ma il test parla
    // di cio' che la piattaforma esegue, e deve leggere solo quello.
    expect(comandiNpm("# npm run inventato\nstartCommand = \"npm run vero\"")).toEqual(["vero"]);
  });
});
