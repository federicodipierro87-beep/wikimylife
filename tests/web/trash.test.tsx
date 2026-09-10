import type {
  ApiClient,
  EmptyTrashResult,
  ListProceduresQueryInput,
  ProcedureList,
  ProcedureSummary,
} from "@wikimylife/shared";
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

/**
 * Il gesto su tutto il cestino insieme.
 *
 * Sopra, la voce singola: un tocco distratto costa una scheda. Qui ne costa
 * quante ne contiene il cestino, e nessuna delle due schermate ha un modo di
 * rimediare. Cambia anche la difesa del server, che sulla voce singola risponde
 * 409 se la scheda non era archiviata: qui non c'e' nessun id da rifiutare —
 * quali schede toccare lo decide il server stesso — e quindi fra il dito e la
 * cancellazione resta la sola conferma.
 *
 * L'altra meta' dei casi e' il messaggio d'esito. Non e' cortesia: `saltate`
 * puo' non essere zero, e allora il cestino dopo lo svuotamento contiene ancora
 * qualcosa. Senza una riga che lo dica, quella schermata sembra un guasto.
 */
describe("TrashScreen: svuotare tutto", () => {
  /**
   * Un cestino che si svuota davvero: il secondo `listProcedures` risponde con
   * quello che il primo aveva promesso di cancellare, cioe' niente.
   *
   * Le richieste si tengono tutte perche' due dei casi qui sotto non guardano
   * cosa c'e' a schermo ma quante volte l'elenco e' stato richiesto, e con quale
   * `offset`: e' li' che si vede la differenza fra tornare alla prima pagina e
   * restare a guardare oltre la fine di un cestino vuoto.
   */
  function clienteSvuotabile(
    esito: () => Promise<EmptyTrashResult>,
    totale = 2,
    /** Cio' che il cestino contiene dopo: vuoto, tranne dove `saltate` non e' zero. */
    rimaste: readonly ProcedureSummary[] = [],
  ): { client: ApiClient; richieste: ListProceduresQueryInput[]; svuotamenti: number[] } {
    const richieste: ListProceduresQueryInput[] = [];
    const svuotamenti: number[] = [];
    let svuotato = false;
    const client = creaClienteFinto({
      listProcedures: (query = {}) => {
        richieste.push(query);
        return Promise.resolve(
          svuotato
            ? unElenco({ items: [...rimaste], offset: 0 })
            : unElenco({
                items: dueCestinate().items,
                total: totale,
                offset: query.offset ?? 0,
              }),
        );
      },
      emptyTrash: () => {
        svuotamenti.push(richieste.length);
        svuotato = true;
        return esito();
      },
    });
    return { client, richieste, svuotamenti };
  }

  const andataBene = (): Promise<EmptyTrashResult> =>
    Promise.resolve({ cancellate: 2, saltate: 0 });

  it("il primo tocco apre la domanda, e al server non parte niente", async () => {
    const { client, svuotamenti } = clienteSvuotabile(andataBene);

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));

    // Come per la voce singola, e per una ragione piu' grossa: qui il primo
    // tocco che cancellasse davvero porterebbe via l'intero cestino.
    expect(svuotamenti).toEqual([]);
    expect(screen.getByText("Cambio di residenza")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancella per sempre 2 schede" })).toBeTruthy();
  });

  it("il numero sul rosso e' quello del cestino, non quante se ne vedono", async () => {
    // Trentaquattro nel cestino, venti per pagina, due in questo finto. Il
    // pulsante che dicesse «2 schede» starebbe descrivendo la pagina e non il
    // gesto: chi lo preme ne perde trentaquattro.
    const { client } = clienteSvuotabile(andataBene, 34);

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));

    expect(screen.getByRole("button", { name: "Cancella per sempre 34 schede" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancella per sempre 2 schede" })).toBeNull();
  });

  it("con una scheda sola non dice «1 schede»", async () => {
    const { client } = clienteSvuotabile(andataBene, 1);

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));

    // Il cestino con dentro una cosa sola e' il caso piu' frequente di tutti:
    // e' il plurale automatico che qui si nota, non il singolare.
    expect(screen.getByRole("button", { name: "Cancella per sempre 1 scheda" })).toBeTruthy();
  });

  it("il secondo tocco svuota, e l'elenco riletto lo conferma", async () => {
    const { client, richieste, svuotamenti } = clienteSvuotabile(andataBene);

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));
    await utente.click(screen.getByRole("button", { name: "Cancella per sempre 2 schede" }));

    expect(svuotamenti).toEqual([1]);
    expect(await screen.findByText("Il cestino e' vuoto.")).toBeTruthy();
    expect(screen.queryByText("Cambio di residenza")).toBeNull();
    // Il messaggio sopravvive alla sparizione dell'elenco: e' l'unica cosa che
    // distingue «ho svuotato il cestino» da «il cestino non si carica».
    expect(screen.getByRole("status").textContent).toBe("2 schede cancellate per sempre.");
    // Il pulsante invece se ne va con l'elenco: offrire di svuotare un cestino
    // vuoto sarebbe un gesto che non puo' riuscire.
    expect(screen.queryByRole("button", { name: "Svuota il cestino" })).toBeNull();
    // Due richieste e non tre: chi era gia' alla prima pagina la rilegge una
    // volta sola.
    expect(richieste.map((r) => r.offset)).toEqual([0, 0]);
  });

  it("dice quante ne sono rimaste quando una e' stata ripescata nel frattempo", async () => {
    // L'unico caso in cui dopo lo svuotamento il cestino non e' vuoto: la
    // scheda ripescata e' ancora li', e accanto al messaggio c'e' di nuovo il
    // pulsante grigio — ma non quello rosso, che era la domanda di prima e ha
    // avuto la sua risposta.
    const { client } = clienteSvuotabile(() => Promise.resolve({ cancellate: 1, saltate: 1 }), 2, [
      unaVoce({ id: "proc-2", titolo: "Disdetta della palestra", status: CardStatus.ARCHIVIATA }),
    ]);

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));
    await utente.click(screen.getByRole("button", { name: "Cancella per sempre 2 schede" }));

    // Senza la seconda frase, un cestino che dopo lo svuotamento non e' vuoto
    // sembrerebbe un difetto — e il secondo tentativo cancellerebbe la scheda
    // che qualcuno aveva appena rimesso a posto.
    expect((await screen.findByRole("status")).textContent).toBe(
      "1 scheda cancellata per sempre. 1 scheda e' stata ripristinata mentre si cancellava, e non e' stata toccata.",
    );
    expect(screen.getByRole("button", { name: "Svuota il cestino" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Cancella per sempre/ })).toBeNull();
  });

  it("al plurale le conta al plurale, tutte e due", async () => {
    const { client } = clienteSvuotabile(() =>
      Promise.resolve({ cancellate: 3, saltate: 2 }),
    );

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));
    await utente.click(screen.getByRole("button", { name: "Cancella per sempre 2 schede" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "3 schede cancellate per sempre. 2 schede sono state ripristinate mentre si cancellava, e non sono state toccate.",
    );
  });

  it("un cestino svuotato altrove non e' un guasto, ed e' detto senza numeri", async () => {
    const { client } = clienteSvuotabile(() =>
      Promise.resolve({ cancellate: 0, saltate: 0 }),
    );

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));
    await utente.click(screen.getByRole("button", { name: "Cancella per sempre 2 schede" }));

    // Fra il caricamento della pagina e il tocco, un altro dispositivo ha fatto
    // la stessa cosa. «0 schede cancellate per sempre» sarebbe vero e
    // illeggibile.
    expect((await screen.findByRole("status")).textContent).toBe("Il cestino era gia' vuoto.");
  });

  it("«Annulla» richiude la domanda senza aver svuotato niente", async () => {
    const { client, svuotamenti, richieste } = clienteSvuotabile(andataBene);

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));
    await utente.click(screen.getByRole("button", { name: "Annulla" }));

    expect(svuotamenti).toEqual([]);
    expect(richieste).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Cancella per sempre 2 schede" })).toBeNull();
    expect(screen.getByRole("button", { name: "Svuota il cestino" })).toBeTruthy();
  });

  it("se il server rifiuta, il rosso non resta acceso sotto il dito", async () => {
    const { client, svuotamenti } = clienteSvuotabile(() =>
      Promise.reject(
        new ApiError({ code: "INTERNAL_ERROR", message: "Il server non risponde.", status: 500 }),
      ),
    );

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));
    await utente.click(screen.getByRole("button", { name: "Cancella per sempre 2 schede" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Il server non risponde.");
    expect(svuotamenti).toEqual([1]);
    // Un errore a meta' svuotamento puo' aver cancellato qualcosa: il pulsante
    // rosso lasciato acceso invita a un secondo tocco che nessuno ha deciso, e
    // per giunta su un numero che non e' piu' quello scritto sopra.
    expect(screen.queryByRole("button", { name: "Cancella per sempre 2 schede" })).toBeNull();
    expect(screen.getByRole("button", { name: "Svuota il cestino" })).toBeTruthy();
  });

  it("il secondo tentativo non lascia a schermo l'errore del primo", async () => {
    let tentativi = 0;
    const client = creaClienteFinto({
      listProcedures: () => Promise.resolve(unElenco({ items: dueCestinate().items })),
      emptyTrash: () => {
        tentativi += 1;
        return tentativi === 1
          ? Promise.reject(
              new ApiError({ code: "INTERNAL_ERROR", message: "Il server non risponde.", status: 500 }),
            )
          : Promise.resolve({ cancellate: 2, saltate: 0 });
      },
    });

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));
    await utente.click(screen.getByRole("button", { name: "Cancella per sempre 2 schede" }));
    await screen.findByRole("alert");
    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));
    await utente.click(screen.getByRole("button", { name: "Cancella per sempre 2 schede" }));

    // «Il server non risponde» accanto a «2 schede cancellate per sempre» e'
    // peggio di uno dei due da solo: chi legge non sa quale delle due frasi
    // riguarda cio' che ha appena fatto.
    expect((await screen.findByRole("status")).textContent).toBe("2 schede cancellate per sempre.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("mentre svuota non si lascia premere una seconda volta", async () => {
    let chiamate = 0;
    let sblocca = (_esito: EmptyTrashResult): void => {};
    const client = creaClienteFinto({
      listProcedures: () => Promise.resolve(unElenco({ items: dueCestinate().items })),
      emptyTrash: () => {
        chiamate += 1;
        return new Promise<EmptyTrashResult>((risolvi) => {
          sblocca = risolvi;
        });
      },
    });

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));
    await utente.click(screen.getByRole("button", { name: "Cancella per sempre 2 schede" }));

    // Il pulsante cambia parole e smette di rispondere. Una seconda richiesta
    // partita mentre la prima cancella non svuoterebbe due volte lo stesso
    // cestino: cancellerebbe cio' che nel frattempo qualcuno ha ripescato, e il
    // secondo esito coprirebbe il primo.
    const rosso = await screen.findByRole("button", { name: "Cancello…" });
    await utente.click(rosso);
    expect(chiamate).toBe(1);

    sblocca({ cancellate: 2, saltate: 0 });
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("dopo aver svuotato torna alla prima pagina, e la chiede una volta sola", async () => {
    const { client, richieste } = clienteSvuotabile(
      () => Promise.resolve({ cancellate: 34, saltate: 0 }),
      34,
    );

    montaConApi(client, <TrashScreen />);
    await screen.findByText("Cambio di residenza");
    const utente = userEvent.setup();
    await utente.click(screen.getByRole("button", { name: "Successive" }));
    await screen.findByText("21–22 di 34");

    await utente.click(screen.getByRole("button", { name: "Svuota il cestino" }));
    await utente.click(screen.getByRole("button", { name: "Cancella per sempre 34 schede" }));

    await screen.findByText("Il cestino e' vuoto.");
    // Restare a `offset: 20` dopo aver cancellato tutto mostrerebbe un cestino
    // vuoto perche' si sta guardando oltre la fine, e le schede eventualmente
    // saltate sarebbero invisibili proprio a chi ha appena letto che ce ne sono.
    // Tre richieste e non quattro: cambiare `offset` ricarica gia' da solo.
    expect(richieste.map((r) => r.offset)).toEqual([0, 20, 0]);
  });
});

describe("TrashScreen: quando non c'e' niente", () => {
  it("un cestino vuoto lo dice, e non offre nessun pulsante da premere", async () => {
    const client = creaClienteFinto({
      listProcedures: () => Promise.resolve(unElenco({ items: [] })),
    });

    const { container } = montaConApi(client, <TrashScreen />);

    expect(await screen.findByText("Il cestino e' vuoto.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Elimina" })).toBeNull();
    // Nemmeno lo svuotamento: un pulsante che promette di cancellare tutto
    // davanti a un cestino vuoto e' un gesto che non puo' riuscire, e chi lo
    // vede si chiede cosa contenga quel cestino che lui non vede.
    expect(screen.queryByRole("button", { name: "Svuota il cestino" })).toBeNull();
    // E nemmeno il riquadro che lo conterrebbe. Non e' pignoleria: `.svuota` ha
    // un bordo in alto, quindi rimasto vuoto disegna una riga che separa «Il
    // cestino e' vuoto.» da niente. Cercare il pulsante non basta a vederla,
    // perche' il pulsante ha una sua condizione che lo toglie lo stesso.
    expect(container.querySelector(".svuota")).toBeNull();
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
