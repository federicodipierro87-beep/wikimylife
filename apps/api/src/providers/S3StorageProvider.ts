import { createHash } from "node:crypto";
import type { PutObjectInput, StorageProvider, StoredObject } from "@wikimylife/shared";
import { EMPTY_PAYLOAD_SHA256, encodeKey, signRequest } from "./s3/sigv4.js";

/**
 * Lo storage di produzione: un bucket compatibile S3.
 *
 * E' il motivo per cui `StorageProvider` esiste dalla Fase 1. Il disco di
 * Railway e' effimero — un redeploy, un riavvio o uno spostamento di istanza e
 * i file spariscono — quindi `LocalFileStorageProvider` in produzione non e'
 * una scelta piu' lenta, e' perdita di dati differita. La configurazione lo
 * impedisce: con `NODE_ENV=production` l'API non parte se lo storage non e'
 * `s3`.
 *
 * Nessun SDK: la firma sta in `s3/sigv4.ts`, novanta righe verificate contro i
 * vettori ufficiali AWS. Il guadagno e' che lo stesso codice parla con S3, R2,
 * B2 e MinIO, perche' il protocollo e' lo stesso e a cambiare e' solo
 * l'endpoint.
 *
 * ## Niente ritentativi qui dentro
 *
 * Un `put` che fallisce diventa un 500, e il 500 lo gestisce gia' la coda del
 * client: la registrazione resta in IndexedDB e riparte al prossimo `online`.
 * Ritentare anche qui vorrebbe dire tenere occupata una richiesta HTTP per
 * decine di secondi mentre l'utente aspetta, per ottenere la stessa cosa che
 * il telefono fa da solo con l'app chiusa.
 */

export interface S3Config {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * L'origine del servizio, per chi non e' AWS. Per Cloudflare R2:
   * `https://<account>.r2.cloudflarestorage.com`. Assente = AWS S3.
   */
  readonly endpoint: string | undefined;
  /**
   * `true` mette il bucket nel percorso invece che nel sottodominio. Serve a
   * MinIO e ad alcuni endpoint self-hosted; AWS lo ha deprecato per i bucket
   * creati dopo il 2020, quindi il default e' `false`.
   */
  readonly forcePathStyle: boolean;
}

export class S3StorageError extends Error {
  readonly status: number;

  constructor(operazione: string, status: number, dettaglio: string) {
    super(`S3 ${operazione}: HTTP ${status} ${dettaglio}`);
    this.name = "S3StorageError";
    this.status = status;
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export class S3StorageProvider implements StorageProvider {
  readonly name = "s3";
  readonly #config: S3Config;
  readonly #origin: string;
  readonly #prefix: string;
  readonly #now: () => Date;

  constructor(config: S3Config, now: () => Date = () => new Date()) {
    this.#config = config;
    this.#now = now;

    const base =
      config.endpoint ?? `https://s3.${config.region}.amazonaws.com`;
    const { protocol, host } = new URL(base);

    if (config.forcePathStyle) {
      this.#origin = `${protocol}//${host}`;
      this.#prefix = `/${encodeKey(config.bucket)}`;
    } else {
      // Stile virtual-hosted: il bucket entra nel nome host. Va firmato cosi'
      // com'e' inviato, quindi l'host che finisce nella firma e' gia' questo.
      this.#origin = `${protocol}//${config.bucket}.${host}`;
      this.#prefix = "";
    }
  }

  #urlFor(key: string): URL {
    return new URL(`${this.#origin}${this.#prefix}/${encodeKey(key)}`);
  }

  async #send(
    operazione: string,
    method: string,
    key: string,
    body?: { readonly data: Uint8Array; readonly mimeType: string },
  ): Promise<Response> {
    const url = this.#urlFor(key);
    const headers = signRequest({
      method,
      url,
      headers: body === undefined ? {} : { "content-type": body.mimeType },
      payloadSha256: body === undefined ? EMPTY_PAYLOAD_SHA256 : sha256Hex(body.data),
      accessKeyId: this.#config.accessKeyId,
      secretAccessKey: this.#config.secretAccessKey,
      region: this.#config.region,
      service: "s3",
      now: this.#now(),
    });

    const risposta = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: body.data }),
    });

    if (!risposta.ok && risposta.status !== 404) {
      // Il corpo di un errore S3 e' XML e contiene il codice vero
      // (`SignatureDoesNotMatch`, `NoSuchBucket`, `AccessDenied`). Senza,
      // resta un 403 che puo' voler dire cinque cose diverse. Si tronca:
      // finisce in un log, non in una risposta all'utente.
      const dettaglio = (await risposta.text().catch(() => "")).slice(0, 500);
      throw new S3StorageError(operazione, risposta.status, dettaglio);
    }

    return risposta;
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    await this.#send("put", "PUT", input.key, {
      data: input.data,
      mimeType: input.mimeType,
    });

    return {
      key: input.key,
      url: this.#urlFor(input.key).toString(),
      mimeType: input.mimeType,
      sizeBytes: input.data.byteLength,
    };
  }

  async get(key: string): Promise<Uint8Array> {
    const risposta = await this.#send("get", "GET", key);
    if (risposta.status === 404) {
      throw new S3StorageError("get", 404, `chiave assente: ${key}`);
    }
    return new Uint8Array(await risposta.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    // Un 404 su una cancellazione non e' un guasto: lo stato voluto e' che la
    // chiave non ci sia, ed e' gia' cosi'.
    await this.#send("delete", "DELETE", key);
  }

  async exists(key: string): Promise<boolean> {
    const risposta = await this.#send("exists", "HEAD", key);
    return risposta.ok;
  }
}
