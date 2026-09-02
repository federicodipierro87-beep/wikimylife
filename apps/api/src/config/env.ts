import { z } from "zod";

/**
 * L'UNICO file dell'API che legge `process.env`.
 *
 * Tutto il resto riceve la configurazione come parametro. E' la ragione per cui
 * i servizi si testano senza toccare l'ambiente e per cui non esiste un
 * `process.env.QUALCOSA` sparso a caso da scoprire in produzione: il divieto e'
 * verificato da tests/unit/guards.test.ts.
 *
 * `dotenv` non serve: `process.loadEnvFile()` e' in Node dalla 20.12 e su
 * Windows evita anche il problema di `--env-file` che non trova il file.
 */

let envFileLoaded = false;

function loadEnvFileOnce(): void {
  if (envFileLoaded) {
    return;
  }
  envFileLoaded = true;
  try {
    process.loadEnvFile();
  } catch {
    // Nessun .env: su Railway le variabili arrivano gia' dall'ambiente.
    // L'assenza del file non e' un errore, un segreto mancante si'.
  }
}

const booleanFromString = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL e' obbligatoria"),

  /**
   * 32 caratteri minimi imposti allo start: il processo non parte con un
   * segreto debole. Un controllo a runtime sulla prima firma sarebbe arrivato
   * troppo tardi, e in un ambiente dove nessuno guarda i log.
   */
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, "JWT_ACCESS_SECRET deve avere almeno 32 caratteri"),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  SIGNUP_ENABLED: booleanFromString.default(true),

  TRANSCRIPTION_PROVIDER: z.enum(["fake", "openai"]).default("fake"),
  EXTRACTION_PROVIDER: z.enum(["fake", "anthropic"]).default("fake"),
  STORAGE_PROVIDER: z.enum(["fake", "local"]).default("fake"),
  EMBEDDING_PROVIDER: z.enum(["fake", "openai"]).default("fake"),

  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  /**
   * Deve combaciare con `vector(1536)` della migration. Non e' negoziabile a
   * runtime: passare a text-embedding-3-large vuol dire migration piu'
   * re-embedding di tutte le procedure.
   */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),

  STORAGE_DIR: z.string().default("./storage"),
});

export type Env = z.infer<typeof envSchema>;

export interface AuthConfig {
  readonly accessSecret: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly signupEnabled: boolean;
}

export interface AppConfig {
  readonly nodeEnv: Env["NODE_ENV"];
  readonly port: number;
  readonly logLevel: Env["LOG_LEVEL"];
  readonly databaseUrl: string;
  readonly auth: AuthConfig;
  readonly providers: {
    readonly transcription: Env["TRANSCRIPTION_PROVIDER"];
    readonly extraction: Env["EXTRACTION_PROVIDER"];
    readonly storage: Env["STORAGE_PROVIDER"];
    readonly embedding: Env["EMBEDDING_PROVIDER"];
    readonly openaiApiKey: string | undefined;
    readonly anthropicApiKey: string | undefined;
    readonly embeddingModel: string;
    readonly embeddingDimensions: number;
    readonly storageDir: string;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function toConfig(env: Env): AppConfig {
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    auth: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_MIN * 60,
      refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
      signupEnabled: env.SIGNUP_ENABLED,
    },
    providers: {
      transcription: env.TRANSCRIPTION_PROVIDER,
      extraction: env.EXTRACTION_PROVIDER,
      storage: env.STORAGE_PROVIDER,
      embedding: env.EMBEDDING_PROVIDER,
      openaiApiKey: env.OPENAI_API_KEY,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      embeddingModel: env.EMBEDDING_MODEL,
      embeddingDimensions: env.EMBEDDING_DIMENSIONS,
      storageDir: env.STORAGE_DIR,
    },
  };
}

/**
 * Legge e valida l'ambiente. Fallisce forte e presto: un'API che si avvia con
 * una configurazione incompleta e' un'API che sbaglia in silenzio.
 */
export function loadConfig(source?: Record<string, string | undefined>): AppConfig {
  if (source === undefined) {
    loadEnvFileOnce();
  }
  const raw = source ?? process.env;
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Configurazione non valida:\n${problems}`);
  }

  return toConfig(parsed.data);
}
