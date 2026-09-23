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
import {
  CaptureContext,
  type Capture,
} from "../../apps/web/src/recording/CaptureProvider";
import { AccountScreen } from "../../apps/web/src/screens/AccountScreen";
import { SessionProvider } from "../../apps/web/src/session";
import { creaCapturaFinta } from "./helpers/capturaFinta";
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
async function montaAccount(client: ApiClient, capture?: Capture): Promise<void> {
  // `CaptureContext` c'e' per una riga sola della schermata: la cancellazione
  // del conto deve svuotare anche la coda dei caricamenti, e ci passa da qui.
  // Il finto predefinito lancia su ogni metodo, quindi i casi che non parlano
  // di cancellazione restano nella stessa condizione di prima — se la schermata
  // cominciasse a toccare la cattura altrove, se ne accorgerebbero.
  montaConApi(
    client,
    <CaptureContext.Provider value={capture ?? creaCapturaFinta()}>
      <SessionProvider>
        <AccountScreen />
      </SessionProvider>
    </CaptureContext.Provider>,
  );
  await act(async () => {});
}

function campo(nome: string): HTMLInputElement {
  return screen.getByLabelText(nome) as HTMLInputElement;
}

function bottone(nome: string): HTMLButtonElement {
  return screen.getByRole("button", { name: nome }) as HTMLButtonElement;
}

/**
 * Un istante fa, in ISO.
 *
 * Il tempo non e' congelato in questi casi: `formatQuando` usa l'orologio vero
 * quando non gliene si passa un altro, e la schermata non gliene passa nessuno.
 * Una data a pochi secondi da adesso finisce nel ramo «adesso» della funzione,
 * che e' stabile — mentre una data fissa scritta nel file diventerebbe «2 anni
 * fa» e poi una data assoluta, e il caso si romperebbe da solo col passare dei
 * mesi senza che nessuno abbia toccato niente.
 */
const ADESSO = new Date().toISOString();

/**
 * Il finto minimo: la sessione c'e', c'e' l'elenco dei dispositivi, e nient'altro
 * e' previsto.
 *
 * Le due risposte insegnate qui sono le due che il montaggio chiede da solo, e
 * nessun caso le ha chieste: `restoreSession` la chiama `SessionProvider`,
 * `listSessions` la chiama la sezione di mezzo appena compare. Un finto che non
 * le sapesse farebbe fallire ogni caso del file con un errore che parla di una
 * rotta a cui nessuno era interessato — cioe' nasconderebbe la vera ragione del
 * fallimento sotto trenta righe identiche.
 *
 * Il predefinito e' una sessione sola, ed e' quella corrente: e' cio' che vede
 * chiunque abbia fatto login una volta, quindi e' lo sfondo giusto per i casi
 * che guardano altro. Chi vuole una lista diversa la passa.
 */
