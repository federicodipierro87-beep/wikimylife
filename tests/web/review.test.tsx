import type { ApiClient, RecordingState } from "@wikimylife/shared";
import { buildExtractionContract } from "@wikimylife/shared/testing";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unaRegistrazione, unaScheda, unVocale } from "./helpers/dati";
import { montaConApi } from "./helpers/render";
import { ReviewScreen } from "../../apps/web/src/screens/ReviewScreen";

/**
 * La schermata che chiude una scheda `DA_RIVEDERE`.
 *
 * Non c'entra niente con i duplicati — quel malinteso e' costato un difetto
 * noto sbagliato nel README, ed e' scritto qui perche' il nome `ReviewScreen`
 * lo suggerisce di nuovo a chiunque arrivi. E' la revisione della scheda: si
 * legge cosa il modello non aveva capito, si corregge il titolo, si aggiunge un
 * passo se ci si ricorda, e si decide se marcarla `COMPLETA`.
 *
 * ## Cosa si prova, e cosa no
 *
 * Non si riprova `revisioneDa`: unisce le `_meta` di piu' registrazioni senza
 * ripetizioni, e' pura e ha i suoi casi in `tests/unit/format.test.ts`. Qui si
 * prova cio' che una funzione pura non puo' dimostrare — che sia questa
 * schermata a raccoglierle da *tutte* le registrazioni, e che le due forme in
 * cui le mostra si escludano invece di comparire insieme.
 *
 * ## Il corpo del `PATCH` e' il punto
 *
 * Undici casi su venti guardano l'oggetto che finisce in `updateProcedure`, e
 * non cio' che si vede in pagina. E' dove stanno le decisioni: il titolo entra
 * solo se e' cambiato davvero, la nota diventa un passo **in coda** ai passi che
 * c'erano, e lo stato lo manda un pulsante e non l'altro. Ognuna di queste,
 * sbagliata, produce una schermata identica a vedersi e una scheda mutilata sul
 * server — che e' il tipo di difetto che si scopre settimane dopo, quando i
 * passi persi non si ricordano piu'.
 */

type Corpo = Parameters<ApiClient["updateProcedure"]>[1];

/** Una registrazione la cui estrazione dichiara incertezza. */
function conDomande(
  id: string,
  campiIncerti: readonly string[],
  domande: readonly string[],
): RecordingState {
  return unaRegistrazione({
    id,
    extraction: buildExtractionContract({
      _meta: {
        confidenzaGlobale: 0.4,
        campiIncerti: [...campiIncerti],
        domandeSuggerite: [...domande],
        contieneDatiSensibili: false,
        tipoRilevato: "PROCEDURA",
      },
    }),
  });
}

const SCHEDA = unaScheda({
  status: "DA_RIVEDERE",
  recordings: [unVocale({ id: "reg-1" })],
});

/** Il client che serve a quasi tutti: la scheda, le registrazioni, il salvataggio. */
function clienteCon(
  registrazioni: readonly RecordingState[],
  updateProcedure?: ApiClient["updateProcedure"],
): ApiClient {
  return creaClienteFinto({
    getProcedure: () => Promise.resolve(SCHEDA),
    getRecording: (id: string) => {
      const trovata = registrazioni.find((r) => r.id === id);
      return trovata === undefined
        ? Promise.reject(new Error(`Il caso non ha preparato la registrazione ${id}.`))
        : Promise.resolve(trovata);
    },
    ...(updateProcedure === undefined ? {} : { updateProcedure }),
  });
}

/** Aspetta che il modulo sia in pagina: prima c'e' solo «Carico…». */
function ilModulo(): Promise<HTMLElement> {
  return screen.findByRole("button", { name: "Salva e segna come completa" });
}

beforeEach(() => {
  window.location.hash = "#/revisione/proc-1";
});

