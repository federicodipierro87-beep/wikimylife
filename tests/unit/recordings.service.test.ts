import {
  RecordingStatus,
  recordingStateSchema,
  type CaptureMetadata,
} from "@wikimylife/shared";
import { buildExtractionContract } from "@wikimylife/shared/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../apps/api/src/errors/AppError.js";
import { FakeStorageProvider } from "../../apps/api/src/providers/fake/index.js";
import {
  audioExtension,
  createRecordingsService,
  toRecordingState,
  type RecordingsService,
} from "../../apps/api/src/services/recordings.service.js";
import { FixedClock } from "../support/FixedClock.js";
import { InMemoryRecordingRepository } from "../support/InMemoryRecordingRepository.js";

/**
 * Il lato sincrono: caricare, guardare, rimettere in coda.
 *
 * Tre cose vale la pena verificare qui, e sono tutte e tre decisioni prese
 * altrove che qui diventano osservabili: che i byte finiscano nello storage
 * prima che la riga esista, che la risorsa di un altro utente sia un 404 e non
 * un 403, e che gli `issues` mostrati vengano ricalcolati dal JSON conservato
 * invece che letti da una colonna.
 */

const USER = "user-1";
const ALTRO = "user-2";
const NOW = new Date("2026-03-01T12:00:00.000Z");

const metadata: CaptureMetadata = {
  recordedAt: "2026-03-01T10:15:00.000Z",
  durationMs: 42_000,
  mimeType: "audio/webm",
  capturedOffline: false,
  deviceLocale: "it-IT",
  latitude: 45.0703,
  longitude: 7.6869,
  placeLabel: "Torino, Corso Vittorio",
};

interface Harness {
  readonly repo: InMemoryRecordingRepository;
  readonly storage: FakeStorageProvider;
  readonly clock: FixedClock;
  readonly enqueued: string[];
  readonly service: RecordingsService;
}

function harness(): Harness {
  const repo = new InMemoryRecordingRepository();
  const storage = new FakeStorageProvider();
  const clock = new FixedClock(NOW);
  const enqueued: string[] = [];

  return {
    repo,
    storage,
    clock,
    enqueued,
    service: createRecordingsService({
      repo,
      storage,
      clock,
      onEnqueued: (id) => enqueued.push(id),
    }),
  };
}

let h: Harness;

beforeEach(() => {
  h = harness();
});

const audio = { bytes: new Uint8Array([1, 2, 3, 4, 5]), mimeType: "audio/webm" };

/**
 * Uno storage che accetta tutto tranne le cancellazioni.
 *
 * E' il bucket momentaneamente irraggiungibile, o la credenziale a cui manca
 * `s3:DeleteObject`. Il fake normale non serve: la sua `delete` riesce sempre,
 * compreso su una chiave che non esiste — come i provider veri.
 */
class StorageSenzaCancellazione extends FakeStorageProvider {
  override delete(): Promise<void> {
    return Promise.reject(new Error("bucket irraggiungibile"));
  }
}

describe("audioExtension", () => {
  it.each([
    ["audio/webm", ".webm"],
    ["audio/ogg", ".ogg"],
    ["audio/mpeg", ".mp3"],
    ["audio/mp4", ".m4a"],
    ["audio/x-m4a", ".m4a"],
    ["audio/wav", ".wav"],
    ["audio/flac", ".flac"],
  ])("mappa %s su %s", (mime, atteso) => {
    expect(audioExtension(mime)).toBe(atteso);
  });

  it("ignora i parametri del content type", () => {
    // `MediaRecorder` produce `audio/webm;codecs=opus`.
    expect(audioExtension("audio/webm;codecs=opus")).toBe(".webm");
    expect(audioExtension("AUDIO/WEBM; codecs=opus")).toBe(".webm");
  });

  it("non inventa un'estensione per un tipo sconosciuto", () => {
    // `.bin` almeno non mente: Whisper sceglie il decoder dall'estensione, e
    // un `.mp3` che non e' un mp3 fallirebbe in modo incomprensibile.
    expect(audioExtension("application/octet-stream")).toBe(".bin");
    expect(audioExtension("")).toBe(".bin");
  });
});

