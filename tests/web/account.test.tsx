import type { ApiClient, AuthSession, ChangePasswordRequest } from "@wikimylife/shared";
import { ApiError, PASSWORD_MIN_LENGTH } from "@wikimylife/shared";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AccountScreen } from "../../apps/web/src/screens/AccountScreen";
import { SessionProvider } from "../../apps/web/src/session";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unaSessione } from "./helpers/dati";
import { montaConApi } from "./helpers/render";

/**
 * La schermata dove si sbaglia una volta sola.
 *
 * Ogni altra schermata di questa applicazione ha un rimedio: si ricarica, si
 * riprova, si preme «Riprova adesso». Qui no. Non c'e' recupero password in
 * nessuna parte del prodotto — nessuna rotta, nessuna mail, niente — quindi una
 * password nuova digitata male e confermata male non chiude fuori per un
 * minuto: chiude fuori e basta. Sono i casi qui sotto, e tutti guardano la
 * stessa cosa da angoli diversi:
 *
 *   i tre `autoComplete`      sbagliarli non produce nessun sintomo mentre si
 *                             sviluppa, e produce un gestore di password che
 *                             dopo il cambio ha ancora quella vecchia. E' il
 *                             modo piu' silenzioso di perdere un account.
 *   attuale e nuova al posto  scambiarle nel corpo non si vede provando la
 *   giusto                    schermata a mano, se si digita due volte la
 *                             stessa stringa per fare in fretta.
 *   la ripetizione blocca     e' l'unica difesa che esista contro il refuso, e
 *                             deve fermare la richiesta, non accompagnarla.
 *   i campi si svuotano dopo  `attuale` contiene una password che non vale
 *                             piu': un secondo invio partirebbe con quella.
 *   un rifiuto non svuota     dopo un «password attuale sbagliata», cancellare
 *                             i campi costringerebbe a ridigitare anche la
 *                             password nuova, che era giusta.
 *   il doppio tocco           due cambi di fila: il secondo arriva con una
 *                             `currentPassword` gia' morta e risponde
 *                             «sbagliata» sotto un «cambiata».
 *
 * `SessionProvider` c'e' perche' questa schermata legge chi sia l'utente e
 * chiama `logout`: da cui il `restoreSession` insegnato a ogni finto, che lo
 * chiama il provider al montaggio e non la schermata.
 */

/**
 * Monta, e lascia finire la lettura della sessione prima di restituire.
 *
 * `SessionProvider` avvia una `restoreSession()` al montaggio. Interagire con
 * la schermata mentre quella promessa e' ancora in volo lascia un
 * aggiornamento di stato fuori da `act`, e l'avviso che ne esce compare in
 * mezzo all'output di un caso che passa: sembra il sintomo di qualcos'altro.
 *
 * L'attesa e' un `act` vuoto e non un `findByText` sull'email, che sarebbe
 * stata la scorciatoia ovvia. La differenza si vede solo mutando il codice: con
 * l'email come punto di sincronia, toglierla dalla schermata fa fallire tutti i
 * casi del file invece del solo caso che parla di lei, e la riga da leggere per
 * capire cos'e' successo finisce sepolta sotto altre dieci.
 */
async function montaAccount(client: ApiClient): Promise<void> {
  montaConApi(
    client,
    <SessionProvider>
      <AccountScreen />
    </SessionProvider>,
  );
  await act(async () => {});
}

function campo(nome: string): HTMLInputElement {
  return screen.getByLabelText(nome) as HTMLInputElement;
}

function bottone(nome: string): HTMLButtonElement {
  return screen.getByRole("button", { name: nome }) as HTMLButtonElement;
}

/** Il finto minimo: la sessione c'e', e nient'altro e' previsto. */
function collegato(risposte: Partial<ApiClient> = {}): ApiClient {
  return creaClienteFinto({
    restoreSession: () => Promise.resolve(unaSessione().user),
    ...risposte,
  });
}

async function compila(
  utente: ReturnType<typeof userEvent.setup>,
  valori: { attuale: string; nuova: string; conferma: string },
): Promise<void> {
  await utente.type(campo("Password attuale"), valori.attuale);
  await utente.type(campo("Password nuova"), valori.nuova);
  await utente.type(campo("Ripeti la password nuova"), valori.conferma);
}

