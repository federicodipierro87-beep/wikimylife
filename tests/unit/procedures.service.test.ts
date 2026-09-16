import {
  CardStatus,
  EMPTY_TRASH_BATCH_SIZE,
  Outcome,
  Scope,
  Severity,
  Visibility,
  procedureDetailSchema,
  type ListProceduresQuery,
} from "@wikimylife/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FakeEmbeddingProvider,
  FakeStorageProvider,
} from "../../apps/api/src/providers/fake/index.js";
import {
  createProceduresService,
  verificaVisibilita,
  type ProceduresService,
} from "../../apps/api/src/services/procedures.service.js";
import { FixedClock } from "../support/FixedClock.js";
import { InMemoryProcedureRepository } from "../support/InMemoryProcedureRepository.js";

/**
 * Le regole che non stanno ne' nella rotta ne' nel database.
 *
 * Sono tre, e sono tutte e tre invisibili guardando lo schema: il divieto della
 * §9 sulla visibilita', la transizione della §8 dopo un'esecuzione, e la soglia
 * di obsolescenza — che e' l'unica cosa in tutta l'app a dipendere da che ora
 * e', e infatti qui l'ora la decide il test.
 */

const USER = "user-1";
const ALTRO = "user-2";
const NOW = new Date("2026-06-01T12:00:00.000Z");

const LISTA: ListProceduresQuery = { limit: 20, offset: 0 };

interface Harness {
  readonly repo: InMemoryProcedureRepository;
  readonly clock: FixedClock;
  readonly blob: FakeStorageProvider;
  readonly service: ProceduresService;
}

function harness(): Harness {
  const repo = new InMemoryProcedureRepository();
  const clock = new FixedClock(NOW);
  const blob = new FakeStorageProvider();
  return {
    repo,
    clock,
    blob,
    service: createProceduresService({
      repo,
      embeddings: new FakeEmbeddingProvider({ model: "fake", dimensions: 1536 }),
      clock,
      storage: blob,
    }),
  };
}

/** Un bucket che non lascia cancellare niente. */
class StorageSenzaCancellazione extends FakeStorageProvider {
  override delete(): Promise<void> {
    return Promise.reject(new Error("bucket irraggiungibile"));
  }
}

/**
 * Un cestino su cui qualcuno mette le mani mentre lo si sta svuotando.
 *
 * `listArchivedIds` risponde con l'elenco vero e subito dopo lascia succedere
 * qualcosa: e' la finestra fra la SELECT e le DELETE, che nel servizio dura
 * quanto un ciclo e in produzione quanto basta a un'altra scheda del browser
 * per premere «Ripristina». Senza questa classe `saltate` sarebbe un campo che
 * nessun test riempie, e la differenza fra contarle e alzare un errore non si
 * vedrebbe da nessuna parte.
 */
class RepoConSorpresa extends InMemoryProcedureRepository {
  sorpresa: (repo: InMemoryProcedureRepository) => Promise<void> | void = () => {};

  override async listArchivedIds(userId: string, take: number): Promise<readonly string[]> {
    const ids = await super.listArchivedIds(userId, take);
    await this.sorpresa(this);
    return ids;
  }
}

let h: Harness;

beforeEach(() => {
  h = harness();
});

describe("verificaVisibilita — la §9 nel codice, non nell'interfaccia", () => {
  it("lascia passare tutto cio' che non e' pubblico", () => {
    expect(() =>
      verificaVisibilita({
        scope: Scope.CLIENTE,
        visibility: Visibility.PRIVATA,
        contieneDatiSensibili: true,
      }),
    ).not.toThrow();
  });

  it("vieta CLIENTE + PUBBLICA", () => {
    expect(() =>
      verificaVisibilita({
        scope: Scope.CLIENTE,
        visibility: Visibility.PUBBLICA,
        contieneDatiSensibili: false,
      }),
    ).toThrow();
  });

  it("vieta dati sensibili + PUBBLICA", () => {
    expect(() =>
      verificaVisibilita({
        scope: Scope.PERSONALE,
        visibility: Visibility.PUBBLICA,
        contieneDatiSensibili: true,
      }),
    ).toThrow();
  });
});

