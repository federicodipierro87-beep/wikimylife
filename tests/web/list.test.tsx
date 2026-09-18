import type {
  ApiClient,
  ListProceduresQueryInput,
  ListTagsQueryInput,
  ProcedureList,
  ProcedureSummary,
  RecordingState,
  TagList,
} from "@wikimylife/shared";
import { ApiError, PROCEDURE_PAGE_SIZE } from "@wikimylife/shared";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toHash } from "../../apps/web/src/routes";
import { ListScreen } from "../../apps/web/src/screens/ListScreen";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unaRegistrazione, unaVoce, unElenco } from "./helpers/dati";
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
 * `PendingRecordings` e' montata dentro questa schermata e quasi ovunque qui
 * risponde vuota: ha i suoi test in `pending.test.tsx`, e vuota non disegna
 * niente e non accende nessun timer. Darle un contenuto vorrebbe dire rifare
 * quei casi, e per giunta di lato.
 *
 * L'eccezione e' l'ultimo gruppo, dove il contenuto dei sospesi e' proprio
 * l'oggetto del test: il legame fra le due sezioni — un id che sparisce di
 * sopra e un elenco che si richiede di sotto — non esiste in nessuno dei due
 * file da solo.
 */

/** Il ritmo del polling dei sospesi, che qui e' l'orologio dell'ultimo gruppo. */
const CINQUE_SECONDI = 5000;

/** L'ultima cosa che la schermata ha chiesto, che e' quasi sempre quella in causa. */
function ultima<T>(xs: readonly T[]): T {
  const x = xs.at(-1);
  if (x === undefined) {
    throw new Error("La schermata non ha chiesto niente: il caso sta verificando il nulla.");
  }
  return x;
}

/**
 * `categorie` ha un valore predefinito vuoto, e non per pigrizia.
 *
 * Un archivio senza nessun tag non disegna la seconda fila di chip, quindi i
 * casi che parlano di ambito, di pagine e di porte restano davanti alla
 * schermata che avevano prima: se dovessero dichiarare delle categorie di cui
 * non gliene importa niente, la fila comparirebbe e ogni ricerca per ruolo
 * `tab` troverebbe il doppio delle voci — a partire da «Tutte», che nelle due
 * file c'e' due volte.
 */
function clienteElenco(
  rispondi: (q: ListProceduresQueryInput) => ProcedureList,
  categorie: (q: ListTagsQueryInput) => TagList = () => ({ items: [] }),
): {
  client: ApiClient;
  richieste: ListProceduresQueryInput[];
  richiesteTag: ListTagsQueryInput[];
} {
  const richieste: ListProceduresQueryInput[] = [];
  const richiesteTag: ListTagsQueryInput[] = [];
  const client = creaClienteFinto({
    listPendingRecordings: () => Promise.resolve({ items: [] }),
    listProcedures: (query = {}) => {
      richieste.push(query);
      return Promise.resolve(rispondi(query));
    },
    listTags: (query = {}) => {
      richiesteTag.push(query);
      return Promise.resolve(categorie(query));
    },
  });
  return { client, richieste, richiesteTag };
}

/**
 * Una delle due file di chip, per nome.
 *
 * Senza, «Tutte» e' ambigua: c'e' negli ambiti e c'e' nelle categorie, e
 * `screen.getByRole("tab", { name: "Tutte" })` con tutte e due le file a schermo
 * fallisce per troppi risultati — oppure, peggio, un `queryBy` trova quella
 * sbagliata e il caso passa guardando l'altra fila.
 */
