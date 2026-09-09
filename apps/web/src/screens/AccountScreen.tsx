import { PASSWORD_MIN_LENGTH } from "@wikimylife/shared";
import { useState } from "react";
import { useApi } from "../api";
import { goBack } from "../router";
import { messaggioDi, useSession } from "../session";

/**
 * L'account: chi sei, cambia password, esci.
 *
 * ## Perche' non si chiama "Impostazioni"
 *
 * Perche' non ci sono impostazioni. Non c'e' niente da regolare in questa
 * applicazione — la lingua viene dal dispositivo, l'ordinamento lo decide il
 * server, i provider stanno nell'API — e una schermata che si chiama
 * Impostazioni e non ne contiene nessuna promette una stanza che non esiste. Se
 * un giorno una preferenza vera arrivera', il nome sara' ancora libero per lei.
 *
 * ## Perche' esiste adesso
 *
 * Perche' `POST /api/auth/password` e' rimasta per un commit intero una rotta
 * che nessuno poteva premere: c'era il client tipizzato, c'erano i test, e
 * l'unico modo di cambiare password era `curl`. Una difesa raggiungibile solo
 * da chi sa usare un terminale non difende quasi nessuno.
 *
 * E `logout` stava messo anche peggio: era in `session.tsx` da sempre, con il
 * suo bel commento sul perche' fosse un contesto e non uno stato, e non lo
 * chiamava nessuno. Dall'interfaccia non si poteva uscire — si poteva solo
 * svuotare lo storage del browser.
 *
 * ## Perche' tre sezioni e non due
 *
 * Perche' i modi di perdere il controllo di un account sono due, e finora
 * avevano una riparazione sola. «Qualcuno sa la mia password» si ripara
 * cambiandola. «Qualcuno ha il mio telefono» no: la password sta al sicuro nel
 * gestore, e cambiarla vuol dire riscriverla ovunque per un guasto che non la
 * riguarda. Le tre sezioni sono in ordine di quanto tolgono — la password e
 * tutti gli altri, tutti gli altri, solo questo — e ognuna dice in una riga
 * cosa lascia in piedi, perche' e' l'unica differenza che conta fra loro.
 */

/**
 * Un esito solo, e non un errore accanto a una conferma.
 *
 * Con due stati separati esiste il momento in cui sono veri insieme: si cambia
 * la password, compare il verde, si riprova e si sbaglia, e adesso lo schermo
 * dice contemporaneamente che e' andata bene e che non e' andata. Un'unione li
 * rende alternativi per costruzione, che e' quello che sono.
 */
type Esito =
  | { readonly kind: "niente" }
  | { readonly kind: "errore"; readonly messaggio: string }
  | { readonly kind: "fatto" };

/**
 * Lo stesso, ma il successo porta un numero.
 *
 * Il conto sta dentro il ramo «fatto» e non accanto: fuori esisterebbe anche
 * prima che qualcuno prema, e allora andrebbe uno zero da qualche parte —
 * indistinguibile dallo zero che vuol dire «non c'era nessun altro collegato»,
 * che e' invece l'informazione per cui il numero c'e'.
 */
type EsitoRevoca =
  | { readonly kind: "niente" }
  | { readonly kind: "errore"; readonly messaggio: string }
  | { readonly kind: "fatto"; readonly quante: number };

