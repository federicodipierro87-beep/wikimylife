import type { ApiClient, ListProceduresQueryInput, ProcedureList } from "@wikimylife/shared";
import { ApiError, CardStatus, PROCEDURE_PAGE_SIZE } from "@wikimylife/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrashScreen } from "../../apps/web/src/screens/TrashScreen";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unaScheda, unaVoce, unElenco } from "./helpers/dati";
import { montaConApi } from "./helpers/render";

/**
 * Il cestino, che e' l'unica schermata dell'app da cui si perde qualcosa.
 *
 * Gli altri file di questa cartella provano soprattutto che a schermo compaia
 * la cosa giusta. Qui la posta e' diversa: un `deleteProcedureForever` partito
 * per sbaglio non si vede, non da' errore e non si annulla. Il server ha una
 * sola difesa — la scheda dev'essere gia' `ARCHIVIATA` — e in questa schermata
 * lo sono tutte. Quello che resta fra un tocco distratto e una procedura
 * perduta e' la conferma, e la conferma sta qui dentro e in nessun altro posto.
 *
 * Da qui i casi: contano le chiamate partite, non solo il testo rimasto. Un
 * caso che guardasse soltanto la riga sparita passerebbe identico contro una
 * schermata che cancella al primo tocco.
 */

/** Le due voci di partenza: due, perche' con una sola meta' dei casi non esiste. */
function dueCestinate(): ProcedureList {
  return unElenco({
    items: [
      unaVoce({ id: "proc-1", titolo: "Cambio di residenza", status: CardStatus.ARCHIVIATA }),
      unaVoce({ id: "proc-2", titolo: "Disdetta della palestra", status: CardStatus.ARCHIVIATA }),
    ],
  });
}

/** La riga di una scheda, per poter premere il pulsante di quella e non di un'altra. */
function riga(titolo: string): HTMLElement {
  const voce = screen.getByRole("button", { name: titolo }).closest("li");
  if (voce === null) {
    throw new Error(`La scheda «${titolo}» non e' in un elemento di elenco: il caso non regge.`);
  }
  return voce;
}

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TrashScreen: cosa chiede", () => {
  it("chiede le archiviate, che sono l'unica cosa che il cestino contiene", async () => {
    const richieste: ListProceduresQueryInput[] = [];
    const client = creaClienteFinto({
      listProcedures: (query = {}) => {
        richieste.push(query);
        return Promise.resolve(dueCestinate());
      },
    });

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");

    // Senza `status` il server risponde con le schede vive, che e' l'elenco
    // della home: due pulsanti «Elimina» comparirebbero accanto a procedure in
    // uso, e il server — che quel filtro ce l'ha davvero — le rifiuterebbe una
    // per una con un 409 che nessuno saprebbe spiegare.
    expect(richieste).toEqual([
      { status: CardStatus.ARCHIVIATA, limit: PROCEDURE_PAGE_SIZE, offset: 0 },
    ]);
  });
});

