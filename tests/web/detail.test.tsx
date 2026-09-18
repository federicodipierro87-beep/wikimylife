import {
  ApiError,
  PROCEDURE_TAG_MAX,
  type ApiClient,
  type CreateExecutionBodyInput,
  type UpdateProcedureBodyInput,
} from "@wikimylife/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { toHash } from "../../apps/web/src/routes";
import { DetailScreen } from "../../apps/web/src/screens/DetailScreen";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unVocale, unaScheda } from "./helpers/dati";
import { montaConApi } from "./helpers/render";

/**
 * La schermata piu' lunga dell'app, provata dove la lunghezza non c'entra.
 *
 * Cinquecento righe di JSX non meritano cinquecento righe di test: quasi tutto
 * quello che c'e' dentro e' un campo stampato accanto al suo titolo, e se
 * sparisse si vedrebbe aprendo la pagina. I casi qui sotto stanno sui quattro
 * punti in cui la schermata *decide* qualcosa, e in cui una decisione sbagliata
 * produce una pagina che sembra a posto:
 *
 *   la voce che si butta       una `DELETE` che non si annulla, dietro due
 *                              pulsanti a due centimetri l'uno dall'altro.
 *   i tre esiti della §8       tre pulsanti quasi uguali che scrivono tre cose
 *                              diverse nella storia della scheda.
 *   le porte verso altrove     redazione e revisione: due schermate che da qui
 *                              in poi non hanno nessun altro ingresso.
 *   cio' che esce dall'app     gli indirizzi dei riferimenti, che arrivano da un
 *                              modello che ha ascoltato un audio.
 *
 * L'ordine delle sezioni e le formattazioni non si provano qui: sono funzioni
 * pure in `format.ts` e hanno gia' il loro file. Di quelle, qui resta l'unica
 * cosa che una funzione pura non puo' dimostrare — che sia questa schermata a
 * chiamarle, invece di aver ricopiato l'ordine nel JSX.
 */

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

/**
 * Il finto di questo file: `creaClienteFinto` piu' le categorie che esistono.
 *
 * Il riquadro delle categorie chiede `listTags` al montaggio, quindi da quando
 * esiste *ogni* caso di questo file passa di li' — anche i dodici che di
 * categorie non parlano. Senza questo valore predefinito il finto lancerebbe, e
 * quei dodici cadrebbero tutti insieme dicendo una cosa che non e' il loro
 * argomento.
 *
 * E' vuoto e non plausibile: un elenco di suggerimenti finto farebbe passare
 * per verdi i casi che verificano *quali* categorie vengono suggerite. Quelli
 * se lo dichiarano.
 */
