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

/**
 * Una stringa vuota e' un valore assente.
 *
 * I pannelli di Railway e Netlify non distinguono «variabile non impostata» da
 * «variabile impostata a niente»: svuotare il campo lascia `""`. Senza questa
 * normalizzazione un `OPENAI_API_KEY=` vuoto supererebbe i controlli di
 * presenza e fallirebbe alla prima chiamata — in produzione, su un vocale
 * vero, con l'audio gia' accettato.
 */
const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

/**
 * Separa `CORS_ORIGINS`, scartando i vuoti e la barra finale.
 *
 * Un'origine e' `schema://host[:porta]`: `https://x.netlify.app/` con la barra
 * non combacia mai con l'intestazione `Origin` che manda il browser, e il
 * sintomo — tutto bloccato, nessun errore nei log dell'API — non suggerisce
 * dove guardare. Anche una virgola di troppo in un pannello di configurazione
 * non deve diventare un'origine vuota.
 */
export function parseOrigins(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((origine) => origine.trim().replace(/\/+$/, ""))
    .filter((origine) => origine !== "");
}

const baseSchema = z.object({
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

  /**
   * Tentativi ammessi su login, signup e refresh, per IP e per rotta, nella
   * finestra sotto.
   *
   * Dieci al minuto: chi conosce la propria password ne usa uno, chi la ricorda
   * male tre o quattro, e chi ne prova diecimila si ferma. Il valore e'
   * configurabile per una ragione sola — un ufficio dietro NAT e' un IP solo, e
   * quel giorno serve poterlo alzare senza un deploy di codice.
   */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AUTH_RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().default(60),

  /**
   * Quanti proxy stanno davanti all'API. Non un booleano, e la differenza e'
   * l'intera tenuta del limite dei tentativi.
   *
   * `trust proxy: true` dice a Express di fidarsi di TUTTI gli indirizzi in
   * `X-Forwarded-For` e di prendere il primo da sinistra. Quel primo lo scrive
   * il client: chiunque puo' mandare `X-Forwarded-For: 1.2.3.4`, cambiarlo a
   * ogni richiesta, e ottenere un budget nuovo ogni volta. Il limitatore
   * continuerebbe a funzionare, a rispondere 429 a chi non falsifica niente, e a
   * non fermare nessuno.
   *
   * Con un numero Express conta da destra: con `1` prende l'indirizzo scritto
   * dall'ultimo proxy — quello di Railway — che e' l'unico che il client non
   * puo' toccare. Le voci che ha aggiunto lui restano dietro le eventuali
   * falsificazioni, non davanti.
   *
   * Zero in sviluppo: senza proxy `req.ip` e' quello del socket, e
   * `X-Forwarded-For` va ignorato del tutto. Uno in produzione, che e' la
   * topologia descritta in «Deploy». Si alza solo aggiungendo un altro proxy
   * davanti (una CDN, per esempio), e allora va alzato davvero: un valore piu'
   * basso del numero di salti riporta il problema di prima.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).optional(),

  /**
   * Le origini ammesse dal CORS, separate da virgola. Vuoto = nessuna origine
   * esterna, cioe' solo chiamate dalla stessa origine o da riga di comando.
   *
   * Non c'e' e non deve esserci un valore che significhi «tutte»: il §5 della
   * consegna chiede il dominio Netlify «e nient'altro», e un jolly qui sarebbe
   * la cosa piu' facile da lasciarsi dietro dopo un pomeriggio di debug.
   */
  CORS_ORIGINS: z.string().default(""),

  TRANSCRIPTION_PROVIDER: z.enum(["fake", "openai"]).default("fake"),
  EXTRACTION_PROVIDER: z.enum(["fake", "anthropic"]).default("fake"),
  STORAGE_PROVIDER: z.enum(["fake", "local", "s3"]).default("fake"),
  EMBEDDING_PROVIDER: z.enum(["fake", "openai"]).default("fake"),

  OPENAI_API_KEY: optionalText,
  ANTHROPIC_API_KEY: optionalText,

  TRANSCRIPTION_MODEL: z.string().default("whisper-1"),
  /**
   * Il nome del modello NON e' la versione del prompt. Questo cambia quando
   * cambia il listino di Anthropic; `extraction.v1` cambia quando cambiano le
   * istruzioni. `Recording.extractionModel` conserva entrambi, perche' per
   * riprocessare lo storico serve sapere quale coppia ha prodotto una scheda.
   */
  EXTRACTION_MODEL: z.string().default("claude-sonnet-4-5-20250929"),

  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  /**
   * Deve combaciare con `vector(1536)` della migration. Non e' negoziabile a
   * runtime: passare a text-embedding-3-large vuol dire migration piu'
   * re-embedding di tutte le procedure.
   */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),

  STORAGE_DIR: z.string().default("./storage"),

  // --- Object storage (STORAGE_PROVIDER=s3) --------------------------------
  S3_BUCKET: optionalText,
  /**
   * Per Cloudflare R2 e' `auto`. Entra nella firma, quindi un valore sbagliato
   * produce `SignatureDoesNotMatch` e non un errore di rete.
   */
  S3_REGION: optionalText,
  /**
   * L'origine del servizio, per chi non e' AWS. Assente = AWS S3.
   * R2: `https://<account>.r2.cloudflarestorage.com`.
   */
  S3_ENDPOINT: optionalText,
  S3_ACCESS_KEY_ID: optionalText,
  S3_SECRET_ACCESS_KEY: optionalText,
  /** Bucket nel percorso invece che nel sottodominio. Serve a MinIO. */
  S3_FORCE_PATH_STYLE: booleanFromString.default(false),
});