export function AccountScreen(): React.JSX.Element {
  const apiClient = useApi();
  const { state, logout } = useSession();

  const [attuale, setAttuale] = useState("");
  const [nuova, setNuova] = useState("");
  const [conferma, setConferma] = useState("");
  const [attesa, setAttesa] = useState(false);
  const [esito, setEsito] = useState<Esito>({ kind: "niente" });

  /**
   * Ogni tasto cancella l'esito di prima.
   *
   * Il messaggio precedente parla di cio' che c'era prima: appena il contenuto
   * cambia non descrive piu' niente. Il caso che conta e' il rosso — «le due
   * password non coincidono» che resta appeso sopra il campo che lo ha appena
   * corretto, e fa credere di non aver corretto abbastanza.
   */
  function scrittura(setta: (valore: string) => void) {
    return (event: React.ChangeEvent<HTMLInputElement>): void => {
      setta(event.target.value);
      setEsito((prima) => (prima.kind === "niente" ? prima : { kind: "niente" }));
    };
  }

  async function invia(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setEsito({ kind: "niente" });

    // Le due verifiche che restano di qua, e nient'altro.
    //
    // Il criterio non e' «controllare presto»: e' se il server, davanti allo
    // stesso sbaglio, sappia dire qualcosa di utile. Sulla password uguale alla
    // precedente lo sa — risponde CONFLICT con una frase che si mostra com'e' —
    // quindi ricopiare qui quella regola aggiungerebbe solo un secondo posto
    // dove cambiarla.
    //
    // Su queste due non lo sa. Che le due password nuove coincidano non puo'
    // proprio saperlo: la seconda non gliela manda nessuno, ed e' il campo che
    // esiste solo perche' qui non c'e' recupero password — una password nuova
    // digitata male e confermata male chiude fuori dall'account per sempre.
    // Sulla lunghezza risponderebbe VALIDATION_FAILED, cioe' "La richiesta non
    // e' valida": vero, e inservibile per chi deve capire cosa correggere.
    if (nuova !== conferma) {
      setEsito({ kind: "errore", messaggio: "Le due password nuove non coincidono." });
      return;
    }
    if (nuova.length < PASSWORD_MIN_LENGTH) {
      setEsito({
        kind: "errore",
        messaggio: `La password nuova deve avere almeno ${String(PASSWORD_MIN_LENGTH)} caratteri.`,
      });
      return;
    }

    setAttesa(true);
    try {
      await apiClient.changePassword({ currentPassword: attuale, newPassword: nuova });
      // Svuotare non e' pulizia. Dopo il cambio, `attuale` contiene una
      // password che non vale piu': lasciandola nel campo, un secondo invio
      // partirebbe con quella e tornerebbe INVALID_CREDENTIALS, cioe' un
      // «password sbagliata» subito sotto un «password cambiata».
      setAttuale("");
      setNuova("");
      setConferma("");
      setEsito({ kind: "fatto" });
    } catch (error: unknown) {
      setEsito({ kind: "errore", messaggio: messaggioDi(error) });
    } finally {
      setAttesa(false);
    }
  }

  return (
    <main className="schermata">
      <header className="testata">
        <button
          type="button"
          className="bottone bottone--piatto"
          onClick={goBack}
          aria-label="Torna indietro"
        >
          ‹
        </button>
        <h1>Il tuo account</h1>
      </header>

      {/* L'unico posto in cui l'app dice con quale account sta parlando. Su un
          telefono prestato e' l'informazione che vale piu' di tutte le altre
          messe insieme. */}
      {state.kind === "attiva" && <p className="muto">Sei collegato come {state.user.email}.</p>}

      <section className="sezione">
        <h2>Cambia password</h2>
        <p className="muto">
          Cambiarla scollega tutti gli altri dispositivi: questo resta dentro,
          gli altri dovranno rientrare con la password nuova. Scrivila due volte,
          perche&apos; se la sbagli non c&apos;e&apos; modo di recuperarla.
        </p>

        <form
          onSubmit={(e) => {
            void invia(e);
          }}
        >
          <label className="campo">
            <span>Password attuale</span>
            <input
              type="password"
              value={attuale}
              onChange={scrittura(setAttuale)}
              // La rotta la chiede anche se siamo gia' autenticati: il token
              // dice che c'e' una sessione aperta, non che davanti allo schermo
              // ci sia il proprietario.
              autoComplete="current-password"
              required
            />
          </label>

          <label className="campo">
            <span>Password nuova</span>
            <input
              type="password"
              value={nuova}
              onChange={scrittura(setNuova)}
              // Sbagliare questo attributo non si vede provando la schermata, e
              // produce un gestore di password che tiene quella vecchia dopo il
              // cambio. Senza recupero, e' un account perso.
              autoComplete="new-password"
              required
            />
          </label>

          <label className="campo">
            <span>Ripeti la password nuova</span>
            <input
              type="password"
              value={conferma}
              onChange={scrittura(setConferma)}
              autoComplete="new-password"
              required
            />
          </label>

          {esito.kind === "errore" && (
            <p className="avviso avviso--errore" role="alert">
              {esito.messaggio}
            </p>
          )}

          {esito.kind === "fatto" && (
            // La frase dice anche cosa e' successo altrove, perche' e' l'unico
            // avviso che l'utente ricevera': sull'altro telefono la sessione
            // cade in silenzio, e senza questa riga sembrera' un guasto.
            <p className="avviso avviso--fatto" role="status">
              Password cambiata. Gli altri dispositivi sono stati scollegati.
            </p>
          )}

          <button type="submit" className="bottone bottone--primario" disabled={attesa}>
            {attesa ? "Un attimo…" : "Cambia password"}
          </button>
        </form>
      </section>

      <ScollegaAltri />

      <section className="sezione">
        <h2>Esci</h2>
        <p className="muto">Chiude solo questo dispositivo. Gli altri restano collegati.</p>
        <button
          type="button"
          className="bottone"
          onClick={() => {
            // Nessuna conferma e nessuno stato di attesa: uscire non distrugge
            // niente e si rimedia rientrando, e `logout` non fallisce mai — se
            // il server non risponde la sessione locale si svuota lo stesso, e
            // questa schermata si smonta da sola.
            void logout();
          }}
        >
          Esci da questo dispositivo
        </button>
      </section>
    </main>
  );
}