function cliente(risposte: Partial<ApiClient> = {}): ApiClient {
  return creaClienteFinto({ listTags: () => Promise.resolve({ items: [] }), ...risposte });
}

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
    const client = cliente({
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
    const client = cliente({
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
    const client = cliente({
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
    const client = cliente({
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
    const client = cliente({
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
    const client = cliente({
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
    const client = cliente({
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
    const client = cliente({
      getProcedure: () => Promise.resolve(unaScheda({ recordings: [] })),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    await screen.findByRole("heading", { name: "Richiedere il casellario giudiziale" });
    expect(screen.queryByRole("button", { name: "Elimina questo vocale" })).toBeNull();
  });
});

/**
 * I tre pulsanti della §8, che scrivono nella storia della scheda.
 *
 * Sono tre rettangoli affiancati con tre frasi corte, e mandano tre valori di
 * un enum. Nessuna delle differenze che contano si vede sullo schermo: dopo
 * ognuno dei tre la pagina si ricarica e torna uguale a prima, tranne un
 * contatore e — per `CAMBIATA` — uno stato che riporta la scheda in
 * `DA_RIVEDERE`. Un pulsante che manda l'esito del vicino produce quindi una
 * schermata perfettamente funzionante che archivia il contrario di cio' che e'
 * successo, e lo scopre solo chi rilegge la scheda mesi dopo.
 *
 * `nota` e' l'altro punto: lo schema del server la accetta anche vuota
 * (`.nullable().default(null)`), quindi una stringa vuota non viene rifiutata —
 * viene salvata. La differenza fra «non ha lasciato una nota» e «ha lasciato una
 * nota vuota» non da' nessun errore da nessuna parte, e resta scritta.
 */

const OK = "Ha funzionato";
const CAMBIATA = "E' cambiata";
const FALLITA = "Non ha funzionato";

/**
 * Un client che registra cosa e' stato mandato e quante volte si e' riletto.
 *
 * Le letture si contano perche' la ricarica *e'* la proprieta': la schermata
 * butta via la scheda che `recordExecution` le restituisce e richiede tutto,
 * cosi' non puo' esistere una versione della pagina che il server non abbia
 * confermato. Senza il conteggio, un `onFatto()` dimenticato passerebbe ogni
 * altro caso di questo blocco.
 */
function conEsiti(esito: () => Promise<void> = () => Promise.resolve()): {
  client: ApiClient;
  inviati: CreateExecutionBodyInput[];
  letture: () => number;
} {
  const inviati: CreateExecutionBodyInput[] = [];
  let letture = 0;
  const client = cliente({
    getProcedure: () => {
      letture += 1;
      return Promise.resolve(unaScheda());
    },
    recordExecution: async (_id, body) => {
      inviati.push(body);
      await esito();
      return unaScheda();
    },
  });
  return { client, inviati, letture: () => letture };
}

describe("DetailScreen — i tre esiti della §8", () => {
  it("il primo tocco apre la nota e non registra niente", async () => {
    // Sono tre bersagli grandi, pensati per essere premuti in piedi davanti a
    // uno sportello: e' esattamente la situazione in cui si tocca quello
    // sbagliato. Finche' non si preme «Salva» non deve essere partito niente.
    const { client, inviati } = conEsiti();

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: OK }));

    expect(inviati).toEqual([]);
    expect(bottone("Salva")).toBeDefined();
  });

  it("ognuno dei tre manda il proprio esito, e non quello del vicino", async () => {
    const { client, inviati } = conEsiti();

    montaConApi(client, <DetailScreen id="proc-1" />);
    const utente = userEvent.setup();

    for (const etichetta of [OK, CAMBIATA, FALLITA]) {
      await utente.click(await screen.findByRole("button", { name: etichetta }));
      await utente.click(bottone("Salva"));
      // La ricarica rimonta la scheda: si aspetta che sia tornata prima di
      // premere il successivo, o il click cadrebbe su un albero smontato.
      await screen.findByRole("button", { name: etichetta });
    }

    expect(inviati.map((b) => b.esito)).toEqual(["FUNZIONATO", "CAMBIATA", "FALLITA"]);
  });

  it("ripremere lo stesso pulsante richiude, invece di registrarlo due volte", async () => {
    const { client, inviati } = conEsiti();

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: CAMBIATA }));
    await utente.click(bottone(CAMBIATA));

    expect(inviati).toEqual([]);
    expect(screen.queryByRole("button", { name: "Salva" })).toBeNull();
  });

  it("la domanda cambia con l'esito, perche' e' l'unico momento in cui si sa cos'e' andato storto", async () => {
    // «Vuoi aggiungere qualcosa?» sotto «Non ha funzionato» e' una domanda
    // generica fatta all'unica persona che sa la risposta specifica, nell'unico
    // istante in cui ce l'ha in mente. Chi legge quella scheda fra un anno e'
    // la stessa persona, e non se la ricordera'.
    const { client } = conEsiti();

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: OK }));
    expect(screen.getByText(/Vuoi aggiungere qualcosa/)).toBeDefined();

    await utente.click(bottone(OK));
    await utente.click(bottone(FALLITA));
    expect(screen.getByText(/Cos'e' cambiato/)).toBeDefined();
    expect(screen.queryByText(/Vuoi aggiungere qualcosa/)).toBeNull();
  });

  it("una nota lasciata in bianco parte come niente, e non come una nota vuota", async () => {
    // Il campo e' facoltativo e quasi sempre resta vuoto: e' il caso normale,
    // non il caso limite. Una stringa vuota qui non da' errore — il server la
    // accetta — e finisce salvata come una nota che esiste e non dice niente.
    const { client, inviati } = conEsiti();

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: OK }));
    await utente.type(screen.getByRole("textbox"), "   ");
    await utente.click(bottone("Salva"));

    await waitFor(() => {
      expect(inviati).toEqual([{ esito: "FUNZIONATO", nota: null }]);
    });
  });

  it("la nota arriva senza gli spazi ai bordi", async () => {
    const { client, inviati } = conEsiti();

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: FALLITA }));
    await utente.type(screen.getByRole("textbox"), "  l'ufficio chiude alle 11  ");
    await utente.click(bottone("Salva"));

    await waitFor(() => {
      expect(inviati).toEqual([{ esito: "FALLITA", nota: "l'ufficio chiude alle 11" }]);
    });
  });

  it("dopo il salvataggio rilegge la scheda invece di raccontare da se' com'e' andata", async () => {
    // `CAMBIATA` non incrementa un contatore: riporta la scheda in
    // `DA_RIVEDERE`, cioe' fa comparire in cima un avviso e un pulsante che
    // prima non c'erano. E' il server a deciderlo, e l'unico modo che questa
    // schermata ha di non inventarsi il risultato e' richiederlo.
    const { client, letture } = conEsiti();

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: CAMBIATA }));
    expect(letture()).toBe(1);

    await utente.click(bottone("Salva"));

    await waitFor(() => {
      expect(letture()).toBe(2);
    });
  });

  it("un rifiuto non si legge come un salvataggio, e la nota resta dov'era", async () => {
    // Chi ha appena scritto tre righe su cosa e' andato storto le ha scritte
    // una volta sola. Svuotare il campo su un errore vorrebbe dire chiedergli
    // di riscriverle, e il piu' delle volte vuol dire perderle.
    const { client, inviati, letture } = conEsiti(() =>
      Promise.reject(
        new ApiError({ status: 500, code: "INTERNAL_ERROR", message: "Il server non risponde." }),
      ),
    );

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: FALLITA }));
    await utente.type(screen.getByRole("textbox"), "hanno chiesto un altro modulo");
    await utente.click(bottone("Salva"));

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toBe("Il server non risponde.");
    expect(inviati).toHaveLength(1);
    // Nessuna ricarica: la scheda non e' cambiata, e una ricarica qui
    // cancellerebbe la nota insieme al resto.
    expect(letture()).toBe(1);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "hanno chiesto un altro modulo",
    );
  });

  it("mentre salva non si puo' salvare di nuovo", async () => {
    // Due esecuzioni identiche a un secondo di distanza non danno nessun
    // errore: sono due righe legittime, e la scheda dira' «fatta 2 volte» a chi
    // l'ha fatta una. Il pulsante spento e' l'unica cosa che lo impedisce.
    let sblocca: () => void = () => undefined;
    const { client, inviati } = conEsiti(
      () =>
        new Promise<void>((resolve) => {
          sblocca = resolve;
        }),
    );

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.click(await screen.findByRole("button", { name: OK }));
    await utente.click(bottone("Salva"));

    // L'etichetta cambia mentre e' in volo, e cambia perche' e' l'unico segno
    // che qualcosa stia succedendo: un pulsante spento e muto si legge come un
    // pulsante rotto, e chi lo legge cosi' cerca un altro modo di premerlo.
    expect(bottone("Salvo…").disabled).toBe(true);
    // Anche i tre esiti: cambiare esito a richiesta in volo manderebbe il
    // secondo su una nota che nel frattempo e' stata svuotata.
    expect(bottone(FALLITA).disabled).toBe(true);

    sblocca();
    await waitFor(() => {
      expect(inviati).toHaveLength(1);
    });
  });
});

