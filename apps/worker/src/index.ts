import { loadConfig } from "@wikimylife/api/config";
import { createPrismaClient } from "@wikimylife/api/db";
import { createLogger } from "@wikimylife/api/logger";
import { RecordingStatus } from "@wikimylife/shared";

/**
 * Scheletro del worker.
 *
 * E' un secondo servizio Railway che gira dallo stesso repo e condivide il
 * database, non un thread dentro l'API: l'elaborazione di un vocale puo' durare
 * decine di secondi e non deve competere con le richieste degli utenti.
 *
 * In Fase 1 non elabora nulla. Fa tre cose che vale la pena avere gia' adesso:
 * dimostra che la configurazione e il client Prisma sono riusabili da un
 * secondo processo, conta il lavoro in attesa con l'indice `Recording_status_idx`
 * previsto dalla deviazione [D3], e gestisce SIGTERM.
 *
 * In Fase 2 il ciclo diventa: prendi i Recording in BOZZA_AUDIO, portali a
 * IN_ELABORAZIONE, trascrivi, estrai, valida, persisti.
 */

const POLL_INTERVAL_MS = 5_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    bindings: { service: "worker" },
  });

  const prisma = createPrismaClient({ databaseUrl: config.databaseUrl });

  logger.info("worker avviato", {
    nodeEnv: config.nodeEnv,
    pollIntervalMs: POLL_INTERVAL_MS,
    providers: {
      transcription: config.providers.transcription,
      extraction: config.providers.extraction,
    },
  });

  let running = true;

  const shutdown = (signal: string): void => {
    if (!running) {
      return;
    }
    running = false;
    logger.info("arresto in corso", { signal });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  while (running) {
    try {
      const pending = await prisma.recording.count({
        where: { status: RecordingStatus.BOZZA_AUDIO },
      });
      const failed = await prisma.recording.count({
        where: { status: RecordingStatus.ESTRAZIONE_FALLITA },
      });

      logger.debug("giro di polling", { pending, failed });
      // Fase 2: qui entra la pipeline.
    } catch (error) {
      logger.error("giro di polling fallito", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS).unref();
    });
  }

  await prisma.$disconnect();
  logger.info("worker terminato");
}

await main();