describe("update — visibilita'", () => {
  it("rifiuta di rendere pubblica una scheda di ambito CLIENTE", async () => {
    const row = h.repo.seed({ userId: USER, scope: Scope.CLIENTE });

    await expect(
      h.service.update(USER, row.id, { visibility: Visibility.PUBBLICA }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("prende la stessa violazione anche dalla direzione opposta", async () => {
    // PATCH { scope: CLIENTE } su una scheda gia' PUBBLICA: controllare solo il
    // campo che arriva lascerebbe passare questa.
    const row = h.repo.seed({ userId: USER, visibility: Visibility.PUBBLICA });

    await expect(h.service.update(USER, row.id, { scope: Scope.CLIENTE })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rifiuta di pubblicare una scheda con dati sensibili", async () => {
    const row = h.repo.seed({ userId: USER, contieneDatiSensibili: true });

    await expect(
      h.service.update(USER, row.id, { visibility: Visibility.PUBBLICA }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("permette di pubblicare togliendo il flag nella stessa patch", async () => {
    // «Una revisione esplicita»: l'utente dichiara di aver riletto la scheda
    // togliendo il flag, e in quel momento la pubblicazione e' legittima.
    const row = h.repo.seed({ userId: USER, contieneDatiSensibili: true });

    const aggiornata = await h.service.update(USER, row.id, {
      contieneDatiSensibili: false,
      visibility: Visibility.PUBBLICA,
    });

    expect(aggiornata.visibility).toBe(Visibility.PUBBLICA);
    expect(aggiornata.contieneDatiSensibili).toBe(false);
  });

  it("non scrive niente quando la regola scatta", async () => {
    const row = h.repo.seed({ userId: USER, scope: Scope.CLIENTE, titolo: "Prima" });

    await expect(
      h.service.update(USER, row.id, { titolo: "Dopo", visibility: Visibility.PUBBLICA }),
    ).rejects.toThrow();

    expect(h.repo.snapshot(row.id).titolo).toBe("Prima");
  });
});

describe("update — testo indicizzabile ed embedding", () => {
  it("ricompone sempre searchText, anche per una modifica a un passo", async () => {
    const row = h.repo.seed({ userId: USER, titolo: "Richiedere il casellario" });

    await h.service.update(USER, row.id, {
      steps: [{ azione: "Accedere con SPID", dettaglio: null, durataStimataMin: null }],
    });

    expect(h.repo.lastUpdate?.searchText).toContain("Accedere con SPID");
    expect(h.repo.lastUpdate?.searchText).toContain("Richiedere il casellario");
  });

  it("non ricalcola l'embedding se titolo, trigger e tag non cambiano", async () => {
    // Correggere un refuso in una trappola non deve costare una chiamata di
    // rete, ne' far fallire la PATCH quando il provider e' irraggiungibile.
    const row = h.repo.seed({ userId: USER });

    await h.service.update(USER, row.id, {
      pitfalls: [{ descrizione: "Lo sportello chiude alle 12:30", gravita: Severity.NOTA }],
    });

    expect(h.repo.lastUpdate?.embedding).toBeUndefined();
  });

  it("ricalcola l'embedding quando cambia il titolo", async () => {
    const row = h.repo.seed({ userId: USER });

    await h.service.update(USER, row.id, { titolo: "Un titolo completamente diverso" });

    expect(h.repo.lastUpdate?.embedding).toHaveLength(1536);
  });

  it("ricalcola l'embedding quando cambiano i tag", async () => {
    // I tag sono nell'input dell'embedding secondo la §7: cambiarli cambia il
    // vettore, anche se il titolo resta identico.
    const row = h.repo.seed({ userId: USER, tag: ["burocrazia"] });

    await h.service.update(USER, row.id, { tag: ["burocrazia", "documenti"] });

    expect(h.repo.lastUpdate?.embedding).toHaveLength(1536);
  });
});

/**
 * La dedup dei tag, vista da qui.
 *
 * Il difetto vero e' nel database (`@@id([procedureId, tagId])`, P2002) e si
 * prova nell'integrazione. Questi due casi pinzano che il servizio non lo
 * *offra* neanche, quel duplicato: il repository in memoria non ha chiavi
 * composte e accetterebbe qualunque cosa, quindi si guarda cosa gli e' stato
 * passato.
 */
describe("update — le categorie ripetute", () => {
  it("un aggiornamento con la stessa categoria due volte ne salva una", async () => {
    const row = h.repo.seed({ userId: USER, tag: [] });

    await h.service.update(USER, row.id, { tag: ["casa", "casa"] });

    expect(h.repo.lastUpdate?.tag).toEqual(["casa"]);
  });

  it("un aggiornamento con due categorie diverse le salva tutte e due", async () => {
    // L'errore opposto: una dedup che tagliasse troppo svuoterebbe le categorie
    // senza che nessun vincolo protesti.
    const row = h.repo.seed({ userId: USER, tag: [] });

    await h.service.update(USER, row.id, { tag: ["casa", "ufficio"] });

    expect(h.repo.lastUpdate?.tag).toEqual(["casa", "ufficio"]);
  });

  it("la categoria ripetuta non conta due volte nemmeno nel testo cercabile", async () => {
    // `searchText` ed embedding leggono i tag prima della scrittura: se la dedup
    // stesse piu' in basso, questi due vedrebbero una lista che il database non
    // accettera' mai.
    const row = h.repo.seed({ userId: USER, tag: [] });

    await h.service.update(USER, row.id, { tag: ["casa", "casa"] });

    const testo = h.repo.lastUpdate?.searchText ?? "";
    expect(testo.split("casa")).toHaveLength(2);
  });
});

describe("addExecution — il diagramma della §8", () => {
  it("CAMBIATA riporta la scheda in DA_RIVEDERE", async () => {
    const row = h.repo.seed({ userId: USER, status: CardStatus.COMPLETA });

    const aggiornata = await h.service.addExecution(USER, row.id, {
      esito: Outcome.CAMBIATA,
      nota: "Ora chiedono anche la marca da bollo",
    });

    expect(aggiornata.status).toBe(CardStatus.DA_RIVEDERE);
  });

  it("CAMBIATA non aggiorna ultimaVerifica", async () => {
    // Sarebbe il contrario di cio' che e' appena successo: la scheda e' stata
    // trovata sbagliata, non confermata.
    const row = h.repo.seed({ userId: USER, ultimaVerifica: null });

    const aggiornata = await h.service.addExecution(USER, row.id, {
      esito: Outcome.CAMBIATA,
      nota: null,
    });

    expect(aggiornata.ultimaVerifica).toBeNull();
  });

  it("FUNZIONATO su una scheda DA_RIVEDERE la riporta a COMPLETA", async () => {
    const row = h.repo.seed({ userId: USER, status: CardStatus.DA_RIVEDERE });

    const aggiornata = await h.service.addExecution(USER, row.id, {
      esito: Outcome.FUNZIONATO,
      nota: null,
    });

    expect(aggiornata.status).toBe(CardStatus.COMPLETA);
    expect(aggiornata.ultimaVerifica).toBe(NOW.toISOString());
  });

  it("FALLITA non muove lo stato", async () => {
    // La §8 non ha una freccia per lei: decidere al posto dell'utente se la
    // colpa e' della scheda o della giornata sarebbe un'invenzione.
    const row = h.repo.seed({ userId: USER, status: CardStatus.COMPLETA });

    const aggiornata = await h.service.addExecution(USER, row.id, {
      esito: Outcome.FALLITA,
      nota: "Ufficio chiuso",
    });

    expect(aggiornata.status).toBe(CardStatus.COMPLETA);
    expect(aggiornata.ultimaVerifica).toBeNull();
  });

  it("incrementa volteEseguita e registra l'esecuzione", async () => {
    const row = h.repo.seed({ userId: USER, volteEseguita: 3 });

    const aggiornata = await h.service.addExecution(USER, row.id, {
      esito: Outcome.FUNZIONATO,
      nota: "Tutto liscio",
    });

    expect(aggiornata.volteEseguita).toBe(4);
    expect(aggiornata.executions).toHaveLength(1);
    expect(aggiornata.executions[0]?.nota).toBe("Tutto liscio");
  });

  it("non arretra ultimaVerifica registrando un'esecuzione vecchia", async () => {
    // Registrare oggi un'esecuzione di sei mesi fa non deve invecchiare la
    // scheda: `ultimaVerifica` e' «l'ultima volta che ha funzionato», non
    // «l'ultima riga inserita».
    const fresca = new Date("2026-05-01T00:00:00.000Z");
    const row = h.repo.seed({ userId: USER, ultimaVerifica: fresca });

    const aggiornata = await h.service.addExecution(USER, row.id, {
      esito: Outcome.FUNZIONATO,
      nota: null,
      eseguitaIl: "2025-12-01T00:00:00.000Z",
    });

    expect(aggiornata.ultimaVerifica).toBe(fresca.toISOString());
  });

  it("rifiuta con 409 su una scheda archiviata", async () => {
    // Non un 404: l'id e' giusto e la scheda si legge. E' l'operazione a non
    // avere senso, e dirlo permette all'interfaccia di proporre il ripristino.
    const row = h.repo.seed({ userId: USER, status: CardStatus.ARCHIVIATA });

    await expect(
      h.service.addExecution(USER, row.id, { esito: Outcome.FUNZIONATO, nota: null }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("obsolescenza — calcolata a ogni lettura", () => {
  it("non segnala una scheda verificata di recente", async () => {
    const row = h.repo.seed({
      userId: USER,
      ultimaVerifica: new Date("2026-05-01T00:00:00.000Z"),
    });

    await expect(h.service.find(USER, row.id)).resolves.toMatchObject({ obsoleta: false });
  });

  it("segnala una scheda verificata piu' di un anno fa", async () => {
    const row = h.repo.seed({
      userId: USER,
      ultimaVerifica: new Date("2025-01-01T00:00:00.000Z"),
    });

    await expect(h.service.find(USER, row.id)).resolves.toMatchObject({ obsoleta: true });
  });

  it("non segnala una scheda mai verificata", async () => {
    // `ultimaVerifica === null` e' gia' detto dallo stato DA_RIVEDERE: due
    // avvisi per lo stesso fatto sarebbero rumore.
    const row = h.repo.seed({ userId: USER, ultimaVerifica: null });

    await expect(h.service.find(USER, row.id)).resolves.toMatchObject({ obsoleta: false });
  });

  it("la stessa scheda diventa obsoleta col passare del tempo, senza scritture", async () => {
    const row = h.repo.seed({
      userId: USER,
      ultimaVerifica: new Date("2026-05-01T00:00:00.000Z"),
    });

    await expect(h.service.find(USER, row.id)).resolves.toMatchObject({ obsoleta: false });
    h.clock.advanceDays(400);
    await expect(h.service.find(USER, row.id)).resolves.toMatchObject({ obsoleta: true });
  });
});

describe("list — il soft delete visto da fuori", () => {
  it("esclude le archiviate quando non si chiede uno stato", async () => {
    h.repo.seed({ userId: USER, id: "viva", status: CardStatus.COMPLETA });
    h.repo.seed({ userId: USER, id: "cestino", status: CardStatus.ARCHIVIATA });

    const page = await h.service.list(USER, LISTA);

    expect(page.items.map((i) => i.id)).toEqual(["viva"]);
    expect(page.total).toBe(1);
  });

  it("le mostra a chi le chiede: e' il cestino, non una cancellazione", async () => {
    h.repo.seed({ userId: USER, id: "viva", status: CardStatus.COMPLETA });
    h.repo.seed({ userId: USER, id: "cestino", status: CardStatus.ARCHIVIATA });

    const page = await h.service.list(USER, { ...LISTA, status: CardStatus.ARCHIVIATA });

    expect(page.items.map((i) => i.id)).toEqual(["cestino"]);
  });

  it("non mostra le schede di un altro utente", async () => {
    h.repo.seed({ userId: ALTRO });

    await expect(h.service.list(USER, LISTA)).resolves.toMatchObject({ items: [], total: 0 });
  });

  it("riporta il totale che soddisfa i filtri, non quello della pagina", async () => {
    for (let i = 0; i < 5; i += 1) {
      h.repo.seed({ userId: USER });
    }

    const page = await h.service.list(USER, { limit: 2, offset: 0 });

    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.limit).toBe(2);
  });
});

describe("proprieta' della risorsa", () => {
  it("risponde 404, non 403, sulla scheda di un altro", async () => {
    const row = h.repo.seed({ userId: ALTRO });

    await expect(h.service.find(USER, row.id)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("non lascia modificare la scheda di un altro", async () => {
    const row = h.repo.seed({ userId: ALTRO, titolo: "Sua" });

    await expect(h.service.update(USER, row.id, { titolo: "Mia" })).rejects.toMatchObject({
      status: 404,
    });
    expect(h.repo.snapshot(row.id).titolo).toBe("Sua");
  });

  it("non lascia archiviare la scheda di un altro", async () => {
    const row = h.repo.seed({ userId: ALTRO, status: CardStatus.COMPLETA });

    await expect(h.service.archive(USER, row.id)).rejects.toMatchObject({ status: 404 });
    expect(h.repo.snapshot(row.id).status).toBe(CardStatus.COMPLETA);
  });

  it("non lascia registrare esecuzioni sulla scheda di un altro", async () => {
    const row = h.repo.seed({ userId: ALTRO, volteEseguita: 1 });

    await expect(
      h.service.addExecution(USER, row.id, { esito: Outcome.FUNZIONATO, nota: null }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.repo.snapshot(row.id).volteEseguita).toBe(1);
  });
});

describe("archive", () => {
  it("porta la scheda in ARCHIVIATA ed e' idempotente", async () => {
    const row = h.repo.seed({ userId: USER, status: CardStatus.COMPLETA });

    await expect(h.service.archive(USER, row.id)).resolves.toMatchObject({
      status: CardStatus.ARCHIVIATA,
    });
    await expect(h.service.archive(USER, row.id)).resolves.toMatchObject({
      status: CardStatus.ARCHIVIATA,
    });
  });

  it("si torna indietro con una PATCH: non e' una cancellazione", async () => {
    const row = h.repo.seed({ userId: USER, status: CardStatus.COMPLETA });
    await h.service.archive(USER, row.id);

    await expect(
      h.service.update(USER, row.id, { status: CardStatus.DA_RIVEDERE }),
    ).resolves.toMatchObject({ status: CardStatus.DA_RIVEDERE });
  });
});

/**
 * L'unico gesto che non si annulla.
 *
 * I casi che contano non sono la cancellazione riuscita — quella e' una riga —
 * ma i tre modi in cui deve rifiutarsi di farla: su una scheda viva, su una
 * scheda di un altro, e una seconda volta sulla stessa. E poi l'audio, che sta
 * fuori dal database e quindi fuori dalla transazione: se il servizio si
 * dimenticasse di passarlo allo storage, ogni test qui sopra resterebbe verde e
 * la voce dell'utente resterebbe nel bucket.
 */
describe("deleteForever", () => {
  it("cancella la scheda che era gia' nel cestino, e i suoi oggetti", async () => {
    const row = h.repo.seed({
      userId: USER,
      status: CardStatus.ARCHIVIATA,
      audioUrls: ["user-1/aaa.webm", "user-1/bbb.webm"],
    });
    await h.blob.put({ key: "user-1/aaa.webm", data: new Uint8Array([1]), mimeType: "audio/webm" });
    await h.blob.put({ key: "user-1/bbb.webm", data: new Uint8Array([2]), mimeType: "audio/webm" });
    // Di un'altra scheda: se il servizio cancellasse tutto invece di cio' che il
    // repository gli ha nominato, la differenza si vedrebbe solo qui.
    await h.blob.put({ key: "user-1/ccc.webm", data: new Uint8Array([3]), mimeType: "audio/webm" });

    await expect(h.service.deleteForever(USER, row.id)).resolves.toBeUndefined();

    expect(h.repo.esiste(row.id)).toBe(false);
    expect([...h.blob.keys]).toEqual(["user-1/ccc.webm"]);
  });

  it("rifiuta con 409 una scheda che non e' nel cestino, e non la tocca", async () => {
    const row = h.repo.seed({ userId: USER, status: CardStatus.COMPLETA });

    await expect(h.service.deleteForever(USER, row.id)).rejects.toMatchObject({ status: 409 });
    expect(h.repo.esiste(row.id)).toBe(true);
    expect(h.repo.snapshot(row.id).status).toBe(CardStatus.COMPLETA);
  });

  it("rifiuta con 409 anche una scheda DA_RIVEDERE, che e' lo stato piu' vicino", async () => {
    // `DA_RIVEDERE` e' cio' che diventa una scheda ripescata dal cestino: e' il
    // caso in cui due schermate aperte fanno cancellare a una quello che l'altra
    // ha appena rimesso a posto.
    const row = h.repo.seed({ userId: USER, status: CardStatus.DA_RIVEDERE });

    await expect(h.service.deleteForever(USER, row.id)).rejects.toMatchObject({ status: 409 });
    expect(h.repo.esiste(row.id)).toBe(true);
  });

  it("non e' idempotente: la seconda volta e' un 404", async () => {
    const row = h.repo.seed({ userId: USER, status: CardStatus.ARCHIVIATA });

    await h.service.deleteForever(USER, row.id);
    await expect(h.service.deleteForever(USER, row.id)).rejects.toMatchObject({ status: 404 });
  });

  it("non lascia cancellare la scheda archiviata di un altro", async () => {
    const row = h.repo.seed({ userId: ALTRO, status: CardStatus.ARCHIVIATA });

    // 404 e non 403: un 403 confermerebbe che quell'id e' stato assegnato a
    // qualcuno, ed e' proprio l'informazione che si nega ovunque.
    await expect(h.service.deleteForever(USER, row.id)).rejects.toMatchObject({ status: 404 });
    expect(h.repo.esiste(row.id)).toBe(true);
  });

  it("se il bucket rifiuta non fa fallire chi ha premuto, ma segnala la chiave", async () => {
    const orfani: string[] = [];
    const repo = new InMemoryProcedureRepository();
    const service = createProceduresService({
      repo,
      embeddings: new FakeEmbeddingProvider({ model: "fake", dimensions: 1536 }),
      clock: new FixedClock(NOW),
      storage: new StorageSenzaCancellazione(),
      onOrphanedAudio: ({ key }) => orfani.push(key),
    });
    const row = repo.seed({
      userId: USER,
      status: CardStatus.ARCHIVIATA,
      audioUrls: ["user-1/rimasto.webm"],
    });

    // La riga non c'e' piu' e la transazione e' chiusa: rilanciare qui darebbe
    // un 500 a chi ha gia' ottenuto cio' che aveva chiesto, e lo spingerebbe a
    // ripetere una DELETE che ormai puo' solo rispondere 404.
    await expect(service.deleteForever(USER, row.id)).resolves.toBeUndefined();
    expect(repo.esiste(row.id)).toBe(false);
    expect(orfani).toEqual(["user-1/rimasto.webm"]);
  });

  it("prova a togliere il secondo oggetto anche se il primo e' fallito", async () => {
    const orfani: string[] = [];
    const repo = new InMemoryProcedureRepository();
    const service = createProceduresService({
      repo,
      embeddings: new FakeEmbeddingProvider({ model: "fake", dimensions: 1536 }),
      clock: new FixedClock(NOW),
      storage: new StorageSenzaCancellazione(),
      onOrphanedAudio: ({ key }) => orfani.push(key),
    });
    const row = repo.seed({
      userId: USER,
      status: CardStatus.ARCHIVIATA,
      audioUrls: ["user-1/primo.webm", "user-1/secondo.webm"],
    });

    await service.deleteForever(USER, row.id);

    // Due e non uno: un `try` attorno all'intero ciclo invece che attorno alla
    // singola cancellazione lascerebbe nel bucket ogni oggetto dopo il primo
    // guasto, e la traccia direbbe che ne era rimasto uno solo.
    expect(orfani).toEqual(["user-1/primo.webm", "user-1/secondo.webm"]);
  });
});

/**
 * Lo stesso gesto, su tutto il cestino insieme.
 *
 * Qui i casi interessanti sono due, e nessuno dei due e' «cancella tutto».
 *
 * Il primo e' cosa NON viene toccato: una scheda viva, una `DA_RIVEDERE`, il
 * cestino di un altro utente. `emptyTrash` non riceve nessun id da chi chiama —
 * se li sceglie da solo — e quindi non ha, come `deleteForever`, un 404 che la
 * ferma quando la scelta e' sbagliata. L'unica difesa e' la `where` di
 * `listArchivedIds`, e questi casi sono il modo di guardarla.
 *
 * Il secondo e' `saltate`. Una scheda ripescata dal cestino mentre lo si svuota
 * non deve essere cancellata e non deve interrompere niente: sono i due errori
 * opposti, e stanno a un `if` di distanza l'uno dall'altro.
 */
describe("emptyTrash", () => {
  /** Un servizio sopra un repository e un bucket scelti dal caso. */
  function servizioSu(
    repo: InMemoryProcedureRepository,
    extra: {
      storage?: FakeStorageProvider;
      onOrphanedAudio?: (info: { key: string; error: unknown }) => void;
    } = {},
  ): ProceduresService {
    return createProceduresService({
      repo,
      embeddings: new FakeEmbeddingProvider({ model: "fake", dimensions: 1536 }),
      clock: new FixedClock(NOW),
      storage: extra.storage ?? new FakeStorageProvider(),
      onOrphanedAudio: extra.onOrphanedAudio,
    });
  }

  it("porta via cio' che era nel cestino, e lascia in piedi tutto il resto", async () => {
    h.repo.seed({ userId: USER, id: "buttata-1", status: CardStatus.ARCHIVIATA });
    h.repo.seed({ userId: USER, id: "buttata-2", status: CardStatus.ARCHIVIATA });
    h.repo.seed({ userId: USER, id: "viva", status: CardStatus.COMPLETA });
    // `DA_RIVEDERE` e' lo stato in cui torna una scheda ripescata dal cestino:
    // e' quella che un filtro scritto al contrario — «tutto tranne COMPLETA» —
    // porterebbe via insieme alle altre.
    h.repo.seed({ userId: USER, id: "ripescata-ieri", status: CardStatus.DA_RIVEDERE });

    await expect(h.service.emptyTrash(USER)).resolves.toEqual({
      cancellate: 2,
      saltate: 0,
      rimaste: 0,
    });

    expect(h.repo.esiste("buttata-1")).toBe(false);
    expect(h.repo.esiste("buttata-2")).toBe(false);
    expect(h.repo.esiste("viva")).toBe(true);
    expect(h.repo.esiste("ripescata-ieri")).toBe(true);
  });

  it("svuota il cestino di chi ha premuto, e non quello di un altro", async () => {
    h.repo.seed({ userId: ALTRO, id: "sua", status: CardStatus.ARCHIVIATA });
    h.repo.seed({ userId: USER, id: "mia", status: CardStatus.ARCHIVIATA });

    // Uno `userId` dimenticato nella `where` non darebbe nessun errore: darebbe
    // un due al posto di un uno, e il cestino di un estraneo vuoto.
    await expect(h.service.emptyTrash(USER)).resolves.toEqual({
      cancellate: 1,
      saltate: 0,
      // Zero anche qui, e non uno: `rimaste` e' il cestino di chi ha premuto.
      // Se contasse tutte le righe `ARCHIVIATA` della tabella, la scheda
      // dell'altro utente si affaccerebbe nella risposta di questo.
      rimaste: 0,
    });
    expect(h.repo.esiste("mia")).toBe(false);
    expect(h.repo.esiste("sua")).toBe(true);
  });

  it("un cestino vuoto risponde zero e zero, e non «fatto»", async () => {
    h.repo.seed({ userId: USER, status: CardStatus.COMPLETA });

    // Zero non e' un guasto e non e' un errore: e' un cestino gia' vuoto, e chi
    // riceve la risposta ha bisogno di poterlo dire con quelle parole.
    await expect(h.service.emptyTrash(USER)).resolves.toEqual({
      cancellate: 0,
      saltate: 0,
      rimaste: 0,
    });
  });

  it("toglie dal bucket i vocali di ogni scheda cancellata, e nient'altro", async () => {
    h.repo.seed({ userId: USER, status: CardStatus.ARCHIVIATA, audioUrls: ["user-1/aaa.webm"] });
    h.repo.seed({ userId: USER, status: CardStatus.ARCHIVIATA, audioUrls: ["user-1/bbb.webm"] });
    h.repo.seed({ userId: USER, status: CardStatus.COMPLETA, audioUrls: ["user-1/viva.webm"] });
    for (const key of ["user-1/aaa.webm", "user-1/bbb.webm", "user-1/viva.webm"]) {
      await h.blob.put({ key, data: new Uint8Array([1]), mimeType: "audio/webm" });
    }

    await h.service.emptyTrash(USER);

    // Due chiavi su tre. Uno svuotamento che cancellasse le righe senza passare
    // dallo storage lascerebbe tutti e tre i file nel bucket, e ogni altra
    // asserzione di questo describe resterebbe verde.
    expect([...h.blob.keys]).toEqual(["user-1/viva.webm"]);
  });

  it("salta la scheda ripescata mentre si cancellava, e non la tocca", async () => {
    const repo = new RepoConSorpresa();
    const service = servizioSu(repo);
    repo.seed({ userId: USER, id: "buttata", status: CardStatus.ARCHIVIATA });
    repo.seed({ userId: USER, id: "ripescata", status: CardStatus.ARCHIVIATA });
    repo.sorpresa = (r) => {
      r.seed({ userId: USER, id: "ripescata", status: CardStatus.DA_RIVEDERE });
    };

    // `saltate: 1` e `rimaste: 0` nella stessa risposta, e non si contraddicono:
    // la scheda saltata e' stata saltata proprio perche' era uscita dal cestino.
    // Un `rimaste` calcolato come «quante ne avevo meno quante ne ho cancellate»
    // direbbe uno, e chi legge premerebbe di nuovo su un cestino vuoto.
    await expect(service.emptyTrash(USER)).resolves.toEqual({
      cancellate: 1,
      saltate: 1,
      rimaste: 0,
    });

    // La scheda e' uscita dal cestino un istante prima: cancellarla comunque
    // vorrebbe dire che «Ripristina» non protegge da «Svuota».
    expect(repo.esiste("ripescata")).toBe(true);
    expect(repo.snapshot("ripescata").status).toBe(CardStatus.DA_RIVEDERE);
    expect(repo.esiste("buttata")).toBe(false);
  });

  it("salta la scheda che nel frattempo era gia' sparita, e arriva in fondo", async () => {
    const repo = new RepoConSorpresa();
    const service = servizioSu(repo);
    repo.seed({ userId: USER, id: "sparita", status: CardStatus.ARCHIVIATA });
    repo.seed({ userId: USER, id: "ultima", status: CardStatus.ARCHIVIATA });
    repo.sorpresa = async (r) => {
      await r.deleteForUser(USER, "sparita");
    };

    // «Non c'e' piu'» e' il risultato che si stava chiedendo. Farne un 404
    // interromperebbe lo svuotamento sulla prima scheda, e «ultima» resterebbe
    // dentro per un motivo che nessuno saprebbe leggere nella risposta.
    await expect(service.emptyTrash(USER)).resolves.toEqual({
      cancellate: 1,
      saltate: 1,
      rimaste: 0,
    });
    expect(repo.esiste("ultima")).toBe(false);
  });

  it("un bucket che rifiuta non ferma lo svuotamento, e ogni chiave viene nominata", async () => {
    const orfani: string[] = [];
    const repo = new InMemoryProcedureRepository();
    const service = servizioSu(repo, {
      storage: new StorageSenzaCancellazione(),
      onOrphanedAudio: ({ key }) => orfani.push(key),
    });
    repo.seed({ userId: USER, id: "prima", status: CardStatus.ARCHIVIATA, audioUrls: ["a.webm"] });
    repo.seed({ userId: USER, id: "seconda", status: CardStatus.ARCHIVIATA, audioUrls: ["b.webm"] });

    await expect(service.emptyTrash(USER)).resolves.toEqual({
      cancellate: 2,
      saltate: 0,
      rimaste: 0,
    });

    // Le righe sono sparite entrambe: i byte stanno fuori dalla transazione, e
    // un bucket irraggiungibile non e' una ragione per lasciare in piedi schede
    // che l'utente ha chiesto di cancellare.
    expect(repo.esiste("prima")).toBe(false);
    expect(repo.esiste("seconda")).toBe(false);
    // Due e non una: se il guasto della prima scheda uscisse dal ciclo, la
    // seconda chiave non sarebbe nemmeno provata, e la scopa la ritroverebbe
    // senza che nessun registro l'avesse mai nominata.
    expect([...orfani].sort()).toEqual(["a.webm", "b.webm"]);
  });

  /**
   * Il tetto per richiesta, e cio' che dice a chi ha chiamato.
   *
   * Il servizio non svuota il cestino: ne svuota un pezzo, e dice quanto resta.
   * E' la meta' server dello stesso gesto, e la sola che sa quanto costa —
   * ogni scheda e' una transazione piu' un giro di `delete` sul bucket, e un
   * cestino da mille schede supera il timeout di qualunque proxy prima di
   * arrivare in fondo.
   *
   * I casi qui sotto guardano il taglio da tutt'e due i lati: che ci sia quando
   * serve, e che non ci sia quando non serve. Un tetto applicato sempre — per
   * esempio uno `slice` scritto prima del controllo — spezzerebbe in due
   * richieste anche un cestino da tre schede, e nessuno se ne accorgerebbe
   * guardando il risultato finale, che sarebbe lo stesso.
   */
  it("il tetto e' un numero piccolo, ed e' l'unica cosa che deve essere", () => {
    // Gli altri casi di questo gruppo usano `EMPTY_TRASH_BATCH_SIZE` invece di
    // scrivere cinquanta, e quindi seguono la costante ovunque vada: portarla a
    // mille non li farebbe cadere. E' voluto — un test che ripete un letterale
    // prova solo che due righe dicono la stessa cosa — ma lascia scoperta
    // proprio la decisione per cui questo tetto esiste.
    //
    // Il limite superiore e' il timeout: ogni scheda costa una transazione piu'
    // un giro sul bucket, e sopra il centinaio una richiesta sola torna a
    // durare piu' di quanto un proxy davanti al server sia disposto ad
    // aspettare. Quello inferiore e' l'opposto: un tetto di cinque
    // trasformerebbe un cestino normale in dieci richieste, e la somma delle
    // latenze costerebbe piu' del problema che si sta evitando.
    expect(EMPTY_TRASH_BATCH_SIZE).toBeGreaterThanOrEqual(10);
    expect(EMPTY_TRASH_BATCH_SIZE).toBeLessThanOrEqual(100);
  });

  it("ne porta via al massimo quante ne sta il tetto, e dice quante ne restano", async () => {
    const quante = EMPTY_TRASH_BATCH_SIZE + 7;
    for (let i = 0; i < quante; i += 1) {
      h.repo.seed({ userId: USER, id: `buttata-${String(i)}`, status: CardStatus.ARCHIVIATA });
    }

    await expect(h.service.emptyTrash(USER)).resolves.toEqual({
      cancellate: EMPTY_TRASH_BATCH_SIZE,
      saltate: 0,
      // Sette, e non zero: senza questo numero chi ha chiamato crederebbe di
      // aver svuotato il cestino, e le sette resterebbero dentro in silenzio.
      rimaste: 7,
    });
  });

  it("un cestino piu' piccolo del tetto se ne va tutto in una volta", async () => {
    // L'errore opposto: un taglio applicato a prescindere costerebbe una
    // seconda richiesta su ogni svuotamento normale — e nei registri del
    // server il pulsante rosso sembrerebbe premuto due volte.
    h.repo.seed({ userId: USER, id: "una", status: CardStatus.ARCHIVIATA });
    h.repo.seed({ userId: USER, id: "due", status: CardStatus.ARCHIVIATA });
    h.repo.seed({ userId: USER, id: "tre", status: CardStatus.ARCHIVIATA });

    await expect(h.service.emptyTrash(USER)).resolves.toEqual({
      cancellate: 3,
      saltate: 0,
      rimaste: 0,
    });
  });

  it("due passate di fila arrivano in fondo, e la seconda morde da dove si era fermata", async () => {
    // Questo e' cio' che il client fa per davvero. Serve perche' il tetto da
    // solo non basta: se `listArchivedIds` prendesse le schede da un ordine che
    // cambia a ogni chiamata — o dalla coda invece che dalla testa — ogni
    // passata potrebbe ripescare le stesse, e il cestino non si accorcerebbe
    // mai. Il ciclo del client girerebbe cinquanta volte e si arrenderebbe.
    const quante = EMPTY_TRASH_BATCH_SIZE + 7;
    for (let i = 0; i < quante; i += 1) {
      h.repo.seed({ userId: USER, id: `buttata-${String(i)}`, status: CardStatus.ARCHIVIATA });
    }

    const prima = await h.service.emptyTrash(USER);
    const seconda = await h.service.emptyTrash(USER);

    expect(prima.rimaste).toBe(7);
    expect(seconda).toEqual({ cancellate: 7, saltate: 0, rimaste: 0 });
  });
});

describe("contratto pubblico", () => {
  it("la scheda restituita e' conforme allo schema di shared", async () => {
    const row = h.repo.seed({
      userId: USER,
      ultimaVerifica: new Date("2025-01-01T00:00:00.000Z"),
      tag: ["burocrazia"],
      steps: [
        { id: "s1", ordine: 1, azione: "Accedere", dettaglio: null, durataStimataMin: 5 },
      ],
    });

    const scheda = await h.service.find(USER, row.id);

    expect(procedureDetailSchema.safeParse(scheda).success).toBe(true);
  });
});