describe("AccountScreen", () => {
  it("dice con quale account si sta parlando", async () => {
    await montaAccount(collegato());

    // Su un telefono prestato, o su un secondo account aperto per sbaglio, e'
    // l'unico posto dell'app che risponde a «di chi sono questi dati».
    expect(await screen.findByText(/mario@example\.com/)).not.toBeNull();
  });

  it("dice al gestore di password quale campo e' vecchio e quali sono nuovi", async () => {
    await montaAccount(collegato());

    expect(campo("Password attuale").getAttribute("autocomplete")).toBe("current-password");
    // Se questi due dicessero `current-password`, il gestore proporrebbe la
    // vecchia e non salverebbe la nuova. Senza recupero password, l'account e'
    // perso: nessun altro attributo di questa applicazione costa cosi' tanto.
    expect(campo("Password nuova").getAttribute("autocomplete")).toBe("new-password");
    expect(campo("Ripeti la password nuova").getAttribute("autocomplete")).toBe("new-password");
  });

  it("avverte che gli altri dispositivi cadranno, prima che si prema", async () => {
    await montaAccount(collegato());

    // Chi cambia password per igiene, senza sospettare niente, si ritroverebbe
    // l'altro telefono scollegato e penserebbe a un guasto dell'app.
    expect(screen.getByText(/scollega tutti gli altri dispositivi/)).not.toBeNull();
  });

  it("manda la password attuale e la nuova, e non l'una al posto dell'altra", async () => {
    const invii: ChangePasswordRequest[] = [];
    await montaAccount(
      collegato({
        changePassword: (input) => {
          invii.push(input);
          return Promise.resolve(unaSessione());
        },
      }),
    );

    const utente = userEvent.setup();
    await compila(utente, {
      attuale: "quella-di-prima",
      nuova: "quella-nuova-lunga",
      conferma: "quella-nuova-lunga",
    });
    await utente.click(bottone("Cambia password"));

    await waitFor(() => {
      expect(invii).toEqual([
        { currentPassword: "quella-di-prima", newPassword: "quella-nuova-lunga" },
      ]);
    });
  });

  it("se la ripetizione non coincide la richiesta non parte", async () => {
    let chiamate = 0;
    await montaAccount(
      collegato({
        changePassword: () => {
          chiamate += 1;
          return Promise.resolve(unaSessione());
        },
      }),
    );

    const utente = userEvent.setup();
    await compila(utente, {
      attuale: "quella-di-prima",
      nuova: "quella-nuova-lunga",
      // Una lettera di differenza in fondo: il refuso che il server non puo'
      // vedere, perche' questo campo non glielo manda nessuno.
      conferma: "quella-nuova-lungo",
    });
    await utente.click(bottone("Cambia password"));

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toContain("non coincidono");
    expect(chiamate).toBe(0);
  });

  it("una password nuova troppo corta si ferma qui, dicendo quanto deve essere lunga", async () => {
    let chiamate = 0;
    await montaAccount(
      collegato({
        changePassword: () => {
          chiamate += 1;
          return Promise.resolve(unaSessione());
        },
      }),
    );

    const utente = userEvent.setup();
    await compila(utente, { attuale: "quella-di-prima", nuova: "corta", conferma: "corta" });
    await utente.click(bottone("Cambia password"));

    // Il server risponderebbe «La richiesta non e' valida», che e' vero e non
    // dice cosa correggere. Il numero viene da `PASSWORD_MIN_LENGTH`, quindi il
    // giorno che il minimo cambia questa frase cambia da sola.
    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toContain(String(PASSWORD_MIN_LENGTH));
    expect(chiamate).toBe(0);
  });

  it("l'errore sparisce appena si corregge il campo che lo ha causato", async () => {
    await montaAccount(collegato());

    const utente = userEvent.setup();
    await compila(utente, {
      attuale: "quella-di-prima",
      nuova: "quella-nuova-lunga",
      conferma: "quella-nuova-lung",
    });
    await utente.click(bottone("Cambia password"));
    await screen.findByRole("alert");

    // «Le due password non coincidono» appeso sopra il campo che le ha appena
    // fatte coincidere si legge come «non hai corretto abbastanza».
    await utente.type(campo("Ripeti la password nuova"), "a");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dopo il cambio i campi restano vuoti e la conferma dice cosa e' successo altrove", async () => {
    await montaAccount(collegato({ changePassword: () => Promise.resolve(unaSessione()) }));

    const utente = userEvent.setup();
    await compila(utente, {
      attuale: "quella-di-prima",
      nuova: "quella-nuova-lunga",
      conferma: "quella-nuova-lunga",
    });
    await utente.click(bottone("Cambia password"));

    // Sull'altro telefono la sessione cade in silenzio: questa riga e' l'unico
    // avviso che qualcuno ricevera' del fatto che e' successo.
    const conferma = await screen.findByRole("status");
    expect(conferma.textContent).toContain("scollegati");

    // `attuale` contiene ormai una password che non vale piu'. Lasciarla nel
    // campo significa che il secondo invio torna INVALID_CREDENTIALS, cioe' un
    // «password sbagliata» stampato sotto un «password cambiata».
    expect(campo("Password attuale").value).toBe("");
    expect(campo("Password nuova").value).toBe("");
    expect(campo("Ripeti la password nuova").value).toBe("");
  });

  it("un rifiuto del server si legge, e non porta via cio' che era gia' scritto bene", async () => {
    await montaAccount(
      collegato({
        changePassword: () =>
          Promise.reject(
            new ApiError({
              code: "INVALID_CREDENTIALS",
              message: "Email o password non corretti.",
              status: 401,
            }),
          ),
      }),
    );

    const utente = userEvent.setup();
    await compila(utente, {
      attuale: "sbagliata",
      nuova: "quella-nuova-lunga",
      conferma: "quella-nuova-lunga",
    });
    await utente.click(bottone("Cambia password"));

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toContain("Email o password non corretti.");

    // Il campo sbagliato e' uno solo. Svuotarli tutti farebbe ridigitare due
    // volte una password nuova che era giusta — cioe' due occasioni in piu' di
    // sbagliarla, in una schermata dove sbagliarla non si rimedia.
    expect(campo("Password nuova").value).toBe("quella-nuova-lunga");
    expect(campo("Ripeti la password nuova").value).toBe("quella-nuova-lunga");
  });

  it("mentre la richiesta e' in volo il pulsante non si puo' premere di nuovo", async () => {
    let chiamate = 0;
    let rispondi: (session: AuthSession) => void = () => undefined;
    await montaAccount(
      collegato({
        changePassword: () => {
          chiamate += 1;
          return new Promise<AuthSession>((resolve) => {
            rispondi = resolve;
          });
        },
      }),
    );

    const utente = userEvent.setup();
    await compila(utente, {
      attuale: "quella-di-prima",
      nuova: "quella-nuova-lunga",
      conferma: "quella-nuova-lunga",
    });
    await utente.click(bottone("Cambia password"));

    const inVolo = await screen.findByRole("button", { name: "Un attimo…" });
    expect((inVolo as HTMLButtonElement).disabled).toBe(true);

    // Il secondo tocco di chi non vede reazione. Passerebbe due volte dal
    // limitatore, e la seconda con una `currentPassword` che il primo cambio ha
    // appena reso falsa.
    await utente.click(inVolo);
    expect(chiamate).toBe(1);

    rispondi(unaSessione());
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Un attimo…" })).toBeNull();
    });
  });

  it("«Esci» chiude davvero la sessione, invece di sembrare di farlo", async () => {
    let uscite = 0;
    await montaAccount(
      collegato({
        logout: () => {
          uscite += 1;
          return Promise.resolve();
        },
      }),
    );

    const utente = userEvent.setup();
    await utente.click(bottone("Esci da questo dispositivo"));

    // Prima di questa schermata `logout` esisteva in `session.tsx` e non lo
    // chiamava nessuno: si usciva svuotando lo storage del browser.
    await waitFor(() => {
      expect(uscite).toBe(1);
    });
  });
});
