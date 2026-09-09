import {
  authSessionSchema,
  recordingStateSchema,
  type CaptureMetadataInput,
  type RecordingState,
} from "@wikimylife/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeStorageProvider } from "../../apps/api/src/providers/fake/index.js";
import {
  SWEEP_GRACE_MS,
  type SweepSummary,
} from "../../apps/api/src/services/storageSweep.service.js";
import { disconnectTestPrisma, resetDatabase } from "./helpers/db.js";
import { call, callBinary, startTestServer, uploadRecording, type TestServer } from "./helpers/server.js";

/**
 * La scopa contro il database vero, e contro le chiavi che scrive il caricamento.
 *
 * `storageSweep.test.ts` copre trenta casi con un repository in memoria: le tre
 * regole, le pagine, i blocchi, l'interruzione a meta'. Tutti veri, e tutti
 * ciechi sulla stessa cosa — in quei test le chiavi le scrive il test. Il
 * repository finto risponde «questa la conosco» perche' gliel'ha messa dentro
 * chi lo interroga, quindi la domanda che conta non gliela fa nessuno.
 *
 * La domanda che conta e' se `findExistingAudioKeys` riconosca le chiavi che
 * `recordings.service.ts` ha davvero scritto. In mezzo ci sono un `IN (...)` su
 * `Recording.audioUrl`, una colonna di Postgres e la stringa
 * `${userId}/${randomUUID()}.${est}` costruita al caricamento: un prefisso di
 * troppo, una normalizzazione, un `url` salvato al posto della `key`, e la
 * risposta diventa l'insieme vuoto. Non un errore — l'insieme vuoto. Che per la
 * regola 1 significa «nessuna riga lo nomina», cioe' orfano, cioe' da
 * cancellare: ogni audio vivo del sistema, tutto insieme.
 *
 * Con `SWEEP_MODE=elenca` sarebbe una pagina di registro sbagliata. Con
 * `cancella` sarebbe il bucket. E nessuna delle due suite se ne accorgerebbe,
 * perche' l'unica che parla di chiavi non le vede nascere e l'unica che le vede
 * nascere non passa mai dalla scopa.
 *
 * Da cui questo file, che fa una cosa sola: carica audio dall'HTTP, come
 * un'app, e poi passa la scopa con `cancella` acceso. Se le due parti non si
 * riconoscono, qui non ci si arriva in fondo.
 */

const PASSWORD = "password-di-prova-lunga";
const RECORDED_AT = "2026-03-01T09:30:00.000Z";

/** Piu' vecchio della soglia, cosi' la regola 2 non salva niente per sbaglio. */
const VECCHIO = new Date(Date.now() - SWEEP_GRACE_MS - 60_000);

let server: TestServer;
let blob: FakeStorageProvider;

beforeAll(async () => {
  server = await startTestServer();

  const { storage } = server.composition.providers;
  if (!(storage instanceof FakeStorageProvider)) {
    throw new Error("I test end-to-end richiedono i provider finti.");
  }
  blob = storage;
});

afterAll(async () => {
  await server.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase();
  // Lo storage finto vive quanto il server, cioe' quanto il file. Senza questo,
  // gli oggetti di un caso finirebbero nei conteggi di quello dopo, e un
  // `orfani: 1` diventerebbe `orfani: 4` senza che nessuna riga lo spieghi.
  for (const key of blob.keys) {
    await blob.delete(key);
  }
});

// ---------------------------------------------------------------------------
// Attrezzi
// ---------------------------------------------------------------------------

let contatore = 0;

