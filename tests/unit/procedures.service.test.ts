import {
  CardStatus,
  Outcome,
  Scope,
  Severity,
  Visibility,
  procedureDetailSchema,
  type ListProceduresQuery,
} from "@wikimylife/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../../apps/api/src/providers/fake/index.js";
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
  readonly service: ProceduresService;
}

function harness(): Harness {
  const repo = new InMemoryProcedureRepository();
  const clock = new FixedClock(NOW);
  return {
    repo,
    clock,
    service: createProceduresService({
      repo,
      embeddings: new FakeEmbeddingProvider({ model: "fake", dimensions: 1536 }),
      clock,
    }),
  };
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