describe("ReviewScreen: cosa va a prendere", () => {
  it("chiede una registrazione per ogni vocale, perche' le domande stanno li' e non sulla scheda", async () => {
    const chiesti: string[] = [];
    const scheda = unaScheda({
      recordings: [unVocale({ id: "reg-1" }), unVocale({ id: "reg-2" })],
    });
    const client = creaClienteFinto({
      getProcedure: () => Promise.resolve(scheda),
      getRecording: (id: string) => {
        chiesti.push(id);
        return Promise.resolve(unaRegistrazione({ id }));
      },
    });

    montaConApi(client, <ReviewScreen id="proc-1" />);
    await ilModulo();

    // `_meta` non e' una colonna della scheda: chiedere solo la prima
    // registrazione perderebbe le domande di tutte le altre, e la schermata
    // sembrerebbe funzionare.
    expect(chiesti).toEqual(["reg-1", "reg-2"]);
  });

  it("se la scheda non arriva compare l'avviso, e non un modulo vuoto", async () => {
    const client = creaClienteFinto({
      getProcedure: () => Promise.reject(new Error("Scheda non trovata.")),
    });

    montaConApi(client, <ReviewScreen id="proc-1" />);

    expect((await screen.findByRole("alert")).textContent).toContain("Scheda non trovata.");
    expect(screen.queryByRole("button", { name: "Salva e segna come completa" })).toBeNull();
  });

  it("se una registrazione non arriva non si apre un modulo con meta' delle domande", async () => {
    // Il `Promise.all` e' una decisione: una revisione a cui manca meta'
    // dell'incertezza si presenta come una revisione completa, e chi la chiude
    // con «Va bene cosi'» non sapra' mai cosa non gli e' stato chiesto.
    const scheda = unaScheda({
      recordings: [unVocale({ id: "reg-1" }), unVocale({ id: "reg-2" })],
    });
    const client = creaClienteFinto({
      getProcedure: () => Promise.resolve(scheda),
      getRecording: (id: string) =>
        id === "reg-1"
          ? Promise.resolve(conDomande("reg-1", ["costo"], ["Quanto costava?"]))
          : Promise.reject(new Error("Registrazione non trovata.")),
    });

    montaConApi(client, <ReviewScreen id="proc-1" />);

    expect((await screen.findByRole("alert")).textContent).toContain("Registrazione non trovata.");
    expect(screen.queryByRole("button", { name: "Salva e segna come completa" })).toBeNull();
  });
});

describe("ReviewScreen: quello che era rimasto in sospeso", () => {
  it("le domande arrivano da tutte le registrazioni, non solo dalla prima", async () => {
    const scheda = unaScheda({
      recordings: [unVocale({ id: "reg-1" }), unVocale({ id: "reg-2" })],
    });
    const client = creaClienteFinto({
      getProcedure: () => Promise.resolve(scheda),
      getRecording: (id: string) =>
        Promise.resolve(
          id === "reg-1"
            ? conDomande("reg-1", ["costo"], ["Quanto costava la marca da bollo?"])
            : conDomande("reg-2", ["durata"], ["Quanto hai aspettato allo sportello?"]),
        ),
    });

    montaConApi(client, <ReviewScreen id="proc-1" />);
    await ilModulo();

    expect(screen.getByText("Quanto costava la marca da bollo?")).toBeTruthy();
    expect(screen.getByText("Quanto hai aspettato allo sportello?")).toBeTruthy();
  });

  it("una registrazione senza estrazione non zittisce le domande delle altre", async () => {
    // `r.extraction?._meta ?? null`: una registrazione ancora in lavorazione fra
    // le origini di una scheda gia' creata e' normale, e non deve far sparire
    // l'unica domanda che c'era.
    const scheda = unaScheda({
      recordings: [unVocale({ id: "reg-1" }), unVocale({ id: "reg-2" })],
    });
    const client = creaClienteFinto({
      getProcedure: () => Promise.resolve(scheda),
      getRecording: (id: string) =>
        Promise.resolve(
          id === "reg-1"
            ? unaRegistrazione({ id: "reg-1", extraction: null })
            : conDomande("reg-2", ["costo"], ["Quanto costava?"]),
        ),
    });

    montaConApi(client, <ReviewScreen id="proc-1" />);
    await ilModulo();

    expect(screen.getByText("Quanto costava?")).toBeTruthy();
  });

  it("senza domande ma con campi incerti resta la riga di ripiego", async () => {
    montaConApi(
      clienteCon([conDomande("reg-1", ["costo", "durata"], [])]),
      <ReviewScreen id="proc-1" />,
    );
    await ilModulo();

    // Sapere *quali* parti erano poco chiare vale comunque qualcosa: senza
    // questo ramo, un'estrazione che dichiara incertezza senza sapere cosa
    // chiedere produrrebbe una schermata che dice solo «completala, se vuoi».
    expect(screen.getByText("Parti poco chiare: costo, durata.")).toBeTruthy();
  });

  it("quando le domande ci sono, la riga di ripiego non compare anche lei", async () => {
    montaConApi(
      clienteCon([conDomande("reg-1", ["costo"], ["Quanto costava?"])]),
      <ReviewScreen id="proc-1" />,
    );
    await ilModulo();

    // Le due condizioni sono legate: la seconda ha un `domande.length === 0`
    // che, tolto, farebbe comparire l'elenco delle domande e sotto l'elenco
    // asciutto dei campi da cui quelle domande sono nate.
    expect(screen.queryByText(/Parti poco chiare/)).toBeNull();
  });

  it("senza nessuna incertezza non compare ne' l'elenco ne' la riga", async () => {
    montaConApi(clienteCon([conDomande("reg-1", [], [])]), <ReviewScreen id="proc-1" />);
    await ilModulo();

    expect(screen.queryByText("Quello che era rimasto in sospeso")).toBeNull();
    expect(screen.queryByText(/Parti poco chiare/)).toBeNull();
  });
});

