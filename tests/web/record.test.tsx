import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { NonSalvata } from "../../apps/web/src/App";
import { RecordScreen } from "../../apps/web/src/screens/RecordScreen";
import { creaCapturaFinta, montaConCattura } from "./helpers/capturaFinta";

/**
 * La schermata con un pulsante solo, che e' anche quella che nessun test
 * guardava.
 *
 * Il motivo per cui era scoperta e' lo stesso per cui e' pericolosa: sembra non
 * avere logica. In realta' decide cinque cose, e quattro non hanno sintomi
 * visibili quando si rompono.
 *
 * ## Il caso che conta piu' di tutti
 *
 * `premi()` fa `await capture.stop()` e **poi** `navigate({ name: "lista" })`.
 * L'ordine e' l'intera garanzia: se il salvataggio fallisce, l'eccezione salta
 * la navigazione e l'utente resta qui, davanti all'avviso. Spostare la
 * navigazione dentro un `finally`, o metterla prima dell'`await`, produrrebbe
 * una schermata che funziona benissimo in ogni prova manuale — perche' a mano
 * il salvataggio riesce — e che il giorno in cui il telefono e' pieno manda
 * l'utente alla lista con un'aria soddisfatta, mentre dieci minuti di parlato
 * stanno per sparire dalla memoria. Quel giorno non arriva mai mentre si prova,
 * e arriva sempre.
 *
 * ## Gli altri quattro
 *
 * Il microfono negato spegne il pulsante invece di mostrarne uno che non fa
 * niente. L'avviso dello spazio compare **prima** di premere e sparisce a
 * microfono acceso, perche' dopo non c'e' piu' niente da decidere. «Non lo so»
 * non diventa «pieno». E «pieno» avvisa senza impedire, che e' la decisione
 * scritta in `spazio.ts` e che un `disabled` messo per prudenza cancellerebbe.
 *
 * Le funzioni pure dietro l'avviso — `valutaSpazio`, `avvisoSpazio` — hanno
 * gia' i loro casi in `tests/unit/spazio.test.ts`. Qui non si riprova cosa
 * dicono: si prova che la schermata le mostri nel momento giusto.
 *
 * ## L'hash invece di un finto
 *
 * `navigate()` scrive su `window.location.hash`, e in `jsdom` quello e' un
 * valore che si legge. Sostituire il modulo del router con un finto avrebbe
 * verificato che la schermata chiama una funzione; leggere l'hash verifica
 * dove si e' finiti, che e' la cosa di cui si sta parlando.
 */

const QUI = "#/registra";
const LISTA = "#/";

beforeEach(() => {
  // Ogni caso parte da dov'e' l'utente quando questa schermata e' aperta.
  // Senza, l'hash lasciato dal caso precedente farebbe passare per «non ha
  // navigato» un caso che ha navigato, e viceversa.
  window.location.hash = QUI;
});

