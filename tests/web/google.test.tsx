import type { ApiClient, AuthSession, PublicUser } from "@wikimylife/shared";
import { ApiError } from "@wikimylife/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  GoogleContext,
  googleDisponibile,
  type AccessoGoogle,
  type PropsPulsanteGoogle,
} from "../../apps/web/src/google";
import { CaptureContext } from "../../apps/web/src/recording/CaptureProvider";
import { AccountScreen } from "../../apps/web/src/screens/AccountScreen";
import { LoginScreen } from "../../apps/web/src/screens/LoginScreen";
import { SessionProvider, useSession } from "../../apps/web/src/session";
import { creaCapturaFinta } from "./helpers/capturaFinta";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unaSessione } from "./helpers/dati";
import { montaConApi } from "./helpers/render";

/**
 * Google nelle due schermate che lo usano: l'accesso e il conto.
 *
 * ## Il pulsante finto
 *
 * Quello vero carica uno script da Google, che qui non c'e'. Il contesto
 * esiste apposta: al suo posto va un `<button>` qualunque che, premuto,
 * consegna un token fisso. Le schermate non sanno la differenza, ed e' cio' che
 * si sta provando — cosa fanno *dopo* che Google ha risposto.
 *
 * `type="button"` e non il predefinito: nell'accesso il pulsante sta dentro il
 * `<form>`, e un submit farebbe partire il login con la password vuota.
 */

const TOKEN = "id-token-di-google";

function PulsanteFinto({ testo, onToken }: PropsPulsanteGoogle): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => {
        onToken(TOKEN);
      }}
    >
      {testo === "continue_with" ? "Continua con Google" : "Accedi con Google"}
    </button>
  );
}

const GOOGLE: AccessoGoogle = { Pulsante: PulsanteFinto };

function conGoogle(ui: React.ReactElement, google: AccessoGoogle | null): React.ReactElement {
  return <GoogleContext.Provider value={google}>{ui}</GoogleContext.Provider>;
}

function sessioneDi(user: Partial<PublicUser>): AuthSession {
  const base = unaSessione();
  return { ...base, user: { ...base.user, ...user } };
}

const SOLO_GOOGLE = sessioneDi({ hasPassword: false, hasGoogle: true });

describe("googleDisponibile", () => {
  it("c'e' quando il client id c'e' e si e' in un browser", () => {
    expect(googleDisponibile("web.apps.googleusercontent.com", {})).toBe(true);
  });

  it("non c'e' senza client id, o con uno vuoto", () => {
    expect(googleDisponibile(undefined, {})).toBe(false);
    expect(googleDisponibile("   ", {})).toBe(false);
  });

  it("non c'e' dentro il guscio nativo, anche con il client id", () => {
    // Google rifiuta l'accesso da una WebView: il pulsante aprirebbe una
    // pagina di errore di Google invece di un accesso.
    const guscio = { Capacitor: { isNativePlatform: () => true } };
    expect(googleDisponibile("web.apps.googleusercontent.com", guscio)).toBe(false);
  });
});

/** Scrive lo stato della sessione, perche' il caso possa leggere se si e' entrati. */
function Sonda(): React.JSX.Element {
  const { state } = useSession();
  return <output data-testid="sessione">{state.kind}</output>;
}

