import type { AddressInfo } from "node:net";
import { RECORDING_UPLOAD_FIELDS } from "@wikimylife/shared";
import type { PrismaClient } from "@prisma/client";
import { loadConfig } from "../../../apps/api/src/config/env.js";
import { compose, type Composition } from "../../../apps/api/src/composition.js";
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
  /**
   * Le stesse istanze che servono le richieste HTTP.
   *
   * Serve a due cose che dall'esterno non si raggiungono: eseguire
   * `ingestionService.processNext()` in-process subito dopo un upload — invece
   * di avviare il worker e aspettare un giro di polling — e programmare i
   * provider finti. Un secondo `compose()` per i test avrebbe dato altri
   * oggetti: si sarebbero configurati fake che nessuna richiesta usa.
   */
  readonly composition: Composition;
  close(): Promise<void>;
}

export interface TestServerOptions {
  readonly signupEnabled?: boolean;
  readonly accessTokenTtlMin?: number;
  readonly refreshTokenTtlDays?: number;
  /** Lista separata da virgola, come la variabile d'ambiente vera. */
  readonly corsOrigins?: string;
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
    CORS_ORIGINS: options.corsOrigins ?? "",
  });

  const prisma = testPrisma();
  // Il logger scrive su array che nessuno legge: senza, ogni 500 atteso
  // stamperebbe uno stack in mezzo all'output della suite e sembrerebbe un
  // guasto.
  const silent = createLogger({ level: "error", write: () => undefined, writeError: () => undefined });
  const composition = compose(config, { prisma, logger: silent });

  const server = composition.app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    prisma,
    composition,
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
  method: "GET" | "POST" | "PATCH" | "DELETE",
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

  return toResult(response);
}

/**
 * Come `call`, ma senza `JSON.parse`: l'audio sono byte, e leggerli come testo
 * li corromperebbe prima ancora di poterli confrontare.
 */
export async function callBinary(
  server: TestServer,
  path: string,
  init: { accessToken?: string } = {},
): Promise<{ status: number; bytes: Uint8Array; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (init.accessToken !== undefined) {
    headers["authorization"] = `Bearer ${init.accessToken}`;
  }

  const response = await fetch(`${server.url}${path}`, { method: "GET", headers });
  return {
    status: response.status,
    bytes: new Uint8Array(await response.arrayBuffer()),
    headers: response.headers,
  };
}

async function toResult(response: Response): Promise<HttpResult> {
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : (JSON.parse(text) as unknown),
    headers: response.headers,
  };
}

export interface UploadInit {
  readonly accessToken?: string | undefined;
  /**
   * Serializzato con `JSON.stringify` se non e' gia' una stringa: i casi
   * negativi devono poter mandare un JSON storto, e una stringa passa intatta.
   */
  readonly metadata: unknown;
  readonly audio?: Uint8Array | undefined;
  readonly filename?: string | undefined;
  /** Manda il multipart senza la parte `audio`. */
  readonly omitAudio?: boolean | undefined;
}

/**
 * L'upload multipart vero.
 *
 * Il `content-type` non si scrive a mano: lo compone `fetch` a partire dalla
 * `FormData`, boundary compreso. Sceglierlo qui vorrebbe dire indovinare il
 * boundary, e un boundary sbagliato produce un corpo illeggibile senza dire
 * perche' — un 400 che sembra un bug del server e invece e' un bug del test.
 */
export async function uploadRecording(
  server: TestServer,
  init: UploadInit,
): Promise<HttpResult> {
  const form = new FormData();
  form.set(
    RECORDING_UPLOAD_FIELDS.metadata,
    typeof init.metadata === "string" ? init.metadata : JSON.stringify(init.metadata),
  );

  if (init.omitAudio !== true) {
    const bytes = init.audio ?? new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
    form.set(
      RECORDING_UPLOAD_FIELDS.audio,
      // `type` volutamente generico: il tipo autorevole e' quello dichiarato
      // nei metadati, e il test lo dimostra non aiutando il server.
      new Blob([bytes], { type: "application/octet-stream" }),
      init.filename ?? "voce.webm",
    );
  }

  const headers: Record<string, string> = {};
  if (init.accessToken !== undefined) {
    headers["authorization"] = `Bearer ${init.accessToken}`;
  }

  const response = await fetch(`${server.url}/api/recordings`, {
    method: "POST",
    headers,
    body: form,
  });

  return toResult(response);
}
