import { beforeEach, describe, expect, it } from "vitest";
import { FakeStorageProvider } from "../../apps/api/src/providers/fake/index.js";
import {
  createStorageSweepService,
  sembraUnAudioNostro,
  SWEEP_GRACE_MS,
  type StorageSweepService,
  type SweepOptions,
  type SweepSummary,
} from "../../apps/api/src/services/storageSweep.service.js";
import { FixedClock } from "../support/FixedClock.js";
import { InMemoryRecordingRepository } from "../support/InMemoryRecordingRepository.js";

/**
 * La scopa cancella file di persone sulla base di una query, e non c'e' un
 * cestino da cui ripescare. Quindi qui non si prova che funzioni: si prova che
 * ognuna delle tre regole basti da sola a salvare un oggetto, e che ogni modo
 * di sbagliare che il servizio dichiara di temere sia davvero coperto.
 *
 * Il caso peggiore ha un test suo — «un errore del database ferma la passata» —
 * perche' e' quello in cui il danno non e' un file perso ma il bucket intero:
 * se la domanda «chi ti nomina?» fallisce in silenzio, la risposta e' «nessuno»
 * per tutti.
 */

const ADESSO = new Date("2026-03-10T12:00:00.000Z");
const GIORNO = 24 * 60 * 60 * 1000;
const AUDIO = new Uint8Array([1, 2, 3]);

/** Una chiave della forma che scrive `recordings.service.ts`. */
function chiave(n: number, utente = "u1"): string {
  const testa = String(n).padStart(8, "0");
  return `${utente}/${testa}-0000-4000-8000-000000000000.webm`;
}

interface Banco {
  readonly storage: FakeStorageProvider;
  readonly clock: FixedClock;
  readonly service: StorageSweepService;
  /** Le liste di chiavi arrivate al database, una per interrogazione. */
  readonly chiamate: (readonly string[])[];
  /** Gli orfani annunciati, in ordine. */
  readonly orfaniVisti: string[];
  /** Quanti oggetti c'erano ancora nello storage a ogni orfano annunciato. */
  readonly allAnnuncio: number[];
  readonly erroriCancellazione: string[];
  /** Mette un oggetto nel bucket, invecchiato di `etaMs`. */
  carica(key: string, etaMs?: number): Promise<void>;
  /** Fa esistere la riga che nomina quella chiave. */
  nomina(key: string): void;
  /** Da qui in poi il database non risponde piu'. */
  rompiIlDatabase(errore: Error): void;
  /** Da qui in poi quella chiave rifiuta di farsi cancellare. */
  rendiIncancellabile(key: string): void;
  esegui(options?: SweepOptions): Promise<SweepSummary>;
}

function banco(): Banco {
  const clock = new FixedClock(ADESSO);
  const storage = new FakeStorageProvider("memory://sweep", () => clock.now());
  const dati = new InMemoryRecordingRepository();
  const chiamate: (readonly string[])[] = [];
  const orfaniVisti: string[] = [];
  const allAnnuncio: number[] = [];
  const erroriCancellazione: string[] = [];
  const incancellabili = new Set<string>();
  let guasto: Error | null = null;

  const cancellaVero = storage.delete.bind(storage);
  storage.delete = (key: string): Promise<void> => {
    if (incancellabili.has(key)) {
      return Promise.reject(new Error(`403 su ${key}`));
    }
    return cancellaVero(key);
  };

  const service = createStorageSweepService({
    storage,
    repo: {
      findExistingAudioKeys(keys: readonly string[]): Promise<ReadonlySet<string>> {
        chiamate.push([...keys]);
        return guasto === null
          ? dati.findExistingAudioKeys(keys)
          : Promise.reject(guasto);
      },
    },
    clock,
  });

  return {
    storage,
    clock,
    service,
    chiamate,
    orfaniVisti,
    allAnnuncio,
    erroriCancellazione,
    async carica(key: string, etaMs = 0): Promise<void> {
      await storage.put({ key, data: AUDIO, mimeType: "audio/webm" });
      storage.touch(key, new Date(ADESSO.getTime() - etaMs));
    },
    nomina(key: string): void {
      dati.seedRecording({ userId: "u1", audioUrl: key });
    },
    rompiIlDatabase(errore: Error): void {
      guasto = errore;
    },
    rendiIncancellabile(key: string): void {
      incancellabili.add(key);
    },
    esegui: (options?: SweepOptions) =>
      service.esegui({
        ...options,
        onOrfano: (object) => {
          orfaniVisti.push(object.key);
          allAnnuncio.push(storage.size);
        },
        onErroreCancellazione: ({ key }) => erroriCancellazione.push(key),
      }),
  };
}

