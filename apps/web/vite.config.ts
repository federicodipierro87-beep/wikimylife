import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  optimizeDeps: {
    /**
     * `@wikimylife/shared` e' un workspace collegato via symlink, non un
     * pacchetto pubblicato. Senza questa esclusione esbuild lo pre-bundla e le
     * modifiche fatte in `packages/shared` durante `tsc -b --watch` non si
     * vedono finche' non si svuota la cache a mano.
     *
     * E' anche il motivo per cui non serve alcun alias ne' `tsconfig-paths`:
     * la risoluzione avviene per node_modules, esattamente come in produzione.
     */
    exclude: ["@wikimylife/shared"],
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