describe("LoginScreen con Google", () => {
  function montaLogin(client: ApiClient, google: AccessoGoogle | null): void {
    montaConApi(
      client,
      conGoogle(
        <SessionProvider>
          <LoginScreen />
          <Sonda />
        </SessionProvider>,
        google,
      ),
    );
  }

  it("senza Google configurato non c'e' ne' il pulsante ne' l'«oppure»", async () => {
    montaLogin(creaClienteFinto({ restoreSession: () => Promise.resolve(null) }), null);
    await act(async () => {});

    expect(screen.queryByRole("button", { name: "Continua con Google" })).toBeNull();
    expect(screen.queryByText("oppure")).toBeNull();
  });

  it("con Google il token va al server con la lingua del dispositivo, e non parte il login", async () => {
    const chiesti: { idToken: string; locale?: string | undefined }[] = [];
    const client = creaClienteFinto({
      restoreSession: () => Promise.resolve(null),
      loginWithGoogle: (input) => {
        chiesti.push(input);
        return Promise.resolve(unaSessione());
      },
    });
    montaLogin(client, GOOGLE);

    await userEvent.setup().click(await screen.findByRole("button", { name: "Continua con Google" }));

    await waitFor(() => {
      expect(chiesti).toEqual([{ idToken: TOKEN, locale: navigator.language }]);
    });
    // E la sessione e' aperta: e' cio' che fa sparire la schermata d'accesso.
    await waitFor(() => {
      expect(screen.getByTestId("sessione").textContent).toBe("attiva");
    });
    // Il finto lancia su `login` non insegnato: se il pulsante avesse fatto
    // partire il modulo, il caso cadrebbe con quel messaggio.
  });

  it("un rifiuto del server si legge nello stesso riquadro del modulo", async () => {
    const client = creaClienteFinto({
      restoreSession: () => Promise.resolve(null),
      loginWithGoogle: () =>
        Promise.reject(
          new ApiError({ code: "SIGNUP_DISABLED", message: "La registrazione e' chiusa", status: 403 }),
        ),
    });
    montaLogin(client, GOOGLE);

    await userEvent.setup().click(await screen.findByRole("button", { name: "Continua con Google" }));

    expect((await screen.findByRole("alert")).textContent).toBe("La registrazione e' chiusa");
    // Fuori, e non dentro.
    expect(screen.getByTestId("sessione").textContent).toBe("assente");
  });
});

