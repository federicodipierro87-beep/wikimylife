import type { EmbeddingProvider, ExtractionProvider, StorageProvider, TranscriptionProvider } from "@wikimylife/shared";
import type { PrismaClient } from "@prisma/client";
import type { Express } from "express";
import { createApp } from "./app.js";
import type { AppConfig } from "./config/env.js";
import { createPrismaClient, isDatabaseReachable } from "./db/client.js";
import { createRequireAuth } from "./http/middleware/requireAuth.js";
import { Argon2PasswordHasher } from "./infra/Argon2PasswordHasher.js";
import { JoseTokenIssuer } from "./infra/JoseTokenIssuer.js";
import { PrismaAuthRepository } from "./infra/PrismaAuthRepository.js";
import { SystemClock } from "./infra/SystemClock.js";
import { createLogger, type Logger } from "./logger.js";
import {
  FakeEmbeddingProvider,
  FakeExtractionProvider,
  FakeStorageProvider,
  FakeTranscriptionProvider,
} from "./providers/fake/index.js";
import { createAuthService, type AuthService } from "./services/auth.service.js";

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
  readonly providers: Providers;
  readonly app: Express;
  shutdown(): Promise<void>;
}

function buildProviders(config: AppConfig): Providers {
  // Fase 1: solo implementazioni fake. Le vere arrivano in Fase 2 e si
  // agganciano qui, senza che nessun servizio se ne accorga.
  const embedding = new FakeEmbeddingProvider({
    model: config.providers.embeddingModel,
    dimensions: config.providers.embeddingDimensions,
  });

  return {
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
    storage: new FakeStorageProvider(),
    embedding,
  };
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

  const app = createApp({
    logger,
    authService,
    requireAuth: createRequireAuth({ tokens, clock }),
    isDatabaseUp: () => isDatabaseReachable(prisma),
    now: () => clock.now(),
    version: API_VERSION,
  });

  return {
    config,
    logger,
    prisma,
    authService,
    providers,
    app,
    async shutdown(): Promise<void> {
      await prisma.$disconnect();
    },
  };
}
