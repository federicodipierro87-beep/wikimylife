import type {
  ApiClient,
  ListProceduresQueryInput,
  ProcedureList,
  ProcedureSummary,
} from "@wikimylife/shared";
import { ApiError, PROCEDURE_PAGE_SIZE } from "@wikimylife/shared";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toHash } from "../../apps/web/src/routes";
import { ListScreen } from "../../apps/web/src/screens/ListScreen";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unaVoce, unElenco } from "./helpers/dati";
import { montaConApi } from "./helpers/render";

/**
 * L'elenco delle schede, e le due cose che sa fare oltre a mostrarle: filtrare
 * per ambito e sfogliare.
 *
 * Nessuna delle due si rompe in modo visibile, ed e' questo che le mette qui.
 * Una schermata che sbaglia a paginare non da' un errore e non ha un'aria
 * strana: mostra una lista, che e' esattamente cio' che ci si aspetta di
 * vedere. Solo che e' la lista sbagliata, oppure e' vuota — e una lista vuota,
 * in quest'app, ha gia' un significato scritto a schermo: «Qui non c'e' ancora
 * niente». Chi ha ottanta procedure e legge quella frase non pensa a un
 * difetto di paginazione: pensa di aver perso l'archivio.
 *
 * Da qui la forma dei casi: non si guarda solo la richiesta che parte, si
 * guarda anche cosa finisce sotto gli occhi di chi ha premuto.
 *
 * `PendingRecordings` e' montata dentro questa schermata e qui risponde vuota
 * in ogni caso: ha i suoi test in `pending.test.tsx`, e vuota non disegna
 * niente e non accende nessun timer. Darle un contenuto vorrebbe dire rifare
 * quei casi, e per giunta di lato.
 */

/** L'ultima cosa che la schermata ha chiesto, che e' quasi sempre quella in causa. */
function ultima<T>(xs: readonly T[]): T {
  const x = xs.at(-1);
  if (x === undefined) {
    throw new Error("La schermata non ha chiesto niente: il caso sta verificando il nulla.");
  }
  return x;
}

function clienteElenco(rispondi: (q: ListProceduresQueryInput) => ProcedureList): {
  client: ApiClient;
  richieste: ListProceduresQueryInput[];
} {
  const richieste: ListProceduresQueryInput[] = [];
  const client = creaClienteFinto({
    listPendingRecordings: () => Promise.resolve({ items: [] }),
    listProcedures: (query = {}) => {
      richieste.push(query);
      return Promise.resolve(rispondi(query));
    },
  });
  return { client, richieste };
}

/**
 * Una pagina piena, numerata a partire da `primo`.
 *
 * Venti voci e non due: `total: 45` con due sole voci in pagina e' una risposta
 * che nessun server manderebbe, e i numeri che ne discendono — «1–20 di 45», e
 * «Successive» che chiede l'offset 20 — sembrerebbero scelti a caso invece che
 * calcolati.
 */
function unaPagina(primo: number, quante: number = PROCEDURE_PAGE_SIZE): ProcedureSummary[] {
  return Array.from({ length: quante }, (_, i) =>
    unaVoce({ id: `proc-${String(primo + i)}`, titolo: `Procedura ${String(primo + i)}` }),
  );
}

/** Quarantacinque schede in tutto, servite a pagine come farebbe il server. */
function archivioDa45(q: ListProceduresQueryInput): ProcedureList {
  const offset = q.offset ?? 0;
  return unElenco({
    items: unaPagina(offset + 1, Math.min(PROCEDURE_PAGE_SIZE, 45 - offset)),
    total: 45,
    offset,
  });
}

/** Un pulsante della schermata, per poterne leggere lo stato e non solo il nome. */
function bottone(nome: string): HTMLElement {
  return screen.getByRole("button", { name: nome });
}