describe("AccountScreen per chi entra solo con Google", () => {
  async function montaAccount(
    sessione: AuthSession,
    risposte: Partial<ApiClient>,
    google: AccessoGoogle | null = GOOGLE,
  ): Promise<void> {
    const client = creaClienteFinto({
      restoreSession: () => Promise.resolve(sessione.user),
      listSessions: () =>
        Promise.resolve({
          sessions: [
            { id: "fam-questo", createdAt: new Date().toISOString(), current: true },
            { id: "fam-altro", createdAt: new Date().toISOString(), current: false },
          ],
        }),
      ...risposte,
    });
    montaConApi(
      client,
      conGoogle(
        <CaptureContext.Provider
          value={creaCapturaFinta({ svuotaCoda: () => Promise.resolve() })}
        >
          <SessionProvider>
            <AccountScreen />
          </SessionProvider>
        </CaptureContext.Provider>,
        google,
      ),
    );
    await act(async () => {});
  }

  function sezione(titolo: string): HTMLElement {
    const h2 = screen.getByRole("heading", { name: titolo });
    const contenitore = h2.closest("section");
    if (contenitore === null) {
      throw new Error(`La sezione «${titolo}» non sta in un <section>: il caso non regge.`);
    }
    return contenitore;
  }

  it("non chiede nessuna password: in ogni sezione c'e' la conferma con Google", async () => {
    await montaAccount(SOLO_GOOGLE, {});

    expect(screen.queryByLabelText("Password attuale")).toBeNull();
    expect(screen.queryByLabelText("La tua password")).toBeNull();
    expect(
      within(sezione("Scollega gli altri dispositivi")).getByRole("button", {
        name: "Accedi con Google",
      }),
    ).toBeTruthy();
  });

  it("chi ha la password la vede chiesta come sempre, anche se Google c'e'", async () => {
    // L'opposto del caso sopra: Google e' la prova di chi non ha altro, non un
    // modo di saltare la password di chi ce l'ha.
    await montaAccount(sessioneDi({ hasPassword: true, hasGoogle: true }), {});

    expect(screen.getByLabelText("Password attuale")).toBeTruthy();
    expect(screen.getByLabelText("La tua password")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accedi con Google" })).toBeNull();
  });

  it("cancella il conto con il token di Google, dopo la conferma e il secondo pulsante", async () => {
    const chiesti: unknown[] = [];
    await montaAccount(SOLO_GOOGLE, {
      deleteAccount: (input) => {
        chiesti.push(input);
        return Promise.resolve({ vocali: 0, schede: 0, sessioni: 1 });
      },
    });
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Voglio cancellare il conto" }));
    const cancella = within(sezione("Cancella il conto"));
    await utente.click(cancella.getByRole("button", { name: "Accedi con Google" }));
    // La conferma da sola non cancella niente: serve ancora il pulsante rosso.
    expect(chiesti).toEqual([]);

    await utente.click(cancella.getByRole("button", { name: "Cancella tutto per sempre" }));

    await waitFor(() => {
      expect(chiesti).toEqual([{ googleIdToken: TOKEN }]);
    });
  });

  it("senza la conferma il pulsante rosso non manda niente, e dice cosa manca", async () => {
    const chiesti: unknown[] = [];
    await montaAccount(SOLO_GOOGLE, {
      deleteAccount: (input) => {
        chiesti.push(input);
        return Promise.resolve({ vocali: 0, schede: 0, sessioni: 1 });
      },
    });
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Voglio cancellare il conto" }));
    await utente.click(screen.getByRole("button", { name: "Cancella tutto per sempre" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Prima conferma con Google che sei tu.",
    );
    expect(chiesti).toEqual([]);
  });

  it("un rifiuto rimette il pulsante di Google: la conferma di prima non si riusa", async () => {
    await montaAccount(SOLO_GOOGLE, {
      deleteAccount: () =>
        Promise.reject(
          new ApiError({
            code: "GOOGLE_TOKEN_INVALID",
            message: "Google non ha confermato chi sei. Riprova.",
            status: 401,
          }),
        ),
    });
    const utente = userEvent.setup();

    await utente.click(screen.getByRole("button", { name: "Voglio cancellare il conto" }));
    const cancella = within(sezione("Cancella il conto"));
    await utente.click(cancella.getByRole("button", { name: "Accedi con Google" }));
    expect(cancella.queryByRole("button", { name: "Accedi con Google" })).toBeNull();

    await utente.click(cancella.getByRole("button", { name: "Cancella tutto per sempre" }));

    expect(await cancella.findByRole("button", { name: "Accedi con Google" })).toBeTruthy();
  });

  // La stessa precauzione — dopo un rifiuto la conferma si rifa' — sta in
  // quattro punti dello schermo. La cancellazione ha il suo caso qui sopra;
  // questi sono gli altri tre, uno per punto, perche' ognuno e' una riga a se'.
  const RIFIUTO = new ApiError({
    code: "GOOGLE_TOKEN_INVALID",
    message: "Google non ha confermato chi sei. Riprova.",
    status: 401,
  });

  it("scollegare gli altri, rifiutato, rimette il pulsante di Google", async () => {
    await montaAccount(SOLO_GOOGLE, { revokeOtherSessions: () => Promise.reject(RIFIUTO) });
    const utente = userEvent.setup();
    const scollega = within(sezione("Scollega gli altri dispositivi"));

    await utente.click(scollega.getByRole("button", { name: "Accedi con Google" }));
    await utente.click(scollega.getByRole("button", { name: "Scollega gli altri" }));

    expect(await scollega.findByRole("button", { name: "Accedi con Google" })).toBeTruthy();
  });

  it("chiuderne uno, rifiutato, rimette il pulsante di Google", async () => {
    await montaAccount(SOLO_GOOGLE, { revokeSession: () => Promise.reject(RIFIUTO) });
    const utente = userEvent.setup();
    const scollega = within(sezione("Scollega gli altri dispositivi"));

    await utente.click(scollega.getByRole("button", { name: "Accedi con Google" }));
    await utente.click(await scollega.findByRole("button", { name: /^Scollega il dispositivo/ }));

    expect(await scollega.findByRole("button", { name: "Accedi con Google" })).toBeTruthy();
  });

  it("impostare la password, rifiutato, rimette il pulsante di Google", async () => {
    await montaAccount(SOLO_GOOGLE, { changePassword: () => Promise.reject(RIFIUTO) });
    const utente = userEvent.setup();
    const imposta = within(sezione("Imposta una password"));

    await utente.click(imposta.getByRole("button", { name: "Accedi con Google" }));
    await utente.type(imposta.getByLabelText("Password nuova"), "una-password-nuova-lunga");
    await utente.type(imposta.getByLabelText("Ripeti la password nuova"), "una-password-nuova-lunga");
    await utente.click(imposta.getByRole("button", { name: "Imposta la password" }));

    expect(await imposta.findByRole("button", { name: "Accedi con Google" })).toBeTruthy();
  });

  it("i pulsanti delle righe restano spenti finche' Google non ha confermato", async () => {
    const chiesti: unknown[] = [];
    await montaAccount(SOLO_GOOGLE, {
      revokeSession: (input) => {
        chiesti.push(input);
        return Promise.resolve({ revoked: 1 });
      },
    });
    const utente = userEvent.setup();
    const scollega = within(sezione("Scollega gli altri dispositivi"));
    const riga = await scollega.findByRole("button", { name: /^Scollega il dispositivo/ });

    expect((riga as HTMLButtonElement).disabled).toBe(true);

    await utente.click(scollega.getByRole("button", { name: "Accedi con Google" }));
    expect((riga as HTMLButtonElement).disabled).toBe(false);

    await utente.click(riga);
    await waitFor(() => {
      expect(chiesti).toEqual([{ sessionId: "fam-altro", googleIdToken: TOKEN }]);
    });
  });

  it("scollega gli altri con il token di Google", async () => {
    const chiesti: unknown[] = [];
    await montaAccount(SOLO_GOOGLE, {
      revokeOtherSessions: (input) => {
        chiesti.push(input);
        return Promise.resolve({ revoked: 1 });
      },
    });
    const utente = userEvent.setup();
    const scollega = within(sezione("Scollega gli altri dispositivi"));

    await utente.click(scollega.getByRole("button", { name: "Accedi con Google" }));
    await utente.click(scollega.getByRole("button", { name: "Scollega gli altri" }));

    await waitFor(() => {
      expect(chiesti).toEqual([{ googleIdToken: TOKEN }]);
    });
  });

  it("si da' una password con Google, e da li' la schermata la chiede come a tutti", async () => {
    const chiesti: unknown[] = [];
    await montaAccount(SOLO_GOOGLE, {
      changePassword: (input) => {
        chiesti.push(input);
        return Promise.resolve(sessioneDi({ hasPassword: true, hasGoogle: true }));
      },
    });
    const utente = userEvent.setup();
    const imposta = within(sezione("Imposta una password"));

    await utente.click(imposta.getByRole("button", { name: "Accedi con Google" }));
    await utente.type(imposta.getByLabelText("Password nuova"), "una-password-nuova-lunga");
    await utente.type(imposta.getByLabelText("Ripeti la password nuova"), "una-password-nuova-lunga");
    await utente.click(imposta.getByRole("button", { name: "Imposta la password" }));

    await waitFor(() => {
      expect(chiesti).toEqual([
        { googleIdToken: TOKEN, newPassword: "una-password-nuova-lunga" },
      ]);
    });
    // L'utente aggiornato arriva alla sessione: la sezione cambia nome e il
    // campo della password attuale compare.
    expect(await screen.findByRole("heading", { name: "Cambia password" })).toBeTruthy();
    expect(screen.getByLabelText("Password attuale")).toBeTruthy();
  });

  it("su un dispositivo senza Google lo dice, invece di un pulsante che non parte", async () => {
    await montaAccount(SOLO_GOOGLE, {}, null);

    // Per ruolo e non per testo: `getByText` trova anche un avviso nascosto, e
    // un avviso nascosto e' proprio il difetto da escludere.
    expect(
      within(sezione("Scollega gli altri dispositivi")).getByRole("status").textContent,
    ).toMatch(/Apri WikiMyLife dal browser/);
    expect(screen.queryByRole("button", { name: "Accedi con Google" })).toBeNull();
  });
});
