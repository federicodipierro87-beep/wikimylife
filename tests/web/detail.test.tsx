import { ApiError } from "@wikimylife/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DetailScreen } from "../../apps/web/src/screens/DetailScreen";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unVocale, unaScheda } from "./helpers/dati";
import { montaConApi } from "./helpers/render";

/**
 * Il gesto che butta via una voce, provato dove sbagliare non si recupera.
 *
 * Di tutto cio' che questa schermata fa, una cosa sola non e' annullabile: la
 * `DELETE` sulla registrazione cancella dei byte che nessun modello puo'
 * rigenerare. E la stessa chiamata puo' portarsi via anche la scheda. Sono due
 * effetti diversi dietro due pulsanti che stanno a due centimetri l'uno
 * dall'altro, e la differenza fra loro e' un booleano che il test e' l'unico
 * posto in cui si vede.
 *
 * Le proprieta' qui sotto sono quelle che, rompendosi, romperebbero qualcosa
 * che guardando la pagina non si nota:
 *
 *   non si cancella al primo tocco   il pulsante visibile apre una domanda, non
 *                                    esegue. Una regressione qui cancella un
 *                                    vocale per uno sfioramento.
 *   «solo il vocale» non archivia    e' il caso legittimo di chi vuole la
 *                                    procedura e non la propria voce: se il
 *                                    booleano partisse vero, quel gesto
 *                                    butterebbe nel cestino una scheda che
 *                                    nessuno ha chiesto di buttare.
 *   «anche la scheda» lo dice        senza il `true`, il pulsante che promette
 *                                    due cose ne fa una e risponde di si'.
 *   si cancella quello aperto        con piu' vocali sotto la stessa scheda, un
 *                                    id preso dall'indice sbagliato cancella
 *                                    quello di un altro giorno.
 *   il rifiuto non nasconde nulla    dopo un 409 la scheda deve restare intera:
 *                                    e' l'unico modo di sapere che il gesto non
 *                                    e' avvenuto.
 *
 * `getProcedure` conta le chiamate invece di essere una costante: che dopo la
 * cancellazione la schermata ricarichi e' l'unica cosa che distingue una pagina
 * aggiornata da una che mostra ancora il vocale appena distrutto.
 */

function bottone(nome: string | RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name: nome }) as HTMLButtonElement;
}

const SOLO = /Solo il vocale/;
const ANCHE = /Il vocale e la scheda/;