describe("RecordScreen: il pulsantone", () => {
  it("da fermi invita a cominciare, e il contatore sta a zero", () => {
    const { container } = montaConCattura(creaCapturaFinta(), <RecordScreen />);

    const pulsante = screen.getByRole("button", { name: "Inizia a registrare" });
    expect((pulsante as HTMLButtonElement).disabled).toBe(false);
    expect(pulsante.className).not.toContain("pulsantone--attivo");
    expect(container.querySelector(".contatore")?.textContent).toBe("0:00");
    expect(screen.getByText("Premi e racconta una procedura.")).toBeTruthy();
  });

  it("a microfono acceso cambia nome, aspetto e contatore", () => {
    const { container } = montaConCattura(
      creaCapturaFinta({ state: { kind: "in-corso", elapsedMs: 65_000 } }),
      <RecordScreen />,
    );

    const pulsante = screen.getByRole("button", { name: "Ferma la registrazione" });
    expect(pulsante.className).toContain("pulsantone--attivo");
    expect(container.querySelector(".contatore")?.textContent).toBe("1:05");
    expect(screen.getByText("Racconta come si fa. Premi per finire.")).toBeTruthy();
  });

  it("premere da fermi accende il microfono e non porta da nessuna parte", async () => {
    const chiamate: string[] = [];
    const capture = creaCapturaFinta({
      start: () => {
        chiamate.push("start");
        return Promise.resolve();
      },
    });
    montaConCattura(capture, <RecordScreen />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Inizia a registrare" }));

    await waitFor(() => {
      expect(chiamate).toEqual(["start"]);
    });
    // Andare alla lista appena premuto lascerebbe il microfono acceso su una
    // schermata che non ha nessun modo di spegnerlo.
    expect(window.location.hash).toBe(QUI);
  });

  it("premere a microfono acceso ferma e porta alla lista, dov'e' l'indicatore della coda", async () => {
    const chiamate: string[] = [];
    const capture = creaCapturaFinta({
      state: { kind: "in-corso", elapsedMs: 3_000 },
      stop: () => {
        chiamate.push("stop");
        return Promise.resolve("locale-1");
      },
    });
    montaConCattura(capture, <RecordScreen />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Ferma la registrazione" }));

    await waitFor(() => {
      expect(window.location.hash).toBe(LISTA);
    });
    expect(chiamate).toEqual(["stop"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("se il salvataggio fallisce si resta qui: mandare alla lista direbbe «fatto» su un audio che non c'e'", async () => {
    const capture = creaCapturaFinta({
      state: { kind: "in-corso", elapsedMs: 3_000 },
      stop: () => Promise.reject(new Error("Spazio esaurito sul dispositivo.")),
    });
    montaConCattura(capture, <RecordScreen />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Ferma la registrazione" }));

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toContain("Spazio esaurito sul dispositivo.");
    // Il punto di tutto il caso. L'avviso con l'uscita per salvare l'audio sta
    // sopra questa schermata, e chi e' stato portato via non lo vede in tempo.
    expect(window.location.hash).toBe(QUI);
  });

  it("l'errore di prima sparisce quando si riprova, e allora si va", async () => {
    let tentativi = 0;
    const capture = creaCapturaFinta({
      state: { kind: "in-corso", elapsedMs: 3_000 },
      stop: () => {
        tentativi += 1;
        return tentativi === 1
          ? Promise.reject(new Error("Spazio esaurito sul dispositivo."))
          : Promise.resolve("locale-1");
      },
    });
    montaConCattura(capture, <RecordScreen />);

    const utente = userEvent.setup();
    const pulsante = screen.getByRole("button", { name: "Ferma la registrazione" });

    await utente.click(pulsante);
    expect((await screen.findByRole("alert")).textContent).toContain("Spazio esaurito");

    await utente.click(pulsante);
    await waitFor(() => {
      expect(window.location.hash).toBe(LISTA);
    });
    // Un avviso rosso che sopravvive al tentativo riuscito dice che e' andata
    // male mentre e' andata bene.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("mentre salva il pulsante non si lascia premere una seconda volta", () => {
    montaConCattura(creaCapturaFinta({ state: { kind: "salvataggio" } }), <RecordScreen />);

    // `stop()` non e' insegnato: se un secondo tocco passasse, il finto lo
    // direbbe. Ma il pulsante spento e' la garanzia, non il finto.
    const pulsante = screen.getByRole("button", { name: "Inizia a registrare" });
    expect((pulsante as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Sto salvando…")).toBeTruthy();
  });

  it("«Annulla» c'e' solo a microfono acceso, e butta via quello che si e' detto", async () => {
    const chiamate: string[] = [];
    const capture = creaCapturaFinta({
      state: { kind: "in-corso", elapsedMs: 3_000 },
      cancel: () => {
        chiamate.push("cancel");
        return Promise.resolve();
      },
    });
    const acceso = montaConCattura(capture, <RecordScreen />);

    await userEvent.setup().click(within(acceso.container).getByRole("button", { name: "Annulla" }));
    await waitFor(() => {
      expect(chiamate).toEqual(["cancel"]);
    });
    // E non naviga: si resta qui, pronti a ricominciare.
    expect(window.location.hash).toBe(QUI);

    // Il secondo montaggio vive accanto al primo nello stesso documento, quindi
    // la domanda va fatta dentro il suo contenitore: `screen` troverebbe
    // l'«Annulla» dell'altro e il caso passerebbe al contrario.
    const fermo = montaConCattura(creaCapturaFinta(), <RecordScreen />);
    // Da fermi non c'e' niente da annullare, e un «Annulla» sempre presente
    // accanto al pulsante principale e' un invito a premerlo per sbaglio.
    expect(within(fermo.container).queryByRole("button", { name: "Annulla" })).toBeNull();
  });
});

describe("RecordScreen: un browser che non sa registrare", () => {
  it("lo dice, e non mostra un pulsante che non farebbe niente", () => {
    montaConCattura(creaCapturaFinta({ supportata: false }), <RecordScreen />);

    expect(screen.getByText(/Questo browser non sa registrare audio/)).toBeTruthy();
    // Il pulsantone che non registra sarebbe la peggiore delle due schermate:
    // si preme, non succede niente, e non c'e' scritto perche'.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("e quando invece sa registrare il pulsante c'e'", () => {
    montaConCattura(creaCapturaFinta({ supportata: true }), <RecordScreen />);

    expect(screen.getByRole("button", { name: "Inizia a registrare" })).toBeTruthy();
    expect(screen.queryByText(/Questo browser non sa registrare audio/)).toBeNull();
  });
});

describe("RecordScreen: l'avviso dello spazio", () => {
  it("con poco spazio lo dice prima di premere, con i minuti che restano", () => {
    const { container } = montaConCattura(
      creaCapturaFinta({ spazio: { kind: "poco", minuti: 4 } }),
      <RecordScreen />,
    );

    const avviso = container.querySelector(".avviso--spazio");
    expect(avviso?.textContent).toContain("circa 4 minuti");
  });

  it("a microfono acceso sparisce, perche' non c'e' piu' niente da decidere", () => {
    const { container } = montaConCattura(
      creaCapturaFinta({
        spazio: { kind: "poco", minuti: 4 },
        state: { kind: "in-corso", elapsedMs: 1_000 },
      }),
      <RecordScreen />,
    );

    // Lo stesso spazio di prima. Cambia solo il momento: adesso l'unica cosa
    // che l'avviso potrebbe ottenere e' far interrompere chi sta parlando.
    expect(container.querySelector(".avviso--spazio")).toBeNull();
  });

  it("«non lo so» non diventa «pieno»: se il browser non sa dirlo, non si dice niente", () => {
    const { container } = montaConCattura(
      creaCapturaFinta({ spazio: { kind: "ignoto" } }),
      <RecordScreen />,
    );

    // Safari senza `navigator.storage`, un contesto non sicuro, una
    // `estimate()` che ha lanciato: tre modi di non sapere. Trasformarli in un
    // avviso rosso vorrebbe dire spaventare chi lo spazio ce l'ha, ogni volta,
    // su un intero browser.
    expect(container.querySelector(".avviso--spazio")).toBeNull();
  });

  it("con lo spazio a posto non c'e' niente da dire", () => {
    const { container } = montaConCattura(
      creaCapturaFinta({ spazio: { kind: "ok" } }),
      <RecordScreen />,
    );

    expect(container.querySelector(".avviso--spazio")).toBeNull();
  });

  it("«pieno» avvisa e basta: il pulsante resta premibile", async () => {
    const chiamate: string[] = [];
    const capture = creaCapturaFinta({
      spazio: { kind: "pieno" },
      start: () => {
        chiamate.push("start");
        return Promise.resolve();
      },
    });
    const { container } = montaConCattura(capture, <RecordScreen />);

    expect(container.querySelector(".avviso--spazio")?.textContent).toContain(
      "Lo spazio sul telefono e' finito",
    );

    // La stima e' arrotondata apposta dai browser per non diventare
    // un'impronta digitale. Un divieto costruito sopra un numero cosi'
    // impedirebbe di registrare a chi lo spazio ce l'ha: fra un avviso
    // sbagliato e una registrazione mai fatta, la seconda e' la perdita
    // peggiore.
    const pulsante = screen.getByRole("button", { name: "Inizia a registrare" });
    expect((pulsante as HTMLButtonElement).disabled).toBe(false);

    await userEvent.setup().click(pulsante);
    await waitFor(() => {
      expect(chiamate).toEqual(["start"]);
    });
  });
});

describe("RecordScreen: senza rete", () => {
  it("offline promette che la registrazione parte da sola, online non promette niente", () => {
    montaConCattura(creaCapturaFinta({ online: false }), <RecordScreen />);
    expect(screen.getByText(/Sei offline/)).toBeTruthy();

    montaConCattura(creaCapturaFinta({ online: true }), <RecordScreen />);
    // Due montaggi nello stesso documento: se l'avviso comparisse anche da
    // online se ne troverebbero due, e `getAllByText` avrebbe lunghezza due.
    expect(screen.getAllByText(/Sei offline/)).toHaveLength(1);
  });
});

/**
 * L'audio che il telefono non ha voluto scrivere.
 *
 * Vive sopra ogni schermata perche' si perde anche guardando un'altra pagina, e
 * la sua unica decisione e' quale delle tre uscite mostrare. Sbagliarla non ha
 * sintomi: un «Riprova a salvare» mostrato quando IndexedDB non esiste non
 * rompe niente, fa solo premere un pulsante che fallira' identico, con un audio
 * in memoria che ogni tentativo avvicina alla chiusura della scheda.
 */
describe("NonSalvata: le tre uscite", () => {
  const REGISTRAZIONE = {
    recordedAt: new Date().toISOString(),
    durationMs: 42_000,
    motivo: "Spazio esaurito sul dispositivo.",
    spazio: true,
  };

  it("senza niente da salvare il riquadro non esiste", () => {
    const { container } = montaConCattura(
      creaCapturaFinta({ nonSalvata: null }),
      <NonSalvata />,
    );

    // Il contenitore e non i pulsanti: un riquadro vuoto con il suo bordo
    // disegnerebbe una riga in cima all'app senza che nessuno cerchi di
    // capirne il motivo.
    expect(container.querySelector(".non-salvata")).toBeNull();
  });

  it("quando e' mancato lo spazio riprovare puo' cambiare qualcosa, e il pulsante c'e'", () => {
    montaConCattura(creaCapturaFinta({ nonSalvata: REGISTRAZIONE }), <NonSalvata />);

    expect(screen.getByRole("button", { name: "Riprova a salvare" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scarica il file" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scarta" })).toBeTruthy();
  });

  it("quando IndexedDB non c'e' proprio, riprovare non c'e': fallirebbe identico", () => {
    montaConCattura(
      creaCapturaFinta({ nonSalvata: { ...REGISTRAZIONE, spazio: false } }),
      <NonSalvata />,
    );

    // Firefox in navigazione privata, per esempio. Le altre due uscite
    // restano, perche' l'audio c'e' ancora e portarlo fuori funziona lo stesso.
    expect(screen.queryByRole("button", { name: "Riprova a salvare" })).toBeNull();
    expect(screen.getByRole("button", { name: "Scarica il file" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scarta" })).toBeTruthy();
  });

  it("i tre pulsanti fanno tre cose diverse", async () => {
    const chiamate: string[] = [];
    const capture = creaCapturaFinta({
      nonSalvata: REGISTRAZIONE,
      riscrivi: () => {
        chiamate.push("riscrivi");
        return Promise.resolve();
      },
      scarica: () => {
        chiamate.push("scarica");
      },
      scarta: () => {
        chiamate.push("scarta");
      },
    });
    montaConCattura(capture, <NonSalvata />);

    const utente = userEvent.setup();
    await utente.click(screen.getByRole("button", { name: "Riprova a salvare" }));
    await utente.click(screen.getByRole("button", { name: "Scarica il file" }));
    await utente.click(screen.getByRole("button", { name: "Scarta" }));

    // Due pulsanti collegati allo stesso gesto sono il modo piu' silenzioso di
    // perdere una registrazione: «Scarica» che scarta non lascia traccia.
    await waitFor(() => {
      expect(chiamate).toEqual(["riscrivi", "scarica", "scarta"]);
    });
  });

  it("dice cosa e' successo, quanto dura e per quanto ancora c'e'", () => {
    const { container } = montaConCattura(
      creaCapturaFinta({ nonSalvata: REGISTRAZIONE }),
      <NonSalvata />,
    );

    const riquadro = screen.getByRole("alert");
    expect(riquadro.textContent).toContain("Spazio esaurito sul dispositivo.");
    // La durata e' l'unica cosa che dice quanto si sta per perdere: senza,
    // «scarta» e' una scelta presa al buio.
    expect(container.querySelector(".non-salvata__quando")?.textContent).toContain("0:42");
    expect(riquadro.textContent).toContain("solo finche' l'app resta aperta");
  });
});
