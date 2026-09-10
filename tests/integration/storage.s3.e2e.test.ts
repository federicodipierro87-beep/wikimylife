import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  S3StorageError,
  S3StorageProvider,
} from "../../apps/api/src/providers/S3StorageProvider.js";
import {
  BucketDiTestAssente,
  svuotaIlBucket,
  testS3Config,
  testStorage,
} from "./helpers/storage.js";

/**
 * `S3StorageProvider` contro un servizio che parla S3 davvero.
 *
 * Fino a qui il provider di produzione era l'unico pezzo del sistema senza un
 * test che lo eseguisse. Non per distrazione: le due meta' di cui e' fatto ne
 * hanno uno per parte. `sigv4.test.ts` confronta la firma con i vettori
 * pubblicati da AWS, che e' quanto di piu' autorevole ci sia, e
 * `storageList.test.ts` interpreta un XML di risposta. Fra i due pero' non
 * passa nessuna richiesta: nessuno aveva mai preso quella firma, l'aveva
 * attaccata a quella URL, e aveva letto cosa rispondeva un server.
 *
 * Quello che si scopre solo cosi' e' l'elenco delle cose che stanno *fra* i due
 * test: che l'host firmato sia quello inviato — porta compresa — che il
 * percorso non venga codificato due volte, che il segnalibro di pagina
 * sopravviva al giro dentro la query firmata, che un 404 arrivi dove il codice
 * lo aspetta e non un secondo prima. Ognuna di queste, sbagliata, produce un
 * `SignatureDoesNotMatch` o un `AccessDenied`: cioe' un messaggio che parla di
 * credenziali mentre il difetto e' un carattere.
 *
 * MinIO e non AWS perche' e' lo stesso protocollo e sta in un container. Non
 * copre le differenze fra fornitori — R2 non pagina identico a S3 — ma copre
 * l'unica domanda che nessun test poteva fare prima: se questo codice sappia
 * parlare con qualcuno.
 */

const KILO = 1000;

let storage: S3StorageProvider;

beforeAll(() => {
  storage = testStorage();
});

beforeEach(async () => {
  await svuotaIlBucket(storage);
});

afterAll(async () => {
  await svuotaIlBucket(storage);
});

const CHIAVE = "utente-uno/audio.webm";

function byte(...valori: readonly number[]): Uint8Array {
  return new Uint8Array(valori);
}