async function signup(): Promise<string> {
  contatore += 1;
  const res = await call(server, "POST", "/api/auth/signup", {
    body: { email: `scopa-${String(contatore)}@wikimylife.test`, password: PASSWORD },
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

/**
 * Un caricamento vero, con la chiave scritta da chi la scrive in produzione.
 *
 * E' il punto di tutto il file: la chiave non compare da nessuna parte in
 * questo test, e nessuno la costruisce a mano. Se `audioUrl` finisse per
 * contenere qualcosa di diverso da cio' che il bucket elenca, non ci sarebbe
 * modo di accorgersene guardando queste righe — solo passandoci la scopa.
 */
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

/**
 * Passa la scopa cancellando davvero.
 *
 * `cancella: true` e non l'elenco, in un file che gira su un bucket in memoria:
 * il default prudente esiste per i bucket veri, e qui varrebbe solo a provare
 * meta' del percorso. Se la scopa sbaglia a riconoscere una chiave viva, un
 * riassunto con `orfani: 1` lo direbbe comunque — ma il caso in cui l'audio
 * sparisce e' quello che si vuole vedere fallire, non il conteggio.
 */
async function scopa(): Promise<SweepSummary> {
  return server.composition.storageSweepService.esegui({ cancella: true });
}

// ---------------------------------------------------------------------------

describe("la scopa, contro le chiavi che scrive davvero il caricamento", () => {
  it("non porta via l'audio di una registrazione viva, per quanto vecchio sia l'oggetto", async () => {
    const token = await signup();
    const registrazione = await carica(token, new Uint8Array([9, 8, 7, 6, 5]));
    const chiave = await chiaveDi(registrazione.id);

    // Vecchio abbastanza da superare la regola 2: quello che resta fra l'audio
    // e la cancellazione e' soltanto la regola 1, cioe' la query.
    blob.touch(chiave, VECCHIO);

    const esito = await scopa();

    expect(esito).toMatchObject({ esaminati: 1, nominati: 1, orfani: 0, cancellati: 0 });

    // E non basta il conteggio. Un riassunto giusto con un bucket vuoto sarebbe
    // il modo piu' silenzioso di sbagliare: i byte si richiedono da dove li
    // chiederebbe l'utente.
    const audio = await callBinary(server, `/api/recordings/${registrazione.id}/audio`, {
      accessToken: token,
    });
    expect(audio.status).toBe(200);
    expect(Array.from(audio.bytes)).toEqual([9, 8, 7, 6, 5]);
  });

  it("dentro lo stesso blocco distingue le chiavi vive da quelle morte", async () => {
    const token = await signup();

    const vive: string[] = [];
    for (const byte of [1, 2, 3]) {
      const registrazione = await carica(token, new Uint8Array([byte]));
      vive.push(await chiaveDi(registrazione.id));
    }

    // Due oggetti con la forma giusta e nessuna riga che li nomini: e' la
    // finestra fra il `put` e la `create` in cui un processo e' morto. Le
    // chiavi hanno la stessa forma delle vive — stesso utente, stessa
    // estensione — perche' un confronto che le distinguesse per qualcos'altro
    // che il contenuto del database non proverebbe niente.
    //
    // Due e non tre: con tre e tre, un riassunto che scambiasse i vivi con i
    // morti avrebbe gli stessi numeri di uno giusto.
    const morte = vive
      .slice(0, 2)
      .map((k) => k.replace(/[0-9a-f]{12}(\.[a-z0-9]+)$/i, "ffffffffffff$1"));
    for (const chiave of morte) {
      await blob.put({ key: chiave, data: new Uint8Array([0]), mimeType: "audio/webm" });
    }

    for (const chiave of [...vive, ...morte]) {
      blob.touch(chiave, VECCHIO);
    }

    const esito = await scopa();

    expect(esito).toMatchObject({ esaminati: 5, nominati: 3, orfani: 2, cancellati: 2 });
    // L'insieme, non il numero: tre cancellazioni sbagliate e tre risparmi
    // sbagliati darebbero gli stessi conteggi.
    expect([...blob.keys].sort()).toEqual([...vive].sort());
  });

  it("riconosce anche l'audio di un altro utente, che nessuno le ha chiesto", async () => {
    const mio = await signup();
    const altrui = await signup();

    const miaRegistrazione = await carica(mio, new Uint8Array([1]));
    const altruiRegistrazione = await carica(altrui, new Uint8Array([2]));
    const mia = await chiaveDi(miaRegistrazione.id);
    const sua = await chiaveDi(altruiRegistrazione.id);

    blob.touch(mia, VECCHIO);
    blob.touch(sua, VECCHIO);

    const esito = await scopa();

    // `findExistingAudioKeys` non filtra per utente, ed e' l'unico metodo del
    // repository che non lo fa. Sembra una dimenticanza: ogni altra query di
    // questo progetto porta lo `userId` nel WHERE, ed e' la regola di
    // ownership. Qui sarebbe la fine di tutti gli archivi tranne uno — il
    // bucket e' di tutti, e chi guarda un oggetto non sa di chi sia finche' non
    // lo trova. Il test sta qui perche' quella riga verra' riletta da qualcuno
    // che conosce la regola e non l'eccezione.
    expect(esito).toMatchObject({ esaminati: 2, nominati: 2, orfani: 0, cancellati: 0 });
    expect([...blob.keys].sort()).toEqual([mia, sua].sort());
  });

  it("prende l'oggetto che e' rimasto solo, quando la riga e' sparita sotto", async () => {
    const token = await signup();
    const registrazione = await carica(token, new Uint8Array([4, 2]));
    const chiave = await chiaveDi(registrazione.id);
    blob.touch(chiave, VECCHIO);

    // La riga sparisce senza passare dal servizio, che avrebbe tolto anche
    // l'oggetto. E' la meta' esatta che la scopa esiste per raccogliere: un
    // processo morto fra la `delete` della riga e quella del bucket, o un
    // bucket irraggiungibile in quel millisecondo.
    await server.prisma.recording.delete({ where: { id: registrazione.id } });

    const esito = await scopa();

    expect(esito).toMatchObject({ esaminati: 1, nominati: 0, orfani: 1, cancellati: 1 });
    expect(esito.byteOrfani).toBe(2);
    expect(blob.keys).toEqual([]);
  });

  it("lascia stare l'audio appena caricato, che e' orfano solo perche' la riga non c'e' ancora", async () => {
    const token = await signup();
    const registrazione = await carica(token, new Uint8Array([4, 2]));
    const chiave = await chiaveDi(registrazione.id);

    // Stessa scena del caso qui sopra, e l'unica differenza e' che l'oggetto
    // non viene invecchiato: la sua data la scrive lo storage al `put`, come in
    // produzione. E' la corsa che la regola 2 esiste per non perdere —
    // `recordings.service.ts` scrive i byte per primi, quindi fra il `put` e la
    // `create` c'e' un istante in cui l'audio di qualcuno e' indistinguibile da
    // spazzatura. Una passata in quell'istante lo cancellerebbe mentre il
    // telefono e' ancora in caricamento.
    //
    // Il caso vive qui e non fra i test unitari perche' li' la data
    // dell'oggetto la sceglie chi scrive il test: prova la disuguaglianza, non
    // che la data arrivi dal caricamento vero.
    await server.prisma.recording.delete({ where: { id: registrazione.id } });

    const esito = await scopa();

    expect(esito).toMatchObject({
      esaminati: 1,
      nominati: 0,
      troppoRecenti: 1,
      orfani: 0,
      cancellati: 0,
    });
    expect(blob.keys).toEqual([chiave]);
  });

  it("dopo una cancellazione fatta come si deve non trova niente da raccogliere", async () => {
    const token = await signup();
    const registrazione = await carica(token, new Uint8Array([7]));
    const chiave = await chiaveDi(registrazione.id);

    const res = await call(server, "DELETE", `/api/recordings/${registrazione.id}`, {
      accessToken: token,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    // La strada normale toglie riga e oggetto insieme. Se ne lasciasse indietro
    // uno, la scopa lo troverebbe — e questo caso serve proprio a dire che non
    // c'e' niente da trovare, cioe' che la scopa e' una rete di sicurezza e non
    // il modo in cui questo sistema fa pulizia di solito.
    expect(await blob.exists(chiave)).toBe(false);
    expect(await scopa()).toMatchObject({ esaminati: 0, orfani: 0, cancellati: 0 });
  });
});