beforeEach(() => {
  // jsdom non sa scorrere, e la schermata glielo chiede a ogni cambio pagina.
  // Senza questo il caso passa lo stesso, ma con un «Not implemented» in mezzo
  // all'output che sembra il sintomo di qualcos'altro.
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ListScreen: il filtro di ambito", () => {
  it("cambiare ambito riporta alla prima pagina, invece di mostrare un vuoto che non esiste", async () => {
    const { client, richieste } = clienteElenco((q) => {
      if (q.scope !== "LAVORO") {
        return archivioDa45(q);
      }
      // In Lavoro ci sono tre schede. Alla pagina due non c'e' niente, ed e'
      // precisamente quel niente che non deve comparire: chiedere «Lavoro»
      // restando all'offset 20 risponde una lista vuota, e la schermata scrive
      // che li' dentro non c'e' ancora niente. Nessun errore, nessun sintomo, e
      // una risposta falsa a una domanda che l'utente ha appena posto.
      const offset = q.offset ?? 0;
      return offset === 0
        ? unElenco({ items: unaPagina(100, 3), total: 3 })
        : unElenco({ items: [], total: 3, offset });
    });

    montaConApi(client, <ListScreen />);
    const utente = userEvent.setup();

    await utente.click(await screen.findByRole("button", { name: "Successive" }));
    await screen.findByText("Procedura 21");
    expect(ultima(richieste).offset).toBe(PROCEDURE_PAGE_SIZE);

    await utente.click(screen.getByRole("tab", { name: "Lavoro" }));

    expect(await screen.findByText("Procedura 100")).toBeTruthy();
    expect(ultima(richieste)).toEqual({
      limit: PROCEDURE_PAGE_SIZE,
      offset: 0,
      scope: "LAVORO",
    });
    expect(screen.queryByText("Qui non c'e' ancora niente.")).toBeNull();
  });

  it("«Tutte» torna a chiedere tutto, e non l'ambito di prima", async () => {
    const { client, richieste } = clienteElenco((q) =>
      unElenco({
        items: [
          unaVoce({ id: "x", titolo: q.scope === undefined ? "Tutte quante" : "Solo lavoro" }),
        ],
      }),
    );

    montaConApi(client, <ListScreen />);
    const utente = userEvent.setup();

    // La prima richiesta parte senza ambito: e' la schermata che si apre.
    await screen.findByText("Tutte quante");
    expect(ultima(richieste)).toEqual({ limit: PROCEDURE_PAGE_SIZE, offset: 0 });

    await utente.click(screen.getByRole("tab", { name: "Lavoro" }));
    await screen.findByText("Solo lavoro");
    expect(ultima(richieste).scope).toBe("LAVORO");

    await utente.click(screen.getByRole("tab", { name: "Tutte" }));
    await screen.findByText("Tutte quante");
    // Non `scope: "TUTTE"`, che il server non conosce, e nemmeno l'ambito
    // rimasto attaccato dal giro prima: la voce «Tutte» e' l'assenza di filtro.
    expect(ultima(richieste).scope).toBeUndefined();
  });
});

