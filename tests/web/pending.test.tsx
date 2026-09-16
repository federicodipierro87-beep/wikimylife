import type { PendingRecordings as PendingRecordingsResponse } from "@wikimylife/shared";
import { ApiError } from "@wikimylife/shared";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingRecordings } from "../../apps/web/src/screens/PendingRecordings";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unaRegistrazione } from "./helpers/dati";
import { montaConApi } from "./helpers/render";

/**
 * La sezione «In lavorazione», e la sola cosa che qui puo' costare qualcosa a
 * qualcuno: quando smette di chiedere.
 *
 * Il polling non ha un sintomo. Se resta acceso quando non doveva, la schermata
 * e' identica e corretta, la prova manuale passa, e l'unico segno e' una
 * richiesta ogni cinque secondi su una connessione mobile — per tutto il tempo
 * in cui la pagina resta aperta, cioe' potenzialmente per giorni. Non se ne
 * accorge chi guarda: se ne accorge chi paga il traffico.
 *
 * La regola e' che si chiede solo se qualcosa puo' cambiare da solo, cioe' se
 * c'e' almeno una registrazione in `BOZZA_AUDIO` o `IN_ELABORAZIONE`. Le altre
 * cambiano solo quando si preme un pulsante, e allora e' il pulsante a
 * ricaricare.
 *
 * ## Due gruppi, e due gestioni del tempo
 *
 * Contare i giri con i timer veri vorrebbe dire un caso che dura quindici
 * secondi per contare fino a tre, quindi il primo gruppo usa `useFakeTimers` e
 * avanza a mano.
 *
 * Il secondo gruppo no, e la ragione e' che i due non si mescolano bene:
 * `userEvent` aspetta fra un gesto e l'altro, React 18 pianifica il proprio
 * lavoro su un `MessageChannel` che i timer finti non toccano, e il risultato
 * di tenerli insieme e' un click che non torna mai. Li' il tempo non e'
 * l'oggetto del test — lo sono due tocchi su un pulsante — e farlo scorrere
 * davvero costa qualche decimo di secondo.
 *
 * Un avanzamento per volta, e non quindici secondi in un colpo: a ogni
 * ricaricamento lo stato torna `attesa`, il timer viene spento e riacceso
 * quando i dati arrivano, e in un unico salto React non ha il tempo di
 * riaccenderlo fra un tick e l'altro. Il conteggio sarebbe giusto per il motivo
 * sbagliato.
 */

const CINQUE_SECONDI = 5000;

function unaRisposta(items: PendingRecordingsResponse["items"]): PendingRecordingsResponse {
  return { items };
}

