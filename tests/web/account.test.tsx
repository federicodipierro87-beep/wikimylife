import type {
  ApiClient,
  AuthSession,
  ChangePasswordRequest,
  RevokeOtherSessionsRequest,
  RevokeOtherSessionsResponse,
} from "@wikimylife/shared";
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
 * La sezione di mezzo — «scollega gli altri dispositivi» — ha una posta
 * diversa, e i suoi casi stanno nel secondo `describe`. Li' non si perde
 * l'account: si perde la verita' su cosa sia successo. Il server risponde con
 * un numero, e un'interfaccia che lo appiattisse in un «fatto» direbbe a chi
 * cerca un telefono rubato che l'ha appena chiuso, anche quando non c'era.
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

/**
 * La sezione di mezzo: scollegare gli altri senza toccare la password.
 *
 * Qui il rischio non e' perdere l'account, e' credere di aver chiuso una
 * sessione che invece e' ancora aperta. Il server risponde con un numero
 * proprio per quello, e ogni caso qui sotto esiste per un modo diverso di
 * buttarlo via: mostrarne uno finto, mostrarne uno solo per tutti e tre, o
 * mostrarlo nel posto sbagliato.
 */
describe("AccountScreen: scollegare gli altri dispositivi", () => {
  /** Il finto che risponde con un numero e tiene il conto di cosa gli e' arrivato. */
  function conRevoca(
    esito: () => Promise<RevokeOtherSessionsResponse>,
  ): { client: ApiClient; invii: RevokeOtherSessionsRequest[] } {
    const invii: RevokeOtherSessionsRequest[] = [];
    const client = collegato({
      revokeOtherSessions: (input) => {
        invii.push(input);
        return esito();
      },
    });
    return { client, invii };
  }

  it("manda la password, e nient'altro", async () => {
    const { client, invii } = conRevoca(() => Promise.resolve({ revoked: 2 }));
    await montaAccount(client);

    const utente = userEvent.setup();
    await utente.type(campo("La tua password"), "quella-che-so");
    await utente.click(bottone("Scollega gli altri"));

    // Nessun `familyId` e nessun «quali»: quale sessione risparmiare lo decide
    // il token con cui la richiesta viaggia, e il corpo che lo dicesse sarebbe
    // rifiutato dallo schema.
    await waitFor(() => {
      expect(invii).toEqual([{ currentPassword: "quella-che-so" }]);
    });
  });

  it("chiede la password al gestore giusto: e' quella di adesso, non una nuova", async () => {
    await montaAccount(collegato());

    // `new-password` qui farebbe proporre al gestore una password inventata da
    // salvare, in un modulo che non ne cambia nessuna.
    expect(campo("La tua password").getAttribute("autocomplete")).toBe("current-password");
  });

  it("dice quanti dispositivi sono caduti, con il numero che ha detto il server", async () => {
    const { client } = conRevoca(() => Promise.resolve({ revoked: 3 }));
    await montaAccount(client);

    const utente = userEvent.setup();
    await utente.type(campo("La tua password"), "quella-che-so");
    await utente.click(bottone("Scollega gli altri"));

    const conferma = await screen.findByRole("status");
    expect(conferma.textContent).toBe("3 altri dispositivi sono stati scollegati.");
  });

  it("uno solo lo dice al singolare, perche' «1 altri dispositivi» si legge come un guasto", async () => {
    const { client } = conRevoca(() => Promise.resolve({ revoked: 1 }));
    await montaAccount(client);

    const utente = userEvent.setup();
    await utente.type(campo("La tua password"), "quella-che-so");
    await utente.click(bottone("Scollega gli altri"));

    const conferma = await screen.findByRole("status");
    expect(conferma.textContent).toBe("Un altro dispositivo e' stato scollegato.");
  });

  it("zero dice che non c'era nessuno, e non «fatto»", async () => {
    const { client } = conRevoca(() => Promise.resolve({ revoked: 0 }));
    await montaAccount(client);

    const utente = userEvent.setup();
    await utente.type(campo("La tua password"), "quella-che-so");
    await utente.click(bottone("Scollega gli altri"));

    // E' il caso per cui il server restituisce un numero invece di un `ok`. Chi
    // preme questo pulsante sta cercando un telefono: «fatto» gli direbbe di
    // smettere di cercarlo, questa frase gli dice che non l'ha trovato.
    const conferma = await screen.findByRole("status");
    expect(conferma.textContent).toBe("Non c'era nessun altro dispositivo collegato.");
  });

  it("svuota il campo dopo, come fa l'altro modulo con il suo", async () => {
    const { client } = conRevoca(() => Promise.resolve({ revoked: 1 }));
    await montaAccount(client);

    const utente = userEvent.setup();
    await utente.type(campo("La tua password"), "quella-che-so");
    await utente.click(bottone("Scollega gli altri"));
    await screen.findByRole("status");

    expect(campo("La tua password").value).toBe("");
  });

  it("un rifiuto si legge come rifiuto, e non come una conferma con zero dispositivi", async () => {
    const { client } = conRevoca(() =>
      Promise.reject(
        new ApiError({
          code: "INVALID_CREDENTIALS",
          message: "Email o password non corretti.",
          status: 401,
        }),
      ),
    );
    await montaAccount(client);

    const utente = userEvent.setup();
    await utente.type(campo("La tua password"), "sbagliata");
    await utente.click(bottone("Scollega gli altri"));

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toBe("Email o password non corretti.");
    // Un errore trattato come un esito con `revoked` mancante mostrerebbe «non
    // c'era nessun altro dispositivo collegato»: la frase piu' rassicurante
    // dell'app, sopra il fallimento piu' importante.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("i due moduli non si passano gli esiti", async () => {
    await montaAccount(
      collegato({
        changePassword: () => Promise.resolve(unaSessione()),
        revokeOtherSessions: () =>
          Promise.reject(
            new ApiError({
              code: "INVALID_CREDENTIALS",
              message: "Password sbagliata.",
              status: 401,
            }),
          ),
      }),
    );

    const utente = userEvent.setup();
    await compila(utente, {
      attuale: "quella-di-prima",
      nuova: "quella-nuova-lunga",
      conferma: "quella-nuova-lunga",
    });
    await utente.click(bottone("Cambia password"));
    await screen.findByRole("status");

    await utente.type(campo("La tua password"), "sbagliata");
    await utente.click(bottone("Scollega gli altri"));
    await screen.findByRole("alert");

    // Con un solo stato condiviso, il rosso di qui avrebbe cancellato il verde
    // di la': la password sarebbe cambiata davvero e lo schermo direbbe
    // soltanto che qualcosa e' andato storto.
    expect(screen.getByRole("status").textContent).toContain("Password cambiata");
  });

  it("mentre la richiesta e' in volo il pulsante non si preme di nuovo", async () => {
    let chiamate = 0;
    let rispondi: (esito: RevokeOtherSessionsResponse) => void = () => undefined;
    await montaAccount(
      collegato({
        revokeOtherSessions: () => {
          chiamate += 1;
          return new Promise<RevokeOtherSessionsResponse>((resolve) => {
            rispondi = resolve;
          });
        },
      }),
    );

    const utente = userEvent.setup();
    await utente.type(campo("La tua password"), "quella-che-so");
    await utente.click(bottone("Scollega gli altri"));

    const inVolo = await screen.findByRole("button", { name: "Un attimo…" });
    expect((inVolo as HTMLButtonElement).disabled).toBe(true);

    // Due chiamate qui costano due argon2 al server e due tacche al limitatore,
    // per un gesto che la seconda volta non ha piu' niente da revocare.
    await utente.click(inVolo);
    expect(chiamate).toBe(1);

    rispondi({ revoked: 1 });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Un attimo…" })).toBeNull();
    });
  });

  it("non e' un «Esci» travestito: questo dispositivo resta dentro", async () => {
    const { client } = conRevoca(() => Promise.resolve({ revoked: 2 }));
    await montaAccount(client);

    const utente = userEvent.setup();
    await utente.type(campo("La tua password"), "quella-che-so");
    await utente.click(bottone("Scollega gli altri"));
    await screen.findByRole("status");

    // `logout` non e' insegnato a questo finto: chiamarlo farebbe fallire il
    // caso con il proprio nome dentro l'errore. E la schermata e' ancora qui,
    // che e' quello che il testo sopra il pulsante promette.
    expect(bottone("Esci da questo dispositivo")).toBeTruthy();
  });
});

