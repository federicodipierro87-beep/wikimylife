import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Esegue un CLI di `node_modules` senza passare da `npx`.
 *
 * Da Node 20 `spawnSync` rifiuta i file `.cmd` senza `shell: true` — e' la
 * mitigazione di CVE-2024-27980, e su Windows `npx` e' esattamente un `.cmd`.
 * La soluzione ovvia (`shell: true`) reintrodurrebbe l'interprete di comandi
 * fra noi e il processo figlio, cioe' proprio la cosa che quella mitigazione
 * toglie: qui passano URL di database, che contengono `&` e `?`.
 *
 * Quindi si risolve il vero entry point JavaScript del pacchetto e lo si esegue
 * con l'eseguibile di Node corrente. Nessuna shell, nessun `.cmd`, e in piu'
 * la certezza di usare la versione installata nel workspace invece di
 * qualunque cosa `npx` deciderebbe di scaricare.
 */

const require = createRequire(import.meta.url);

function resolveBin(pkg: string, binName: string): string {
  const manifestPath = require.resolve(`${pkg}/package.json`);
  const manifest = require(manifestPath) as { bin?: string | Record<string, string> };
  const bin = manifest.bin;
  const relative = typeof bin === "string" ? bin : bin?.[binName];

  if (relative === undefined) {
    throw new Error(`Il pacchetto ${pkg} non dichiara un bin ${binName}.`);
  }
  return path.resolve(path.dirname(manifestPath), relative);
}

export function runNodeBin(
  pkg: string,
  binName: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): void {
  execFileSync(process.execPath, [resolveBin(pkg, binName), ...args], {
    env,
    stdio: "inherit",
  });
}