describe("PendingRecordings: quando smette di chiedere", () => {
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

  it("continua a chiedere finche' qualcosa si sta muovendo", async () => {
    let letture = 0;
    const client = creaClienteFinto({
      listPendingRecordings: () => {
        letture += 1;
        return Promise.resolve(
          unaRisposta([unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })]),
        );
      },
    });

    montaConApi(client, <PendingRecordings onSparita={() => {}} />);

    await avanza(0);
    expect(letture).toBe(1);

    await avanza(CINQUE_SECONDI);
    expect(letture).toBe(2);

    await avanza(CINQUE_SECONDI);
    expect(letture).toBe(3);
  });

  it("smette di chiedere quando non resta niente che possa cambiare da solo", async () => {
    let letture = 0;
    const client = creaClienteFinto({
      listPendingRecordings: () => {
        letture += 1;
        return Promise.resolve(
          unaRisposta([
            // Ferma per davvero: senza un tocco umano restera' cosi' per
            // sempre, e richiederla e' chiedere all'infinito la stessa risposta.
            unaRegistrazione({ id: "r1", status: "ESTRAZIONE_FALLITA" }),
          ]),
        );
      },
    });

    montaConApi(client, <PendingRecordings onSparita={() => {}} />);

    await avanza(0);
    expect(letture).toBe(1);

    await avanza(CINQUE_SECONDI * 10);
    expect(letture).toBe(1);
  });

  it("smette da sola quando l'ultima registrazione in movimento si ferma", async () => {
    let letture = 0;
    const client = creaClienteFinto({
      listPendingRecordings: () => {
        letture += 1;
        // Il primo giro la trova in lavorazione, il secondo fallita: e' la fine
        // dell'elaborazione, ed e' li' che il timer deve spegnersi da solo. Un
        // `useEffect` con le dipendenze sbagliate lo lascerebbe acceso senza
        // che niente in pagina lo dica.
        return Promise.resolve(
          unaRisposta([
            unaRegistrazione({
              id: "r1",
              status: letture === 1 ? "IN_ELABORAZIONE" : "ESTRAZIONE_FALLITA",
            }),
          ]),
        );
      },
    });

    montaConApi(client, <PendingRecordings onSparita={() => {}} />);

    await avanza(0);
    expect(letture).toBe(1);

    await avanza(CINQUE_SECONDI);
    expect(letture).toBe(2);

    await avanza(CINQUE_SECONDI * 10);
    expect(letture).toBe(2);
  });

  it("una registrazione gia' diventata scheda non compare e non tiene acceso niente", async () => {
    let letture = 0;
    const client = creaClienteFinto({
      listPendingRecordings: () => {
        letture += 1;
        return Promise.resolve(
          unaRisposta([unaRegistrazione({ id: "r1", status: "ESTRATTO", procedureId: "proc-1" })]),
        );
      },
    });

    const { container } = montaConApi(client, <PendingRecordings onSparita={() => {}} />);

    await avanza(CINQUE_SECONDI * 3);
    // Ha gia' la sua scheda nell'elenco sotto: mostrarla anche qui la farebbe
    // comparire due volte nella stessa schermata.
    expect(container.querySelector(".sospesa")).toBeNull();
    expect(letture).toBe(1);
  });

  it("se la richiesta fallisce non mette un avviso rosso in cima alla lista", async () => {
    const client = creaClienteFinto({
      listPendingRecordings: () =>
        Promise.reject(
          new ApiError({ code: "INTERNAL_ERROR", message: "Il server non risponde.", status: 500 }),
        ),
    });

    const { container } = montaConApi(client, <PendingRecordings onSparita={() => {}} />);

    await avanza(0);
    // Questa sezione e' un di piu' sopra l'elenco delle schede. Un avviso rosso
    // per una richiesta accessoria fallita farebbe sembrare rotta una schermata
    // che funziona.
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/**
 * L'avviso a chi sta sopra, e quando NON deve partire.
 *
 * Il server toglie dai sospesi tutto cio' che e' `ESTRATTO`: l'unico istante in
 * cui si sa che un vocale e' appena diventato una scheda e' quello in cui il
 * suo id sparisce da questa lista. Se l'avviso non parte, la scheda nuova non
 * compare finche' qualcuno non ricarica la pagina; se parte quando non deve,
 * ogni tick costa una richiesta paginata in piu'.
 */
describe("PendingRecordings: quando avvisa chi sta sopra", () => {
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

  /** Un client che risponde con una lista diversa a ogni giro. */
  function clienteAGiri(giri: readonly PendingRecordingsResponse["items"][]) {
    let letture = 0;
    return creaClienteFinto({
      listPendingRecordings: () => {
        const giro = giri[Math.min(letture, giri.length - 1)] ?? [];
        letture += 1;
        return Promise.resolve(unaRisposta(giro));
      },
    });
  }

  it("quando un vocale sparisce dalla lista, lo dice a chi sta sopra", async () => {
    const onSparita = vi.fn();
    const client = clienteAGiri([[unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })], []]);

    montaConApi(client, <PendingRecordings onSparita={onSparita} />);

    await avanza(0);
    expect(onSparita).not.toHaveBeenCalled();

    await avanza(CINQUE_SECONDI);
    expect(onSparita).toHaveBeenCalledTimes(1);
  });

  it("finche' sono tutti li', non dice niente", async () => {
    // L'errore opposto: un avviso a ogni giro farebbe richiedere l'elenco delle
    // schede ogni cinque secondi per tutto il tempo dell'elaborazione.
    const onSparita = vi.fn();
    const client = clienteAGiri([[unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })]]);

    montaConApi(client, <PendingRecordings onSparita={onSparita} />);

    await avanza(CINQUE_SECONDI * 3);
    expect(onSparita).not.toHaveBeenCalled();
  });

  it("il primo giro non e' una sparizione", async () => {
    const onSparita = vi.fn();
    const client = clienteAGiri([[unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })]]);

    montaConApi(client, <PendingRecordings onSparita={onSparita} />);

    await avanza(0);
    // Prima di questo giro non si sapeva cosa ci fosse: «r1 c'e' adesso e prima
    // no» non e' un'informazione, e leggerla come tale farebbe ricaricare
    // l'elenco a ogni apertura della schermata.
    expect(onSparita).not.toHaveBeenCalled();
  });

  it("uno che esce e uno che entra nello stesso giro e' comunque una sparizione", async () => {
    // La lunghezza non cambia: e' il caso in cui un confronto sui numeri invece
    // che sugli id lascerebbe la scheda appena nata invisibile.
    const onSparita = vi.fn();
    const client = clienteAGiri([
      [unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })],
      [unaRegistrazione({ id: "r2", status: "IN_ELABORAZIONE" })],
    ]);

    montaConApi(client, <PendingRecordings onSparita={onSparita} />);

    await avanza(0);
    await avanza(CINQUE_SECONDI);
    expect(onSparita).toHaveBeenCalledTimes(1);
  });

  it("un vocale che arriva e basta non e' una sparizione", async () => {
    const onSparita = vi.fn();
    const client = clienteAGiri([
      [unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })],
      [
        unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" }),
        unaRegistrazione({ id: "r2", status: "IN_ELABORAZIONE" }),
      ],
    ]);

    montaConApi(client, <PendingRecordings onSparita={onSparita} />);

    await avanza(0);
    await avanza(CINQUE_SECONDI);
    expect(onSparita).not.toHaveBeenCalled();
  });

  it("un giro andato storto non e' una sparizione", async () => {
    // Un errore non dice che qualcosa e' sparito: dice che non lo sappiamo.
    // Leggendolo come lista vuota, ogni buco di rete farebbe ricaricare
    // l'elenco delle schede.
    const onSparita = vi.fn();
    let letture = 0;
    const client = creaClienteFinto({
      listPendingRecordings: () => {
        letture += 1;
        if (letture === 1) {
          return Promise.resolve(
            unaRisposta([unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })]),
          );
        }
        return Promise.reject(
          new ApiError({ code: "INTERNAL_ERROR", message: "Il server non risponde.", status: 500 }),
        );
      },
    });

    montaConApi(client, <PendingRecordings onSparita={onSparita} />);

    await avanza(0);
    await avanza(CINQUE_SECONDI);
    expect(letture).toBe(2);
    expect(onSparita).not.toHaveBeenCalled();
  });
});