describe("ReviewScreen: cosa finisce nel PATCH", () => {
  it("«Va bene cosi'» non manda niente e porta alla scheda", async () => {
    // Il finto lancia su `updateProcedure`: se questo pulsante chiamasse il
    // server, il caso si fermerebbe dicendo quale metodo.
    montaConApi(clienteCon([unaRegistrazione()]), <ReviewScreen id="proc-1" />);
    await ilModulo();

    await userEvent.setup().click(screen.getByRole("button", { name: "Va bene cosi'" }));

    expect(window.location.hash).toBe("#/scheda/proc-1");
  });

  it("«lasciala da rivedere» senza aver toccato niente non manda un PATCH vuoto, ma porta via lo stesso", async () => {
    // Un `PATCH {}` e' un 400 di validazione: l'utente vedrebbe un errore rosso
    // per aver premuto «non ho niente da aggiungere», che e' una risposta
    // legittima.
    montaConApi(clienteCon([unaRegistrazione()]), <ReviewScreen id="proc-1" />);
    await ilModulo();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Salva e lasciala da rivedere" }));

    expect(window.location.hash).toBe("#/scheda/proc-1");
  });

  it("«segna come completa» manda lo stato anche quando non si e' scritto niente", async () => {
    let corpo: Corpo | null = null;
    montaConApi(
      clienteCon([unaRegistrazione()], (_id, input) => {
        corpo = input;
        return Promise.resolve(SCHEDA);
      }),
      <ReviewScreen id="proc-1" />,
    );

    await userEvent.setup().click(await ilModulo());

    // E' l'altra meta' del caso qui sopra: la scorciatoia del `PATCH {}` non
    // deve valere per questo pulsante, o «segna come completa» non segnerebbe
    // niente proprio quando non c'e' nient'altro da salvare.
    expect(corpo).toEqual({ status: "COMPLETA" });
    expect(window.location.hash).toBe("#/scheda/proc-1");
  });

  it("il titolo lasciato com'era non entra nel corpo", async () => {
    let corpo: Corpo | null = null;
    montaConApi(
      clienteCon([unaRegistrazione()], (_id, input) => {
        corpo = input;
        return Promise.resolve(SCHEDA);
      }),
      <ReviewScreen id="proc-1" />,
    );

    await userEvent.setup().click(await ilModulo());

    // Rimandare indietro il titolo identico non e' innocuo: `updateProcedure`
    // e' cio' che marca una scheda come toccata a mano, e il campo va nel corpo
    // solo se l'utente l'ha davvero cambiato.
    //
    // Il `not.toBeNull()` prima non e' rumore: `expect(null).not.toHaveProperty`
    // passa, quindi senza di lui questo caso resterebbe verde anche se il
    // pulsante non chiamasse il server affatto.
    expect(corpo).not.toBeNull();
    expect(corpo).not.toHaveProperty("titolo");
  });

  it("un titolo di soli spazi non cancella quello vero", async () => {
    let corpo: Corpo | null = null;
    montaConApi(
      clienteCon([unaRegistrazione()], (_id, input) => {
        corpo = input;
        return Promise.resolve(SCHEDA);
      }),
      <ReviewScreen id="proc-1" />,
    );
    const utente = userEvent.setup();
    await ilModulo();

    await utente.clear(screen.getByLabelText("Titolo"));
    await utente.type(screen.getByLabelText("Titolo"), "   ");
    await utente.click(screen.getByRole("button", { name: "Salva e segna come completa" }));

    // Svuotare il campo e premere e' un gesto che capita: il titolo e' il solo
    // modo di ritrovare la scheda in elenco, e mandare `""` la renderebbe una
    // riga bianca.
    expect(corpo).toEqual({ status: "COMPLETA" });
  });

  it("il titolo cambiato arriva senza gli spazi ai bordi", async () => {
    let corpo: Corpo | null = null;
    montaConApi(
      clienteCon([unaRegistrazione()], (_id, input) => {
        corpo = input;
        return Promise.resolve(SCHEDA);
      }),
      <ReviewScreen id="proc-1" />,
    );
    const utente = userEvent.setup();
    await ilModulo();

    await utente.clear(screen.getByLabelText("Titolo"));
    await utente.type(screen.getByLabelText("Titolo"), "  Casellario giudiziale  ");
    await utente.click(screen.getByRole("button", { name: "Salva e segna come completa" }));

    expect(corpo).toEqual({ titolo: "Casellario giudiziale", status: "COMPLETA" });
  });

  it("la nota diventa un passo in coda, e i passi che c'erano restano tutti", async () => {
    let corpo: Corpo | null = null;
    montaConApi(
      clienteCon([unaRegistrazione()], (_id, input) => {
        corpo = input;
        return Promise.resolve(SCHEDA);
      }),
      <ReviewScreen id="proc-1" />,
    );
    const utente = userEvent.setup();
    await ilModulo();

    await utente.type(
      screen.getByLabelText("Vuoi aggiungere un passo? (facoltativo)"),
      "Chiedere il modulo AP70",
    );
    await utente.click(screen.getByRole("button", { name: "Salva e lasciala da rivedere" }));

    // Il caso che conta piu' di tutti: `steps` e' una sostituzione, non
    // un'aggiunta. Mandare il solo passo nuovo cancellerebbe in silenzio tutto
    // cio' che l'utente aveva raccontato, e la schermata direbbe «salvato».
    expect(corpo).toEqual({
      steps: [
        { azione: "Andare in Procura", dettaglio: null, durataStimataMin: null },
        { azione: "Chiedere il modulo AP70", dettaglio: null, durataStimataMin: null },
      ],
    });
  });

  it("una nota di soli spazi non aggiunge un passo vuoto", async () => {
    let corpo: Corpo | null = null;
    montaConApi(
      clienteCon([unaRegistrazione()], (_id, input) => {
        corpo = input;
        return Promise.resolve(SCHEDA);
      }),
      <ReviewScreen id="proc-1" />,
    );
    const utente = userEvent.setup();
    await ilModulo();

    await utente.type(screen.getByLabelText("Vuoi aggiungere un passo? (facoltativo)"), "   ");
    await utente.click(screen.getByRole("button", { name: "Salva e segna come completa" }));

    expect(corpo).toEqual({ status: "COMPLETA" });
  });

  it("«lasciala da rivedere» non manda mai lo stato: e' tutto cio' che la distingue dall'altro pulsante", async () => {
    let corpo: Corpo | null = null;
    montaConApi(
      clienteCon([unaRegistrazione()], (_id, input) => {
        corpo = input;
        return Promise.resolve(SCHEDA);
      }),
      <ReviewScreen id="proc-1" />,
    );
    const utente = userEvent.setup();
    await ilModulo();

    await utente.type(
      screen.getByLabelText("Vuoi aggiungere un passo? (facoltativo)"),
      "Chiedere il modulo AP70",
    );
    await utente.click(screen.getByRole("button", { name: "Salva e lasciala da rivedere" }));

    expect(corpo).not.toBeNull();
    expect(corpo).not.toHaveProperty("status");
  });
});

