import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { loadConfig } from "../../../apps/api/src/config/env.js";
import { compose } from "../../../apps/api/src/composition.js";
import { createLogger } from "../../../apps/api/src/logger.js";
import { testDatabaseUrl, testPrisma } from "./db.js";

/**
 * L'API vera, in ascolto su una porta effimera.
 *
 * `listen(0)` fa scegliere la porta al sistema operativo: nessuna collisione con
 * un'API gia' avviata in un altro terminale, nessuna costante 3001 da coordinare
 * fra file di test. Poi si parla con `fetch`, che e' il motivo per cui
 * `supertest` non e' fra le dipendenze — sono le venti righe qui sotto, e in
 * cambio si esercita lo stack HTTP vero: parsing dell'header Authorization,
 * serializzazione JSON, codici di stato. Un finto oggetto request non avrebbe
 * mai scoperto un `res.status()` dimenticato.
 *
 * La configurazione si costruisce con `loadConfig(source)` passando un record
 * esplicito invece di `process.env`: i test non toccano l'ambiente del
 * processo, quindi non possono lasciarlo sporco per i file successivi.
 */

export interface TestServer {
  readonly url: string;
  readonly prisma: PrismaClient;
  close(): Promise<void>;
}

export interface TestServerOptions {
  readonly signupEnabled?: boolean;
  readonly accessTokenTtlMin?: number;
  readonly refreshTokenTtlDays?: number;
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    DATABASE_URL: testDatabaseUrl(),
    JWT_ACCESS_SECRET: "segreto-di-test-lungo-almeno-trentadue-caratteri",
    ACCESS_TOKEN_TTL_MIN: String(options.accessTokenTtlMin ?? 15),
    REFRESH_TOKEN_TTL_DAYS: String(options.refreshTokenTtlDays ?? 30),
    SIGNUP_ENABLED: String(options.signupEnabled ?? true),
  });

  const prisma = testPrisma();
  // Il logger scrive su array che nessuno legge: senza, ogni 500 atteso
  // stamperebbe uno stack in mezzo all'output della suite e sembrerebbe un
  // guasto.
  const silent = createLogger({ level: "error", write: () => undefined, writeError: () => undefined });
  const { app } = compose(config, { prisma, logger: silent });

  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    prisma,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

/** Non lancia mai sui codici di errore: nei test lo status e' un'asserzione. */
export async function call(
  server: TestServer,
  method: "GET" | "POST",
  path: string,
  init: { body?: unknown; accessToken?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (init.accessToken !== undefined) {
    headers["authorization"] = `Bearer ${init.accessToken}`;
  }

  const response = await fetch(`${server.url}${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : (JSON.parse(text) as unknown),
    headers: response.headers,
  };
}