/**
 * La sezione di mezzo, con il proprio stato invece che con quello della
 * schermata.
 *
 * Le due sezioni chiedono la stessa password e hanno ciascuna il proprio esito.
 * Tenendoli insieme, un «password sbagliata» digitato qui comparirebbe sotto il
 * modulo di sopra, dove nessuno lo ha chiesto; e un «password cambiata»
 * resterebbe acceso mentre si scrive qui, dicendo che e' andata bene una cosa
 * che non e' ancora partita. Sono due conversazioni diverse con lo stesso
 * server, e non devono avere una casella di testo in comune.
 */
function ScollegaAltri(): React.JSX.Element {
  const apiClient = useApi();
  const [password, setPassword] = useState("");
  const [attesa, setAttesa] = useState(false);
  const [esito, setEsito] = useState<EsitoRevoca>({ kind: "niente" });

  async function invia(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setAttesa(true);
    setEsito({ kind: "niente" });
    try {
      const { revoked } = await apiClient.revokeOtherSessions({ currentPassword: password });
      // Come nel cambio password: il campo si svuota perche' quello che
      // contiene e' un segreto che non serve piu' a questa schermata, e perche'
      // un secondo invio involontario partirebbe da solo.
      setPassword("");
      setEsito({ kind: "fatto", quante: revoked });
    } catch (error: unknown) {
      setEsito({ kind: "errore", messaggio: messaggioDi(error) });
    } finally {
      setAttesa(false);
    }
  }

  return (
    <section className="sezione">
      <h2>Scollega gli altri dispositivi</h2>
      <p className="muto">
        Per quando un telefono non e&apos; piu&apos; tuo e la password invece va
        bene. Questo dispositivo resta collegato; gli altri dovranno rientrare
        con la stessa password di adesso, che non cambia.
      </p>

      <form
        onSubmit={(e) => {
          void invia(e);
        }}
      >
        <label className="campo">
          <span>La tua password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setEsito((prima) => (prima.kind === "niente" ? prima : { kind: "niente" }));
            }}
            // Chiesta anche qui, e qui e' quella che conta di piu': senza,
            // basterebbe avere in mano il telefono per premere il pulsante e
            // restare l'unico collegato.
            autoComplete="current-password"
            required
          />
        </label>

        {esito.kind === "errore" && (
          <p className="avviso avviso--errore" role="alert">
            {esito.messaggio}
          </p>
        )}

        {esito.kind === "fatto" && (
          // Il numero, e non un «fatto» che vale per tutti i casi. Zero e' la
          // risposta piu' importante delle tre: dice che il dispositivo che si
          // stava cercando non era collegato, e chi legge «fatto» al suo posto
          // smetterebbe di cercarlo credendo di averlo chiuso.
          <p className="avviso avviso--fatto" role="status">
            {esito.quante === 0
              ? "Non c'era nessun altro dispositivo collegato."
              : esito.quante === 1
                ? "Un altro dispositivo e' stato scollegato."
                : `${String(esito.quante)} altri dispositivi sono stati scollegati.`}
          </p>
        )}

        <button type="submit" className="bottone" disabled={attesa}>
          {attesa ? "Un attimo…" : "Scollega gli altri"}
        </button>
      </form>
    </section>
  );
}