/**
 * I controlli che riguardano piu' di una variabile insieme.
 *
 * Stanno qui e non in `buildProviders` perche' devono valere anche per il
 * worker, che compone gli stessi provider da un altro processo: una regola
 * scritta nel ramo di costruzione dell'API sarebbe una regola che il worker
 * non applica.
 */
const envSchema = baseSchema.superRefine((env, ctx) => {
  const manca = (path: string, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };

  if (env.STORAGE_PROVIDER === "s3") {
    if (env.S3_BUCKET === undefined) manca("S3_BUCKET", "obbligatoria con STORAGE_PROVIDER=s3");
    if (env.S3_REGION === undefined) manca("S3_REGION", "obbligatoria con STORAGE_PROVIDER=s3");
    if (env.S3_ACCESS_KEY_ID === undefined) {
      manca("S3_ACCESS_KEY_ID", "obbligatoria con STORAGE_PROVIDER=s3");
    }
    if (env.S3_SECRET_ACCESS_KEY === undefined) {
      manca("S3_SECRET_ACCESS_KEY", "obbligatoria con STORAGE_PROVIDER=s3");
    }
  }

  if (env.NODE_ENV !== "production") {
    return;
  }

  /**
   * In produzione lo storage su disco e' perdita di dati, non lentezza.
   *
   * Il filesystem di Railway e' effimero: sopravvive al processo, non al
   * redeploy. Un'API che parte con `local` funziona benissimo per una
   * settimana e poi restituisce 404 su ogni audio piu' vecchio dell'ultimo
   * deploy, senza un errore da nessuna parte. E' l'unico guasto di questa
   * lista che non si puo' riparare dopo.
   */
  if (env.STORAGE_PROVIDER !== "s3") {
    manca(
      "STORAGE_PROVIDER",
      `in produzione deve essere "s3": il disco dell'host e' effimero e "${env.STORAGE_PROVIDER}" perde gli audio al primo redeploy`,
    );
  }

  /**
   * Senza origini ammesse la PWA non puo' parlare con l'API: sta su un dominio
   * Netlify, l'API su uno Railway, e ogni fetch muore nel browser. Meglio non
   * partire che partire e sembrare a posto nei log mentre nessuno riesce a
   * fare login.
   */
  if (env.CORS_ORIGINS.trim() === "") {
    manca(
      "CORS_ORIGINS",
      "in produzione serve almeno l'origine del frontend (es. https://wikimylife.netlify.app)",
    );
  }

  // I provider finti in produzione producono schede finte in un database vero,
  // indistinguibili dalle buone il giorno dopo.
  for (const [nome, valore] of [
    ["TRANSCRIPTION_PROVIDER", env.TRANSCRIPTION_PROVIDER],
    ["EXTRACTION_PROVIDER", env.EXTRACTION_PROVIDER],
    ["EMBEDDING_PROVIDER", env.EMBEDDING_PROVIDER],
  ] as const) {
    if (valore === "fake") {
      manca(nome, `in produzione non puo' essere "fake"`);
    }
  }
});