describe("sembraUnAudioNostro", () => {
  it("riconosce la forma che scrive il caricamento", () => {
    expect(sembraUnAudioNostro(chiave(1))).toBe(true);
    expect(sembraUnAudioNostro("cmb9k2x0000abcdef/3f8a1b2c-1111-4222-8333-444455556666.m4a")).toBe(
      true,
    );
    // L'UUID maiuscolo non e' nostro oggi, ma e' lo stesso identificatore.
    expect(sembraUnAudioNostro("u1/3F8A1B2C-1111-4222-8333-444455556666.WEBM")).toBe(true);
  });

  it("non riconosce cio' che non ha esattamente due segmenti", () => {
    expect(sembraUnAudioNostro("3f8a1b2c-1111-4222-8333-444455556666.webm")).toBe(false);
    expect(sembraUnAudioNostro("u1/sotto/3f8a1b2c-1111-4222-8333-444455556666.webm")).toBe(false);
    expect(sembraUnAudioNostro("/3f8a1b2c-1111-4222-8333-444455556666.webm")).toBe(false);
  });

  it("non riconosce cio' che nel mezzo non e' un UUID", () => {
    // Il caso che questa regola esiste per proteggere: roba di qualcun altro,
    // vecchia e non nominata da nessuna riga, cioe' cancellabile secondo le
    // altre due regole.
    expect(sembraUnAudioNostro("backup/2026-03-01.tar.gz")).toBe(false);
    expect(sembraUnAudioNostro("u1/export.zip")).toBe(false);
    expect(sembraUnAudioNostro("u1/3f8a1b2c-1111-4222-8333-44445555666.webm")).toBe(false);
    expect(sembraUnAudioNostro("u1/3f8a1b2c-1111-4222-8333-444455556666")).toBe(false);
    expect(sembraUnAudioNostro("u1/3f8a1b2c-1111-4222-8333-444455556666.webm.bak")).toBe(false);
  });
});

describe("la scopa: cosa risparmia", () => {
  let b: Banco;

  beforeEach(() => {
    b = banco();
  });

  it("non tocca un oggetto che una riga nomina, per quanto vecchio", async () => {
    const key = chiave(1);
    await b.carica(key, 365 * GIORNO);
    b.nomina(key);

    const esito = await b.esegui({ cancella: true });

    expect(esito.nominati).toBe(1);
    expect(esito.orfani).toBe(0);
    expect(b.storage.keys).toEqual([key]);
  });

  it("non tocca un orfano piu' recente della soglia", async () => {
    // E' la regola 2, ed e' l'audio che qualcuno sta caricando adesso: i byte
    // ci sono, la riga non ancora.
    const key = chiave(1);
    await b.carica(key);

    const esito = await b.esegui({ cancella: true });

    expect(esito.troppoRecenti).toBe(1);
    expect(esito.orfani).toBe(0);
    expect(b.storage.keys).toEqual([key]);
  });

  it("considera vecchio abbastanza cio' che compie la soglia esatta", async () => {
    await b.carica(chiave(1), SWEEP_GRACE_MS);

    const esito = await b.esegui();

    expect(esito.troppoRecenti).toBe(0);
    expect(esito.orfani).toBe(1);
  });

  it("non tocca — e non chiede nemmeno al database — cio' che non ha la nostra forma", async () => {
    await b.carica("backup/2026-03-01.tar.gz", 365 * GIORNO);

    const esito = await b.esegui({ cancella: true });

    expect(esito.esaminati).toBe(1);
    expect(esito.estranei).toBe(1);
    expect(esito.orfani).toBe(0);
    expect(b.chiamate).toEqual([]);
    expect(b.storage.size).toBe(1);
  });

  it("su un bucket vuoto non interroga il database e non solleva", async () => {
    const esito = await b.esegui({ cancella: true });

    expect(esito).toMatchObject({ esaminati: 0, orfani: 0, cancellati: 0, falliti: 0 });
    expect(b.chiamate).toEqual([]);
  });

  it("guarda soltanto, se non gli si dice di cancellare", async () => {
    const key = chiave(1);
    await b.carica(key, 2 * GIORNO);

    const esito = await b.esegui();

    expect(b.orfaniVisti).toEqual([key]);
    expect(esito.cancellati).toBe(0);
    expect(b.storage.keys).toEqual([key]);
  });
});