function collegato(risposte: Partial<ApiClient> = {}): ApiClient {
  return creaClienteFinto({
    restoreSession: () => Promise.resolve(unaSessione().user),
    listSessions: () =>
      Promise.resolve({ sessions: [{ id: "fam-questo", createdAt: ADESSO, current: true }] }),
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

/**
 * L'elenco dei dispositivi, che e' il metro del numero della sezione di sopra.
 *
 * Senza, «ne ho scollegate due» e' una frase che non si puo' verificare: chi la
 * legge non sapeva quante fossero prima. I casi qui guardano le tre cose che
 * quella verifica richiede — che le righe ci siano, che si capisca quale e' il
 * dispositivo in mano, e che dopo il gesto la lista dica la verita' nuova invece
 * di quella vecchia.
 */
describe("AccountScreen: l'elenco dei dispositivi collegati", () => {
  const TRE_GIORNI_FA = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const SETTANTA_GIORNI_FA = new Date(Date.now() - 70 * 86_400_000).toISOString();

  function conElenco(
    sessions: readonly { id: string; createdAt: string; current: boolean }[],
  ): ApiClient {
    return collegato({ listSessions: () => Promise.resolve({ sessions: [...sessions] }) });
  }

  it("mostra una riga per dispositivo, con da quando e' collegato", async () => {
    await montaAccount(
      conElenco([
        { id: "fam-questo", createdAt: TRE_GIORNI_FA, current: true },
        { id: "fam-vecchio", createdAt: SETTANTA_GIORNI_FA, current: false },
      ]),
    );

    const righe = await screen.findAllByRole("listitem");
    expect(righe).toHaveLength(2);
    // Relative e non assolute: «3 giorni fa» accanto a «2 mesi fa» si confronta
    // a colpo d'occhio, e il confronto e' l'unica operazione che si fa su questa
    // lista. Due date in cifre chiederebbero di sottrarle a mente.
    expect(righe[0]?.textContent).toContain("Collegato 3 giorni fa");
    expect(righe[1]?.textContent).toContain("Collegato 2 mesi fa");
  });

  it("marca il dispositivo in mano, e marca solo quello", async () => {
    await montaAccount(
      conElenco([
        { id: "fam-vecchio", createdAt: TRE_GIORNI_FA, current: false },
        { id: "fam-questo", createdAt: SETTANTA_GIORNI_FA, current: true },
      ]),
    );

    const righe = await screen.findAllByRole("listitem");
    // La riga giusta, e non la prima: marcare sempre la prima passerebbe con
    // l'ordine piu' comune — il dispositivo in uso e' spesso l'ultimo aperto —
    // e sbaglierebbe esattamente su chi ha appena fatto login altrove, cioe' su
    // chi sta guardando questa schermata per un motivo.
    expect(righe[0]?.textContent).not.toContain("questo dispositivo");
    expect(righe[1]?.textContent).toContain("questo dispositivo");
    expect(screen.getAllByText("questo dispositivo")).toHaveLength(1);
  });

  it("un solo dispositivo non e' un caso speciale: la riga c'e' lo stesso", async () => {
    await montaAccount(
      conElenco([{ id: "fam-questo", createdAt: TRE_GIORNI_FA, current: true }]),
    );

    const righe = await screen.findAllByRole("listitem");
    expect(righe).toHaveLength(1);
    // Nascondere la lista quando ce n'e' uno solo sembrerebbe un'economia e
    // sarebbe una bugia per omissione: chi cerca un telefono perduto e non vede
    // niente non sa se la risposta e' «ce n'e' uno solo» o «non ho guardato».
    expect(righe[0]?.textContent).toContain("questo dispositivo");
  });

  it("mentre conta lo dice, invece di mostrare una lista vuota", async () => {
    await montaAccount(
      collegato({
        listSessions: () => new Promise(() => undefined),
      }),
    );

    // Una lista vuota durante il caricamento si legge come «nessun altro
    // dispositivo collegato», che e' la risposta piu' rassicurante delle tre e
    // qui sarebbe inventata.
    expect(screen.getByText("Conto i dispositivi collegati…")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("se l'elenco non arriva, il pulsante che serve davvero resta usabile", async () => {
    await montaAccount(
      collegato({
        listSessions: () =>
          Promise.reject(
            new ApiError({ code: "INTERNAL_ERROR", message: "Il server non risponde.", status: 500 }),
          ),
      }),
    );

    expect(await screen.findByText(/Non sono riuscito a leggere l'elenco/)).toBeTruthy();
    // Il modulo e' intatto: l'elenco e' un contorno, non una precondizione. Chi
    // ha appena perso un telefono deve poterlo scollegare anche quando il conto
    // dei dispositivi non arriva.
    expect(campo("La tua password")).toBeTruthy();
    expect(bottone("Scollega gli altri").disabled).toBe(false);
    // E soprattutto non e' un allarme: un rosso con `role="alert"` accanto a un
    // modulo funzionante direbbe che il gesto e' diventato impossibile.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dopo una revoca riuscita la lista si accorcia, invece di restare quella di prima", async () => {
    const risposte: { sessions: { id: string; createdAt: string; current: boolean }[] }[] = [
      {
        sessions: [
          { id: "fam-questo", createdAt: TRE_GIORNI_FA, current: true },
          { id: "fam-vecchio", createdAt: SETTANTA_GIORNI_FA, current: false },
        ],
      },
      { sessions: [{ id: "fam-questo", createdAt: TRE_GIORNI_FA, current: true }] },
    ];
    let giro = 0;
    await montaAccount(
      collegato({
        listSessions: () => {
          const risposta = risposte[Math.min(giro, risposte.length - 1)];
          giro += 1;
          return Promise.resolve(risposta ?? { sessions: [] });
        },
        revokeOtherSessions: () => Promise.resolve({ revoked: 1 }),
      }),
    );

    expect(await screen.findAllByRole("listitem")).toHaveLength(2);

    const utente = userEvent.setup();
    await utente.type(campo("La tua password"), "quella-che-so");
    await utente.click(bottone("Scollega gli altri"));
    await screen.findByRole("status");

    // Senza la ricarica, sotto «un altro dispositivo e' stato scollegato»
    // resterebbero scritti due dispositivi: il messaggio e la lista si
    // smentirebbero a vicenda, e la lista e' quella che si crede.
    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
    });
  });

  it("dopo un rifiuto la lista non si ricarica, perche' non e' cambiato niente", async () => {
    let letture = 0;
    await montaAccount(
      collegato({
        listSessions: () => {
          letture += 1;
          return Promise.resolve({
            sessions: [{ id: "fam-questo", createdAt: TRE_GIORNI_FA, current: true }],
          });
        },
        revokeOtherSessions: () =>
          Promise.reject(
            new ApiError({
              code: "INVALID_CREDENTIALS",
              message: "Email o password non corretti.",
              status: 401,
            }),
          ),
      }),
    );
    await screen.findAllByRole("listitem");
    expect(letture).toBe(1);

    const utente = userEvent.setup();
    await utente.type(campo("La tua password"), "sbagliata");
    await utente.click(bottone("Scollega gli altri"));
    await screen.findByRole("alert");

    // Una `ricarica` anche qui farebbe sparire e riapparire la lista identica
    // sotto un messaggio d'errore, come se il guasto riguardasse anche lei — e
    // costerebbe una richiesta per ogni password digitata male.
    expect(letture).toBe(1);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});

/**
 * Chiudere un dispositivo solo, scegliendolo dall'elenco.
 *
 * E' l'unico posto dell'applicazione in cui l'utente preme un pulsante fra piu'
 * pulsanti identici e ne esce un gesto irreversibile. Tutto il resto di questa
 * schermata ha un pulsante per sezione, e sbagliare significa premere il gesto
 * accanto — che si legge. Qui i pulsanti sono tre, dicono tutti «Scollega», e
 * l'unica cosa che li distingue e' la riga su cui stanno: ogni caso qui sotto
 * guarda un modo diverso in cui quella corrispondenza puo' rompersi senza che
 * niente a schermo lo dica.
 */
describe("AccountScreen: chiudere un dispositivo solo", () => {
  const TRE_GIORNI_FA = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const VENTI_GIORNI_FA = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const SETTANTA_GIORNI_FA = new Date(Date.now() - 70 * 86_400_000).toISOString();

  /**
   * Quattro righe, e tre di loro scollegabili.
   *
   * Tre e non due: con due pulsanti, «si e' spento quello premuto» e «si e'
   * spento quello *non* premuto» hanno lo stesso aspetto se si guarda solo il
   * conto, e la riga di mezzo e' anche l'unica posizione che distingue una
   * scelta per id da una scelta per posizione.
   */
  const QUATTRO = [
    { id: "fam-questo", createdAt: ADESSO, current: true },
    { id: "fam-a", createdAt: TRE_GIORNI_FA, current: false },
    { id: "fam-b", createdAt: VENTI_GIORNI_FA, current: false },
    { id: "fam-c", createdAt: SETTANTA_GIORNI_FA, current: false },
  ] as const;

  const NOME_A = "Scollega il dispositivo collegato 3 giorni fa";
  const NOME_B = "Scollega il dispositivo collegato 2 settimane fa";
  const NOME_C = "Scollega il dispositivo collegato 2 mesi fa";

  /** L'elenco fisso di sopra, piu' cio' che il caso vuole insegnare. */
  function conQuattro(risposte: Partial<ApiClient> = {}): ApiClient {
    return collegato({
      listSessions: () => Promise.resolve({ sessions: [...QUATTRO] }),
      ...risposte,
    });
  }

  /** Scrive la password, che e' cio' che accende i pulsanti delle righe. */
  async function pronto(): Promise<ReturnType<typeof userEvent.setup>> {
    const utente = userEvent.setup();
    await screen.findAllByRole("listitem");
    await utente.type(campo("La tua password"), "quella-che-so");
    return utente;
  }

  it("ogni riga ha il suo pulsante, tranne quella del dispositivo in mano", async () => {
    await montaAccount(conQuattro());

    const righe = await screen.findAllByRole("listitem");
    expect(righe).toHaveLength(4);
    // Tre e non quattro. Un pulsante sulla riga corrente sarebbe un secondo
    // «Esci» con un'altra etichetta, premuto per sbaglio da chi crede di stare
    // chiudendo il telefono che ha perso.
    expect(screen.getAllByRole("button", { name: /^Scollega il dispositivo/ })).toHaveLength(3);
    expect(righe[0]?.querySelector("button")).toBeNull();
    // E l'opposto: le altre tre ce l'hanno davvero, quindi il caso non passa
    // per un elenco che non ha pulsanti affatto.
    expect(righe[1]?.querySelector("button")).not.toBeNull();
    expect(righe[2]?.querySelector("button")).not.toBeNull();
    expect(righe[3]?.querySelector("button")).not.toBeNull();
  });

  it("i pulsanti sono spenti finche' il campo e' vuoto, e si accendono appena si scrive", async () => {
    await montaAccount(conQuattro());
    await screen.findAllByRole("listitem");

    // Spenti: la richiesta senza password partirebbe per tornare indietro con
    // un VALIDATION_FAILED, cioe' un rosso su un gesto che non era ancora
    // pronto a partire.
    expect(bottone(NOME_A).disabled).toBe(true);

    const utente = userEvent.setup();
    await utente.type(campo("La tua password"), "q");

    // E accesi, che e' l'altra meta': un pulsante spento per sempre non e' una
    // precauzione, e' un gesto che non esiste.
    await waitFor(() => {
      expect(bottone(NOME_A).disabled).toBe(false);
    });
    expect(bottone(NOME_B).disabled).toBe(false);
    expect(bottone(NOME_C).disabled).toBe(false);
  });

  it("manda l'id di quella riga, e non quello della prima", async () => {
    const invii: unknown[] = [];
    await montaAccount(
      conQuattro({
        revokeSession: (input) => {
          invii.push(input);
          return Promise.resolve({ revoked: 1 });
        },
      }),
    );

    const utente = await pronto();
    await utente.click(bottone(NOME_B));

    // `fam-b` e non `fam-a`: prendere l'id dalla prima riga, o dalla riga
    // corrente, e' il difetto che una prova a mano non vede — si preme, un
    // dispositivo sparisce, e sembra andata bene.
    await waitFor(() => {
      expect(invii).toEqual([{ sessionId: "fam-b", currentPassword: "quella-che-so" }]);
    });
  });

  it("solo la riga premuta si spegne: le altre due restano premibili", async () => {
    let risolvi: (esito: { revoked: number }) => void = () => undefined;
    await montaAccount(
      conQuattro({
        revokeSession: () =>
          new Promise((r) => {
            risolvi = r;
          }),
      }),
    );

    const utente = await pronto();
    await utente.click(bottone(NOME_B));

    // Un booleano condiviso spegnerebbe tutti e tre, e chi guarda non saprebbe
    // piu' quale ha premuto: tre righe grigie identiche, e un gesto in corso su
    // una di loro.
    await waitFor(() => {
      expect(bottone(NOME_B).disabled).toBe(true);
    });
    expect(bottone(NOME_A).disabled).toBe(false);
    expect(bottone(NOME_C).disabled).toBe(false);
    // E l'etichetta visibile cambia solo su quella, perche' e' l'unica cosa che
    // dice dove sta succedendo qualcosa.
    expect(screen.getAllByText("Un attimo…")).toHaveLength(1);

    risolvi({ revoked: 1 });
    await waitFor(() => {
      expect(screen.queryByText("Un attimo…")).toBeNull();
    });
  });

  it("il nome del pulsante in volo nomina ancora il suo dispositivo", async () => {
    let risolvi: (esito: { revoked: number }) => void = () => undefined;
    await montaAccount(
      conQuattro({
        revokeSession: () =>
          new Promise((r) => {
            risolvi = r;
          }),
      }),
    );

    const utente = await pronto();
    await utente.click(bottone(NOME_B));

    // Il nome accessibile e' un `aria-label`, quindi vince sul contenuto e resta
    // lo stesso mentre l'etichetta visibile dice «Un attimo». Senza, chi legge a
    // voce sentirebbe sparire il dispositivo dall'elenco e comparire un pulsante
    // «Un attimo» senza padrone, nel momento in cui gli serve sapere su quale
    // riga sta agendo.
    await waitFor(() => {
      expect(bottone(NOME_B).textContent).toBe("Un attimo…");
    });
    risolvi({ revoked: 1 });
  });

  it("la riga chiusa viene smontata, non riciclata per quella che le scivola sotto", async () => {
    const risposte = [
      { sessions: [...QUATTRO] },
      { sessions: QUATTRO.filter((s) => s.id !== "fam-b") },
    ];
    let giro = 0;
    await montaAccount(
      conQuattro({
        listSessions: () => {
          const risposta = risposte[Math.min(giro, risposte.length - 1)];
          giro += 1;
          return Promise.resolve(risposta ?? { sessions: [] });
        },
        revokeSession: () => Promise.resolve({ revoked: 1 }),
      }),
    );

    const utente = await pronto();
    const premuto = bottone(NOME_B);
    await utente.click(premuto);

    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(3);
    });

    // Questo e' il caso che uccide `key={indice}`. Con la posizione come
    // chiave, React non smonta niente: riusa il nodo della riga sparita per
    // quella che prende il suo posto, riscrivendogli sopra l'`aria-label` e il
    // gestore. Il pulsante che l'utente ha appena premuto — e su cui il browser
    // ha lasciato il fuoco — resta li' sotto il dito e adesso scollega un altro
    // dispositivo: premere due volte di fila, che e' la cosa piu' naturale
    // mentre si ripulisce un elenco, ne chiude uno che nessuno aveva guardato.
    expect(premuto.isConnected).toBe(false);
    // E le due che restano sono ancora loro, con i loro nomi: una chiave
    // sbagliata al contrario — tutte uguali — le farebbe collassare in una.
    expect(bottone(NOME_A)).toBeTruthy();
    expect(bottone(NOME_C)).toBeTruthy();
  });

  it("dopo il gesto riuscito l'elenco si ricarica e il campo si svuota", async () => {
    let letture = 0;
    await montaAccount(
      conQuattro({
        listSessions: () => {
          letture += 1;
          return Promise.resolve({
            sessions: letture === 1 ? [...QUATTRO] : QUATTRO.filter((s) => s.id !== "fam-b"),
          });
        },
        revokeSession: () => Promise.resolve({ revoked: 1 }),
      }),
    );

    const utente = await pronto();
    await utente.click(bottone(NOME_B));

    const conferma = await screen.findByRole("status");
    expect(conferma.textContent).toBe("Il dispositivo e' stato scollegato.");
    // Senza la ricarica, sotto il messaggio resterebbe scritto il dispositivo
    // appena chiuso, e la lista e' quella che si crede.
    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(3);
    });
    expect(letture).toBe(2);
    // Il campo si svuota come nell'altro modulo, e qui vale una volta in piu':
    // dopo il primo gesto ogni pulsante torna spento, quindi un secondo clic
    // distratto sulla riga accanto non parte da solo.
    expect(campo("La tua password").value).toBe("");
    expect(bottone(NOME_A).disabled).toBe(true);
  });

  it("zero non dice «scollegato»: dice che quel dispositivo era gia' andato", async () => {
    await montaAccount(conQuattro({ revokeSession: () => Promise.resolve({ revoked: 0 }) }));

    const utente = await pronto();
    await utente.click(bottone(NOME_B));

    // Succede con due schede aperte sullo stesso account, o con un elenco
    // vecchio di qualche minuto. Dire «e' stato scollegato» a chi sta cercando
    // un telefono rubato gli fa credere di averlo appena chiuso adesso, e di
    // sapere che fino a un istante fa era vivo: due cose false.
    const conferma = await screen.findByRole("status");
    expect(conferma.textContent).toBe("Quel dispositivo era gia' scollegato.");
  });

  it("un rifiuto si legge, e la riga torna premibile", async () => {
    await montaAccount(
      conQuattro({
        revokeSession: () =>
          Promise.reject(
            new ApiError({
              code: "INVALID_CREDENTIALS",
              message: "Email o password non corretti.",
              status: 401,
            }),
          ),
      }),
    );

    const utente = await pronto();
    await utente.click(bottone(NOME_B));

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toBe("Email o password non corretti.");
    expect(screen.queryByRole("status")).toBeNull();
    // Senza il `finally`, la riga resterebbe spenta per sempre: l'unico modo di
    // riprovare sarebbe ricaricare la pagina, e il messaggio d'errore — che
    // parla di una password da correggere — starebbe sopra un pulsante che non
    // si puo' piu' premere.
    expect(campo("La tua password").value).toBe("quella-che-so");
    await waitFor(() => {
      expect(bottone(NOME_B).disabled).toBe(false);
    });
  });

  it("premere «Scollega» su una riga non fa partire «scollega gli altri»", async () => {
    let tutti = 0;
    await montaAccount(
      conQuattro({
        revokeSession: () => Promise.resolve({ revoked: 1 }),
        revokeOtherSessions: () => {
          tutti += 1;
          return Promise.resolve({ revoked: 3 });
        },
      }),
    );

    const utente = await pronto();
    await utente.click(bottone(NOME_B));
    await screen.findByRole("status");

    // L'elenco sta dentro il `<form>`, dove un pulsante senza `type` e' un
    // submit. Con il tipo sbagliato, un clic su una riga farebbe partire tutti
    // e due i gesti insieme — il piu' piccolo e il piu' distruttivo — con la
    // password gia' scritta nel campo, e la conferma che si vede a schermo
    // sarebbe quella del gesto che nessuno voleva.
    expect(tutti).toBe(0);
  });

  it("l'esito di una riga e quello del modulo non stanno a schermo insieme", async () => {
    await montaAccount(
      conQuattro({
        revokeSession: () => Promise.resolve({ revoked: 1 }),
        revokeOtherSessions: () => Promise.resolve({ revoked: 3 }),
      }),
    );

    const utente = await pronto();
    await utente.click(bottone("Scollega gli altri"));
    expect((await screen.findByRole("status")).textContent).toBe(
      "3 altri dispositivi sono stati scollegati.",
    );

    await utente.type(campo("La tua password"), "quella-che-so");
    await utente.click(bottone(NOME_B));

    // Un esito per riquadro e non due: con due stati separati esisterebbe il
    // momento in cui lo schermo dice insieme «tre dispositivi sono stati
    // scollegati» e «il dispositivo e' stato scollegato», e chi legge non
    // saprebbe quanti ne sono caduti in tutto.
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Il dispositivo e' stato scollegato.");
    });
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});

describe("AccountScreen: le quattro sezioni", () => {
  it("ognuna dice cosa lascia in piedi, che e' l'unica differenza fra loro", async () => {
    await montaAccount(collegato());

    // Quattro pulsanti che si somigliano e tolgono cose diverse. Chi cerca di
    // rimediare a un telefono perduto non ha modo di sceglierli, se non
    // leggendo: senza queste righe, «Esci» sembra il gesto piu' forte perche'
    // e' quello che si conosce, e invece e' il piu' debole dei quattro.
    expect(screen.getByText(/scollega tutti gli altri dispositivi/)).toBeTruthy();
    expect(screen.getByText(/Questo dispositivo resta collegato/)).toBeTruthy();
    expect(screen.getByText(/Chiude solo questo dispositivo/)).toBeTruthy();
    expect(screen.getByText(/non si torna indietro/)).toBeTruthy();
  });

  it("i quattro pulsanti hanno quattro nomi diversi, e nessuno e' «Conferma»", async () => {
    await montaAccount(collegato());

    // I nomi accessibili sono anche cio' che legge chi non vede lo schermo, e
    // sono l'unica cosa che distingue quattro gesti irreversibili in ordine
    // crescente di danno.
    expect(bottone("Cambia password")).toBeTruthy();
    expect(bottone("Scollega gli altri")).toBeTruthy();
    expect(bottone("Esci da questo dispositivo")).toBeTruthy();
    expect(bottone("Voglio cancellare il conto")).toBeTruthy();
  });
});

/**
 * La quarta sezione, che e' l'unica di questa schermata a non avere un rimedio.
 *
 * Le altre tre tolgono qualcosa che si rimette: una password si ricambia, un
 * dispositivo scollegato si ricollega, da un logout si rientra. Qui il gesto
 * riuscito non si annulla, e quindi i casi guardano due cose che altrove non
 * conterebbero: che il gesto NON parta quando non deve — un tocco solo, una
 * schermata appena aperta — e che un rifiuto lasci l'utente esattamente dov'era,
 * con la sessione viva e i vocali in coda ancora li'.
 *
 * `svuotaCoda` e' la parte piu' facile da sbagliare senza accorgersene: e' una
 * promessa che nessuno guarda, chiamata dopo una richiesta riuscita. Se partisse
 * prima della risposta, o anche nel ramo dell'errore, distruggerebbe i vocali
 * non ancora caricati di un conto ancora vivo — e la prima volta che qualcuno
 * lo scoprirebbe sarebbe sul proprio telefono.
 */
describe("AccountScreen: cancellare il conto", () => {
  const CONTI = { vocali: 4, schede: 2, sessioni: 3 };

  /** Una cattura che conta le volte che le hanno svuotato la coda. */
  function catturaCheConta(): { capture: Capture; svuotate: () => number } {
    let volte = 0;
    const capture = creaCapturaFinta({
      svuotaCoda: () => {
        volte += 1;
        return Promise.resolve();
      },
    });
    return { capture, svuotate: () => volte };
  }

  it("il primo tocco non cancella niente: chiede la password", async () => {
    const utente = userEvent.setup();
    let chiamate = 0;
    await montaAccount(
      collegato({
        deleteAccount: () => {
          chiamate += 1;
          return Promise.resolve(CONTI);
        },
      }),
    );

    // Il campo non c'e' prima: un campo password sempre visibile accanto a un
    // pulsante rosso e' un invito a compilarlo.
    expect(screen.queryByLabelText("Password, per cancellare il conto")).toBeNull();

    await utente.click(bottone("Voglio cancellare il conto"));

    expect(campo("Password, per cancellare il conto")).toBeTruthy();
    expect(bottone("Cancella tutto per sempre")).toBeTruthy();
    // La meta' che conta: un solo tocco non ha mandato niente al server.
    expect(chiamate).toBe(0);
  });

  it("il secondo passo manda la password, e solo allora", async () => {
    const utente = userEvent.setup();
    let ricevuto: unknown = null;
    const { capture, svuotate } = catturaCheConta();
    await montaAccount(
      collegato({
        deleteAccount: (input) => {
          ricevuto = input;
          return Promise.resolve(CONTI);
        },
      }),
      capture,
    );

    await utente.click(bottone("Voglio cancellare il conto"));
    await utente.type(campo("Password, per cancellare il conto"), "la-mia-password");
    await utente.click(bottone("Cancella tutto per sempre"));

    await waitFor(() => {
      expect(ricevuto).not.toBeNull();
    });
    expect(ricevuto).toEqual({ currentPassword: "la-mia-password" });
    expect(svuotate()).toBe(1);
  });

  it("«Lascia stare» richiude e non lascia la password scritta", async () => {
    const utente = userEvent.setup();
    await montaAccount(collegato());

    await utente.click(bottone("Voglio cancellare il conto"));
    await utente.type(campo("Password, per cancellare il conto"), "la-mia-password");
    await utente.click(bottone("Lascia stare"));

    expect(screen.queryByLabelText("Password, per cancellare il conto")).toBeNull();

    // E riaprendo, il campo e' vuoto. Senza questa seconda meta', un
    // `setChiesta(false)` che si dimenticasse il `setPassword("")` passerebbe:
    // il campo smontato non si puo' interrogare, ma il valore tornerebbe
    // appena lo si rimonta.
    await utente.click(bottone("Voglio cancellare il conto"));
    expect(campo("Password, per cancellare il conto").value).toBe("");
  });

  it("finito, il modulo sparisce e restano i numeri", async () => {
    const utente = userEvent.setup();
    await montaAccount(
      collegato({ deleteAccount: () => Promise.resolve(CONTI) }),
      catturaCheConta().capture,
    );

    await utente.click(bottone("Voglio cancellare il conto"));
    await utente.type(campo("Password, per cancellare il conto"), "la-mia-password");
    await utente.click(bottone("Cancella tutto per sempre"));

    // I tre numeri sono l'unica ricevuta che questo gesto avra' mai: dopo non
    // c'e' piu' nessun posto dove tornare a verificare.
    const fatto = await screen.findByRole("status");
    expect(fatto.textContent).toContain("4 vocali");
    expect(fatto.textContent).toContain("2 schede");
    expect(fatto.textContent).toContain("3 dispositivi");

    // Il pulsante non resta acceso: offrirebbe di cancellare un conto che non
    // c'e' piu', e la risposta sarebbe un 401 senza spiegazione.
    expect(screen.queryByRole("button", { name: "Cancella tutto per sempre" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Voglio cancellare il conto" })).toBeNull();
  });

  it("zero si legge come una frase, non come un conteggio", async () => {
    const utente = userEvent.setup();
    await montaAccount(
      collegato({
        deleteAccount: () => Promise.resolve({ vocali: 0, schede: 0, sessioni: 1 }),
      }),
      catturaCheConta().capture,
    );

    await utente.click(bottone("Voglio cancellare il conto"));
    await utente.type(campo("Password, per cancellare il conto"), "la-mia-password");
    await utente.click(bottone("Cancella tutto per sempre"));

    // E' il caso di chi si iscrive e ci ripensa, cioe' il piu' probabile dei
    // tre qui dentro. «Sono spariti 0 vocali» e' una ricevuta che sembra un
    // guasto.
    const fatto = await screen.findByRole("status");
    expect(fatto.textContent).toContain("nessun vocale");
    expect(fatto.textContent).toContain("nessuna scheda");
    expect(fatto.textContent).toContain("1 dispositivo");
  });

  it("un errore lascia la sessione in piedi", async () => {
    const utente = userEvent.setup();
    let usciti = 0;
    const { capture, svuotate } = catturaCheConta();
    await montaAccount(
      collegato({
        logout: () => {
          usciti += 1;
          return Promise.resolve();
        },
        deleteAccount: () =>
          Promise.reject(
            new ApiError({
              code: "CONFLICT",
              message: "Ci sono 2 vocali ancora in lavorazione: finiscono da soli",
              status: 409,
            }),
          ),
      }),
      capture,
    );

    await utente.click(bottone("Voglio cancellare il conto"));
    await utente.type(campo("Password, per cancellare il conto"), "la-mia-password");
    await utente.click(bottone("Cancella tutto per sempre"));

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toContain("in lavorazione");

    // Le tre cose che NON devono essere successe. La coda e' la piu' silenziosa
    // delle tre: svuotarla qui butterebbe via i vocali non ancora caricati di
    // un conto che e' ancora vivo, e nessuno se ne accorgerebbe fino a quando
    // non andasse a cercarli.
    expect(usciti).toBe(0);
    expect(svuotate()).toBe(0);
    expect(bottone("Cancella tutto per sempre")).toBeTruthy();
    // E le altre tre sezioni sono ancora al loro posto: la schermata non ha
    // navigato via.
    expect(bottone("Cambia password")).toBeTruthy();
  });

  it("scrivere nel campo toglie l'errore di prima", async () => {
    const utente = userEvent.setup();
    let risposte = 0;
    await montaAccount(
      collegato({
        deleteAccount: () => {
          risposte += 1;
          return risposte === 1
            ? Promise.reject(
                new ApiError({
                  code: "INVALID_CREDENTIALS",
                  message: "Email o password non corretti",
                  status: 401,
                }),
              )
            : Promise.resolve(CONTI);
        },
      }),
      catturaCheConta().capture,
    );

    await utente.click(bottone("Voglio cancellare il conto"));
    await utente.type(campo("Password, per cancellare il conto"), "sbagliata");
    await utente.click(bottone("Cancella tutto per sempre"));
    await screen.findByRole("alert");

    // Un «password non corretta» che resta sullo schermo mentre si digita
    // quella giusta dice una cosa falsa su cio' che c'e' scritto adesso.
    await utente.type(campo("Password, per cancellare il conto"), "x");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
