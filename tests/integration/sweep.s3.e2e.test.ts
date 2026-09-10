import { randomUUID } from "node:crypto";
import {
  authSessionSchema,
  recordingStateSchema,
  type CaptureMetadataInput,
  type RecordingState,
} from "@wikimylife/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { S3StorageProvider } from "../../apps/api/src/providers/S3StorageProvider.js";
import type { SweepSummary } from "../../apps/api/src/services/storageSweep.service.js";
import { disconnectTestPrisma, resetDatabase } from "./helpers/db.js";
import { call, callBinary, startTestServer, uploadRecording, type TestServer } from "./helpers/server.js";
import { svuotaIlBucket, testStorage } from "./helpers/storage.js";

/**
 * La scopa contro un bucket vero, che e' l'altra meta' di `sweep.e2e.test.ts`.
 *
 * Quel file mise sotto la scopa un Postgres vero e risolse la domanda che il
 * repository finto non poteva porre: se `findExistingAudioKeys` riconosca le
 * chiavi che il caricamento scrive davvero. Dall'altra parte pero' restava la
 * memoria, e con lei tutto cio' che un servizio vero fa e un `Map` no.
 *
 * Tre cose, in ordine di quanto costerebbero.
 *
 * **Il segnalibro dopo una cancellazione.** E' la piu' grossa, e finora era una
 * frase. `storageSweep.service.ts` cancella blocco per blocco *mentre* scorre,
 * e il commento che lo giustifica dice che si puo' fare perche' il segnalibro
 * di `list` «dice dopo quale oggetto riprendere e non a quale posizione». Vero
 * per il protocollo, mai verificato contro qualcuno che lo implementi: la
 * seconda pagina si chiede con un segnalibro costruito sull'ultima chiave della
 * prima, e quella chiave a quel punto e' stata cancellata da un istante. Se un
 * servizio rispondesse con una pagina vuota, la scopa concluderebbe la passata
 * annunciando di aver finito, e tutto cio' che stava oltre il migliaio non
 * verrebbe guardato mai piu' — nessun errore, nessun conteggio strano, solo un
 * bucket che non smette di crescere.
 *
 * **La forma delle chiavi che tornano indietro.** Un servizio vero puo'
 * restituirle con un prefisso, codificate, o normalizzate. Basta uno scarto di
 * un carattere fra la chiave elencata e quella salvata in `Recording.audioUrl`
 * perche' la regola 1 dica «nessuna riga lo nomina» di ogni audio vivo del
 * sistema.
 *
 * **Che la cancellazione cancelli.** `FakeStorageProvider` toglie una voce da
 * una mappa e non puo' fallire a meta'. Qui i byte vanno via da un servizio, e
 * `cancellati: 1` nel riassunto e' un conteggio, non una prova.
 *
 * Cio' che questo file NON copre e resta di `sweep.e2e.test.ts`: la regola 2.
 * Invecchiare un oggetto e' un potere che il finto ha — `touch()` — e un bucket
 * vero non da' a nessuno, perche' la data di un oggetto la scrive il servizio.
 */

const PASSWORD = "password-di-prova-lunga";
const RECORDED_AT = "2026-03-01T09:30:00.000Z";

/**
 * Grazia negativa: «abbastanza vecchio» diventa «nato prima di un minuto nel
 * futuro», cioe' tutto.
 *
 * Serve perche' qui la data degli oggetti la scrive MinIO, dentro il container,
 * e la soglia la calcola il test, fuori. Sono due orologi, e con `graceMs: 0`
 * basterebbe mezzo secondo di scarto perche' un oggetto appena scritto risulti
 * «troppo recente» e il caso fallisse un giorno su dieci senza che niente sia
 * cambiato. Il minuto e' lo scarto piu' grande che valga la pena tollerare.
 *
 * Non toglie niente alla copertura: la regola 2 ha i suoi casi in
 * `storageSweep.test.ts` e in `sweep.e2e.test.ts`, e quelli la provano con un
 * orologio solo. Qui il soggetto e' la regola 1 e cio' che viene dopo.
 */
const NESSUNA_GRAZIA = -60_000;

/** Uno in piu' del massimo che S3 mette in una pagina. */
const OLTRE_UNA_PAGINA = 1001;

let server: TestServer;
let bucket: S3StorageProvider;

beforeAll(async () => {
  server = await startTestServer({ storage: "s3" });
  bucket = testStorage();
});

afterAll(async () => {
  await svuotaIlBucket(bucket);
  await server.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase();
  await svuotaIlBucket(bucket);
});

// ---------------------------------------------------------------------------
// Attrezzi
// ---------------------------------------------------------------------------

let contatore = 0;

