import type { ApiClient, SearchQueryInput, SearchResult } from "@wikimylife/shared";
import { SEARCH_PAGE_SIZE } from "@wikimylife/shared";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchScreen } from "../../apps/web/src/screens/SearchScreen";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unaRicerca, unRisultato } from "./helpers/dati";
import { montaConApi } from "./helpers/render";

/**
 * La ricerca, e la sola cosa che qui costa dei soldi veri: quante volte parte.
 *
 * Ogni ricerca calcola un embedding, cioe' una chiamata a pagamento verso
 * OpenAI. Il ritardo di 300 ms fra l'ultimo tasto e la partenza e' l'unica cosa
 * che separa una parola scritta da una richiesta, e non ha nessun sintomo: se
 * sparisse, la schermata funzionerebbe meglio del solito — i risultati
 * comparirebbero prima — e il conto arriverebbe a fine mese moltiplicato per
 * nove. Nessuna prova manuale lo vedrebbe.
 *
 * ## Perche' `fireEvent` e non `userEvent`
 *
 * Per la ragione spiegata in `pending.test.tsx`: `userEvent` aspetta fra un
 * gesto e l'altro, React 18 pianifica su un `MessageChannel` che i timer finti
 * non toccano, e i due insieme si bloccano. Qui il tempo e' l'oggetto stesso
 * del test, quindi i timer finti non sono negoziabili e a cedere e' `userEvent`.
 *
 * Ci si guadagna anche in precisione: `fireEvent.change` con il valore intero
 * e' un evento solo, e cosi' «nove tasti» sono nove eventi contati a mano
 * invece che un'approssimazione di quel che fa una tastiera.
 *
 * Per la stessa incompatibilita' qui non compare mai `findByText`: aspetta con
 * un orologio che i timer finti hanno fermato, e il caso non fallisce — resta
 * appeso fino al timeout di Vitest, che e' il modo peggiore di sbagliare. Dopo
 * `avanza()` lo stato e' gia' assestato e `getByText` dice la stessa cosa
 * subito; se non lo fosse, e' `avanza()` che ha avanzato troppo poco, ed e'
 * quella la cosa da leggere.
 */

const RITARDO_MS = 300;

/** L'ultima domanda arrivata al server, che e' quasi sempre quella in causa. */
function ultima<T>(xs: readonly T[]): T {
  const x = xs.at(-1);
  if (x === undefined) {
    throw new Error("Nessuna ricerca e' partita: il caso sta verificando il nulla.");
  }
  return x;
}

function clienteRicerca(rispondi: (q: SearchQueryInput) => SearchResult): {
  client: ApiClient;
  domande: SearchQueryInput[];
} {
  const domande: SearchQueryInput[] = [];
  const client = creaClienteFinto({
    search: (query) => {
      domande.push(query);
      return Promise.resolve(rispondi(query));
    },
  });
  return { client, domande };
}

/** Una risposta qualsiasi, che ripete la domanda: serve a poterla rileggere a schermo. */
function unEco(q: SearchQueryInput): SearchResult {
  const offset = q.offset ?? 0;
  return unaRicerca({
    q: q.q,
    offset,
    items: offset === 0 ? [unRisultato({ id: "a", titolo: `Prima di ${q.q}` })] : [],
    hasMore: offset === 0,
  });
}

function scrivi(testo: string): void {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: testo } });
}