describe("ReviewScreen: quando il server rifiuta", () => {
  it("l'avviso compare e non si va via: il testo appena scritto vive solo qui", async () => {
    montaConApi(
      clienteCon([unaRegistrazione()], () => Promise.reject(new Error("Scheda archiviata."))),
      <ReviewScreen id="proc-1" />,
    );
    const utente = userEvent.setup();
    await ilModulo();

    await utente.type(
      screen.getByLabelText("Vuoi aggiungere un passo? (facoltativo)"),
      "Chiedere il modulo AP70",
    );
    await utente.click(screen.getByRole("button", { name: "Salva e segna come completa" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Scheda archiviata.");
    // Navigare comunque porterebbe alla scheda senza il passo appena scritto,
    // e quel testo non e' salvato da nessuna parte.
    expect(window.location.hash).toBe("#/revisione/proc-1");
  });

  it("e i pulsanti tornano premibili, cosi' si puo' riprovare", async () => {
    let tentativi = 0;
    montaConApi(
      clienteCon([unaRegistrazione()], () => {
        tentativi += 1;
        return Promise.reject(new Error("Rete assente."));
      }),
      <ReviewScreen id="proc-1" />,
    );
    const utente = userEvent.setup();

    await utente.click(await ilModulo());
    await screen.findByRole("alert");
    await utente.click(screen.getByRole("button", { name: "Salva e segna come completa" }));

    // Senza il `finally`, `attesa` resterebbe `true` dopo un errore e la
    // schermata sarebbe da ricaricare: tre pulsanti spenti e un avviso rosso.
    expect(tentativi).toBe(2);
  });

  it("mentre salva i tre pulsanti sono spenti, e il primo dice cosa sta succedendo", async () => {
    let sblocca: () => void = () => undefined;
    montaConApi(
      clienteCon(
        [unaRegistrazione()],
        () =>
          new Promise((resolve) => {
            sblocca = () => {
              resolve(SCHEDA);
            };
          }),
      ),
      <ReviewScreen id="proc-1" />,
    );

    await userEvent.setup().click(await ilModulo());

    // Due `PATCH` sullo stesso salvataggio significano due passi identici in
    // coda alla scheda, e nessuno dei due si puo' togliere da questa schermata.
    const salvo = await screen.findByRole("button", { name: "Salvo…" });
    expect((salvo as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Salva e lasciala da rivedere" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Va bene cosi'" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    sblocca();
  });
});
