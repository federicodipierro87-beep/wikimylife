/**
 * Logger JSON su stdout.
 *
 * Perche' non `pino`: Railway raccoglie stdout e basta, non serve trasporto ne'
 * rotazione ne' redazione. Venti righe fanno lo stesso lavoro senza aggiungere
 * una dipendenza al percorso critico dell'avvio.
 *
 * Gli stack finiscono su stderr e mai nel corpo di una risposta.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly bindings?: LogFields;
  readonly write?: ((line: string) => void) | undefined;
  readonly writeError?: ((line: string) => void) | undefined;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_WEIGHT[options.level];
  const bindings = options.bindings ?? {};
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const writeError =
    options.writeError ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < threshold) {
      return;
    }
    const record = {
      time: new Date().toISOString(),
      level,
      message,
      ...bindings,
      ...(fields ?? {}),
    };
    const line = JSON.stringify(record);
    if (level === "error") {
      writeError(line);
    } else {
      write(line);
    }
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (extra) =>
      createLogger({
        level: options.level,
        bindings: { ...bindings, ...extra },
        write: options.write,
        writeError: options.writeError,
      }),
  };
}