async function avanza(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom non sa scorrere, e la schermata glielo chiede a ogni cambio pagina.
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SearchScreen: quando parte una ricerca", () => {
  it("nove tasti fanno una ricerca sola, e non nove", async () => {
    const { client, domande } = clienteRicerca(unEco);

    montaConApi(client, <SearchScreen />);

    const parola = "residenza";
    for (let i = 1; i <= parola.length; i += 1) {
      scrivi(parola.slice(0, i));
      // Un decimo di secondo fra un tasto e l'altro: chi digita normalmente non
      // arriva mai ai 300 ms, ed e' proprio per questo che il ritardo funziona.
      await avanza(100);
    }

    // Prima che il silenzio sia abbastanza lungo non e' partito niente.
    expect(domande).toEqual([]);

    await avanza(RITARDO_MS);

    expect(domande.length).toBe(1);
    expect(ultima(domande).q).toBe("residenza");
  });

  it("una lettera sola non parte, nemmeno con gli spazi intorno", async () => {
    const { client, domande } = clienteRicerca(unEco);

    montaConApi(client, <SearchScreen />);

    // Il minimo e' due caratteri, ed e' lo stesso dello schema condiviso: «a»
    // mandato al server vorrebbe dire farsi restituire l'archivio intero
    // ordinato per caso — se non fosse che lo schema lo rifiuta, e allora
    // sarebbe un avviso rosso comparso mentre si scrive.
    scrivi(" a ");
    await avanza(RITARDO_MS * 10);

    expect(domande).toEqual([]);
    // E le istruzioni restano: non e' successo niente, e la schermata non deve
    // far credere di aver cercato e non trovato.
    expect(screen.queryByText(/Scrivi cosa devi fare/)).toBeTruthy();
  });

  it("gli spazi intorno non entrano nella domanda", async () => {
    const { client, domande } = clienteRicerca(unEco);

    montaConApi(client, <SearchScreen />);

    scrivi("  casellario  ");
    await avanza(RITARDO_MS);

    // Non e' pignoleria: la domanda torna indietro dentro il riassunto, e
    // «Risultati per «  casellario  »» e' scritto male in una schermata che per
    // il resto e' curata.
    expect(ultima(domande).q).toBe("casellario");
    expect(screen.getByText(/«casellario»/)).toBeTruthy();
  });

  it("svuotare il campo non fa partire una ricerca vuota", async () => {
    const { client, domande } = clienteRicerca(unEco);

    montaConApi(client, <SearchScreen />);

    scrivi("casellario");
    await avanza(RITARDO_MS);
    expect(domande.length).toBe(1);

    scrivi("");
    await avanza(RITARDO_MS * 10);

    // Cancellare quel che si era scritto e' il gesto di chi ha cambiato idea,
    // non una domanda nuova. Il server la rifiuterebbe (`min(2)`), quindi il
    // costo sarebbe un avviso rosso invece di un embedding — ma resta un avviso
    // rosso comparso perche' qualcuno ha premuto backspace.
    expect(domande.length).toBe(1);
    // E si torna alle istruzioni, che sono lo stato in cui la schermata si apre.
    expect(screen.queryByText(/Scrivi cosa devi fare/)).toBeTruthy();
  });
});

describe("SearchScreen: sfogliare i risultati", () => {
  it("«Successive» chiede la pagina dopo della stessa domanda", async () => {
    const { client, domande } = clienteRicerca(unEco);

    montaConApi(client, <SearchScreen />);

    scrivi("casellario");
    await avanza(RITARDO_MS);

    fireEvent.click(screen.getByRole("button", { name: "Successive" }));
    await avanza(0);

    expect(ultima(domande)).toEqual({
      q: "casellario",
      limit: SEARCH_PAGE_SIZE,
      offset: SEARCH_PAGE_SIZE,
    });
  });

  it("cambiare domanda riparte dalla prima pagina", async () => {
    const { client, domande } = clienteRicerca(unEco);

    montaConApi(client, <SearchScreen />);

    scrivi("casellario");
    await avanza(RITARDO_MS);
    fireEvent.click(screen.getByRole("button", { name: "Successive" }));
    await avanza(0);
    expect(ultima(domande).offset).toBe(SEARCH_PAGE_SIZE);

    scrivi("passaporto");
    await avanza(RITARDO_MS);

    // La pagina due della domanda di prima non vuol dire niente per la domanda
    // nuova. Restandoci, la ricerca ripartirebbe dall'offset 20 di una
    // classifica lunga uno, e la schermata scriverebbe «Non c'e' altro per
    // «passaporto»» — cioe' che si e' gia' visto tutto, a chi non ha ancora
    // visto niente.
    expect(ultima(domande)).toEqual({ q: "passaporto", limit: SEARCH_PAGE_SIZE, offset: 0 });
    expect(screen.getByText("Prima di passaporto")).toBeTruthy();
    expect(screen.queryByText(/Non c'e' altro/)).toBeNull();
  });

  it("quando i risultati stanno in una pagina non c'e' niente da sfogliare", async () => {
    const { client } = clienteRicerca((q) => unaRicerca({ q: q.q, hasMore: false }));

    montaConApi(client, <SearchScreen />);

    scrivi("casellario");
    await avanza(RITARDO_MS);

    expect(screen.getByText(/1 risultati/)).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
