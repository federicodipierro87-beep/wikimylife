import { ApiError } from "@wikimylife/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AudioPlayer } from "../../apps/web/src/screens/AudioPlayer";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { montaConApi } from "./helpers/render";

/**
 * Il player dell'audio originale, e la sola riga che qui possa fare del male:
 * `URL.revokeObjectURL`.
 *
 * Un object URL non revocato non si vede. La schermata e' giusta, l'audio si
 * sente, non c'e' nessun avviso e nessuna richiesta di troppo: c'e' un blob di
 * qualche megabyte che resta in memoria finche' la scheda del browser non si
 * chiude. Su un telefono bastano dieci schede aperte una dopo l'altra perche'
 * l'app venga uccisa dal sistema, e cio' che l'utente racconta e' «si chiude da
 * sola», che non assomiglia a nessuna riga di codice.
 *
 * Lo sbaglio opposto e' altrettanto silenzioso in prova e piu' evidente in uso:
 * revocare troppo presto — subito dopo `createObjectURL`, per esempio — lascia
 * un `<audio>` in pagina con un `src` che non punta piu' a niente. Percio' i
 * casi non contano soltanto le revoche: guardano quando avvengono.
 *
 * ## Le due funzioni che jsdom non ha
 *
 * `URL.createObjectURL` e `URL.revokeObjectURL` non esistono in jsdom, che non
 * ha un motore di blob. Vanno messe a mano, e tanto vale che siano quelle che
 * il test vuole: restituiscono URL riconoscibili e tengono l'elenco di cio' che
 * hanno creato e revocato. E' l'unico modo di verificare che l'URL revocato sia
 * *quello* creato e non un altro — un `revokeObjectURL(qualcosa)` chiamato il
 * numero giusto di volte sull'oggetto sbagliato passerebbe qualunque conteggio.
 *
 * Si mettono una volta per file e non a ogni caso, e non e' pigrizia: lo
 * smontaggio automatico di Testing Library (`afterEach(cleanup)` in `setup.ts`)
 * avviene *dopo* gli `afterEach` di questo file, ed e' precisamente il momento
 * in cui il componente revoca. Rimettendo qui le funzioni di jsdom — che non
 * esistono — il caso che finisce con il player ancora in pagina morirebbe
 * durante le pulizie, con un errore che non parla di niente che il test dica.
 * Gli elenchi si svuotano a ogni caso: sono loro l'oggetto delle verifiche, le
 * funzioni no.
 */

const CREA_ORIGINALE = URL.createObjectURL;
const REVOCA_ORIGINALE = URL.revokeObjectURL;

let creati: string[] = [];
let revocati: string[] = [];

beforeAll(() => {
  URL.createObjectURL = (): string => {
    const url = `blob:finto/${String(creati.length + 1)}`;
    creati.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string): void => {
    revocati.push(url);
  };
});

afterAll(() => {
  URL.createObjectURL = CREA_ORIGINALE;
  URL.revokeObjectURL = REVOCA_ORIGINALE;
});

beforeEach(() => {
  creati = [];
  revocati = [];
});

function unBlobAudio(): Blob {
  return new Blob(["finti byte"], { type: "audio/webm" });
}

const ASCOLTA = "▶ Ascolta l'originale";

