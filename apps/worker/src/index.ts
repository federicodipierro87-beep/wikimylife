import { loadConfig } from "@wikimylife/api/config";
import { createLogger } from "@wikimylife/api/logger";
import { compose } from "@wikimylife/api";

/**
 * Il worker: prende le registrazioni in attesa e le porta a scheda.
 *
 * E' un secondo servizio Railway dallo stesso repo e sullo stesso database, non
 * un thread dentro l'API: l'elaborazione di un vocale dura decine di secondi
 * fra due chiamate a modelli, e non deve competere con le richieste degli
 * utenti ne' morire con un redeploy dell'API.
 *
 * LA CODA E' UNA TABELLA. Non c'e' Redis, e nemmeno una tabella `Job`: la coda
 * e' `Recording.status` con il suo indice [D3]. Un job qui e' sempre e solo
 * "questa registrazione va elaborata", il suo stato e' gia' una colonna che
 * serve anche a rispondere a `GET /api/recordings/:id`, e una tabella separata
 * introdurrebbe soltanto il rischio che i due stati divergano.
 *
 * DUE WORKER NON SI PESTANO. `claimNext` e' un compare-and-swap
 * (`UPDATE ... WHERE status = 'BOZZA_AUDIO'` e si guarda il conteggio): chi
 * perde la corsa riceve `null` e passa oltre. E' la stessa proprieta' che
 * rende sicuro scalare a due repliche senza toccare una riga di questo file.
 *
 * `compose` e non un cablaggio a mano: cosi' il worker usa esattamente gli
 * stessi provider e lo stesso repository dell'API. Due composizioni separate
 * vorrebbero dire poter trascrivere con Whisper in un processo e con il fake
 * nell'altro, e accorgersene dai dati.
 */

const POLL_INTERVAL_MS = 5_000;

/**
 * Quanti job di fila prima di tornare a dormire.
 *
 * Serve a svuotare un arretrato senza aspettare cinque secondi per ognuno, e a
 * non restare bloccati per sempre in un ciclo che ignora SIGTERM.
 */
const MAX_BATCH = 10;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    bindings: { service: "worker" },
  });
  const composition = compose(config, { logger });

  logger.info("worker avviato", {
    nodeEnv: config.nodeEnv,
    pollIntervalMs: POLL_INTERVAL_MS,
    providers: {
      transcription: composition.providers.transcription.name,
      extraction: composition.providers.extraction.name,
      storage: composition.providers.storage.name,
      embedding: composition.providers.embedding.name,
    },
  });

  let running = true;
  const shutdown = (signal: string): void => {
    if (!running) {
      return;
    }
    running = false;
    // Non si interrompe il job in corso: e' a meta' fra due chiamate a modelli
    // gia' pagate, e la riga tornerebbe in coda per essere rifatta da capo.
    logger.info("arresto richiesto, termino il lavoro in corso", { signal });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  while (running) {
    let processed = 0;
    try {
      while (running && processed < MAX_BATCH) {
        const outcome = await composition.ingestionService.processNext();
        if (outcome === null) {
          break;
        }
        processed += 1;
        logger.info("registrazione elaborata", {
          recordingId: outcome.recordingId,
          esito: outcome.kind,
        });
      }
    } catch (error) {
      // La pipeline non lancia: scrive l'esito sulla riga e restituisce un
      // valore. Se si arriva qui e' il database a essere irraggiungibile, e
      // l'unica cosa sensata e' aspettare il prossimo giro.
      logger.error("giro di elaborazione interrotto", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (running && processed === 0) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  await composition.shutdown();
  logger.info("worker terminato");
}

await main();