async function signup(): Promise<string> {
  contatore += 1;
  const res = await call(server, "POST", "/api/auth/signup", {
    body: { email: `scopa-s3-${String(contatore)}@wikimylife.test`, password: PASSWORD },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return authSessionSchema.parse(res.body).tokens.accessToken;
}

function metadata(): CaptureMetadataInput {
  return {
    recordedAt: RECORDED_AT,
    durationMs: 42_000,
    mimeType: "audio/webm;codecs=opus",
    capturedOffline: false,
    deviceLocale: "it-IT",
  };
}

async function carica(token: string, audio: Uint8Array): Promise<RecordingState> {
  const res = await uploadRecording(server, { accessToken: token, metadata: metadata(), audio });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return recordingStateSchema.parse(res.body);
}

/** La chiave dell'oggetto, letta dal database e non ricostruita. */
async function chiaveDi(id: string): Promise<string> {
  const row = await server.prisma.recording.findUniqueOrThrow({
    where: { id },
    select: { audioUrl: true },
  });
  return row.audioUrl;
}

async function scopa(): Promise<SweepSummary> {
  return server.composition.storageSweepService.esegui({
    cancella: true,
    graceMs: NESSUNA_GRAZIA,
  });
}

async function chiaviNelBucket(): Promise<readonly string[]> {
  const tutte: string[] = [];
  let token: string | undefined;
  do {
    const pagina = await bucket.list({ continuationToken: token });
    tutte.push(...pagina.objects.map((o) => o.key));
    token = pagina.continuationToken;
  } while (token !== undefined);
  return tutte;
}

// ---------------------------------------------------------------------------

describe("la scopa, con un bucket vero sotto", () => {
  it("lascia intatto l'audio vivo, e i byte si riscaricano da dove li chiederebbe l'utente", async () => {
    const token = await signup();
    const registrazione = await carica(token, new Uint8Array([9, 8, 7, 6, 5]));

    const esito = await scopa();

    expect(esito).toMatchObject({ esaminati: 1, nominati: 1, orfani: 0, cancellati: 0 });

    // Il giro intero: il caricamento ha scritto su MinIO, `list` ha riportato
    // quella chiave nella forma in cui il database la nomina, e adesso l'API la
    // rilegge dal bucket e la ristreamma. Se una qualunque delle tre la
    // trattasse diversamente, il riassunto qui sopra direbbe `orfani: 1` — o
    // questi cinque byte non arriverebbero.
    const audio = await callBinary(server, `/api/recordings/${registrazione.id}/audio`, {
      accessToken: token,
    });
    expect(audio.status).toBe(200);
    expect(Array.from(audio.bytes)).toEqual([9, 8, 7, 6, 5]);
  });

  it("l'orfano non e' solo contato: i byte non ci sono piu' nel bucket", async () => {
    const token = await signup();
    const registrazione = await carica(token, new Uint8Array([4, 2]));
    const chiave = await chiaveDi(registrazione.id);

    // La riga sparisce senza passare dal servizio, che avrebbe tolto anche
    // l'oggetto: e' la meta' esatta che la scopa esiste per raccogliere.
    await server.prisma.recording.delete({ where: { id: registrazione.id } });

    const esito = await scopa();

    expect(esito).toMatchObject({ esaminati: 1, orfani: 1, cancellati: 1, falliti: 0 });
    expect(esito.byteOrfani).toBe(2);
    // `cancellati: 1` dice che la chiamata non ha lanciato. Questa riga dice
    // che il servizio ha fatto quello che gli era stato chiesto, ed e' l'unica
    // delle due che un bucket in memoria non poteva dire.
    expect(await bucket.exists(chiave)).toBe(false);
  });

  it("non tocca un file che qualcun altro ha messo nel bucket", async () => {
    const estraneo = "backup/2026-03-01/dump.sql";
    await bucket.put({
      key: estraneo,
      data: new Uint8Array([1, 2, 3]),
      mimeType: "application/sql",
    });

    const esito = await scopa();

    // Regola 3: nessuna riga lo nomina ed e' vecchio a sufficienza, quindi le
    // prime due regole lo condannerebbero. E' la forma della chiave a salvarlo,
    // ed e' l'unica cosa che lo salva.
    expect(esito).toMatchObject({ esaminati: 1, estranei: 1, orfani: 0, cancellati: 0 });
    expect(await bucket.exists(estraneo)).toBe(true);
  });

  it(
    "arriva anche oltre il migliaio, dopo aver cancellato le chiavi su cui il segnalibro si appoggia",
    async () => {
      const token = await signup();
      const registrazione = await carica(token, new Uint8Array([1]));
      const viva = await chiaveDi(registrazione.id);

      // Mille orfani con la forma giusta, tutti ordinati prima di quello vivo:
      // cosi' la chiave viva finisce sulla seconda pagina, cioe' oltre il punto
      // in cui la passata puo' fermarsi in silenzio.
      const morte: string[] = [];
      for (let i = 0; i < OLTRE_UNA_PAGINA - 1; i += 1) {
        morte.push(`0scopa-${String(i).padStart(4, "0")}/${randomUUID()}.webm`);
      }

      // Se un giorno gli id degli utenti smettessero di cominciare per lettera,
      // l'ordine qui sopra non varrebbe piu' e il caso proverebbe un'altra cosa
      // senza dirlo. Meglio che fallisca qui, dove c'e' scritto perche'.
      expect(
        morte.every((k) => k < viva),
        `la chiave viva ${viva} deve ordinarsi dopo tutte le altre`,
      ).toBe(true);

      const GRUPPO = 50;
      for (let i = 0; i < morte.length; i += GRUPPO) {
        await Promise.all(
          morte.slice(i, i + GRUPPO).map((key) =>
            bucket.put({ key, data: new Uint8Array([0]), mimeType: "audio/webm" }),
          ),
        );
      }

      const esito = await scopa();

      // `esaminati` e' il numero che cadrebbe per primo: una seconda pagina che
      // tornasse vuota lo lascerebbe a mille, con `interrotta: false` e nessun
      // errore da nessuna parte.
      expect(esito).toMatchObject({
        esaminati: OLTRE_UNA_PAGINA,
        nominati: 1,
        orfani: OLTRE_UNA_PAGINA - 1,
        cancellati: OLTRE_UNA_PAGINA - 1,
        falliti: 0,
        interrotta: false,
      });

      // E l'insieme, non il conteggio: mille cancellazioni sono mille anche se
      // fra quelle c'e' la chiave viva e fuori ne resta una morta.
      expect(await chiaviNelBucket()).toEqual([viva]);
    },
    180_000,
  );
});