describe("DetailScreen — eliminare il vocale", () => {
  it("il primo tocco chiede quale delle due cose, e non cancella niente", async () => {
    // La conferma non e' un «sei sicuro»: chi ha aperto il vocale e cercato il
    // pulsante e' sicuro. E' una domanda con due risposte diverse, e finche'
    // non se ne sceglie una non deve essere partita nessuna richiesta.
    const chiamate: unknown[] = [];
    const client = creaClienteFinto({
      getProcedure: () => Promise.resolve(unaScheda({ recordings: [unVocale()] })),
      deleteRecording: (id, opzioni) => {
        chiamate.push({ id, opzioni });
        return Promise.resolve();
      },
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: "Elimina questo vocale" }));

    expect(chiamate).toEqual([]);
    expect(bottone(SOLO)).toBeDefined();
    expect(bottone(ANCHE)).toBeDefined();
  });

  it("«solo il vocale» non chiede di archiviare la scheda", async () => {
    // Il difetto contro cui questo caso esiste e' una riga: passare `true` per
    // difetto, o dimenticare l'oggetto e lasciare che sia il server a decidere.
    // Sono entrambi invisibili sullo schermo — la pagina si ricarica e il
    // vocale sparisce — e in tutti e due i casi la scheda finisce nel cestino.
    const opzioni: unknown[] = [];
    const client = creaClienteFinto({
      getProcedure: () => Promise.resolve(unaScheda({ recordings: [unVocale()] })),
      deleteRecording: (_id, o) => {
        opzioni.push(o);
        return Promise.resolve();
      },
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: "Elimina questo vocale" }));
    await utente.click(bottone(SOLO));

    await waitFor(() => {
      expect(opzioni).toEqual([{ ancheLaScheda: false }]);
    });
  });

  it("«il vocale e la scheda» chiede tutte e due le cose", async () => {
    const opzioni: unknown[] = [];
    const client = creaClienteFinto({
      getProcedure: () => Promise.resolve(unaScheda({ recordings: [unVocale()] })),
      deleteRecording: (_id, o) => {
        opzioni.push(o);
        return Promise.resolve();
      },
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: "Elimina questo vocale" }));
    await utente.click(bottone(ANCHE));

    await waitFor(() => {
      expect(opzioni).toEqual([{ ancheLaScheda: true }]);
    });
  });

  it("cancella il vocale su cui si e' premuto, non il primo della lista", async () => {
    // Con tre riquadri intitolati tutti «Vocale del …» l'errore non si vedrebbe
    // mai in prova a mano: sparisce comunque un vocale, e chi guarda pensa che
    // sia quello giusto. Ogni riquadro ha il proprio stato apposta.
    const cancellati: string[] = [];
    const client = creaClienteFinto({
      getProcedure: () =>
        Promise.resolve(
          unaScheda({
            recordings: [
              unVocale({ id: "reg-1" }),
              unVocale({ id: "reg-2" }),
              unVocale({ id: "reg-3" }),
            ],
          }),
        ),
      deleteRecording: (id) => {
        cancellati.push(id);
        return Promise.resolve();
      },
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    const aperture = await screen.findAllByRole("button", { name: "Elimina questo vocale" });
    expect(aperture).toHaveLength(3);

    // Il secondo. Se lo stato della conferma fosse uno solo per tutta la
    // sezione, questo click aprirebbe tre conferme insieme e la riga dopo
    // troverebbe tre pulsanti «Solo il vocale».
    await utente.click(aperture[1]!);
    await utente.click(bottone(SOLO));

    await waitFor(() => {
      expect(cancellati).toEqual(["reg-2"]);
    });
  });

  it("dopo la cancellazione ricarica la scheda invece di credersi aggiornata", async () => {
    // Nessuna rimozione ottimistica, per la stessa ragione della lista delle
    // sospese: se la richiesta e' andata a buon fine la scheda intorno puo'
    // essere cambiata — con `ancheLaScheda` e' passata in archivio — e l'unico
    // modo di non raccontarne una versione inventata e' richiederla.
    let letture = 0;
    const client = creaClienteFinto({
      getProcedure: () => {
        letture += 1;
        return Promise.resolve(unaScheda({ recordings: [unVocale()] }));
      },
      deleteRecording: () => Promise.resolve(),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: "Elimina questo vocale" }));
    expect(letture).toBe(1);

    await utente.click(bottone(ANCHE));

    await waitFor(() => {
      expect(letture).toBe(2);
    });
  });

  it("un rifiuto lascia la scheda intera e richiude la conferma", async () => {
    // Il 409 «e' in elaborazione» e' l'errore probabile qui, ed e' temporaneo.
    // Due cose devono restare vere: che il vocale sia ancora li' — se sparisse
    // dalla pagina, l'utente crederebbe di averlo cancellato — e che sotto il
    // messaggio non restino due pulsanti rossi che invitano a ripremere subito
    // quello che ha appena fallito.
    const client = creaClienteFinto({
      getProcedure: () => Promise.resolve(unaScheda({ recordings: [unVocale()] })),
      deleteRecording: () =>
        Promise.reject(
          new ApiError({
            status: 409,
            code: "CONFLICT",
            message: "Registrazione in elaborazione: riprova quando ha finito",
          }),
        ),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: "Elimina questo vocale" }));
    await utente.click(bottone(ANCHE));

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toContain("riprova quando ha finito");
    expect(screen.queryByRole("button", { name: ANCHE })).toBeNull();
    expect(bottone("Elimina questo vocale")).toBeDefined();
    // La trascrizione e' ancora dov'era: nessuna sparizione ottimistica.
    expect(screen.getByText(/ho chiesto il casellario/)).toBeDefined();
  });

  it("annullare non manda niente e riporta la conferma dov'era", async () => {
    const chiamate: string[] = [];
    const client = creaClienteFinto({
      getProcedure: () => Promise.resolve(unaScheda({ recordings: [unVocale()] })),
      deleteRecording: (id) => {
        chiamate.push(id);
        return Promise.resolve();
      },
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: "Elimina questo vocale" }));
    await utente.click(bottone("Annulla"));

    expect(chiamate).toEqual([]);
    expect(screen.queryByRole("button", { name: SOLO })).toBeNull();
    expect(bottone("Elimina questo vocale")).toBeDefined();
  });

  it("una scheda senza vocali non mostra niente da eliminare", async () => {
    // Le schede nate da una modifica a mano, o quelle il cui unico vocale e'
    // gia' stato cancellato. Una sezione «Da cosa nasce» vuota con dentro un
    // pulsante rosso sarebbe un'offerta di cancellare il nulla.
    const client = creaClienteFinto({
      getProcedure: () => Promise.resolve(unaScheda({ recordings: [] })),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    await screen.findByRole("heading", { name: "Richiedere il casellario giudiziale" });
    expect(screen.queryByRole("button", { name: "Elimina questo vocale" })).toBeNull();
  });
});