describe("la scopa: cosa cancella", () => {
  let b: Banco;

  beforeEach(() => {
    b = banco();
  });

  it("toglie gli orfani vecchi e lascia tutto il resto", async () => {
    const nominato = chiave(1);
    const orfano = chiave(2);
    const recente = chiave(3);
    const estraneo = "backup/vecchio.tar.gz";
    await b.carica(nominato, 10 * GIORNO);
    await b.carica(orfano, 10 * GIORNO);
    await b.carica(recente, 60_000);
    await b.carica(estraneo, 10 * GIORNO);
    b.nomina(nominato);

    const esito = await b.esegui({ cancella: true });

    expect(esito).toMatchObject({
      esaminati: 4,
      nominati: 1,
      estranei: 1,
      troppoRecenti: 1,
      orfani: 1,
      cancellati: 1,
      falliti: 0,
      byteOrfani: 3,
    });
    expect(b.orfaniVisti).toEqual([orfano]);
    expect([...b.storage.keys].sort()).toEqual([estraneo, nominato, recente].sort());
  });

  it("annuncia ogni orfano prima che sia stato cancellato qualcosa", async () => {
    // Chi legge l'elenco deve poter fermare la passata guardandolo, e un
    // annuncio che arrivasse a cancellazione avvenuta sarebbe un necrologio.
    await b.carica(chiave(1), 10 * GIORNO);
    await b.carica(chiave(2), 10 * GIORNO);

    await b.esegui({ cancella: true });

    expect(b.allAnnuncio).toEqual([2, 2]);
    expect(b.storage.size).toBe(0);
  });

  it("una chiave che rifiuta di farsi cancellare non ferma le altre", async () => {
    const ostinato = chiave(1);
    const arrendevole = chiave(2);
    await b.carica(ostinato, 10 * GIORNO);
    await b.carica(arrendevole, 10 * GIORNO);
    b.rendiIncancellabile(ostinato);

    const esito = await b.esegui({ cancella: true });

    expect(esito.cancellati).toBe(1);
    expect(esito.falliti).toBe(1);
    expect(b.erroriCancellazione).toEqual([ostinato]);
    // Resta li' e la prossima passata la ritrova identica: e' cio' che deve
    // succedere, perche' l'errore puo' essere un permesso mancante.
    expect(b.storage.keys).toEqual([ostinato]);
  });

  it("usa la soglia che gli si passa al posto del giorno", async () => {
    const key = chiave(1);
    await b.carica(key, 60 * 60 * 1000);

    expect((await b.esegui()).orfani).toBe(0);
    expect((await b.esegui({ graceMs: 60_000 })).orfani).toBe(1);
  });

  it("guarda solo il prefisso che gli si passa", async () => {
    await b.carica(chiave(1, "u1"), 10 * GIORNO);
    await b.carica(chiave(2, "u2"), 10 * GIORNO);

    const esito = await b.esegui({ prefix: "u2/", cancella: true });

    expect(esito.esaminati).toBe(1);
    expect(b.orfaniVisti).toEqual([chiave(2, "u2")]);
    expect(b.storage.keys).toEqual([chiave(1, "u1")]);
  });

  it("l'orologio iniettato decide cosa e' vecchio", async () => {
    const key = chiave(1);
    await b.carica(key);

    expect((await b.esegui()).troppoRecenti).toBe(1);

    b.clock.advanceDays(2);

    expect((await b.esegui()).orfani).toBe(1);
  });
});

