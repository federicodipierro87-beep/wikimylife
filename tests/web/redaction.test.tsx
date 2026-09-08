import type { ProcedureDetail } from "@wikimylife/shared";
import { ApiError } from "@wikimylife/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RedactionScreen } from "../../apps/web/src/screens/RedactionScreen";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unaProposta, unReport } from "./helpers/dati";
import { montaConApi } from "./helpers/render";

/**
 * La schermata della §9, provata dove sbagliare costa privacy.
 *
 * Le altre cose che questa schermata fa — i tre testi dell'elenco vuoto, il
 * riquadro del guasto, il conteggio nel pulsante — sono testo, e un test che le
 * ricopia verifica soltanto di aver copiato bene. Qui sotto ci sono invece le
 * proprieta' che, se si rompessero, romperebbero qualcosa che non si vede
 * guardando la pagina:
 *
 *   nessuna casella spuntata      una regressione qui trasforma la schermata in
 *                                 un «conferma» e cancella dati che nessuno ha
 *                                 letto. E' la §9 alla lettera.
 *   si manda solo il selezionato  una regressione qui cancella dati che
 *                                 qualcuno ha letto e ha deciso di tenere.
 *   il rifiuto azzera le scelte   senza, restano spuntate caselle che si
 *                                 riferiscono a un testo che non esiste piu'.
 *   «letto, non calcolato»        e' l'unica cosa che distingue l'ipotesi di un
 *                                 modello da un checksum, e sta in una `span`
 *                                 che una riscrittura del CSS non protegge.
 *   il contesto non e' HTML       la frase intorno l'ha scritta un modello che
 *                                 ha letto un audio: e' l'ingresso meno fidato
 *                                 che questa applicazione abbia.
 *
 * Il finto di `applyRedaction` restituisce una promessa che non si risolve mai,
 * dove il caso guarda cosa ha ricevuto, e non e' pigrizia. Alla riuscita la
 * schermata naviga altrove e si smonta: cio' che il test vuole leggere e' gia'
 * stato deciso prima di allora, e costruire un `ProcedureDetail` intero — venti
 * campi, tutti irrilevanti — per farla proseguire avrebbe aggiunto solo righe.
 */

/** Il `ProcedureDetail` che `applyRedaction` promette e che qui non arriva mai. */
function maiRisolta(): Promise<ProcedureDetail> {
  return new Promise<ProcedureDetail>(() => {
    // Volutamente vuota: si veda il commento in testa al file.
  });
}

function spuntate(): readonly HTMLElement[] {
  return screen.queryAllByRole("checkbox", { checked: true });
}

function bottone(nome: string): HTMLButtonElement {
  return screen.getByRole("button", { name: nome }) as HTMLButtonElement;
}