describe("create", () => {
  it("salva i byte prima della riga, e la riga punta a quella chiave", async () => {
    // L'ordine e' il requisito numero uno della fase: un oggetto orfano si
    // raccoglie, una riga che punta al nulla e' una registrazione persa.
    const state = await h.service.create(USER, { audio, metadata });

    const detail = h.repo.snapshot(state.id);
    await expect(h.storage.exists(detail.audioUrl)).resolves.toBe(true);
    expect(h.storage.size).toBe(1);
  });

  it("mette la chiave nello spazio dell'utente e con l'estensione giusta", async () => {
    const state = await h.service.create(USER, { audio, metadata });

    const { audioUrl } = h.repo.snapshot(state.id);
    expect(audioUrl.startsWith(`${USER}/`)).toBe(true);
    expect(audioUrl.endsWith(".webm")).toBe(true);
  });

  it("misura i byte invece di credere al client", async () => {
    // `sizeBytes` non e' nei metadati di proposito: e' un dato che il server
    // puo' verificare da solo, quindi non c'e' motivo di chiederlo.
    const state = await h.service.create(USER, { audio, metadata });

    expect(state.sizeBytes).toBe(audio.bytes.byteLength);
  });

  it("nasce in BOZZA_AUDIO, senza trascrizione ne' scheda", async () => {
    const state = await h.service.create(USER, { audio, metadata });

    expect(state.status).toBe(RecordingStatus.BOZZA_AUDIO);
    expect(state.transcript).toBeNull();
    expect(state.procedureId).toBeNull();
    expect(state.extraction).toBeNull();
    expect(state.issues).toEqual([]);
    expect(state.lastError).toBeNull();
    expect(state.duplicate).toBeNull();
    expect(state.retryCount).toBe(0);
  });

  it("conserva i metadati di cattura della §2", async () => {
    const state = await h.service.create(USER, { audio, metadata });

    const detail = h.repo.snapshot(state.id);
    expect(detail.recordedAt.toISOString()).toBe(metadata.recordedAt);
    expect(detail.durationMs).toBe(metadata.durationMs);
    expect(detail.deviceLocale).toBe("it-IT");
    expect(detail.latitude).toBe(45.0703);
    expect(detail.longitude).toBe(7.6869);
    expect(detail.placeLabel).toBe("Torino, Corso Vittorio");
    expect(detail.capturedOffline).toBe(false);
  });

  it("segnala l'accodamento una volta sola, con l'id creato", async () => {
    const state = await h.service.create(USER, { audio, metadata });

    expect(h.enqueued).toEqual([state.id]);
  });

  it("da' a due caricamenti chiavi diverse", async () => {
    // La chiave e' casuale e non derivata dall'id: la riga non esiste ancora.
    const primo = await h.service.create(USER, { audio, metadata });
    const secondo = await h.service.create(USER, { audio, metadata });

    expect(h.repo.snapshot(primo.id).audioUrl).not.toBe(h.repo.snapshot(secondo.id).audioUrl);
    expect(h.storage.size).toBe(2);
  });

  it("restituisce una risposta conforme al contratto pubblico", async () => {
    const state = await h.service.create(USER, { audio, metadata });

    expect(recordingStateSchema.safeParse(state).success).toBe(true);
  });
});

