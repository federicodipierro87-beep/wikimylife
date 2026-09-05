import type { EmbeddingProvider, ExtractionProvider, StorageProvider, TranscriptionProvider } from "@wikimylife/shared";
import type { PrismaClient } from "@prisma/client";
import type { Express } from "express";
import { createApp } from "./app.js";
import { ConfigError, type AppConfig } from "./config/env.js";
import { createPrismaClient, isDatabaseReachable } from "./db/client.js";
import { createRequireAuth } from "./http/middleware/requireAuth.js";
import { Argon2PasswordHasher } from "./infra/Argon2PasswordHasher.js";
import { JoseTokenIssuer } from "./infra/JoseTokenIssuer.js";
import { PrismaAuthRepository } from "./infra/PrismaAuthRepository.js";
import { PrismaProcedureRepository } from "./infra/PrismaProcedureRepository.js";
import { PrismaRecordingRepository } from "./infra/PrismaRecordingRepository.js";
import { SystemClock } from "./infra/SystemClock.js";
import { createLogger, type Logger } from "./logger.js";
import { AnthropicExtractionProvider } from "./providers/AnthropicExtractionProvider.js";
import { LocalFileStorageProvider } from "./providers/LocalFileStorageProvider.js";
import { OpenAiEmbeddingProvider } from "./providers/OpenAiEmbeddingProvider.js";
import { OpenAiTranscriptionProvider } from "./providers/OpenAiTranscriptionProvider.js";
import { S3StorageProvider } from "./providers/S3StorageProvider.js";
import {
  FakeEmbeddingProvider,
  FakeExtractionProvider,
  FakeStorageProvider,
  FakeTranscriptionProvider,
} from "./providers/fake/index.js";
import { createAuthService, type AuthService } from "./services/auth.service.js";
import { createIngestionService, type IngestionService } from "./services/ingestion.service.js";
import {
  createProceduresService,
  type ProceduresService,
} from "./services/procedures.service.js";
import {
  createRecordingsService,
  type RecordingsService,
} from "./services/recordings.service.js";
import { createSearchService, type SearchService } from "./services/search.service.js";

/**
 * L'unico file che conosce le classi concrete.
 *
 * Tutto il resto vede interfacce. E' il punto in cui si decide che dietro
 * `PasswordHasher` c'e' argon2 e dietro `TokenIssuer` c'e' jose — e l'unico
 * punto da toccare il giorno in cui una di quelle scelte cambia.
 */

export const API_VERSION = "0.1.0";

export interface Providers {
  readonly transcription: TranscriptionProvider;
  readonly extraction: ExtractionProvider;
  readonly storage: StorageProvider;
  readonly embedding: EmbeddingProvider;
}

export interface Composition {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly prisma: PrismaClient;
  readonly authService: AuthService;
  readonly recordingsService: RecordingsService;
  readonly proceduresService: ProceduresService;
  readonly searchService: SearchService;
  /**
   * Esposto anche se l'app HTTP non lo usa: e' il worker a chiamarlo, e i test
   * end-to-end lo eseguono in-process subito dopo l'upload invece di aspettare
   * un giro di polling di un secondo processo.
   */
  readonly ingestionService: IngestionService;
  readonly providers: Providers;
  readonly app: Express;
  shutdown(): Promise<void>;
}

/**
 * Una chiave assente e' un errore di configurazione, non un caso da gestire.
 *
 * Fallire qui significa che il processo non parte; il ramo alternativo —
 * lasciar partire l'API e scoprirlo al primo vocale — trasformerebbe una
 * variabile dimenticata in un `Recording` fallito per un utente vero. Il
 * fallback silenzioso al fake sarebbe anche peggio: schede finte in un
 * database vero, indistinguibili da quelle buone.
 */
function requireKey(value: string | undefined, name: string, provider: string): string {
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`${name} e' obbligatoria quando il provider e' "${provider}"`);
  }
  return value;
}

/**
 * Lo storage ha tre implementazioni e una sola e' adatta alla produzione.
 *
 * La configurazione impedisce gia' di avviare `NODE_ENV=production` con le
 * altre due, quindi qui non c'e' nessun controllo da rifare: e' il vantaggio
 * di validare l'ambiente in un punto solo.
 */