describe("il bucket vero, andata e ritorno", () => {
  it("restituisce gli stessi byte che ha ricevuto, compresi quelli che non sono testo", async () => {
    // 0x00 e 0xFF non sono UTF-8 validi: un provider che passasse dal testo da
    // qualche parte — un `await risposta.text()` invece di `arrayBuffer()` —
    // li renderebbe entrambi 0xEF 0xBF 0xBD, e la registrazione tornerebbe
    // illeggibile senza che nessuno sbagli uno status code.
    const dati = byte(0x00, 0x1a, 0x45, 0xdf, 0xa3, 0xff, 0x80, 0x7f);

    const messo = await storage.put({ key: CHIAVE, data: dati, mimeType: "audio/webm" });
    expect(messo.key).toBe(CHIAVE);
    expect(messo.sizeBytes).toBe(8);

    expect(Array.from(await storage.get(CHIAVE))).toEqual(Array.from(dati));
  });

  it("dice che una chiave c'e' quando c'e', e che non c'e' quando e' stata tolta", async () => {
    expect(await storage.exists(CHIAVE)).toBe(false);

    await storage.put({ key: CHIAVE, data: byte(1), mimeType: "audio/webm" });
    expect(await storage.exists(CHIAVE)).toBe(true);

    await storage.delete(CHIAVE);
    expect(await storage.exists(CHIAVE)).toBe(false);
  });

  it("sostituisce i byte di una chiave che c'era gia', invece di affiancarli", async () => {
    await storage.put({ key: CHIAVE, data: byte(1, 1, 1), mimeType: "audio/webm" });
    await storage.put({ key: CHIAVE, data: byte(2, 2), mimeType: "audio/webm" });

    expect(Array.from(await storage.get(CHIAVE))).toEqual([2, 2]);
    expect((await storage.list()).objects).toHaveLength(1);
  });

  it("chiedere i byte di una chiave che non c'e' e' un errore, non un file vuoto", async () => {
    // La differenza conta piu' di quanto sembri: `GET /api/recordings/:id/audio`
    // ristreamma cio' che riceve da qui, e un array vuoto restituito senza
    // lamentarsi diventa un 200 con zero byte — un audio che il browser apre,
    // mostra lungo zero secondi, e fa credere perduto cio' che invece e' solo
    // stato cercato con la chiave sbagliata.
    await expect(storage.get("utente-uno/mai-scritto.webm")).rejects.toThrow(S3StorageError);
  });

  it("cancellare una chiave che non c'e' non e' un errore: lo stato voluto e' gia' quello", async () => {
    await expect(storage.delete("utente-uno/mai-scritto.webm")).resolves.toBeUndefined();
  });

  it("porta al ritorno una chiave che la firma deve codificare, e non un'altra", async () => {
    // Spazio, parentesi e piu': i tre modi in cui `uriEncode` puo' divergere da
    // `encodeURIComponent`, che risparmia `!'()*` mentre AWS li vuole
    // codificati. Se il percorso viene firmato in un modo e inviato in un
    // altro, la risposta e' `SignatureDoesNotMatch` — e questo caso e' l'unico
    // posto del repository in cui quella divergenza puo' manifestarsi, perche'
    // `sigv4.test.ts` verifica la codifica contro se stessa e nessun server.
    const scomoda = "utente-uno/registrazione (2) +bis.webm";

    await storage.put({ key: scomoda, data: byte(7, 7), mimeType: "audio/webm" });

    expect(Array.from(await storage.get(scomoda))).toEqual([7, 7]);
    expect((await storage.list()).objects.map((o) => o.key)).toEqual([scomoda]);
  });
});