describe("find — proprieta' della risorsa", () => {
  it("restituisce la registrazione al suo proprietario", async () => {
    const creata = await h.service.create(USER, { audio, metadata });

    await expect(h.service.find(USER, creata.id)).resolves.toMatchObject({ id: creata.id });
  });

  it("risponde 404, non 403, sulla registrazione di un altro", async () => {
    // Un 403 confermerebbe che quell'id esiste ed e' stato assegnato a
    // qualcuno: dall'esterno "non esiste" e "non e' tua" devono coincidere.
    const creata = await h.service.create(USER, { audio, metadata });

    await expect(h.service.find(ALTRO, creata.id)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("risponde 404 su un id inesistente", async () => {
    await expect(h.service.find(USER, "rec-inesistente")).rejects.toBeInstanceOf(AppError);
  });
});

describe("audio", () => {
  it("restituisce i byte originali con il loro mime type", async () => {
    const creata = await h.service.create(USER, { audio, metadata });

    await expect(h.service.audio(USER, creata.id)).resolves.toEqual({
      bytes: audio.bytes,
      mimeType: "audio/webm",
    });
  });

  it("non consegna l'audio di un altro utente", async () => {
    // La stessa regola della scheda, e per la stessa ragione: qui l'audio e' la
    // voce di una persona, quindi e' il posto dove un 403 costerebbe di piu'.
    const creata = await h.service.create(USER, { audio, metadata });

    await expect(h.service.audio(ALTRO, creata.id)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("risponde 404 quando la riga c'e' ma l'oggetto no", async () => {
    // Succede davvero: `create` scrive i byte prima della riga, quindi un
    // database ripristinato da un backup piu' recente dello storage lascia
    // righe orfane. Il client deve poter mostrare la scheda senza player.
    const creata = await h.service.create(USER, { audio, metadata });
    const riga = h.repo.snapshot(creata.id);
    await h.storage.delete(riga.audioUrl);

    await expect(h.service.audio(USER, creata.id)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });
});

describe("retry", () => {
  it("rimette in coda una registrazione fallita azzerando l'errore", async () => {
    const recording = h.repo.seedRecording({
      userId: USER,
      status: RecordingStatus.ESTRAZIONE_FALLITA,
      lastErrorCode: "contratto.non_conforme",
      lastErrorMessage: "Estrazione non conforme",
      lastErrorAt: NOW,
    });

    const state = await h.service.retry(USER, recording.id);

    expect(state.status).toBe(RecordingStatus.BOZZA_AUDIO);
    expect(state.lastError).toBeNull();
    expect(state.retryCount).toBe(1);
    expect(h.enqueued).toEqual([recording.id]);
  });

  it("scioglie il sospetto di duplicato: e' l'utente a decidere", async () => {
    // §5 lascia la decisione all'utente. Chiedere il riprocessamento significa
    // "no, e' un'altra cosa": il suggerimento va cancellato, non conservato.
    const procedura = h.repo.seedProcedure({
      userId: USER,
      titolo: "Richiedere il casellario giudiziale",
      embedding: [1, 0, 0],
    });
    const recording = h.repo.seedRecording({
      userId: USER,
      status: RecordingStatus.DUPLICATO_SOSPETTO,
      duplicateOfId: procedura.id,
      duplicateOfTitolo: procedura.titolo,
      duplicateSimilarity: 0.93,
    });

    const state = await h.service.retry(USER, recording.id);

    expect(state.status).toBe(RecordingStatus.BOZZA_AUDIO);
    expect(state.duplicate).toBeNull();
  });

  it("rifiuta di riprocessare una registrazione gia' in elaborazione", async () => {
    // Rimetterla in coda mentre un worker la sta trattando produrrebbe due
    // schede dalla stessa registrazione.
    const recording = h.repo.seedRecording({
      userId: USER,
      status: RecordingStatus.IN_ELABORAZIONE,
    });

    await expect(h.service.retry(USER, recording.id)).rejects.toMatchObject({ status: 404 });
    expect(h.repo.snapshot(recording.id).status).toBe(RecordingStatus.IN_ELABORAZIONE);
  });

  it("rifiuta di riprocessare una registrazione gia' estratta", async () => {
    const recording = h.repo.seedRecording({
      userId: USER,
      status: RecordingStatus.ESTRATTO,
      procedureId: "proc-1",
    });

    await expect(h.service.retry(USER, recording.id)).rejects.toMatchObject({ status: 404 });
  });

  it("non lascia riprocessare la registrazione di un altro", async () => {
    const recording = h.repo.seedRecording({
      userId: USER,
      status: RecordingStatus.ESTRAZIONE_FALLITA,
    });

    await expect(h.service.retry(ALTRO, recording.id)).rejects.toMatchObject({ status: 404 });
    expect(h.repo.snapshot(recording.id).status).toBe(RecordingStatus.ESTRAZIONE_FALLITA);
    expect(h.enqueued).toEqual([]);
  });
});

describe("remove", () => {
  it("toglie la riga e l'oggetto, in quest'ordine", async () => {
    // L'ordine e' l'opposto di `create` e per la stessa ragione: qui la riga e'
    // il dato condiviso con il worker, e finche' esiste puo' essere reclamata.
    const creata = await h.service.create(USER, { audio, metadata });
    const chiave = h.repo.snapshot(creata.id).audioUrl;

    await expect(h.service.remove(USER, creata.id)).resolves.toBeUndefined();

    await expect(h.repo.findForUser(USER, creata.id)).resolves.toBeNull();
    await expect(h.storage.exists(chiave)).resolves.toBe(false);
    expect(h.storage.size).toBe(0);
  });

  it("cancella per davvero, non archivia", async () => {
    // La scheda si archivia; la registrazione no. Uno stato «cancellata» con i
    // byte ancora nel bucket sarebbe la risposta sbagliata a chi ha chiesto che
    // la propria voce sparisse.
    const creata = await h.service.create(USER, { audio, metadata });
    await h.service.remove(USER, creata.id);

    await expect(h.service.find(USER, creata.id)).rejects.toMatchObject({ status: 404 });
    await expect(h.service.pending(USER)).resolves.toEqual([]);
  });

  it("rifiuta con 409 finche' un worker la sta elaborando", async () => {
    // Non 404: la registrazione esiste ed e' sua. Cancellarla adesso lascerebbe
    // il worker a scrivere una trascrizione su un id che non c'e' piu'.
    const recording = h.repo.seedRecording({
      userId: USER,
      status: RecordingStatus.IN_ELABORAZIONE,
    });

    await expect(h.service.remove(USER, recording.id)).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });
    expect(h.repo.snapshot(recording.id).status).toBe(RecordingStatus.IN_ELABORAZIONE);
  });

  it("cancella anche una registrazione gia' estratta, e la scheda resta", async () => {
    // E' il caso che giustifica la rotta piu' di ogni altro: tenere la
    // procedura e non l'audio. Il legame va in una direzione sola — la
    // registrazione nomina la scheda, non la possiede.
    const procedura = h.repo.seedProcedure({
      userId: USER,
      titolo: "Richiedere il casellario giudiziale",
      embedding: [1, 0, 0],
    });
    const recording = h.repo.seedRecording({
      userId: USER,
      status: RecordingStatus.ESTRATTO,
      procedureId: procedura.id,
    });

    await h.service.remove(USER, recording.id);

    await expect(h.repo.findForUser(USER, recording.id)).resolves.toBeNull();
    await expect(h.repo.findMostSimilar(USER, [1, 0, 0])).resolves.toMatchObject({
      procedureId: procedura.id,
    });
  });

  it("non lascia cancellare la registrazione di un altro, e non tocca l'oggetto", async () => {
    const creata = await h.service.create(USER, { audio, metadata });
    const chiave = h.repo.snapshot(creata.id).audioUrl;

    await expect(h.service.remove(ALTRO, creata.id)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    await expect(h.storage.exists(chiave)).resolves.toBe(true);
  });

  it("risponde 404 su un id inesistente", async () => {
    await expect(h.service.remove(USER, "rec-inesistente")).rejects.toBeInstanceOf(AppError);
  });

  it("riesce anche se l'oggetto non c'era gia' piu'", async () => {
    // Succede: un `create` interrotto fra il `put` e la riga, o un ripristino
    // del database da un backup piu' recente dello storage. Cancellare cio' che
    // non c'e' e' esattamente il risultato voluto, e tutti e tre i provider lo
    // trattano cosi' — S3 tollera il 404, il locale usa `rm --force`.
    const recording = h.repo.seedRecording({ userId: USER, audioUrl: "user-1/mai-scritto.webm" });

    await expect(h.service.remove(USER, recording.id)).resolves.toBeUndefined();
    await expect(h.repo.findForUser(USER, recording.id)).resolves.toBeNull();
  });

  it("non fa fallire l'utente se il bucket e' irraggiungibile, ma segnala la chiave", async () => {
    // La riga non c'e' piu': per chi ha premuto la registrazione e' cancellata,
    // e un 500 lo spingerebbe a ripetere una DELETE che ormai puo' solo dare
    // 404. Il file rimasto indietro e' un problema di pulizia, e deve arrivare
    // a chi tiene il bucket invece che a lui.
    const orfani: string[] = [];
    const repo = new InMemoryRecordingRepository();
    const service = createRecordingsService({
      repo,
      storage: new StorageSenzaCancellazione(),
      clock: new FixedClock(NOW),
      onOrphanedAudio: ({ key }) => orfani.push(key),
    });
    const recording = repo.seedRecording({ userId: USER, audioUrl: "user-1/rimasto.webm" });

    await expect(service.remove(USER, recording.id)).resolves.toBeUndefined();

    await expect(repo.findForUser(USER, recording.id)).resolves.toBeNull();
    expect(orfani).toEqual(["user-1/rimasto.webm"]);
  });
});

describe("toRecordingState — gli issues sono derivati", () => {
  it("ricalcola i rilievi della §5 dal JSON conservato", async () => {
    // Nessuna colonna `issues`: cambiare una regola della §5 deve cambiare
    // subito cio' che l'utente vede, senza riprocessare niente.
    const recording = h.repo.seedRecording({
      userId: USER,
      status: RecordingStatus.ESTRATTO,
      procedureId: "proc-1",
      rawExtraction: buildExtractionContract({
        costi: [{ descrizione: "Rimborso", importoCent: -100, valuta: "euro" }],
      }),
    });

    const state = toRecordingState(recording);

    expect(state.issues.map((i) => i.rule)).toEqual([
      "costi.importo_negativo",
      "costi.valuta_non_iso",
    ]);
    expect(state.extraction?.titolo).toBe("Richiedere il casellario giudiziale");
  });

  it("mostra i rilievi bloccanti ma non l'estrazione, quando il JSON non e' conforme", async () => {
    // Il caso di ESTRAZIONE_FALLITA: c'e' qualcosa da mostrare sul perche',
    // ma non c'e' nessun contratto da proporre all'utente.
    const recording = h.repo.seedRecording({
      userId: USER,
      status: RecordingStatus.ESTRAZIONE_FALLITA,
      rawExtraction: { titolo: "a meta'" },
    });

    const state = toRecordingState(recording);

    expect(state.extraction).toBeNull();
    expect(state.issues.length).toBeGreaterThan(0);
    expect(state.issues.every((i) => i.blocking)).toBe(true);
  });

  it("espone il suggerimento di aggiornamento del duplicato", async () => {
    const recording = h.repo.seedRecording({
      userId: USER,
      status: RecordingStatus.DUPLICATO_SOSPETTO,
      duplicateOfId: "proc-esistente",
      duplicateOfTitolo: "Richiedere il casellario giudiziale",
      duplicateSimilarity: 0.91,
      rawExtraction: buildExtractionContract(),
    });

    const state = toRecordingState(recording);

    expect(state.duplicate).toEqual({
      procedureId: "proc-esistente",
      titolo: "Richiedere il casellario giudiziale",
      similarity: 0.91,
    });
    // L'estrazione c'e': senza vederla, "aggiorna quella esistente" sarebbe
    // una domanda a scatola chiusa.
    expect(state.extraction).not.toBeNull();
  });

  it("espone l'ultimo errore con il suo istante", async () => {
    const at = new Date("2026-03-01T11:00:00.000Z");
    const recording = h.repo.seedRecording({
      userId: USER,
      status: RecordingStatus.BOZZA_AUDIO,
      lastErrorCode: "trascrizione.fallita",
      lastErrorMessage: "timeout",
      lastErrorAt: at,
      retryCount: 2,
    });

    const state = toRecordingState(recording);

    expect(state.lastError).toEqual({
      code: "trascrizione.fallita",
      message: "timeout",
      at: at.toISOString(),
    });
    expect(state.retryCount).toBe(2);
  });

  it("resta conforme al contratto pubblico in ogni stato", () => {
    const stati = [
      RecordingStatus.BOZZA_AUDIO,
      RecordingStatus.IN_ELABORAZIONE,
      RecordingStatus.ESTRAZIONE_FALLITA,
      RecordingStatus.DUPLICATO_SOSPETTO,
      RecordingStatus.ESTRATTO,
    ];

    for (const status of stati) {
      const recording = h.repo.seedRecording({
        userId: USER,
        status,
        rawExtraction: buildExtractionContract(),
      });
      expect(recordingStateSchema.safeParse(toRecordingState(recording)).success).toBe(true);
    }
  });
});