function buildStorage(p: AppConfig["providers"]): StorageProvider {
  switch (p.storage) {
    case "s3": {
      if (p.s3 === undefined) {
        throw new ConfigError('STORAGE_PROVIDER="s3" senza configurazione S3');
      }
      return new S3StorageProvider(p.s3);
    }
    case "local":
      return new LocalFileStorageProvider(p.storageDir);
    case "fake":
      return new FakeStorageProvider();
  }
}

function buildProviders(config: AppConfig): Providers {
  const p = config.providers;

  const transcription: TranscriptionProvider =
    p.transcription === "openai"
      ? new OpenAiTranscriptionProvider({
          apiKey: requireKey(p.openaiApiKey, "OPENAI_API_KEY", "openai"),
          model: p.transcriptionModel,
        })
      : new FakeTranscriptionProvider();

  const extraction: ExtractionProvider =
    p.extraction === "anthropic"
      ? new AnthropicExtractionProvider({
          apiKey: requireKey(p.anthropicApiKey, "ANTHROPIC_API_KEY", "anthropic"),
          model: p.extractionModel,
        })
      : new FakeExtractionProvider();

  const storage: StorageProvider = buildStorage(p);

  const embedding: EmbeddingProvider =
    p.embedding === "openai"
      ? new OpenAiEmbeddingProvider({
          apiKey: requireKey(p.openaiApiKey, "OPENAI_API_KEY", "openai"),
          model: p.embeddingModel,
          dimensions: p.embeddingDimensions,
        })
      : new FakeEmbeddingProvider({
          model: p.embeddingModel,
          dimensions: p.embeddingDimensions,
        });

  return { transcription, extraction, storage, embedding };
}

export function compose(config: AppConfig, overrides?: {
  readonly prisma?: PrismaClient | undefined;
  readonly logger?: Logger | undefined;
}): Composition {
  const logger =
    overrides?.logger ??
    createLogger({ level: config.logLevel, bindings: { service: "api" } });

  const prisma =
    overrides?.prisma ?? createPrismaClient({ databaseUrl: config.databaseUrl });

  const clock = new SystemClock();
  const hasher = new Argon2PasswordHasher();
  const tokens = new JoseTokenIssuer({
    accessSecret: config.auth.accessSecret,
    accessTtlSeconds: config.auth.accessTokenTtlSeconds,
  });
  const repo = new PrismaAuthRepository(prisma);

  const authService = createAuthService({
    repo,
    hasher,
    tokens,
    clock,
    config: config.auth,
  });

  const providers = buildProviders(config);
  const recordingRepo = new PrismaRecordingRepository(prisma);

  const ingestionService = createIngestionService({
    repo: recordingRepo,
    transcription: providers.transcription,
    extraction: providers.extraction,
    storage: providers.storage,
    embedding: providers.embedding,
    clock,
    logger: logger.child({ component: "ingestion" }),
  });

  const recordingsService = createRecordingsService({
    repo: recordingRepo,
    storage: providers.storage,
    clock,
    // L'API non elabora: accoda e basta. E' il worker a raccogliere, e questa
    // riga esiste solo perche' un giorno il segnale possa diventare qualcosa di
    // piu' immediato del polling senza toccare il servizio.
    onEnqueued: (recordingId) => {
      logger.debug("registrazione in coda", { recordingId });
    },
  });

  const procedureRepo = new PrismaProcedureRepository(prisma);

  const proceduresService = createProceduresService({
    repo: procedureRepo,
    embeddings: providers.embedding,
    clock,
  });

  const searchService = createSearchService({
    repo: procedureRepo,
    embeddings: providers.embedding,
    clock,
    // Il canale semantico che cade non e' un errore da 500: la ricerca risponde
    // lo stesso col solo full-text. Ma un provider giu' per un'ora deve lasciare
    // una traccia, altrimenti la degradazione e' invisibile e si scopre solo
    // dalle lamentele sulla qualita' dei risultati.
    onSemanticUnavailable: (error) => {
      logger.warn("ricerca semantica non disponibile, degrado a full-text", { error });
    },
  });

  const app = createApp({
    logger,
    authService,
    recordingsService,
    proceduresService,
    searchService,
    requireAuth: createRequireAuth({ tokens, clock }),
    isDatabaseUp: () => isDatabaseReachable(prisma),
    now: () => clock.now(),
    version: API_VERSION,
    corsOrigins: config.corsOrigins,
  });

  return {
    config,
    logger,
    prisma,
    authService,
    recordingsService,
    proceduresService,
    searchService,
    ingestionService,
    providers,
    app,
    async shutdown(): Promise<void> {
      await prisma.$disconnect();
    },
  };
}