describe("PendingRecordings: eliminare", () => {
  it("chiede un secondo tocco prima di chiamare il server", async () => {
    const eliminati: string[] = [];
    const client = creaClienteFinto({
      listPendingRecordings: () =>
        Promise.resolve(unaRisposta([unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })])),
      deleteRecording: (id) => {
        eliminati.push(id);
        return Promise.resolve();
      },
    });

    montaConApi(client, <PendingRecordings onSparita={() => {}} />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: "Elimina" }));
    // Il primo tocco non ha chiamato niente. Il pulsante sta accanto a «Riprova
    // adesso» su un telefono, e cancellare l'audio e' l'unica cosa
    // irreversibile che questa schermata sappia fare.
    expect(eliminati).toEqual([]);

    await utente.click(screen.getByRole("button", { name: "Annulla" }));
    expect(eliminati).toEqual([]);
    expect(screen.queryByRole("button", { name: "Elimina davvero" })).toBeNull();

    await utente.click(screen.getByRole("button", { name: "Elimina" }));
    await utente.click(screen.getByRole("button", { name: "Elimina davvero" }));
    await waitFor(() => {
      expect(eliminati).toEqual(["r1"]);
    });
  });

  it("un rifiuto lascia la registrazione dov'era, con scritto il perche'", async () => {
    const client = creaClienteFinto({
      listPendingRecordings: () =>
        Promise.resolve(unaRisposta([unaRegistrazione({ id: "r1", status: "IN_ELABORAZIONE" })])),
      deleteRecording: () =>
        Promise.reject(
          new ApiError({
            code: "CONFLICT",
            message: "La sto elaborando: riprova fra poco.",
            status: 409,
          }),
        ),
    });

    montaConApi(client, <PendingRecordings onSparita={() => {}} />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: "Elimina" }));
    await utente.click(screen.getByRole("button", { name: "Elimina davvero" }));

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toContain("La sto elaborando: riprova fra poco.");
    // Niente rimozione ottimistica: sparire e ricomparire al giro dopo sarebbe
    // peggio che non sparire.
    expect(screen.getByText("La sto ascoltando…")).toBeTruthy();
    // E la conferma si e' richiusa: «Elimina davvero» ancora acceso dopo un
    // rifiuto invita a riprovare a vuoto.
    expect(screen.queryByRole("button", { name: "Elimina davvero" })).toBeNull();
  });
});