describe("ListScreen: sfogliare", () => {
  it("«Successive» chiede la pagina dopo, contata su cio' che il server ha risposto", async () => {
    const { client, richieste } = clienteElenco(archivioDa45);

    montaConApi(client, <ListScreen />);
    const utente = userEvent.setup();

    await utente.click(await screen.findByRole("button", { name: "Successive" }));

    expect(await screen.findByText("Procedura 21")).toBeTruthy();
    // L'offset e' `offset + limit` di cio' che e' tornato, e non un contatore
    // di pagine tenuto a parte: sono la stessa cosa finche' nessuno tocca
    // `PROCEDURE_PAGE_SIZE`, e smettono di esserlo il giorno dopo.
    expect(ultima(richieste)).toEqual({ limit: PROCEDURE_PAGE_SIZE, offset: PROCEDURE_PAGE_SIZE });
    expect(screen.queryByText("Procedura 1")).toBeNull();
  });

  it("sulla prima pagina non si puo' andare indietro", async () => {
    const { client } = clienteElenco(archivioDa45);

    montaConApi(client, <ListScreen />);
    await screen.findByText("Procedura 1");

    // Acceso, «Precedenti» chiederebbe l'offset -20. Il server lo rifiuta
    // (`min(0)` nello schema), e chi ha premuto si ritrova un avviso rosso su
    // una schermata che non ha nessun problema.
    expect(bottone("Precedenti").hasAttribute("disabled")).toBe(true);
    expect(bottone("Successive").hasAttribute("disabled")).toBe(false);
  });

  it("sull'ultima pagina non si puo' andare avanti, ma si puo' ancora tornare indietro", async () => {
    const { client } = clienteElenco(() =>
      unElenco({ items: unaPagina(41, 5), total: 45, offset: 40 }),
    );

    montaConApi(client, <ListScreen />);
    await screen.findByText("Procedura 41");

    // Avanti non c'e' niente: «Successive» acceso chiederebbe una pagina vuota,
    // e la schermata scriverebbe «Qui non c'e' ancora niente» su un archivio di
    // quarantacinque schede.
    expect(bottone("Successive").hasAttribute("disabled")).toBe(true);
    // La barra pero' resta disegnata. Nasconderla quando non c'e' un seguito
    // lascerebbe l'ultima pagina senza via d'uscita: da li' si torna indietro
    // solo ricaricando.
    expect(bottone("Precedenti").hasAttribute("disabled")).toBe(false);
  });

  it("quando l'archivio sta in una pagina non c'e' niente da sfogliare", async () => {
    const { client } = clienteElenco(() => unElenco({ items: unaPagina(1, 3) }));

    montaConApi(client, <ListScreen />);
    await screen.findByText("Procedura 1");

    // Due pulsanti spenti e un «1–3 di 3» sotto tre righe sono rumore: dicono
    // che da qualche parte c'e' dell'altro, e non c'e'.
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("ListScreen: quando il server non risponde", () => {
  it("un guasto si vede come un guasto, e non come un archivio vuoto", async () => {
    const client = creaClienteFinto({
      listPendingRecordings: () => Promise.resolve({ items: [] }),
      listProcedures: () =>
        Promise.reject(
          new ApiError({ code: "INTERNAL_ERROR", message: "Il server non risponde.", status: 500 }),
        ),
    });

    montaConApi(client, <ListScreen />);

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toBe("Il server non risponde.");
    // La differenza fra «non sono riuscito a leggere» e «non hai niente» e'
    // tutta qui: la seconda frase, letta da chi ha ottanta procedure, dice che
    // le ha perse.
    expect(screen.queryByText("Qui non c'e' ancora niente.")).toBeNull();
  });
});

describe("ListScreen: la porta dell'account", () => {
  it("«Account» ci porta davvero, perche' non ce n'e' un'altra", async () => {
    const { client } = clienteElenco(archivioDa45);

    montaConApi(client, <ListScreen />);
    await screen.findByText("Procedura 1");

    window.location.hash = "";
    const utente = userEvent.setup();
    await utente.click(bottone("Account"));

    // Il cambio password e il logout stanno di la' da questo pulsante e da
    // nessun altro posto: la barra bassa ha tre voci e nessuna e' questa. Se
    // qui si navigasse altrove, o se il pulsante sparisse in una riscrittura
    // della testata, la schermata tornerebbe irraggiungibile — che e' lo stato
    // esatto in cui la rotta e' rimasta per un commit intero.
    expect(window.location.hash).toBe(toHash({ name: "account" }));
  });
});

describe("ListScreen: la porta del cestino", () => {
  it("«Cestino» ci porta davvero, perche' anche di quella non ce n'e' un'altra", async () => {
    const { client } = clienteElenco(archivioDa45);

    montaConApi(client, <ListScreen />);
    await screen.findByText("Procedura 1");

    window.location.hash = "";
    const utente = userEvent.setup();
    await utente.click(bottone("Cestino"));

    expect(window.location.hash).toBe(toHash({ name: "cestino" }));
  });

  it("c'e' anche quando l'elenco e' vuoto, che e' quando serve di piu'", async () => {
    const { client } = clienteElenco(() => unElenco({ items: [], total: 0 }));

    montaConApi(client, <ListScreen />);
    await screen.findByText("Qui non c'e' ancora niente.");

    // Dentro il ramo che disegna le schede — dove sta la paginazione, e dove
    // sarebbe finito senza pensarci — il pulsante sparirebbe proprio a chi ha
    // archiviato tutto e sta cercando dove sia finito l'archivio. La frase
    // «Qui non c'e' ancora niente» diventerebbe l'ultima parola dell'app.
    expect(bottone("Cestino")).toBeTruthy();
  });
});