describe("l'elenco, che e' cio' su cui la scopa decide", () => {
  it("dice chiave, byte e data di ogni oggetto, e la data e' una data", async () => {
    const prima = Date.now();
    await storage.put({ key: CHIAVE, data: byte(1, 2, 3, 4, 5), mimeType: "audio/webm" });

    const pagina = await storage.list();

    expect(pagina.objects).toHaveLength(1);
    const [oggetto] = pagina.objects;
    expect(oggetto?.key).toBe(CHIAVE);
    expect(oggetto?.sizeBytes).toBe(5);

    // La regola 2 della scopa fa `Date.parse(lastModified)`: se il formato non
    // si interpretasse, `Date.parse` darebbe NaN, ogni confronto sarebbe falso,
    // e ogni oggetto risulterebbe abbastanza vecchio da essere spazzatura.
    // Un `toBeDefined()` non lo direbbe.
    const quando = Date.parse(oggetto?.lastModified ?? "");
    expect(Number.isNaN(quando)).toBe(false);
    // Un minuto di margine da tutte e due le parti: l'orologio del container e
    // quello dell'host non sono lo stesso orologio.
    expect(quando).toBeGreaterThan(prima - 60_000);
    expect(quando).toBeLessThan(Date.now() + 60_000);
  });

  it("con un prefisso porta solo cio' che comincia cosi', e lascia fuori il resto", async () => {
    await storage.put({ key: "utente-uno/a.webm", data: byte(1), mimeType: "audio/webm" });
    await storage.put({ key: "utente-uno/b.webm", data: byte(1), mimeType: "audio/webm" });
    await storage.put({ key: "utente-due/c.webm", data: byte(1), mimeType: "audio/webm" });

    const filtrata = await storage.list({ prefix: "utente-uno/" });
    expect(filtrata.objects.map((o) => o.key).sort()).toEqual([
      "utente-uno/a.webm",
      "utente-uno/b.webm",
    ]);

    // E l'errore opposto: senza prefisso ci sono tutti e tre. Un `list` che
    // ignorasse il parametro passerebbe la meta' qui sopra solo se il bucket
    // contenesse esclusivamente quel prefisso.
    expect((await storage.list()).objects).toHaveLength(3);
  });

  it("il prefisso taglia i caratteri, non i segmenti di percorso", async () => {
    await storage.put({ key: "utente-uno/a.webm", data: byte(1), mimeType: "audio/webm" });
    await storage.put({ key: "utente-uno-bis/b.webm", data: byte(1), mimeType: "audio/webm" });

    // `--prefix=utente-uno` da riga di comando sembra dire «la cartella
    // utente-uno», e non lo dice: S3 confronta byte, non segmenti, quindi ci
    // entra anche l'utente il cui id comincia per gli stessi caratteri. Gli id
    // qui sono inventati, ma la forma e' quella vera — la chiave e'
    // `${userId}/${uuid}.${est}` e i cuid condividono spesso il primo pezzo.
    // Chi passa la scopa con `cancella` su un prefisso scritto senza barra
    // finale tocca l'archivio di qualcun altro, ed e' scritto qui perche'
    // nessun altro punto del repository lo dice.
    expect((await storage.list({ prefix: "utente-uno" })).objects.map((o) => o.key).sort()).toEqual([
      "utente-uno-bis/b.webm",
      "utente-uno/a.webm",
    ]);

    expect((await storage.list({ prefix: "utente-uno/" })).objects.map((o) => o.key)).toEqual([
      "utente-uno/a.webm",
    ]);
  });

  it("oltre il migliaio da un segnalibro, e il segnalibro riporta esattamente il resto", async () => {
    // Mille e uno, cioe' uno in piu' del massimo che S3 mette in una pagina.
    // E' il numero piu' piccolo che costringe il servizio a produrre un
    // `NextContinuationToken` vero: una stringa base64 che contiene `+`, `/` e
    // `=`, cioe' i tre caratteri su cui la codifica percentuale della query
    // firmata puo' sbagliare. Il finto in memoria un segnalibro se lo inventa,
    // e se lo inventa senza quei caratteri.
    const attese = await riempi(KILO + 1);

    const prima = await storage.list();
    expect(prima.objects).toHaveLength(KILO);
    expect(prima.continuationToken).toBeDefined();

    const seconda = await storage.list({ continuationToken: prima.continuationToken });
    expect(seconda.objects).toHaveLength(1);
    // La fine si dichiara: un segnalibro che restasse definito manderebbe la
    // scopa a girare sull'ultima pagina per sempre.
    expect(seconda.continuationToken).toBeUndefined();

    // L'insieme e non i due conteggi: mille piu' uno fa mille e uno anche se la
    // seconda pagina ripete una chiave della prima e ne salta un'altra.
    const viste = [...prima.objects, ...seconda.objects].map((o) => o.key);
    expect(new Set(viste).size).toBe(KILO + 1);
    expect([...viste].sort()).toEqual([...attese].sort());
  }, 180_000);
});

describe("quando il bucket non e' quello che si crede", () => {
  it("un bucket che non esiste e' un errore, e non un bucket vuoto", async () => {
    // E' la tolleranza ai 404 di `#send` che qui sarebbe una bugia: «nessun
    // oggetto» e «nessun bucket» hanno la stessa forma, e la scopa che ricevesse
    // la prima al posto della seconda concluderebbe che non c'e' niente da
    // fare. Con `cancella` acceso sarebbe innocuo per caso; con un bucket
    // scritto male in configurazione, il registro direbbe ogni giorno che tutto
    // e' a posto.
    const altrove = new S3StorageProvider({
      ...testS3Config(),
      bucket: "questo-bucket-non-esiste-davvero",
    });

    await expect(altrove.list()).rejects.toThrow(S3StorageError);
  });

  it("una firma sbagliata si annuncia, invece di somigliare a un bucket vuoto", async () => {
    const conChiaveStorta = new S3StorageProvider({
      ...testS3Config(),
      secretAccessKey: "questo-non-e-il-segreto-giusto",
    });

    // 403, non 404: la differenza fra «non ti conosco» e «non c'e'» e' la
    // prima cosa che si guarda quando la produzione smette di salvare audio.
    await expect(conChiaveStorta.list()).rejects.toMatchObject({
      name: "S3StorageError",
      status: 403,
    });
  });
});

