import {
  S3StorageProvider,
  type S3Config,
} from "../../../apps/api/src/providers/S3StorageProvider.js";

/**
 * Il bucket dei test: MinIO, cioe' un servizio che parla S3 davvero.
 *
 * `FakeStorageProvider` impagina, conta i byte e sa dire di no. Quello che non
 * ha e' un protocollo: non c'e' una firma che possa non tornare, non c'e' un
 * XML da interpretare, e il suo segnalibro di pagina e' un numero che si
 * inventa lui. Sono esattamente le tre cose che `S3StorageProvider` fa e che
 * nessun test provava, perche' fra `sigv4.test.ts` — che confronta la firma con
 * i vettori AWS senza mandarla a nessuno — e `storageList.test.ts` — che
 * interpreta un XML scritto a mano — non passa mai una richiesta HTTP.
 *
 * ## Perche' cinque variabili e nessun default
 *
 * Perche' la suite svuota questo bucket, e un default lo farebbe puntare a
 * quello di sviluppo. E' la stessa ragione per cui `DATABASE_URL_TEST` non ha
 * un default e per cui `globalSetup` rifiuta di partire se coincide con
 * `DATABASE_URL`: un TRUNCATE e una `delete` su un oggetto non chiedono
 * conferma, e il momento in cui ci si accorge dell'errore e' dopo.
 */

export const VARIABILI = [
  "S3_ENDPOINT_TEST",
  "S3_BUCKET_TEST",
  "S3_REGION_TEST",
  "S3_ACCESS_KEY_ID_TEST",
  "S3_SECRET_ACCESS_KEY_TEST",
] as const;

export class BucketDiTestAssente extends Error {
  constructor(motivo: string) {
    super(
      [
        motivo,
        "",
        "  1. Copy-Item .env.example .env",
        "  2. docker compose up -d",
        "  3. npm run test:integration",
        "",
        "Il compose alza MinIO e crea i due bucket. Non c'e' un valore di default",
        "di proposito: la suite svuota il bucket dei test, e un default che punta",
        "a quello di sviluppo cancellerebbe gli audio veri in silenzio.",
      ].join("\n"),
    );
    this.name = "BucketDiTestAssente";
  }
}

function leggi(nome: string): string {
  const valore = process.env[nome];
  if (valore === undefined || valore.trim() === "") {
    throw new BucketDiTestAssente(`${nome} non e' configurata.`);
  }
  return valore.trim();
}

/**
 * La configurazione del bucket dei test, letta dall'ambiente.
 *
 * `forcePathStyle` e' fisso a `true` e non arriva da una variabile: MinIO non
 * fa l'host virtuale per bucket, quindi `false` qui produrrebbe richieste verso
 * `wikimylife-test.127.0.0.1`, che non risolve. Lasciarlo configurabile
 * avrebbe voluto dire una sesta variabile con un solo valore giusto.
 */
export function testS3Config(): S3Config {
  const bucket = leggi("S3_BUCKET_TEST");

  if (bucket === process.env["S3_BUCKET"]?.trim()) {
    throw new BucketDiTestAssente(
      "S3_BUCKET_TEST e S3_BUCKET nominano lo stesso bucket: la suite lo svuoterebbe.",
    );
  }

  return {
    bucket,
    region: leggi("S3_REGION_TEST"),
    accessKeyId: leggi("S3_ACCESS_KEY_ID_TEST"),
    secretAccessKey: leggi("S3_SECRET_ACCESS_KEY_TEST"),
    endpoint: leggi("S3_ENDPOINT_TEST"),
    forcePathStyle: true,
  };
}

/**
 * Le variabili nella forma che `loadConfig` si aspetta.
 *
 * Serve a `startTestServer({ storage: "s3" })`: l'API non conosce le `_TEST`,
 * conosce le sue, e comporre il provider a mano per poi infilarlo dentro la
 * composizione salterebbe proprio il pezzo che si vuole provare — che
 * `STORAGE_PROVIDER=s3` piu' quelle variabili costruiscano un provider che
 * funziona.
 */
export function testS3Env(): Record<string, string> {
  const config = testS3Config();
  return {
    STORAGE_PROVIDER: "s3",
    S3_BUCKET: config.bucket,
    S3_REGION: config.region,
    S3_ACCESS_KEY_ID: config.accessKeyId,
    S3_SECRET_ACCESS_KEY: config.secretAccessKey,
    S3_ENDPOINT: config.endpoint ?? "",
    S3_FORCE_PATH_STYLE: "true",
  };
}

export function testStorage(): S3StorageProvider {
  return new S3StorageProvider(testS3Config());
}

/**
 * Toglie tutto quello che c'e' dentro, e dice quanto ha tolto.
 *
 * L'equivalente di `resetDatabase()`, e come quello va chiamato fra un caso e
 * l'altro: il bucket vive quanto il container, non quanto il file di test, e
 * un oggetto lasciato indietro da un caso diventa un `esaminati: 1` in piu' nel
 * riassunto del caso dopo — un fallimento che parla di una passata che non
 * c'entra niente.
 *
 * Ricomincia dalla prima pagina invece di seguire il segnalibro, e non e' una
 * svista: le chiavi che il segnalibro nominava sono appena state cancellate, e
 * chiedere «cosa viene dopo quella» a un bucket in cui quella non c'e' piu' e'
 * il genere di domanda su cui i servizi veri si comportano diversamente l'uno
 * dall'altro. Con millecinque oggetti si fanno due scorse invece di una, e la
 * seconda ne trova cinque.
 */
export async function svuotaIlBucket(storage: S3StorageProvider): Promise<number> {
  let tolti = 0;

  // Il tetto esiste per una cosa vista davvero. Una `delete` che fallisce lancia
  // — `S3StorageProvider` tollera solo i 404 — ma una che risponde `204` senza
  // togliere niente no: la pagina successiva riporta le stesse chiavi, e il
  // ciclo gira per sempre. E' successo durante il mutation testing, e la
  // mutazione ci ha messo trentaquattro minuti a morire dove le altre ne
  // impiegavano quaranta secondi. Il numero e' generoso di proposito: nessun
  // caso di questa suite lascia dietro piu' di un paio di migliaia di oggetti,
  // quindi superarlo non significa «bucket grosso», significa «le cancellazioni
  // non hanno effetto» — ed e' quello che dice il messaggio.
  const SCORSE_MASSIME = 20;

  for (let scorsa = 0; scorsa < SCORSE_MASSIME; scorsa += 1) {
    const pagina = await storage.list();
    if (pagina.objects.length === 0) {
      return tolti;
    }
    for (const oggetto of pagina.objects) {
      await storage.delete(oggetto.key);
      tolti += 1;
    }
  }

  throw new Error(
    `svuotaIlBucket: dopo ${String(SCORSE_MASSIME)} scorse e ${String(tolti)} cancellazioni il bucket non e' vuoto. Le delete rispondono ma non cancellano.`,
  );
}