describe("TrashScreen: cancellare per sempre", () => {
  /** Cliente che tiene il conto di cio' che gli e' stato chiesto di cancellare. */
  function clienteCestino(
    esito: (id: string) => Promise<void> = () => Promise.resolve(),
  ): { client: ApiClient; cancellate: string[] } {
    const cancellate: string[] = [];
    const client = creaClienteFinto({
      listProcedures: () =>
        Promise.resolve(
          unElenco({
            items: dueCestinate().items.filter((p) => !cancellate.includes(p.id)),
          }),
        ),
      deleteProcedureForever: (id) => {
        cancellate.push(id);
        return esito(id);
      },
    });
    return { client, cancellate };
  }

  it("il primo tocco non cancella niente: apre solo la domanda", async () => {
    const { client, cancellate } = clienteCestino();

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(within(riga("Cambio di residenza")).getByRole("button", { name: "Elimina" }));

    // Il pulsante rosso e' comparso, ma la scheda c'e' ancora e al server non e'
    // partito niente. E' l'intera ragione per cui i tocchi sono due.
    expect(cancellate).toEqual([]);
    expect(screen.getByText("Cambio di residenza")).toBeTruthy();
    expect(
      within(riga("Cambio di residenza")).getByRole("button", { name: "Cancella per sempre" }),
    ).toBeTruthy();
  });

  it("il secondo tocco cancella la riga che ha aperto la domanda, e solo quella", async () => {
    const { client, cancellate } = clienteCestino();

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Disdetta della palestra");
    const utente = userEvent.setup();

    await utente.click(
      within(riga("Disdetta della palestra")).getByRole("button", { name: "Elimina" }),
    );

    // La conferma e' della voce che l'ha aperta. Tenuta nella schermata invece
    // che nella riga, i pulsanti rossi sarebbero due, e il tocco successivo
    // cadrebbe su quello che capita per primo nel DOM.
    expect(screen.getAllByRole("button", { name: "Cancella per sempre" }).length).toBe(1);

    await utente.click(screen.getByRole("button", { name: "Cancella per sempre" }));

    expect(cancellate).toEqual(["proc-2"]);
    // L'elenco si rilegge dal server invece di togliere la riga a mano: e' la
    // stessa risposta che vedrebbe chi ricarica la pagina, e quindi l'unica che
    // non puo' mentire su cosa e' rimasto.
    expect(await screen.findByText("Cambio di residenza")).toBeTruthy();
    expect(screen.queryByText("Disdetta della palestra")).toBeNull();
  });

  it("«Annulla» richiude la domanda senza aver chiesto niente", async () => {
    const { client, cancellate } = clienteCestino();

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(within(riga("Cambio di residenza")).getByRole("button", { name: "Elimina" }));
    await utente.click(within(riga("Cambio di residenza")).getByRole("button", { name: "Annulla" }));

    expect(cancellate).toEqual([]);
    // Il rosso torna via. Restare acceso dopo un ripensamento e' la stessa cosa
    // che non avere mai chiesto conferma, solo con un passaggio in piu'.
    expect(screen.queryByRole("button", { name: "Cancella per sempre" })).toBeNull();
    expect(
      within(riga("Cambio di residenza")).getByRole("button", { name: "Elimina" }),
    ).toBeTruthy();
  });

  it("se il server rifiuta, il rosso non resta acceso sotto il dito", async () => {
    const { client, cancellate } = clienteCestino(() =>
      Promise.reject(
        new ApiError({
          code: "CONFLICT",
          message: "La scheda non e' nel cestino: archiviala prima di cancellarla per sempre",
          status: 409,
        }),
      ),
    );

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(within(riga("Cambio di residenza")).getByRole("button", { name: "Elimina" }));
    await utente.click(
      within(riga("Cambio di residenza")).getByRole("button", { name: "Cancella per sempre" }),
    );

    const avviso = await within(riga("Cambio di residenza")).findByRole("alert");
    expect(avviso.textContent).toBe(
      "La scheda non e' nel cestino: archiviala prima di cancellarla per sempre",
    );
    expect(cancellate).toEqual(["proc-1"]);
    // Un 409 qui vuol dire che da un'altra schermata qualcuno ha ripescato la
    // scheda: il pulsante rosso lasciato acceso inviterebbe a insistere su una
    // cosa che nel frattempo e' diventata un'altra.
    expect(screen.queryByRole("button", { name: "Cancella per sempre" })).toBeNull();
  });
});

describe("TrashScreen: ripristinare", () => {
  it("«Ripristina» rimette la scheda fra quelle da rivedere, e non tocca niente altro", async () => {
    const aggiornate: { id: string; status: string | undefined }[] = [];
    let ripristinata = false;
    const client = creaClienteFinto({
      listProcedures: () =>
        Promise.resolve(
          unElenco({
            items: ripristinata
              ? dueCestinate().items.filter((p) => p.id !== "proc-1")
              : dueCestinate().items,
          }),
        ),
      updateProcedure: (id, patch) => {
        aggiornate.push({ id, status: patch.status });
        ripristinata = true;
        return Promise.resolve(unaScheda({ id, status: CardStatus.DA_RIVEDERE }));
      },
    });

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(
      within(riga("Cambio di residenza")).getByRole("button", { name: "Ripristina" }),
    );

    // `DA_RIVEDERE` e non `COMPLETA`: lo stato che la scheda aveva prima
    // dell'archiviazione non e' scritto da nessuna parte, e «completa» sarebbe
    // l'unica delle due bugie che non si nota — la scheda tornerebbe in home con
    // il bollino di chi e' stata riletta e confermata.
    expect(aggiornate).toEqual([{ id: "proc-1", status: CardStatus.DA_RIVEDERE }]);
    // E soprattutto non passa dalla cancellazione: `deleteProcedureForever` non
    // e' insegnato a questo finto, quindi chiamarlo farebbe fallire il caso col
    // proprio nome dentro l'errore.
    expect(await screen.findByText("Disdetta della palestra")).toBeTruthy();
  });
});

describe("TrashScreen: quando non c'e' niente", () => {
  it("un cestino vuoto lo dice, e non offre nessun pulsante da premere", async () => {
    const client = creaClienteFinto({
      listProcedures: () => Promise.resolve(unElenco({ items: [] })),
    });

    montaConApi(client, <TrashScreen />);

    expect(await screen.findByText("Il cestino e' vuoto.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Elimina" })).toBeNull();
    // Nemmeno l'avvertenza su cosa comporta cancellare: senza niente da
    // cancellare e' una minaccia rivolta a nessuno.
    expect(screen.queryByText(/Non si torna indietro/)).toBeNull();
  });

  it("un guasto si vede come un guasto, e non come un cestino gia' svuotato", async () => {
    const client = creaClienteFinto({
      listProcedures: () =>
        Promise.reject(
          new ApiError({ code: "INTERNAL_ERROR", message: "Il server non risponde.", status: 500 }),
        ),
    });

    montaConApi(client, <TrashScreen />);

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toBe("Il server non risponde.");
    expect(screen.queryByText("Il cestino e' vuoto.")).toBeNull();
  });
});
