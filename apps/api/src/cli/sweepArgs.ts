import type { ListedObject } from "@wikimylife/shared";
import type { SweepSummary } from "../services/storageSweep.service.js";

/**
 * La parte del comando che non tocca niente: leggere gli argomenti, scrivere il
 * rapporto.
 *
 * Sta in un modulo suo perche' l'entry point non e' importabile — finisce con un
 * `await main()` che aprirebbe una connessione al database dentro un test — e
 * perche' qui c'e' l'unica cosa del comando che possa sbagliarsi in silenzio: un
 * argomento letto male sceglie un altro insieme di file da cancellare.
 */

const GIORNO_MS = 24 * 60 * 60 * 1000;

export const SWEEP_USAGE = `uso: npm run sweep -- [opzioni]

Confronta cio' che c'e' nello storage con le righe della tabella e trova gli
oggetti che nessuna riga nomina piu'. Elenca soltanto, se non gli si dice
altrimenti.

  --cancella         cancella gli orfani trovati, invece di elencarli e basta
  --prefix=<chiave>  guarda solo le chiavi che cominciano cosi'
  --giorni=<n>       quanto vecchio dev'essere un orfano per esserlo (default 1)
  --help             questo testo

Un oggetto viene cancellato solo se nessuna riga lo nomina, se e' piu' vecchio
della soglia e se ha la forma di una chiave scritta da noi. Le tre condizioni
sono cumulative e il motivo di ognuna sta in storageSweep.service.ts.

Il rapporto va su stdout, il registro di quel che succede su stderr.
`;

export type SweepCommand =
  | { readonly kind: "AIUTO" }
  | {
      readonly kind: "ESEGUI";
      readonly cancella: boolean;
      readonly prefix: string | undefined;
      readonly graceMs: number;
    }
  | { readonly kind: "ERRORE"; readonly message: string };

/**
 * Ogni argomento che non si capisce e' un errore, non un argomento ignorato.
 *
 * `--prefix u1/` scritto con lo spazio invece che con l'uguale e' il caso che
 * conta: leggerlo come «nessun prefisso, e poi una parola che non c'entra»
 * significherebbe passare la scopa sull'intero bucket a chi credeva di averla
 * puntata su una cartella.
 */
export function parseSweepArgs(argv: readonly string[]): SweepCommand {
  let cancella = false;
  let prefix: string | undefined;
  let graceMs = GIORNO_MS;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "AIUTO" };
    }

    if (arg === "--cancella") {
      cancella = true;
      continue;
    }

    const uguale = arg.indexOf("=");
    const nome = uguale === -1 ? arg : arg.slice(0, uguale);
    const valore = uguale === -1 ? undefined : arg.slice(uguale + 1);

    if (nome === "--prefix" || nome === "--giorni") {
      if (valore === undefined) {
        return {
          kind: "ERRORE",
          message: `«${nome}» vuole il suo valore attaccato: ${nome}=qualcosa`,
        };
      }
      if (nome === "--prefix") {
        if (valore === "") {
          // Un prefisso vuoto e' l'intero bucket, ed e' gia' il default: farlo
          // dire da una riga di comando che sembra restringere il campo e'
          // esattamente il fraintendimento da evitare.
          return {
            kind: "ERRORE",
            message: "«--prefix=» senza valore e' tutto il bucket: si ometta l'opzione",
          };
        }
        prefix = valore;
        continue;
      }
      const giorni = Number(valore);
      if (!Number.isFinite(giorni) || giorni <= 0) {
        // Zero e' vietato apposta. La soglia e' l'unica difesa contro la corsa
        // fra il `put` del caricamento e la riga che lo nomina: annullarla
        // significa poter cancellare l'audio che qualcuno sta caricando adesso.
        return {
          kind: "ERRORE",
          message: `«--giorni=${valore}» non e' un numero di giorni maggiore di zero`,
        };
      }
      graceMs = giorni * GIORNO_MS;
      continue;
    }

    return {
      kind: "ERRORE",
      message: arg.startsWith("--")
        ? `opzione sconosciuta: «${arg}» (--help per l'elenco)`
        : `argomento inatteso: «${arg}» (le opzioni vogliono il valore attaccato con =)`,
    };
  }

  return { kind: "ESEGUI", cancella, prefix, graceMs };
}

/**
 * Byte in una misura leggibile, in potenze di 1024 e con il nome giusto.
 *
 * `MiB` e non `MB` perche' e' quello che il numero dice davvero, e chi confronta
 * questo rapporto con la fattura di un bucket — che conta in MB da mille — deve
 * poter vedere che le due misure non sono la stessa.
 */
export function formatBytes(bytes: number): string {
  const unita = ["B", "KiB", "MiB", "GiB", "TiB"];
  let valore = bytes;
  let i = 0;
  while (valore >= 1024 && i < unita.length - 1) {
    valore /= 1024;
    i += 1;
  }
  const testo = i === 0 ? String(valore) : valore.toFixed(1).replace(".", ",");
  return `${testo} ${unita[i] ?? "B"}`;
}

/** Una riga per orfano: data, dimensione, chiave. */
export function formatOrfano(object: ListedObject): string {
  return `${object.lastModified}  ${formatBytes(object.sizeBytes).padStart(9)}  ${object.key}`;
}

function riga(etichetta: string, valore: number, nota = ""): string {
  const numero = String(valore).padStart(8);
  return `${etichetta.padEnd(12)}${numero}${nota === "" ? "" : `  ${nota}`}`;
}

export function formatSummary(summary: SweepSummary, cancella: boolean): string {
  const righe = [
    riga("esaminati", summary.esaminati),
    riga("nominati", summary.nominati, "una riga li nomina"),
    riga("estranei", summary.estranei, "non hanno la forma di una chiave nostra"),
    riga("recenti", summary.troppoRecenti, "piu' giovani della soglia"),
    riga("orfani", summary.orfani, formatBytes(summary.byteOrfani)),
  ];

  if (cancella) {
    righe.push(riga("cancellati", summary.cancellati));
    if (summary.falliti > 0) {
      righe.push(
        riga("falliti", summary.falliti, "restano dove sono, la prossima passata li ritrova"),
      );
    }
  }

  // Prima di ogni altra nota, perche' cambia il senso di tutte le righe sopra:
  // sono il conto di quel che si e' guardato, non del bucket.
  if (summary.interrotta) {
    righe.push("", "Interrotta prima della fine: i numeri valgono solo per la parte guardata.");
  }

  if (!cancella && summary.orfani > 0) {
    righe.push("", "Non e' stato cancellato niente. Per farlo davvero: --cancella");
  }

  return `${righe.join("\n")}\n`;
}