describe("DetailScreen — l'ordine di lettura, e le porte verso altrove", () => {
  it("le sezioni arrivano in pagina nell'ordine della §4, non in quello del JSX", async () => {
    // `sezioniDi` ha gia' i suoi casi in `format.test.ts`, e provano l'ordine
    // come proprieta' di una funzione pura. Quello che nessuna funzione pura
    // puo' dire e' se sia questa schermata a chiamarla: un JSX che elencasse le
    // cinque sezioni a mano — che e' come si scrive di solito — passerebbe tutti
    // quei casi mostrando i passi per primi.
    const client = cliente({
      getProcedure: () =>
        Promise.resolve(
          unaScheda({
            prereqs: [
              { id: "pr1", descrizione: "Carta d'identita'", tipo: "DOCUMENTO", obbligatorio: true },
            ],
            pitfalls: [{ id: "t1", descrizione: "Chiude alle 11", gravita: "BLOCCANTE" }],
            costs: [{ id: "c1", descrizione: "Marca da bollo", importoCent: 1600, valuta: "EUR" }],
            refs: [{ id: "r1", tipo: "UFFICIO", valore: "Procura, sportello 3" }],
          }),
        ),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);
    await screen.findByRole("heading", { name: "Richiedere il casellario giudiziale" });

    const titoli = ["Cosa serve prima", "Attenzione a", "Come si fa", "Quanto costa", "Riferimenti"];
    const inPagina = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent ?? "")
      .filter((t) => titoli.includes(t));

    expect(inPagina).toEqual(titoli);
  });

  it("una scheda da rivedere offre di completarla, e ci porta davvero", async () => {
    // La revisione non ha nessun altro ingresso: non c'e' nella barra bassa,
    // non c'e' nell'elenco. Se questo pulsante navigasse altrove, l'unico modo
    // di sistemare una scheda con i buchi sarebbe scrivere l'hash a mano.
    const client = cliente({
      getProcedure: () => Promise.resolve(unaScheda({ status: "DA_RIVEDERE" })),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);
    const bott = await screen.findByRole("button", { name: /completala/ });

    window.location.hash = "";
    const utente = userEvent.setup();
    await utente.click(bott);

    expect(window.location.hash).toBe(toHash({ name: "revisione", id: "proc-1" }));
  });

  it("una scheda completa non invita a completarla", async () => {
    const client = cliente({
      getProcedure: () => Promise.resolve(unaScheda({ status: "COMPLETA" })),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    await screen.findByRole("heading", { name: "Richiedere il casellario giudiziale" });
    expect(screen.queryByRole("button", { name: /completala/ })).toBeNull();
  });

  it("col bollino acceso, l'avviso porta a vedere cosa c'e' dentro", async () => {
    const client = cliente({
      getProcedure: () => Promise.resolve(unaScheda({ contieneDatiSensibili: true })),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);
    const bott = await screen.findByRole("button", { name: /Guarda cosa c'e' dentro/ });

    window.location.hash = "";
    const utente = userEvent.setup();
    await utente.click(bott);

    expect(window.location.hash).toBe(toHash({ name: "redazione", id: "proc-1" }));
  });

  it("col bollino spento la redazione si raggiunge lo stesso, che e' il punto", async () => {
    // Il flag dice cosa ha pensato l'estrazione, non cosa c'e' nel testo: una
    // scheda corretta a mano dopo l'estrazione non ci ripassa mai, e il nome di
    // una persona aggiunto a mano non accende nessun bollino. Un pulsante
    // annidato dentro il ramo del flag toglierebbe la §9 esattamente alle
    // schede su cui nessuno l'ha ancora fatta girare — e la pagina, guardata,
    // sarebbe identica.
    const client = cliente({
      getProcedure: () => Promise.resolve(unaScheda({ contieneDatiSensibili: false })),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);
    const bott = await screen.findByRole("button", { name: /Controlla i dati personali/ });
    // E l'avviso no: sarebbe un allarme su una scheda che nessuno ha segnalato.
    expect(screen.queryByText(/sono venuti fuori dei dati personali/)).toBeNull();

    window.location.hash = "";
    const utente = userEvent.setup();
    await utente.click(bott);

    expect(window.location.hash).toBe(toHash({ name: "redazione", id: "proc-1" }));
  });

  it("l'avviso di obsolescenza dice da quando, e quando non lo sa lo dice lo stesso", async () => {
    // `ultimaVerifica` e' `null` su tutte le schede mai confermate, cioe' su
    // quasi tutte. `formatQuando(null)` risponde `null`, e un `null` stampato
    // in un paragrafo diventa «Verificata l'ultima volta . Le cose potrebbero
    // essere cambiate» — una frase rotta nel punto in cui l'app sta chiedendo
    // di non fidarsi di cio' che c'e' scritto sotto.
    const client = cliente({
      getProcedure: () => Promise.resolve(unaScheda({ obsoleta: true, ultimaVerifica: null })),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    const avviso = await screen.findByText(/Le cose potrebbero essere cambiate/);
    expect(avviso.textContent).toContain("molto tempo fa");
  });

  it("una scheda verificata di recente non mette in dubbio se stessa", async () => {
    const client = cliente({
      getProcedure: () => Promise.resolve(unaScheda({ obsoleta: false })),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    await screen.findByRole("heading", { name: "Richiedere il casellario giudiziale" });
    expect(screen.queryByText(/Le cose potrebbero essere cambiate/)).toBeNull();
  });
});

describe("DetailScreen — cio' che porta fuori dall'app", () => {
  it("un indirizzo si apre altrove senza portarsi dietro questa pagina", async () => {
    // I riferimenti li ha scritti un modello leggendo un audio: sono la stringa
    // meno fidata che questa schermata stampi, e l'unica che diventa cliccabile.
    // Senza `noopener` la pagina che si apre puo' riscrivere
    // `window.opener.location`, cioe' cambiare sotto i piedi la scheda a cui si
    // torna indietro; senza `noreferrer` si consegna a un sito qualunque
    // l'indirizzo da cui si e' partiti. Nessuna delle due cose ha un sintomo:
    // il link funziona.
    const client = cliente({
      getProcedure: () =>
        Promise.resolve(
          unaScheda({
            refs: [{ id: "r1", tipo: "URL", valore: "https://esempio.it/casellario" }],
          }),
        ),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    const link = (await screen.findByRole("link", {
      name: "https://esempio.it/casellario",
    })) as HTMLAnchorElement;
    expect(link.getAttribute("target")).toBe("_blank");
    const rel = link.getAttribute("rel") ?? "";
    expect(rel.split(" ")).toContain("noopener");
    expect(rel.split(" ")).toContain("noreferrer");
  });

  it("un riferimento che non e' un indirizzo resta testo", async () => {
    // `tipo` lo ha scelto lo stesso modello che ha scritto `valore`. Rendere
    // cliccabile tutto vorrebbe dire mettere in un `href` la trascrizione di un
    // numero di telefono, e un `href` e' l'unico posto di questa pagina in cui
    // una stringa smette di essere testo.
    const client = cliente({
      getProcedure: () =>
        Promise.resolve(
          unaScheda({ refs: [{ id: "r1", tipo: "TELEFONO", valore: "800 123 456" }] }),
        ),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    await screen.findByText("800 123 456");
    expect(screen.queryByRole("link")).toBeNull();
  });
});

/**
 * Le categorie, dove scriverle puo' cancellarle.
 *
 * Questo riquadro e' l'unico posto dell'app da cui si scrive `tag`, e `tag` nel
 * `PATCH` e' una **sostituzione**: cio' che arriva diventa l'elenco completo.
 * Quindi il difetto che conta qui non e' «non salva» — quello si vede subito —
 * ma «salva e nel farlo butta via il resto», che ha lo stesso aspetto di un
 * successo finche' non si riguarda la scheda. E' lo stesso difetto gia' pagato
 * su `steps`, e i primi due casi qui sotto sono gli unici posti in cui si vede.
 *
 * Il corpo mandato si raccoglie in un array invece di guardare lo schermo,
 * perche' lo schermo mostra cio' che il server ha *risposto*: un finto che
 * risponde bene farebbe passare per corretta anche una richiesta che ha mandato
 * una lista di un elemento solo.
 */
function conCategorie(
  tag: readonly string[],
  opzioni: {
    esistenti?: readonly { nome: string; conteggio: number }[];
    salva?: () => Promise<void>;
  } = {},
): {
  client: ApiClient;
  inviati: UpdateProcedureBodyInput[];
  letture: () => number;
} {
  const inviati: UpdateProcedureBodyInput[] = [];
  let letture = 0;
  const client = cliente({
    getProcedure: () => {
      letture += 1;
      return Promise.resolve(unaScheda({ tag: [...tag] }));
    },
    listTags: () => Promise.resolve({ items: [...(opzioni.esistenti ?? [])] }),
    updateProcedure: async (_id, patch) => {
      inviati.push(patch);
      await (opzioni.salva?.() ?? Promise.resolve());
      return unaScheda({ tag: [...tag] });
    },
  });
  return { client, inviati, letture: () => letture };
}

function campoCategoria(): HTMLInputElement {
  return screen.getByLabelText("Aggiungi una categoria") as HTMLInputElement;
}

describe("DetailScreen — le categorie, che si scrivono sostituendo", () => {
  it("aggiungerne una manda anche tutte quelle che c'erano", async () => {
    const { client, inviati } = conCategorie(["casa", "burocrazia"]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.type(await screen.findByLabelText("Aggiungi una categoria"), "documenti");
    await utente.click(bottone("Aggiungi"));

    // Se qui arrivasse `["documenti"]` la scheda perderebbe due categorie e la
    // schermata non direbbe niente: si ricarica, e le due che mancano nessuno
    // le sta contando.
    expect(inviati).toHaveLength(1);
    expect(inviati[0]?.tag).toEqual(["casa", "burocrazia", "documenti"]);
  });

  it("toglierne una manda le rimaste, e non quella tolta", async () => {
    const { client, inviati } = conCategorie(["casa", "burocrazia", "documenti"]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Togli la categoria burocrazia" }));

    expect(inviati).toHaveLength(1);
    expect(inviati[0]?.tag).toEqual(["casa", "documenti"]);
  });

  it("la crocetta toglie quella accanto a cui sta, non la prima della fila", async () => {
    // Tre pulsanti identici a vedersi, a un centimetro l'uno dall'altro: un
    // indice sbagliato qui toglie la categoria del vicino, e chi guarda vede
    // comunque «una categoria in meno».
    const { client, inviati } = conCategorie(["casa", "burocrazia", "documenti"]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Togli la categoria documenti" }));

    expect(inviati[0]?.tag).toEqual(["casa", "burocrazia"]);
  });

  it("togliere l'ultima manda una lista vuota, invece di saltare la richiesta", async () => {
    // `tag: []` e' cio' che significa «nessuna categoria». Un riquadro che si
    // rifiutasse di mandare la lista vuota lascerebbe l'ultima categoria
    // attaccata per sempre, e sarebbe l'unica che non si puo' togliere.
    const { client, inviati } = conCategorie(["casa"]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Togli la categoria casa" }));

    expect(inviati).toHaveLength(1);
    expect(inviati[0]?.tag).toEqual([]);
  });

  it("dopo il salvataggio la scheda si rilegge dal server", async () => {
    // Il server normalizza per conto suo — ha una dedup che questo riquadro non
    // ha — quindi cio' che si vede dopo deve venire da lui e non da una copia
    // locale aggiornata a mano.
    const { client, letture } = conCategorie(["casa"]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.type(await screen.findByLabelText("Aggiungi una categoria"), "documenti");
    expect(letture()).toBe(1);
    await utente.click(bottone("Aggiungi"));

    await waitFor(() => {
      expect(letture()).toBe(2);
    });
  });

  it("se il salvataggio fallisce lo dice, e a schermo restano le categorie di prima", async () => {
    const { client, letture } = conCategorie(["casa"], {
      salva: () =>
        Promise.reject(
          new ApiError({ status: 400, code: "VALIDATION_FAILED", message: "Non va bene" }),
        ),
    });

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.type(await screen.findByLabelText("Aggiungi una categoria"), "documenti");
    await utente.click(bottone("Aggiungi"));

    expect((await screen.findByRole("alert")).textContent).toContain("Non va bene");
    // Non si e' riletto niente, quindi cio' che si vede e' ancora la scheda di
    // prima: «casa» c'e', «documenti» no. Una schermata che avesse aggiunto la
    // chip in locale prima della risposta mostrerebbe adesso una categoria che
    // il server non ha.
    expect(letture()).toBe(1);
    expect(screen.getByRole("button", { name: "Togli la categoria casa" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Togli la categoria documenti" })).toBeNull();
  });
});

describe("DetailScreen — le categorie, e cio' che il campo rifiuta", () => {
  it("col campo vuoto il pulsante e' spento", async () => {
    const { client } = conCategorie(["casa"]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    expect((await screen.findByRole("button", { name: "Aggiungi" })).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("con dei soli spazi resta spento, e con una parola si accende", async () => {
    const { client } = conCategorie(["casa"]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.type(await screen.findByLabelText("Aggiungi una categoria"), "   ");
    expect(bottone("Aggiungi").disabled).toBe(true);

    // Il verso opposto, che e' quello che rende il caso qui sopra qualcosa di
    // piu' di «il pulsante e' sempre spento».
    await utente.clear(campoCategoria());
    await utente.type(campoCategoria(), "documenti");
    expect(bottone("Aggiungi").disabled).toBe(false);
  });

  it("una categoria che la scheda ha gia' non si aggiunge una seconda volta", async () => {
    const { client } = conCategorie(["casa"]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.type(await screen.findByLabelText("Aggiungi una categoria"), "casa");

    // Il server la dedupplica comunque: la ragione per fermarla qui e' che la
    // richiesta non direbbe niente a chi l'ha premuta — la pagina si
    // ricaricherebbe identica, e sembrerebbe che il pulsante non funzioni.
    expect(bottone("Aggiungi").disabled).toBe(true);
  });

  it("gli spazi ai bordi non bastano a farne una nuova", async () => {
    const { client } = conCategorie(["casa"]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.type(await screen.findByLabelText("Aggiungi una categoria"), "  casa  ");

    // Senza il `trim` questa passerebbe, e l'archivio si riempirebbe di «casa»
    // e « casa » — due chip che a schermo sono indistinguibili.
    expect(bottone("Aggiungi").disabled).toBe(true);
  });

  it("e cio' che si manda e' la parola senza gli spazi", async () => {
    const { client, inviati } = conCategorie(["casa"]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.type(await screen.findByLabelText("Aggiungi una categoria"), "  documenti  ");
    await utente.click(bottone("Aggiungi"));

    expect(inviati[0]?.tag).toEqual(["casa", "documenti"]);
  });

  it("al tetto del contratto il pulsante e' spento, e il perche' si legge", async () => {
    // Il numero viene da `PROCEDURE_TAG_MAX`, non da un `30` scritto qui: se il
    // contratto cambiasse e la schermata no, un caso con la costante ricopiata
    // passerebbe lo stesso.
    const piene = Array.from({ length: PROCEDURE_TAG_MAX }, (_, i) => `c${String(i)}`);
    const { client } = conCategorie(piene);

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.type(await screen.findByLabelText("Aggiungi una categoria"), "unaditroppo");
    expect(bottone("Aggiungi").disabled).toBe(true);
    expect(screen.getByText(new RegExp(`${String(PROCEDURE_TAG_MAX)} categorie`))).toBeDefined();
  });

  it("a un posto dal tetto si aggiunge ancora, e nessuno avvisa di niente", async () => {
    const quasi = Array.from({ length: PROCEDURE_TAG_MAX - 1 }, (_, i) => `c${String(i)}`);
    const { client } = conCategorie(quasi);

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.type(await screen.findByLabelText("Aggiungi una categoria"), "lultima");
    expect(bottone("Aggiungi").disabled).toBe(false);
    expect(screen.queryByText(new RegExp(`${String(PROCEDURE_TAG_MAX)} categorie`))).toBeNull();
  });

  it("Invio aggiunge, perche' sul telefono e' il tasto sotto il dito", async () => {
    const { client, inviati } = conCategorie(["casa"]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.type(await screen.findByLabelText("Aggiungi una categoria"), "documenti{Enter}");

    expect(inviati[0]?.tag).toEqual(["casa", "documenti"]);
  });

  it("Invio non e' una porta di servizio: cio' che il pulsante rifiuta rifiuta anche lui", async () => {
    const { client, inviati } = conCategorie(["casa"]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.type(await screen.findByLabelText("Aggiungi una categoria"), "casa{Enter}");

    expect(inviati).toEqual([]);
  });

  it("una scheda senza categorie lo dice, invece di mostrare una fila vuota", async () => {
    const { client } = conCategorie([]);

    montaConApi(client, <DetailScreen id="proc-1" />);

    expect(await screen.findByText(/non e' in nessuna categoria/)).toBeDefined();
  });
});

describe("DetailScreen — le categorie, e cosa suggerisce il campo", () => {
  function opzioni(container: HTMLElement): string[] {
    return [...container.querySelectorAll("#categorie-esistenti option")].map(
      (o) => (o as HTMLOptionElement).value,
    );
  }

  it("suggerisce le categorie che esistono gia' nell'archivio", async () => {
    // E' l'unica difesa contro «Casa» e «casa»: il database le tiene separate,
    // e nessuno riscrive le parole dell'utente. Far scegliere invece di far
    // riscrivere e' tutto cio' che si puo' fare da qui.
    const { client } = conCategorie([], {
      esistenti: [
        { nome: "burocrazia", conteggio: 7 },
        { nome: "casa", conteggio: 3 },
      ],
    });

    const { container } = montaConApi(client, <DetailScreen id="proc-1" />);

    await screen.findByLabelText("Aggiungi una categoria");
    expect(opzioni(container)).toEqual(["burocrazia", "casa"]);
  });

  it("non suggerisce quelle che la scheda ha gia', che sono le uniche che non si possono aggiungere", async () => {
    const { client } = conCategorie(["casa"], {
      esistenti: [
        { nome: "burocrazia", conteggio: 7 },
        { nome: "casa", conteggio: 3 },
      ],
    });

    const { container } = montaConApi(client, <DetailScreen id="proc-1" />);

    await screen.findByLabelText("Aggiungi una categoria");
    expect(opzioni(container)).toEqual(["burocrazia"]);
  });

  it("il campo e' scrivibile anche quando non c'e' niente da suggerire", async () => {
    // Un archivio nuovo non ha nessuna categoria, ed e' proprio il momento in
    // cui servono di piu' le categorie nuove. Se il riquadro aspettasse una
    // lista per lasciar scrivere, la prima categoria non nascerebbe mai.
    const { client, inviati } = conCategorie([], { esistenti: [] });

    montaConApi(client, <DetailScreen id="proc-1" />);

    const utente = userEvent.setup();
    await utente.type(await screen.findByLabelText("Aggiungi una categoria"), "laprima");
    await utente.click(bottone("Aggiungi"));

    expect(inviati[0]?.tag).toEqual(["laprima"]);
  });
});