export type Env = z.infer<typeof envSchema>;

export interface AuthConfig {
  readonly accessSecret: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly signupEnabled: boolean;
  /** Millisecondi e conteggio, gia' convertiti per il middleware. */
  readonly rateLimit: { readonly windowMs: number; readonly max: number };
}

export interface S3Settings {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: string | undefined;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

export interface AppConfig {
  readonly nodeEnv: Env["NODE_ENV"];
  readonly port: number;
  readonly logLevel: Env["LOG_LEVEL"];
  readonly databaseUrl: string;
  /** Gia' separate e ripulite: si veda `parseOrigins`. */
  readonly corsOrigins: readonly string[];
  /** Salti di proxy da scartare per ottenere l'IP del client. Mai un booleano. */
  readonly trustProxyHops: number;
  readonly auth: AuthConfig;
  readonly providers: {
    readonly transcription: Env["TRANSCRIPTION_PROVIDER"];
    readonly extraction: Env["EXTRACTION_PROVIDER"];
    readonly storage: Env["STORAGE_PROVIDER"];
    readonly embedding: Env["EMBEDDING_PROVIDER"];
    readonly openaiApiKey: string | undefined;
    readonly anthropicApiKey: string | undefined;
    readonly transcriptionModel: string;
    readonly extractionModel: string;
    readonly embeddingModel: string;
    readonly embeddingDimensions: number;
    readonly storageDir: string;
    /**
     * Presente solo con `STORAGE_PROVIDER=s3`, e allora completo: la validazione
     * dello schema ha gia' respinto il caso «s3 con meta' delle credenziali».
     */
    readonly s3: S3Settings | undefined;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function toS3(env: Env): S3Settings | undefined {
  if (env.STORAGE_PROVIDER !== "s3") {
    return undefined;
  }
  // Le quattro obbligatorie ci sono: lo `superRefine` non avrebbe lasciato
  // passare l'ambiente altrimenti. Il `??` e' qui solo per il compilatore, che
  // quella prova non la vede.
  return {
    bucket: env.S3_BUCKET ?? "",
    region: env.S3_REGION ?? "",
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  };
}

function toConfig(env: Env): AppConfig {
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    corsOrigins: parseOrigins(env.CORS_ORIGINS),
    // Il default segue l'ambiente perche' segue la topologia: in produzione c'e'
    // il proxy di Railway, in locale non c'e' niente. Chi ne mette un altro
    // davanti lo dichiara, e nel frattempo nessuno deve ricordarsi una variabile
    // il cui unico sintomo, se dimenticata, e' un limite che non limita.
    trustProxyHops: env.TRUST_PROXY_HOPS ?? (env.NODE_ENV === "production" ? 1 : 0),
    auth: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_MIN * 60,
      refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
      signupEnabled: env.SIGNUP_ENABLED,
      rateLimit: {
        windowMs: env.AUTH_RATE_LIMIT_WINDOW_SEC * 1000,
        max: env.AUTH_RATE_LIMIT_MAX,
      },
    },
    providers: {
      transcription: env.TRANSCRIPTION_PROVIDER,
      extraction: env.EXTRACTION_PROVIDER,
      storage: env.STORAGE_PROVIDER,
      embedding: env.EMBEDDING_PROVIDER,
      openaiApiKey: env.OPENAI_API_KEY,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      transcriptionModel: env.TRANSCRIPTION_MODEL,
      extractionModel: env.EXTRACTION_MODEL,
      embeddingModel: env.EMBEDDING_MODEL,
      embeddingDimensions: env.EMBEDDING_DIMENSIONS,
      storageDir: env.STORAGE_DIR,
      s3: toS3(env),
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