function fila(etichetta: string): HTMLElement {
  return screen.getByRole("tablist", { name: etichetta });
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

/**
 * Le categorie, che a schermo sono chip e nel contratto sono tag.
 *
 * Il guasto da cui nascono questi casi non e' una schermata rotta ma una
 * schermata che mente: una chip dice «Casa 7» e apre sei schede, oppure dice
 * «Casa» e non filtra niente, oppure filtra e resta spenta. Sono tutte cose che
 * si vedono solo contando, e chi guarda non conta.
 *
 * L'altra meta' sta sull'indice: quando la fila delle categorie si ricarica e
 * quando no. Sbagliare in eccesso non da' nessun sintomo — solo una richiesta in
 * piu' a ogni tocco — mentre sbagliare per difetto lascia a schermo il conteggio
 * di un minuto fa, cioe' il numero su cui la schermata chiede di fidarsi.
 */
describe("ListScreen: le categorie", () => {
  const DUE_CATEGORIE: TagList = {
    items: [
      { nome: "Casa", conteggio: 7 },
      { nome: "Ufficio", conteggio: 2 },
    ],
  };

  it("compaiono come chip, e ognuna dice quante schede ci sono dentro", async () => {
    const { client } = clienteElenco(archivioDa45, () => DUE_CATEGORIE);

    montaConApi(client, <ListScreen />);
    await screen.findByText("Procedura 1");

    const categorie = fila("Categoria");
    // Il numero sta nel nome accessibile della chip e non solo in un attributo:
    // una fila di nomi nudi non dice quale valga la pena di premere, e quella
    // con una scheda sola si presenta identica a quella con quaranta.
    expect(within(categorie).getByRole("tab", { name: "Casa 7" })).toBeTruthy();
    expect(within(categorie).getByRole("tab", { name: "Ufficio 2" })).toBeTruthy();
  });

  it("senza nessuna categoria la fila non compare, invece di un «Tutte» solitario", async () => {
    const { client } = clienteElenco(archivioDa45);

    montaConApi(client, <ListScreen />);
    await screen.findByText("Procedura 1");

    expect(screen.queryByRole("tablist", { name: "Categoria" })).toBeNull();
    // E l'errore opposto, che qui e' la parte che conta: la fila degli ambiti
    // c'e' lo stesso. Senza questa riga il caso sopra passerebbe anche se la
    // schermata non disegnasse piu' nessun filtro.
    expect(fila("Ambito")).toBeTruthy();
  });

  it("premere una categoria la chiede al server, e la accende", async () => {
    const { client, richieste } = clienteElenco(archivioDa45, () => DUE_CATEGORIE);

    montaConApi(client, <ListScreen />);
    await screen.findByText("Procedura 1");
    const utente = userEvent.setup();

    await utente.click(within(fila("Categoria")).getByRole("tab", { name: "Casa 7" }));
    await screen.findByText("Procedura 1");

    expect(ultima(richieste).tag).toBe("Casa");
    // Il filtro applicato e la chip accesa sono due cose diverse, e una
    // schermata che filtra senza dirlo e' una schermata che nasconde schede
    // senza motivo apparente.
    expect(
      within(fila("Categoria")).getByRole("tab", { name: "Casa 7" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      within(fila("Categoria")).getByRole("tab", { name: "Tutte" }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("premere una categoria riporta alla prima pagina", async () => {
    const { client, richieste } = clienteElenco(archivioDa45, () => DUE_CATEGORIE);

    montaConApi(client, <ListScreen />);
    const utente = userEvent.setup();

    await utente.click(await screen.findByRole("button", { name: "Successive" }));
    await screen.findByText("Procedura 21");
    expect(ultima(richieste).offset).toBe(PROCEDURE_PAGE_SIZE);

    await utente.click(within(fila("Categoria")).getByRole("tab", { name: "Casa 7" }));

    // Stesso ragionamento dell'ambito: sette schede in «Casa» non hanno una
    // pagina due, e restare all'offset 20 risponde una lista vuota sotto una
    // chip che dice sette.
    await screen.findByText("Procedura 1");
    expect(ultima(richieste)).toEqual({
      limit: PROCEDURE_PAGE_SIZE,
      offset: 0,
      tag: "Casa",
    });
  });

  it("«Tutte» toglie la categoria dalla query, e non ne manda una vuota", async () => {
    const { client, richieste } = clienteElenco(archivioDa45, () => DUE_CATEGORIE);

    montaConApi(client, <ListScreen />);
    await screen.findByText("Procedura 1");
    const utente = userEvent.setup();

    await utente.click(within(fila("Categoria")).getByRole("tab", { name: "Casa 7" }));
    await screen.findByText("Procedura 1");
    expect(ultima(richieste).tag).toBe("Casa");

    await utente.click(within(fila("Categoria")).getByRole("tab", { name: "Tutte" }));
    await screen.findByText("Procedura 1");

    // `tag: ""` sarebbe rifiutato dal contratto (`min(1)`) e chi ha premuto
    // «Tutte» si ritroverebbe un avviso rosso: l'assenza di filtro e' l'assenza
    // del parametro.
    expect(ultima(richieste)).toEqual({ limit: PROCEDURE_PAGE_SIZE, offset: 0 });
  });

  it("cambiare ambito richiede anche le categorie di quell'ambito", async () => {
    const { client, richiesteTag } = clienteElenco(archivioDa45, () => DUE_CATEGORIE);

    montaConApi(client, <ListScreen />);
    await screen.findByText("Procedura 1");
    expect(richiesteTag).toEqual([{}]);

    const utente = userEvent.setup();
    await utente.click(within(fila("Ambito")).getByRole("tab", { name: "Lavoro" }));
    await screen.findByText("Procedura 1");

    // Una categoria che vive solo fra le schede personali, mostrata con il suo
    // conteggio intero sotto l'ambito «Lavoro», sarebbe un filo che non apre
    // niente e un numero falso.
    expect(richiesteTag).toHaveLength(2);
    expect(ultima(richiesteTag)).toEqual({ scope: "LAVORO" });
  });

  it("scegliere una categoria non richiede le categorie da capo", async () => {
    const { client, richiesteTag } = clienteElenco(archivioDa45, () => DUE_CATEGORIE);

    montaConApi(client, <ListScreen />);
    await screen.findByText("Procedura 1");
    const utente = userEvent.setup();

    await utente.click(within(fila("Categoria")).getByRole("tab", { name: "Casa 7" }));
    await screen.findByText("Procedura 1");

    // L'errore opposto del caso qui sopra, e non e' solo una richiesta di
    // troppo: le categorie di un archivio gia' filtrato per «Casa» sono quelle
    // che convivono con «Casa», quindi la fila si accorcerebbe sotto le dita di
    // chi ha appena premuto — il filtro si mangerebbe il menu da cui e' stato
    // scelto, «Tutte» compresa.
    expect(richiesteTag).toEqual([{}]);
    expect(within(fila("Categoria")).getByRole("tab", { name: "Ufficio 2" })).toBeTruthy();
  });

  it("cambiare ambito lascia andare la categoria, invece di filtrare di nascosto", async () => {
    const { client, richieste } = clienteElenco(archivioDa45, (q) =>
      // In «Lavoro» «Casa» non esiste: e' il caso in cui tenersi la categoria
      // scelta produce una lista vuota con nessuna chip accesa e niente da
      // premere per capire perche'.
      q.scope === "LAVORO" ? { items: [{ nome: "Fatture", conteggio: 4 }] } : DUE_CATEGORIE,
    );

    montaConApi(client, <ListScreen />);
    await screen.findByText("Procedura 1");
    const utente = userEvent.setup();

    await utente.click(within(fila("Categoria")).getByRole("tab", { name: "Casa 7" }));
    await screen.findByText("Procedura 1");
    expect(ultima(richieste).tag).toBe("Casa");

    await utente.click(within(fila("Ambito")).getByRole("tab", { name: "Lavoro" }));
    await screen.findByText("Procedura 1");

    expect(ultima(richieste)).toEqual({
      limit: PROCEDURE_PAGE_SIZE,
      offset: 0,
      scope: "LAVORO",
    });
    // Cio' che e' acceso a schermo e cio' che e' nella query sono la stessa
    // cosa: la chip che dice «nessuna categoria» e' quella accesa.
    expect(
      within(fila("Categoria")).getByRole("tab", { name: "Tutte" }).getAttribute("aria-selected"),
    ).toBe("true");
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
      // Le categorie rispondono, e sono vuote: l'unico avviso a schermo deve
      // venire dall'elenco, o `findByRole("alert")` non saprebbe quale dei due
      // ha trovato.
      listTags: () => Promise.resolve({ items: [] }),
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

/**
 * Il vocale che diventa scheda, e l'elenco che se ne accorge.
 *
 * Senza questo legame la schermata ha un buco che non da' nessun sintomo: il
 * server toglie dai sospesi tutto cio' che e' `ESTRATTO`, quindi il riquadro «In
 * lavorazione» svanisce, il polling si spegne — non c'e' piu' niente in
 * movimento — e l'elenco delle schede, le cui dipendenze sono ambito e pagina,
 * non ha nessun motivo di richiedersi. Chi ha appena registrato vede il proprio
 * vocale sparire e nessuna scheda comparire al suo posto.
 *
 * Timer finti e `fireEvent` al posto di `userEvent`, per la ragione gia' scritta
 * in cima a `pending.test.tsx`: i due non si mescolano: `userEvent` aspetta fra
 * un gesto e l'altro, e con i timer fermi quell'attesa non finisce mai. Qui i
 * gesti non sono l'oggetto del test — lo e' cosa parte dopo.
 */
describe("ListScreen: quando un vocale diventa scheda", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function avanza(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** Come `clienteElenco`, ma con i sospesi che cambiano di giro in giro. */
  function clienteConSospesi(
    giri: readonly RecordingState[][],
    rispondi: (q: ListProceduresQueryInput) => ProcedureList,
    categorie: (q: ListTagsQueryInput) => TagList = () => ({ items: [] }),
  ): {
    client: ApiClient;
    richieste: ListProceduresQueryInput[];
    richiesteTag: ListTagsQueryInput[];
  } {
    const richieste: ListProceduresQueryInput[] = [];
    const richiesteTag: ListTagsQueryInput[] = [];
    let letture = 0;
    const client = creaClienteFinto({
      listPendingRecordings: () => {
        const giro = giri[Math.min(letture, giri.length - 1)] ?? [];
        letture += 1;
        return Promise.resolve({ items: giro });
      },
      listProcedures: (query = {}) => {
        richieste.push(query);
        return Promise.resolve(rispondi(query));
      },
      listTags: (query = {}) => {
        richiesteTag.push(query);
        return Promise.resolve(categorie(query));
      },
    });
    return { client, richieste, richiesteTag };
  }

  it("quando un vocale diventa scheda, l'elenco si richiede da capo", async () => {
    const { client, richieste } = clienteConSospesi(
      [[unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })], []],
      archivioDa45,
    );

    montaConApi(client, <ListScreen />);

    await avanza(0);
    expect(richieste).toHaveLength(1);

    await avanza(CINQUE_SECONDI);
    expect(richieste).toHaveLength(2);
  });

  it("quando un vocale diventa scheda, anche le categorie si richiedono da capo", async () => {
    const { client, richiesteTag } = clienteConSospesi(
      [[unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })], []],
      archivioDa45,
      () => ({ items: [{ nome: "Casa", conteggio: 7 }] }),
    );

    montaConApi(client, <ListScreen />);

    await avanza(0);
    expect(richiesteTag).toHaveLength(1);

    await avanza(CINQUE_SECONDI);

    // Una scheda che nasce porta le sue categorie: o una che non c'era, o un
    // conteggio che sale di uno. Ricaricare solo l'elenco lascerebbe la fila
    // delle chip a raccontare l'archivio di prima — cioe' proprio il numero su
    // cui questa schermata chiede di fidarsi.
    expect(richiesteTag).toHaveLength(2);
  });

  it("finche' il vocale e' in lavorazione, l'elenco non si richiede", async () => {
    // L'errore opposto, e costa: una richiesta paginata ogni cinque secondi per
    // tutto il tempo dell'elaborazione, su una connessione mobile.
    const { client, richieste } = clienteConSospesi(
      [[unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })]],
      archivioDa45,
    );

    montaConApi(client, <ListScreen />);

    await avanza(CINQUE_SECONDI * 3);
    expect(richieste).toHaveLength(1);
  });

  it("l'elenco richiesto di nuovo e' la stessa pagina e lo stesso ambito", async () => {
    // Ricaricare riportando alla prima pagina e a «Tutte» sarebbe peggio del
    // difetto: chi sta leggendo la pagina tre di «Lavoro» si ritroverebbe in
    // cima all'archivio intero perche' un vocale ha finito di elaborare.
    const { client, richieste } = clienteConSospesi(
      [[unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })], []],
      archivioDa45,
    );

    montaConApi(client, <ListScreen />);

    await avanza(0);
    // `fireEvent` e non `userEvent`: quest'ultimo aspetta fra un gesto e
    // l'altro su timer che qui sono finti, e il click non torna mai. Il gesto
    // non e' l'oggetto del caso — lo e' cosa viene richiesto dopo — quindi un
    // evento sintetico basta.
    fireEvent.click(screen.getByRole("tab", { name: "Lavoro" }));
    await avanza(0);
    fireEvent.click(bottone("Successive"));
    await avanza(0);
    expect(ultima(richieste)).toEqual({
      limit: PROCEDURE_PAGE_SIZE,
      offset: PROCEDURE_PAGE_SIZE,
      scope: "LAVORO",
    });

    const quante = richieste.length;
    await avanza(CINQUE_SECONDI);

    expect(richieste).toHaveLength(quante + 1);
    expect(ultima(richieste)).toEqual({
      limit: PROCEDURE_PAGE_SIZE,
      offset: PROCEDURE_PAGE_SIZE,
      scope: "LAVORO",
    });
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
