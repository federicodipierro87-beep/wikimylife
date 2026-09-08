import { ConfigError, loadConfig } from "../config/env.js";
import { compose } from "../composition.js";
import { createLogger } from "../logger.js";
import { formatOrfano, formatSummary, parseSweepArgs, SWEEP_USAGE } from "./sweepArgs.js";

/**
 * La scopa a mano: `npm run sweep`.
 *
 * Il worker la passa da solo — `SWEEP_MODE` parte da `elenca` — quindi questo
 * comando non e' piu' l'unico modo di farla girare. Resta perche' e' l'unico in
 * cui a decidere c'e' qualcuno che guarda: la prima passata su un bucket vero e'
 * quella in cui si scopre che il prefisso era sbagliato o che il `DATABASE_URL`
 * puntava altrove, e leggere quell'elenco a schermo e' un'altra cosa dal
 * ritrovarselo nel registro il giorno dopo. `--prefix` e `--giorni` esistono
 * solo qui per la stessa ragione, e `--cancella` e' il gesto a mano che il
 * worker per default non fa.
 *
 * `compose` e non un cablaggio a mano, per la stessa ragione del worker: la
 * scopa deve guardare esattamente lo storage che l'API ha usato per scrivere.
 * Un secondo cablaggio potrebbe puntare a un bucket diverso, e la differenza si
 * vedrebbe solo dai file cancellati.
 */

async function main(): Promise<void> {
  const comando = parseSweepArgs(process.argv.slice(2));

  if (comando.kind === "AIUTO") {
    process.stdout.write(SWEEP_USAGE);
    return;
  }

  if (comando.kind === "ERRORE") {
    process.stderr.write(`${comando.message}\n`);
    process.exitCode = 2;
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  // Le righe del registro vanno su stderr e non su stdout come negli altri due
  // processi: qui stdout e' il rapporto, e chi lo reindirizza in un file per
  // rileggerselo non vuole trovarci in mezzo il JSON.
  const logger = createLogger({
    level: config.logLevel,
    bindings: { service: "sweep" },
    write: (line: string): void => void process.stderr.write(`${line}\n`),
  });

  const composition = compose(config, { logger });

  logger.info("passata avviata", {
    storage: composition.providers.storage.name,
    cancella: comando.cancella,
    graceMs: comando.graceMs,
    prefix: comando.prefix ?? null,
  });

  // Ctrl-C su una passata lunga da' il rapporto di quel che si e' fatto finora,
  // invece di lasciare in mano soltanto le righe gia' scorse via. Fermarsi non
  // lascia niente in sospeso — la passata dopo ricomincia da capo — quindi non
  // c'e' ragione di far scegliere fra aspettare la fine e ammazzare il processo.
  let procedi = true;
  process.on("SIGINT", () => {
    if (!procedi) {
      // Il secondo Ctrl-C e' di chi non vuole aspettare nemmeno il blocco in
      // corso. Registrare un gestore ha tolto di mezzo quello di Node, quindi
      // se non lo si rimette qui il secondo Ctrl-C non fa piu' niente.
      process.exit(130);
    }
    procedi = false;
    process.stderr.write("\ninterruzione richiesta, chiudo il blocco in corso\n");
  });

  try {
    const esito = await composition.storageSweepService.esegui({
      cancella: comando.cancella,
      graceMs: comando.graceMs,
      prefix: comando.prefix,
      continua: () => procedi,
      // Riga per riga mentre la passata va avanti, e non un elenco alla fine:
      // il servizio non tiene gli orfani in memoria apposta, e su un bucket
      // trascurato a lungo l'elenco sarebbe il bucket. Il registro riceve gli
      // stessi nomi, ed e' l'unica prova che resta se la passata muore a meta' —
      // il riassunto, a quel punto, non viene mai stampato.
      onOrfano: (object) => {
        process.stdout.write(`${formatOrfano(object)}\n`);
        logger.info("orfano trovato", {
          key: object.key,
          sizeBytes: object.sizeBytes,
          lastModified: object.lastModified,
        });
      },
      // Stessa scelta di `onOrphanedAudio`, dall'altro capo: li' resta indietro
      // una chiave perche' la riga e' gia' sparita, qui perche' il bucket ha
      // detto di no. In entrambi i casi non c'e' altro da fare che lasciarne il
      // nome scritto.
      onErroreCancellazione: ({ key, error }) => {
        logger.error("orfano non cancellato", { key, error });
      },
    });

    process.stdout.write(formatSummary(esito, comando.cancella));

    // Un fallimento di cancellazione non e' un guasto della passata, ma non e'
    // nemmeno un successo: chi la esegue da uno script deve poterlo sapere
    // senza rileggere il rapporto. Una passata interrotta vale lo stesso, e per
    // una ragione piu' forte: i suoi numeri non sono il conto del bucket.
    if (esito.falliti > 0 || esito.interrotta) {
      process.exitCode = 1;
    }
  } catch (error) {
    // Ci si arriva quando il database non risponde: la passata si interrompe
    // apposta invece di dare per orfano tutto quello che non ha potuto
    // chiedere. Non c'e' niente da riparare, si riesegue.
    logger.error("passata interrotta, niente e' stato deciso sul resto del bucket", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await composition.shutdown();
  }
}

await main();