describe("AudioPlayer: quando scarica", () => {
  it("aprire la scheda non scarica niente finche' non lo si chiede", async () => {
    let scaricati = 0;
    const client = creaClienteFinto({
      getRecordingAudio: () => {
        scaricati += 1;
        return Promise.resolve(unBlobAudio());
      },
    });

    montaConApi(client, <AudioPlayer recordingId="reg-1" />);

    // La §3 dice che l'audio dev'essere sempre accessibile, non sempre
    // scaricato: aprire una scheda sotto rete mobile non deve costare tre
    // megabyte che nessuno ascoltera'.
    expect(scaricati).toBe(0);
    expect(screen.getByRole("button", { name: ASCOLTA }).hasAttribute("disabled")).toBe(false);
  });

  it("mentre scarica il pulsante e' spento, e non si scarica due volte", async () => {
    let scaricati = 0;
    let consegna: (b: Blob) => void = () => undefined;
    const client = creaClienteFinto({
      getRecordingAudio: () => {
        scaricati += 1;
        return new Promise<Blob>((risolvi) => {
          consegna = risolvi;
        });
      },
    });

    const { container } = montaConApi(client, <AudioPlayer recordingId="reg-1" />);
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: ASCOLTA }));

    // Un secondo tocco su un download lento — che e' esattamente quando si
    // ripreme — scaricherebbe di nuovo gli stessi megabyte, e il primo blob
    // resterebbe in memoria senza che nessuno abbia mai piu' il suo URL per
    // revocarlo.
    const pulsante = screen.getByRole("button", { name: "Scarico…" });
    expect(pulsante.hasAttribute("disabled")).toBe(true);
    await utente.click(pulsante);
    expect(scaricati).toBe(1);

    consegna(unBlobAudio());
    await waitFor(() => {
      expect(container.querySelector("audio")).not.toBeNull();
    });
  });

  it("un errore lascia il pulsante e non mette in pagina un player muto", async () => {
    const client = creaClienteFinto({
      getRecordingAudio: () =>
        Promise.reject(
          new ApiError({ code: "NOT_FOUND", message: "L'audio non c'e' piu'.", status: 404 }),
        ),
    });

    const { container } = montaConApi(client, <AudioPlayer recordingId="reg-1" />);
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: ASCOLTA }));

    expect((await screen.findByRole("alert")).textContent).toBe("L'audio non c'e' piu'.");
    // Nessun `<audio src="">`: un player disegnato su un download fallito e'
    // un comando che non fa niente quando lo si preme, e non spiega perche'.
    expect(container.querySelector("audio")).toBeNull();
    // E il pulsante resta, perche' un 404 di adesso puo' essere una rete che
    // torna fra un minuto.
    expect(screen.getByRole("button", { name: ASCOLTA }).hasAttribute("disabled")).toBe(false);
  });
});

describe("AudioPlayer: quando libera la memoria", () => {
  it("revoca l'object URL quando il player sparisce, e non un momento prima", async () => {
    const client = creaClienteFinto({
      getRecordingAudio: () => Promise.resolve(unBlobAudio()),
    });

    const { container, unmount } = montaConApi(client, <AudioPlayer recordingId="reg-1" />);
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: ASCOLTA }));
    await waitFor(() => {
      expect(container.querySelector("audio")).not.toBeNull();
    });

    expect(creati.length).toBe(1);
    // Finche' l'audio e' in pagina l'URL serve. Revocarlo qui — per esempio
    // subito dopo averlo creato — lascerebbe un player che non suona, e
    // sarebbe l'unico dei due sbagli a vedersi in una prova a mano.
    expect(revocati).toEqual([]);
    expect(container.querySelector("audio")?.getAttribute("src")).toBe(creati[0]);

    unmount();

    // Quello creato, non «uno». Revocare l'URL sbagliato soddisfa qualunque
    // conteggio e non libera niente.
    expect(revocati).toEqual(creati);
  });

  it("cambiare registrazione revoca il vecchio audio e torna al pulsante", async () => {
    const client = creaClienteFinto({
      getRecordingAudio: () => Promise.resolve(unBlobAudio()),
    });

    const { container, rerender } = montaConApi(client, <AudioPlayer recordingId="reg-1" />);
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: ASCOLTA }));
    await waitFor(() => {
      expect(container.querySelector("audio")).not.toBeNull();
    });
    const primo = creati[0];

    rerender(<AudioPlayer recordingId="reg-2" />);

    await waitFor(() => {
      // Il vocale di prima non deve restare appeso sotto la scheda nuova: e' la
      // registrazione sbagliata, e chi la ascolta non ha modo di accorgersene.
      expect(screen.getByRole("button", { name: ASCOLTA })).toBeTruthy();
    });
    expect(container.querySelector("audio")).toBeNull();
    expect(revocati).toEqual([primo]);
    // E il nuovo non parte da solo: vale la stessa regola di quando si apre la
    // scheda, ed e' l'utente a decidere se spendere i megabyte.
    expect(creati.length).toBe(1);
  });
});
