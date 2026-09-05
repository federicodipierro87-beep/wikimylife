import { createHash, createHmac } from "node:crypto";

/**
 * Firma AWS Signature Version 4, scritta a mano.
 *
 * `@aws-sdk/client-s3` risolve lo stesso problema portandosi dietro una
 * cinquantina di pacchetti e qualche decina di megabyte in `node_modules`, per
 * usarne quattro operazioni: PUT, GET, DELETE, HEAD di un oggetto. Qui ci sono
 * novanta righe e nessuna dipendenza nuova, coerente con il resto del
 * repository — `dotenv`, `supertest`, `pino` e `uuid` non ci sono per la stessa
 * ragione.
 *
 * Il vantaggio vero non e' il peso: e' che l'algoritmo e' pubblico e stabile
 * dal 2012, quindi lo stesso codice firma per AWS S3, Cloudflare R2, Backblaze
 * B2, MinIO e chiunque altro esponga l'API S3. Il giorno in cui si cambia
 * fornitore cambia una variabile d'ambiente, non una libreria.
 *
 * Questo modulo e' puro: date, chiavi e corpo entrano come parametri e ne esce
 * un dizionario di intestazioni. E' cio' che permette a
 * `tests/unit/sigv4.test.ts` di confrontarlo con i vettori di prova pubblicati
 * da AWS invece di fidarsi che «sembri giusto».
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const TERMINATOR = "aws4_request";

/** Il corpo vuoto, precalcolato: e' lo sha256 di zero byte. */
export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface SignInput {
  readonly method: string;
  /** Deve avere il percorso gia' codificato: si veda `encodeKey`. */
  readonly url: URL;
  /**
   * Intestazioni aggiuntive da firmare. `host`, `x-amz-date` e
   * `x-amz-content-sha256` le aggiunge questa funzione.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadSha256: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly service: string;
  readonly now: Date;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * La catena di derivazione: segreto → data → regione → servizio → terminatore.
 *
 * Quattro HMAC invece di uno perche' la chiave che firma davvero non deve
 * poter servire a un'altra data, un'altra regione o un altro servizio: se
 * trapela, scade da sola dopo un giorno.
 */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, TERMINATOR);
}

/**
 * La codifica percentuale secondo AWS, che non e' quella di
 * `encodeURIComponent`.
 *
 * L'insieme dei caratteri da lasciare intatti e' `A-Za-z0-9-_.~` e basta;
 * `encodeURIComponent` risparmia anche `!'()*`, che qui vanno codificati. Una
 * chiave con una parentesi firmata in un modo e inviata in un altro produce un
 * `SignatureDoesNotMatch` che nessun log spiega.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Traduce una chiave di object storage nel percorso di una URL.
 *
 * Le barre restano barre — sono separatori, non parte del nome — e ogni
 * segmento si codifica una volta sola. S3 e' l'unico servizio AWS che NON
 * vuole la doppia codifica del percorso nella richiesta canonica: qui il
 * percorso si firma esattamente come si invia.
 */
export function encodeKey(key: string): string {
  return key.split("/").map(uriEncode).join("/");
}

/** `20150830T123600Z`, l'unico formato che SigV4 accetta. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function canonicalQueryString(url: URL): string {
  const parti: string[] = [];
  for (const [chiave, valore] of url.searchParams) {
    parti.push(`${uriEncode(chiave)}=${uriEncode(valore)}`);
  }
  // Ordine lessicografico sulla coppia gia' codificata: e' la regola di AWS, e
  // `URLSearchParams` conserva l'ordine di inserimento, che non e' lo stesso.
  parti.sort();
  return parti.join("&");
}

export interface CanonicalRequest {
  readonly text: string;
  readonly signedHeaders: string;
}

export function canonicalRequest(
  method: string,
  url: URL,
  headers: Readonly<Record<string, string>>,
  payloadSha256: string,
): CanonicalRequest {
  const normalizzate = Object.entries(headers)
    .map(([nome, valore]) => [nome.toLowerCase(), valore.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = normalizzate.map(([n, v]) => `${n}:${v}\n`).join("");
  const signedHeaders = normalizzate.map(([n]) => n).join(";");

  const text = [
    method,
    // Gia' codificato da `encodeKey`: `URL` non lo tocca se contiene solo
    // caratteri non riservati, quindi ricodificarlo qui lo raddoppierebbe.
    url.pathname,
    canonicalQueryString(url),
    canonicalHeaders,
    signedHeaders,
    payloadSha256,
  ].join("\n");

  return { text, signedHeaders };
}

/**
 * Firma la richiesta e restituisce le intestazioni da inviare.
 *
 * `host` viene firmato ma NON restituito: `fetch` lo deriva dalla URL e
 * rifiuta di farselo imporre. I due valori coincidono per costruzione, incluso
 * l'eventuale numero di porta.
 */
export function signRequest(input: SignInput): Record<string, string> {
  const data = amzDate(input.now);
  const giorno = data.slice(0, 8);
  const scope = `${giorno}/${input.region}/${input.service}/${TERMINATOR}`;

  const daFirmare: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    "x-amz-date": data,
  };

  // `x-amz-content-sha256` e' un requisito di S3, non di SigV4: gli altri
  // servizi AWS non lo vogliono fra le intestazioni firmate. Tenerlo
  // condizionato al servizio e' anche cio' che permette al test di riprodurre
  // alla lettera i vettori ufficiali, che usano un servizio finto.
  if (input.service === "s3") {
    daFirmare["x-amz-content-sha256"] = input.payloadSha256;
  }

  const canonica = canonicalRequest(input.method, input.url, daFirmare, input.payloadSha256);

  const stringToSign = [ALGORITHM, data, scope, sha256Hex(canonica.text)].join("\n");

  const firma = hmac(
    signingKey(input.secretAccessKey, giorno, input.region, input.service),
    stringToSign,
  ).toString("hex");

  const { host: _host, ...daInviare } = daFirmare;

  return {
    ...daInviare,
    authorization:
      `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${canonica.signedHeaders}, Signature=${firma}`,
  };
}