describe("AccountScreen: le tre sezioni", () => {
  it("ognuna dice cosa lascia in piedi, che e' l'unica differenza fra loro", async () => {
    await montaAccount(collegato());

    // Tre pulsanti che si somigliano e tolgono cose diverse. Chi cerca di
    // rimediare a un telefono perduto non ha modo di sceglierli, se non
    // leggendo: senza queste righe, «Esci» sembra il gesto piu' forte perche'
    // e' quello che si conosce, e invece e' il piu' debole dei tre.
    expect(screen.getByText(/scollega tutti gli altri dispositivi/)).toBeTruthy();
    expect(screen.getByText(/Questo dispositivo resta collegato/)).toBeTruthy();
    expect(screen.getByText(/Chiude solo questo dispositivo/)).toBeTruthy();
  });

  it("i tre pulsanti hanno tre nomi diversi, e nessuno e' «Conferma»", async () => {
    await montaAccount(collegato());

    // I nomi accessibili sono anche cio' che legge chi non vede lo schermo, e
    // sono l'unica cosa che distingue tre gesti irreversibili in ordine
    // crescente di danno.
    expect(bottone("Cambia password")).toBeTruthy();
    expect(bottone("Scollega gli altri")).toBeTruthy();
    expect(bottone("Esci da questo dispositivo")).toBeTruthy();
  });
});