describe("RedactionScreen", () => {
  it("non spunta niente da sola, nemmeno con una sola proposta", async () => {
    const client = creaClienteFinto({
      proposeRedaction: () => Promise.resolve(unReport({ proposte: [unaProposta({ id: "p1" })] })),
    });

    montaConApi(client, <RedactionScreen id="proc-1" />);

    await screen.findByRole("checkbox");
    expect(spuntate()).toHaveLength(0);
    // Il pulsante dice perche' e' spento, invece di essere solo spento: uno
    // spento e basta si legge come «l'app e' rotta».
    expect(bottone("Scegli cosa togliere").disabled).toBe(true);
  });

  it("manda solo gli id che sono stati spuntati", async () => {
    const invii: (readonly string[])[] = [];
    const client = creaClienteFinto({
      proposeRedaction: () =>
        Promise.resolve(
          unReport({
            proposte: [
              unaProposta({ id: "p1", etichetta: "Passo 1" }),
              unaProposta({ id: "p2", etichetta: "Passo 2" }),
              unaProposta({ id: "p3", etichetta: "Passo 3" }),
            ],
          }),
        ),
      applyRedaction: (_id, conferme) => {
        invii.push(conferme);
        return maiRisolta();
      },
    });

    montaConApi(client, <RedactionScreen id="proc-1" />);

    const caselle = await screen.findAllByRole("checkbox");
    expect(caselle).toHaveLength(3);

    const utente = userEvent.setup();
    // La prima e la terza. Se la schermata mandasse gli indici invece degli id,
    // o li mandasse tutti, questo caso lo direbbe.
    await utente.click(caselle[0]!);
    await utente.click(caselle[2]!);
    await utente.click(bottone("Togli 2 su 3"));

    await waitFor(() => {
      expect(invii).toEqual([["p1", "p3"]]);
    });
  });

  it("una proposta spuntata e rispuntata resta fuori dall'invio", async () => {
    const invii: (readonly string[])[] = [];
    const client = creaClienteFinto({
      proposeRedaction: () =>
        Promise.resolve(
          unReport({ proposte: [unaProposta({ id: "p1" }), unaProposta({ id: "p2" })] }),
        ),
      applyRedaction: (_id, conferme) => {
        invii.push(conferme);
        return maiRisolta();
      },
    });

    montaConApi(client, <RedactionScreen id="proc-1" />);

    const caselle = await screen.findAllByRole("checkbox");
    const utente = userEvent.setup();
    await utente.click(caselle[0]!);
    await utente.click(caselle[1]!);
    await utente.click(caselle[0]!);

    await utente.click(bottone("Togli 1 su 2"));

    await waitFor(() => {
      expect(invii).toEqual([["p2"]]);
    });
  });

  it("dopo un rifiuto del server le caselle tornano vuote e le proposte si rileggono", async () => {
    let letture = 0;
    const client = creaClienteFinto({
      proposeRedaction: () => {
        letture += 1;
        return Promise.resolve(
          unReport({ proposte: [unaProposta({ id: "p1" }), unaProposta({ id: "p2" })] }),
        );
      },
      applyRedaction: () =>
        Promise.reject(
          new ApiError({
            code: "CONFLICT",
            message: "La scheda e' cambiata: rileggi le proposte.",
            status: 409,
          }),
        ),
    });

    montaConApi(client, <RedactionScreen id="proc-1" />);

    const caselle = await screen.findAllByRole("checkbox");
    const utente = userEvent.setup();
    await utente.click(caselle[0]!);
    await utente.click(bottone("Togli 1 su 2"));

    // Il messaggio del server e non una frase generica: e' quello che spiega
    // perche' ripremere subito non servirebbe.
    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toContain("La scheda e' cambiata: rileggi le proposte.");

    // Gli id in mano alla schermata valgono per un testo che non esiste piu':
    // lasciarli spuntati vorrebbe dire offrire di riprovare con dati scaduti.
    await waitFor(() => {
      expect(spuntate()).toHaveLength(0);
    });
    expect(letture).toBe(2);
  });

  it("una proposta assistita porta scritto che e' stata letta, non calcolata", async () => {
    const client = creaClienteFinto({
      proposeRedaction: () =>
        Promise.resolve(
          unReport({
            assistenza: "ESEGUITA",
            proposte: [
              unaProposta({ id: "p1", origine: "CERTA", kind: "EMAIL" }),
              unaProposta({
                id: "p2",
                origine: "ASSISTITA",
                kind: "NOME_PERSONA",
                valore: "Mario Rossi",
                contesto: "chiedere di Mario Rossi allo sportello",
                sostituzione: "[nome]",
              }),
            ],
          }),
        ),
    });

    montaConApi(client, <RedactionScreen id="proc-1" />);

    // Una volta sola: e' la seconda proposta ad averlo, non tutte. Il testo e
    // non la classe CSS, perche' chi non distingue i colori legge solo questo.
    const segni = await screen.findAllByText("letto, non calcolato");
    expect(segni).toHaveLength(1);
  });

  it("evidenzia il dato dentro la frase senza scrivere HTML in pagina", async () => {
    const client = creaClienteFinto({
      proposeRedaction: () =>
        Promise.resolve(
          unReport({
            proposte: [
              unaProposta({
                valore: "mario@example.com",
                // Un contesto che, passato per `dangerouslySetInnerHTML`,
                // diventerebbe un tag vero.
                contesto: "<img src=x onerror=alert(1)> scrivere a mario@example.com",
              }),
            ],
          }),
        ),
    });

    const { container } = montaConApi(client, <RedactionScreen id="proc-1" />);

    const marcato = await screen.findByText("mario@example.com");
    expect(marcato.tagName).toBe("MARK");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
