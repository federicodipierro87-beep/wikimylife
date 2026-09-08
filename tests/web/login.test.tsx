import type { ApiClient, AuthSession } from "@wikimylife/shared";
import { ApiError } from "@wikimylife/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LoginScreen } from "../../apps/web/src/screens/LoginScreen";
import { SessionProvider } from "../../apps/web/src/session";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unaSessione } from "./helpers/dati";
import { montaConApi } from "./helpers/render";

/**
 * La porta d'ingresso: due campi, e tre modi di rendere l'app inutilizzabile.
 *
 * Il primo e' non dire perche' non si entra. `login` fallisce, `messaggioDi`
 * traduce, e se quella traduzione non arriva in pagina resta un pulsante che
 * non fa niente — indistinguibile da un guasto della rete. E' l'unico posto
 * dell'applicazione dove l'errore non e' un dettaglio: e' l'intera risposta.
 *
 * Il secondo e' `autoComplete`. Sbagliarlo non produce nessun sintomo visibile
 * durante lo sviluppo, e produce un utente che si e' iscritto con una password
 * che il suo gestore non ha mai salvato — cioe' un account perso. Un attributo
 * di venti caratteri che nessuna revisione guarda: e' esattamente il genere di
 * cosa che un test deve tenere ferma.
 *
 * Il terzo e' il doppio invio. Il pulsante resta acceso mentre la richiesta e'
 * in volo, chi non vede reazione preme di nuovo, e partono due iscrizioni.
 *
 * Questa e' l'unica schermata di questa cartella che monta `SessionProvider`,
 * perche' qui la sessione e' l'oggetto del test e non lo sfondo. Da cui il
 * `restoreSession` insegnato al finto: lo chiama il provider al montaggio, non
 * la schermata.
 */

function montaLogin(client: ApiClient): void {
  montaConApi(
    client,
    <SessionProvider>
      <LoginScreen />
    </SessionProvider>,
  );
}

function campo(nome: string): HTMLInputElement {
  return screen.getByLabelText(nome) as HTMLInputElement;
}

describe("LoginScreen", () => {
  it("mostra il messaggio del server quando le credenziali non vanno", async () => {
    const client = creaClienteFinto({
      restoreSession: () => Promise.resolve(null),
      login: () =>
        Promise.reject(
          new ApiError({
            code: "INVALID_CREDENTIALS",
            message: "Email o password non corretti.",
            status: 401,
          }),
        ),
    });

    montaLogin(client);

    const utente = userEvent.setup();
    await utente.type(campo("Email"), "mario@example.com");
    await utente.type(campo("Password"), "sbagliata");
    await utente.click(screen.getByRole("button", { name: "Entra" }));

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toContain("Email o password non corretti.");
  });

  it("dice che manca la rete invece di ripetere «Failed to fetch»", async () => {
    const client = creaClienteFinto({
      restoreSession: () => Promise.resolve(null),
      // E' cosi' che `fetch` fallisce quando il telefono e' offline, ed e' il
      // caso piu' frequente dei due: la frase inglese del browser in mezzo a
      // una schermata italiana e' un guasto travestito da messaggio.
      login: () => Promise.reject(new Error("Failed to fetch")),
    });

    montaLogin(client);

    const utente = userEvent.setup();
    await utente.type(campo("Email"), "mario@example.com");
    await utente.type(campo("Password"), "qualunque");
    await utente.click(screen.getByRole("button", { name: "Entra" }));

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toContain("Nessuna connessione");
    expect(avviso.textContent).not.toContain("Failed to fetch");
  });

  it("dice al gestore di password se sta compilando o salvando", async () => {
    const client = creaClienteFinto({ restoreSession: () => Promise.resolve(null) });

    montaLogin(client);

    expect(campo("Email").getAttribute("autocomplete")).toBe("email");
    expect(campo("Password").getAttribute("autocomplete")).toBe("current-password");

    const utente = userEvent.setup();
    await utente.click(screen.getByRole("button", { name: "Non ho un account" }));

    // Non e' un dettaglio estetico: con `current-password` il gestore propone
    // una password vecchia e non salva quella nuova.
    expect(campo("Password").getAttribute("autocomplete")).toBe("new-password");

    await utente.click(screen.getByRole("button", { name: "Ho gia' un account" }));
    expect(campo("Password").getAttribute("autocomplete")).toBe("current-password");
  });

  it("passando da entrata a iscrizione l'errore di prima sparisce", async () => {
    const client = creaClienteFinto({
      restoreSession: () => Promise.resolve(null),
      login: () =>
        Promise.reject(
          new ApiError({ code: "INVALID_CREDENTIALS", message: "Non ci sei.", status: 401 }),
        ),
    });

    montaLogin(client);

    const utente = userEvent.setup();
    await utente.type(campo("Email"), "mario@example.com");
    await utente.type(campo("Password"), "sbagliata");
    await utente.click(screen.getByRole("button", { name: "Entra" }));
    await screen.findByRole("alert");

    // «Non ci sei» sotto un modulo che adesso dice «Crea l'account» sarebbe una
    // frase riferita a una domanda che non e' piu' quella.
    await utente.click(screen.getByRole("button", { name: "Non ho un account" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("mentre la richiesta e' in volo il pulsante non si puo' premere di nuovo", async () => {
    let chiamate = 0;
    let rispondi: (session: AuthSession) => void = () => undefined;
    const client = creaClienteFinto({
      restoreSession: () => Promise.resolve(null),
      login: () => {
        chiamate += 1;
        return new Promise<AuthSession>((resolve) => {
          rispondi = resolve;
        });
      },
    });

    montaLogin(client);

    const utente = userEvent.setup();
    await utente.type(campo("Email"), "mario@example.com");
    await utente.type(campo("Password"), "giusta");
    await utente.click(screen.getByRole("button", { name: "Entra" }));

    const inVolo = await screen.findByRole("button", { name: "Un attimo…" });
    expect((inVolo as HTMLButtonElement).disabled).toBe(true);

    // Il secondo tocco di chi non vede reazione: due iscrizioni, o due
    // tentativi contati dal limitatore per un utente che ne ha fatto uno.
    await utente.click(inVolo);
    expect(chiamate).toBe(1);

    rispondi(unaSessione());
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Un attimo…" })).toBeNull();
    });
  });

  it("iscrivendosi manda la lingua del dispositivo, senza chiederla", async () => {
    const locali: (string | undefined)[] = [];
    const client = creaClienteFinto({
      restoreSession: () => Promise.resolve(null),
      signup: (input) => {
        locali.push(input.locale);
        return Promise.resolve(unaSessione());
      },
    });

    montaLogin(client);

    const utente = userEvent.setup();
    await utente.click(screen.getByRole("button", { name: "Non ho un account" }));
    await utente.type(campo("Email"), "mario@example.com");
    await utente.type(campo("Password"), "una-password-lunga");
    await utente.click(screen.getByRole("button", { name: "Crea l'account" }));

    // E' la lingua che lo stadio 2 passera' a Whisper. Un menu a tendina qui
    // avrebbe chiesto a chi si registra di scegliere un dettaglio tecnico.
    await waitFor(() => {
      expect(locali).toEqual([navigator.language]);
    });
  });
});