describe("la scopa: la regola 1 quando il database non risponde", () => {
  it("interrompe la passata invece di dare per orfano tutto il blocco", async () => {
    const b = banco();
    const chiavi = [chiave(1), chiave(2), chiave(3)];
    for (const key of chiavi) {
      await b.carica(key, 10 * GIORNO);
    }
    b.rompiIlDatabase(new Error("connessione persa"));

    await expect(b.esegui({ cancella: true })).rejects.toThrow("connessione persa");

    // Nessuna cancellazione, e nemmeno un annuncio: senza risposta dal
    // database nessuno di questi oggetti e' stato dichiarato orfano.
    expect([...b.storage.keys].sort()).toEqual([...chiavi].sort());
    expect(b.orfaniVisti).toEqual([]);
  });
});

describe("la scopa: pagine e blocchi", () => {
  it("scorre tutte le pagine invece di fermarsi alla prima", async () => {
    const b = banco();
    b.storage.pageSize = 2;
    for (let n = 1; n <= 5; n += 1) {
      await b.carica(chiave(n), 10 * GIORNO);
    }

    const esito = await b.esegui({ cancella: true });

    expect(esito.esaminati).toBe(5);
    expect(esito.cancellati).toBe(5);
    expect(b.storage.size).toBe(0);
  });

  it("non ripete la stessa pagina all'infinito quando le pagine dividono esatte", async () => {
    const b = banco();
    b.storage.pageSize = 2;
    for (let n = 1; n <= 4; n += 1) {
      await b.carica(chiave(n), 10 * GIORNO);
    }

    const esito = await b.esegui();

    expect(esito.esaminati).toBe(4);
    expect(esito.orfani).toBe(4);
  });

  it("interroga il database a blocchi propri, anche se lo storage risponde tutto in una volta", async () => {
    // E' il caso del provider locale: una pagina sola, lunga quanto la
    // cartella. Senza un taglio proprio, l'`IN (...)` sarebbe lungo uguale.
    const b = banco();
    for (let n = 1; n <= 1200; n += 1) {
      await b.carica(chiave(n), 10 * GIORNO);
    }

    const esito = await b.esegui();

    expect(esito.esaminati).toBe(1200);
    expect(esito.orfani).toBe(1200);
    expect(b.chiamate.map((c) => c.length)).toEqual([500, 500, 200]);
    // Ogni chiave chiesta una volta sola, nessuna dimenticata.
    expect(new Set(b.chiamate.flat()).size).toBe(1200);
  });

  it("accumula fra pagine invece di interrogare il database una pagina per volta", async () => {
    const b = banco();
    b.storage.pageSize = 10;
    for (let n = 1; n <= 30; n += 1) {
      await b.carica(chiave(n), 10 * GIORNO);
    }

    await b.esegui();

    expect(b.chiamate.map((c) => c.length)).toEqual([30]);
  });

  it("cancella mentre scorre, senza saltare le pagine che restano", async () => {
    // Il caso che il segnalibro deve reggere. Con milleduecento oggetti e pagine
    // da cento, il primo blocco viene cancellato dopo la quinta pagina: da li'
    // in poi si chiedono pagine di un bucket che si sta accorciando sotto i
    // piedi. Con un segnalibro posizionale ne salterebbe cinquecento — mai
    // guardati, quindi mai cancellati, e nessuno se ne accorgerebbe se non
    // contando.
    const b = banco();
    b.storage.pageSize = 100;
    for (let n = 1; n <= 1200; n += 1) {
      await b.carica(chiave(n), 10 * GIORNO);
    }

    const esito = await b.esegui({ cancella: true });

    expect(esito.esaminati).toBe(1200);
    expect(esito.cancellati).toBe(1200);
    expect(b.storage.size).toBe(0);
  });

  it("non tiene in memoria piu' di un blocco di orfani", async () => {
    // La proprieta' che il riassunto non porta l'elenco: ottocento orfani, e
    // alla fine il servizio ne ha in mano un conteggio e nient'altro. Chi li
    // voleva li ha ricevuti strada facendo.
    const b = banco();
    for (let n = 1; n <= 800; n += 1) {
      await b.carica(chiave(n), 10 * GIORNO);
    }

    const esito = await b.esegui();

    expect(esito.orfani).toBe(800);
    expect(b.orfaniVisti).toHaveLength(800);
    // Il primo blocco e' stato annunciato prima che il secondo fosse chiesto al
    // database: gli annunci non aspettano la fine.
    expect(b.orfaniVisti.slice(0, 500)).toEqual(
      Array.from({ length: 500 }, (_, i) => chiave(i + 1)),
    );
  });
});