describe("la guardia che impedisce alla suite di svuotare il bucket sbagliato", () => {
  /**
   * L'unico caso di questo file che non tocca il bucket, e non e' un caso di
   * troppo.
   *
   * `svuotaIlBucket` gira in un `beforeEach`, quindi se `S3_BUCKET_TEST` e
   * `S3_BUCKET` nominassero lo stesso posto la suite comincerebbe cancellando
   * gli audio di chi sta provando l'app — in silenzio, e restando verde. La
   * riga che lo impedisce e' una sola dentro `testS3Config`, e finche' non
   * c'era questo caso nessun test la eseguiva: toglierla non faceva fallire
   * niente, il che e' il modo peggiore in cui puo' stare una guardia.
   *
   * `S3_BUCKET` si tocca e si rimette a posto in un `finally`: e' l'ambiente
   * del processo, e i file d'integrazione girano in serie ma dentro lo stesso
   * processo.
   */
  it("rifiuta se S3_BUCKET_TEST e S3_BUCKET nominano lo stesso bucket", () => {
    const atteso = testS3Config().bucket;
    const prima = process.env["S3_BUCKET"];
    try {
      // Con degli spazi intorno, perche' la guardia confronta valori ripuliti:
      // scriverlo identico proverebbe anche una guardia che non lo fa.
      process.env["S3_BUCKET"] = `  ${atteso}  `;
      expect(() => testS3Config()).toThrow(BucketDiTestAssente);
    } finally {
      ripristina(prima);
    }
  });

  it("accetta quando i due nomi sono diversi, e anche quando S3_BUCKET non c'e' affatto", () => {
    // L'errore opposto: una guardia scritta male — un `!==` al posto di un
    // `===`, o un confronto che considera uguali due `undefined` — rifiuterebbe
    // sempre, e il caso qui sopra passerebbe lo stesso.
    const atteso = testS3Config().bucket;
    const prima = process.env["S3_BUCKET"];
    try {
      process.env["S3_BUCKET"] = `${atteso}-di-sviluppo`;
      expect(testS3Config().bucket).toBe(atteso);

      delete process.env["S3_BUCKET"];
      expect(testS3Config().bucket).toBe(atteso);
    } finally {
      ripristina(prima);
    }
  });
});

function ripristina(valore: string | undefined): void {
  if (valore === undefined) {
    delete process.env["S3_BUCKET"];
  } else {
    process.env["S3_BUCKET"] = valore;
  }
}

// ---------------------------------------------------------------------------

/**
 * Scrive `quanti` oggetti minuscoli e restituisce le chiavi.
 *
 * A gruppi e non uno per volta: mille e uno `PUT` in fila sono mille e uno
 * giri di rete in sequenza, e il caso diventerebbe piu' lento di tutto il
 * resto della suite messo insieme. A gruppi di cinquanta MinIO regge senza
 * lamentarsi e il caso resta sotto il minuto.
 */
async function riempi(quanti: number): Promise<readonly string[]> {
  const chiavi: string[] = [];
  for (let i = 0; i < quanti; i += 1) {
    // Riempito a sinistra: senza, `10` verrebbe prima di `9` nell'ordine
    // lessicografico di S3, e un caso che si aspetta un ordine si romperebbe
    // per una ragione che non c'entra con cio' che prova.
    chiavi.push(`paginazione/${String(i).padStart(5, "0")}.bin`);
  }

  const GRUPPO = 50;
  for (let i = 0; i < chiavi.length; i += GRUPPO) {
    await Promise.all(
      chiavi.slice(i, i + GRUPPO).map((key) =>
        storage.put({ key, data: byte(0), mimeType: "application/octet-stream" }),
      ),
    );
  }

  return chiavi;
}
