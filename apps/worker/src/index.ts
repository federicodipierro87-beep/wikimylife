import { loadConfig } from "@wikimylife/api/config";
import { createLogger } from "@wikimylife/api/logger";
import { compose } from "@wikimylife/api";
import { creaSonno } from "./sonno.js";
import { toccaCancellare, toccaSpazzare } from "./sweepSchedule.js";

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
 *
 * FA ANCHE LA SCOPA, e la fa senza che nessuno gliel'abbia chiesto. E' l'unica
 * altra cosa periodica del sistema, sta qui perche' qui c'e' gia' un processo
 * che si sveglia da solo, e dal default `elenca` in poi passa anche in
 * un'installazione che non ha mai letto `SWEEP_MODE`: scorre il bucket, scrive
 * cosa cancellerebbe, e non cancella. A cancellare ci vuole `cancella`, e la
 * riga che lo decide e' `toccaCancellare`. Quando la coda ha qualcosa dentro
 * non passa — la ragione sta in `sweepSchedule.ts`, ed e' che nessuno deve
 * aspettare la propria scheda perche' il worker sta pulendo la spazzatura di
 * ieri.
 *
 * DUE WORKER NON SI PESTANO NEMMENO QUI, ma per un motivo diverso dalla coda:
 * non c'e' nessun lucchetto, e non serve. Cosa cancellare e' una funzione pura
 * di (bucket, tabella, ora), quindi due passate in parallelo prendono le stesse
 * decisioni; e cancellare due volte la stessa chiave non e' un errore ne' su
 * S3 ne' sul filesystem, dove `delete` e' idempotente apposta. Il costo di due
 * repliche e' quindi soltanto una scorsa del bucket pagata due volte — voci di
 * `LIST` sulla fattura, niente di piu' — e chi vuole evitarlo tiene la scopa
 * accesa su una replica sola.
 */

const POLL_INTERVAL_MS = 5_000;

/**
 * Quanti job di fila prima di tornare a dormire.
 *
 * Serve a svuotare un arretrato senza aspettare cinque secondi per ognuno, e a
 * non restare bloccati per sempre in un ciclo che ignora SIGTERM.
 */
const MAX_BATCH = 10;

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
    // Nel registro dell'avvio, dove chi guarda un deploy la vede: e' l'unica
    // cosa che questo processo faccia sui file di qualcuno senza che gliel'abbia
    // chiesto nessuno, e sapere che e' accesa non deve costare una lettura del
    // pannello delle variabili.
    sweep: {
      mode: config.sweep.mode,
      everyMs: config.sweep.everyMs,
      graceMs: config.sweep.graceMs,
    },
    providers: {
      transcription: composition.providers.transcription.name,
      extraction: composition.providers.extraction.name,
      storage: composition.providers.storage.name,
      embedding: composition.providers.embedding.name,
    },
  });

  const sonno = creaSonno();

  let running = true;
  const shutdown = (signal: string): void => {
    if (!running) {
      return;
    }
    running = false;
    // Non si interrompe il job in corso: e' a meta' fra due chiamate a modelli
    // gia' pagate, e la riga tornerebbe in coda per essere rifatta da capo.
    logger.info("arresto richiesto, termino il lavoro in corso", { signal });
    // Se invece sta dormendo, non c'e' niente da finire e non c'e' ragione di
    // consumare la finestra fra il SIGTERM e il SIGKILL aspettando un timer.
    sonno.svegliati();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const scopa = logger.child({ component: "sweep" });

  /**
   * Una passata, e tutto quello che succede resta scritto mentre succede.
   *
   * Il riassunto arriva alla fine e la fine puo' non arrivare — un SIGTERM, un
   * bucket che smette di rispondere — quindi ogni orfano va nel registro
   * appena trovato. In `elenca` quelle righe sono l'unico prodotto della
   * passata: dicono cosa sarebbe sparito, senza che sparisca.
   */
  const spazza = async (): Promise<void> => {
    const cancella = toccaCancellare(config.sweep.mode);
    scopa.info("passata avviata", { cancella, graceMs: config.sweep.graceMs });
    try {
      const esito = await composition.storageSweepService.esegui({
        cancella,
        graceMs: config.sweep.graceMs,
        // Fermarsi a meta' non lascia niente in sospeso, e restare a scorrere un
        // bucket grande dopo un SIGTERM significa solo farsi ammazzare piu'
        // tardi. E' la differenza con l'elaborazione di un vocale, che invece si
        // lascia finire perche' e' fatta di chiamate gia' pagate.
        continua: () => running,
        onOrfano: (object) => {
          scopa.info("orfano trovato", {
            key: object.key,
            sizeBytes: object.sizeBytes,
            lastModified: object.lastModified,
          });
        },
        onErroreCancellazione: ({ key, error }) => {
          scopa.error("orfano non cancellato", { key, error });
        },
      });
      scopa.info(esito.interrotta ? "passata interrotta dall'arresto" : "passata conclusa", {
        ...esito,
      });
    } catch (error) {
      // Ci si arriva quando il database non risponde: la passata si interrompe
      // apposta invece di dare per orfano tutto cio' che non ha potuto chiedere.
      // Non c'e' niente da riparare, ci riprova la prossima.
      scopa.error("passata interrotta, niente e' stato deciso sul resto del bucket", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // La prima e' un intervallo dopo l'avvio e non all'avvio: un worker che si
  // riavvia in ciclo passerebbe la scopa a ogni riavvio, e la scopa e' la cosa
  // che non deve girare piu' spesso di quanto le si e' detto.
  let nonPrimaDi = Date.now() + config.sweep.everyMs;

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

    if (
      running &&
      toccaSpazzare({
        mode: config.sweep.mode,
        adesso: Date.now(),
        nonPrimaDi,
        codaVuota: processed === 0,
      })
    ) {
      await spazza();
      // Riarmato comunque, anche se la passata e' fallita o e' stata
      // interrotta: contare dalla fine e non dall'inizio, e riarmare fuori dal
      // ramo felice, e' cio' che impedisce a un bucket irraggiungibile di
      // trasformarsi in un tentativo ogni cinque secondi.
      nonPrimaDi = Date.now() + config.sweep.everyMs;
    }

    if (running && processed === 0) {
      await sonno.dormi(POLL_INTERVAL_MS);
    }
  }

  await composition.shutdown();
  logger.info("worker terminato");
}

await main();
