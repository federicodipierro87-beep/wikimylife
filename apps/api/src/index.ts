import { ConfigError, loadConfig } from "./config/env.js";
import { compose } from "./composition.js";
import { createLogger } from "./logger.js";

/**
 * Punto di ingresso del processo. L'unico file che chiama `listen`.
 */

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Prima che esista un logger: la configurazione e' rotta, quindi anche il
      // livello di log lo sarebbe.
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const composition = compose(config);
  const { logger, app } = composition;

  const server = app.listen(config.port, () => {
    logger.info("api in ascolto", {
      port: config.port,
      nodeEnv: config.nodeEnv,
      signupEnabled: config.auth.signupEnabled,
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("arresto in corso", { signal });

    server.close(() => {
      void composition.shutdown().then(() => {
        process.exit(0);
      });
    });

    // Railway manda SIGKILL dopo qualche secondo: meglio uscire da soli con un
    // codice sensato che farsi terminare a meta' di una transazione.
    setTimeout(() => {
      logger.warn("arresto forzato: connessioni ancora aperte");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

await main();
