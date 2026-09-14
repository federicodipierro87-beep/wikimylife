import { PASSWORD_MIN_LENGTH, type OpenSessionsResponse } from "@wikimylife/shared";
import { useState } from "react";
import { useApi } from "../api";
import { formatQuando } from "../format";
import { goBack } from "../router";
import { messaggioDi, useSession } from "../session";
import { useAsync, type Async } from "../useAsync";

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
  | { readonly kind: "fatto"; readonly quante: number }
  /**
   * Una sola, scelta nell'elenco.
   *
   * Un ramo suo e non `fatto` con `quante: 1`: quella frase dice «un altro
   * dispositivo e' stato scollegato», che qui sarebbe vera e insufficiente —
   * gli altri due sono ancora nella lista sopra, e chi legge non saprebbe se il
   * gesto ha preso la riga che aveva premuto o una a caso. E `quante: 0`
   * direbbe «non c'era nessun altro dispositivo collegato», che nel caso di una
   * riga gia' chiusa e' semplicemente falso.
   *
   * Il numero c'e' lo stesso perche' lo zero qui ha un significato suo: «quella
   * sessione era gia' chiusa», che succede davvero con due schede aperte sullo
   * stesso account.
   */
  | { readonly kind: "chiusa"; readonly quante: number };

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

  /**
   * Quale riga sta partendo, non «una riga sta partendo».
   *
   * Un booleano condiviso spegnerebbe tutti e tre i pulsanti, e chi guarda non
   * saprebbe quale ha premuto — che e' l'unica cosa che vorrebbe sapere in un
   * elenco di date tutte uguali. Con l'id dentro, solo la riga premuta cambia
   * etichetta, e le altre restano vive: e' anche la ragione per cui la chiave
   * della lista deve essere l'id e non la posizione.
   */
  const [inVolo, setInVolo] = useState<string | null>(null);

  /**
   * L'elenco vive qui e non in una sezione sua.
   *
   * Serve a tre cose, e nessuna delle tre funziona lontano dal modulo: dire
   * quanti dispositivi ci sono *prima* di premere; dare un metro al numero che
   * torna dopo, perche' «ne ho scollegate due» significa qualcosa solo a chi
   * sapeva che ce n'erano tre; e ospitare i pulsanti che ne chiudono uno solo,
   * che consumano la password scritta nel campo qui sotto.
   */
  const elenco = useAsync(() => apiClient.listSessions(), [apiClient]);

  /**
   * Una sola, quella premuta.
   *
   * Svuota il campo come fa `invia`, e per la stessa ragione piu' una: dopo il
   * primo gesto tutti i pulsanti tornano spenti, quindi un secondo clic
   * distratto sulla riga accanto non parte da solo. Chi vuole chiuderne due
   * riscrive la password, ed e' voluto — sono due decisioni diverse.
   */
  async function chiudiUna(sessionId: string): Promise<void> {
    setInVolo(sessionId);
    setEsito({ kind: "niente" });
    try {
      const { revoked } = await apiClient.revokeSession({
        sessionId,
        currentPassword: password,
      });
      setPassword("");
      setEsito({ kind: "chiusa", quante: revoked });
      elenco.ricarica();
    } catch (error: unknown) {
      // Come sopra: niente `ricarica` quando non e' stato revocato niente.
      setEsito({ kind: "errore", messaggio: messaggioDi(error) });
    } finally {
      setInVolo(null);
    }
  }

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
      // L'elenco appena mostrato adesso e' falso: ci sono ancora scritti sopra
      // i dispositivi che questa chiamata ha appena chiuso. Ricaricarlo e' cio'
      // che trasforma il numero in una verifica — si legge «due» e si vede la
      // lista accorciarsi di due.
      elenco.ricarica();
    } catch (error: unknown) {
      // Nessun `ricarica` di qua: non e' stato revocato niente, quindi la lista
      // a schermo e' ancora quella giusta, e rileggerla la farebbe sparire e
      // riapparire identica sotto un messaggio d'errore — come se il guasto
      // riguardasse anche lei.
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

      {/* L'elenco sta *dentro* il modulo, e non gli fa da didascalia sopra.
          Ogni riga ha un pulsante che manda al server la password scritta nel
          campo qui sotto: sono lo stesso gesto in due pezzi, e separarli
          vorrebbe dire un campo password fuori da qualunque form — che i
          gestori di password trattano peggio, e che rende `type="button"` sui
          pulsanti di riga una precauzione senza effetto invece della cosa che
          impedisce a un clic sulla riga di far partire «scollega gli altri». */}
      <form
        onSubmit={(e) => {
          void invia(e);
        }}
      >
        <Dispositivi
          stato={elenco.stato}
          // Spenti finche' il campo e' vuoto, con la stessa disciplina del
          // pulsante in fondo: senza password la richiesta partirebbe per
          // tornare indietro con un VALIDATION_FAILED, cioe' un errore rosso al
          // posto di un pulsante che si vede non essere ancora pronto.
          puoiChiudere={password !== ""}
          inVolo={inVolo}
          onChiudi={(id) => {
            void chiudiUna(id);
          }}
        />

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

        {esito.kind === "chiusa" && (
          // Lo zero non e' un errore e non e' un successo pieno: e' «quella
          // riga era gia' chiusa», che capita davvero con due schede aperte
          // sullo stesso account e con l'elenco vecchio di qualche minuto.
          // Dirlo com'e' evita la sola cosa peggiore delle due, cioe' far
          // credere di aver appena chiuso un dispositivo che era gia' andato —
          // e a chi ha perso un telefono quel dettaglio cambia la giornata.
          <p className="avviso avviso--fatto" role="status">
            {esito.quante === 0
              ? "Quel dispositivo era gia' scollegato."
              : "Il dispositivo e' stato scollegato."}
          </p>
        )}

        <button type="submit" className="bottone" disabled={attesa}>
          {attesa ? "Un attimo…" : "Scollega gli altri"}
        </button>
      </form>
    </section>
  );
}

/**
 * L'elenco dei dispositivi collegati, e di ognuno una cosa sola.
 *
 * ## Perche' una riga di sole date
 *
 * Un elenco che dicesse anche da dove e con che cosa ci si e' collegati, e
 * quando lo si e' fatto l'ultima volta, sarebbe piu' utile nel momento in cui
 * serve — e un registro degli spostamenti del proprietario in tutti gli altri,
 * leggibile da chiunque prenda in mano uno qualsiasi dei dispositivi elencati.
 * La data di nascita basta a distinguere «il telefono di ieri» da «quello di
 * due anni fa», che e' la domanda vera di chi sta guardando questa lista.
 *
 * ## Perche' l'errore e' muto e non un allarme
 *
 * Perche' non e' successo niente di grave: il pulsante qui sotto funziona
 * ancora, e continua a scollegare gli altri dispositivi anche se non si e'
 * riusciti a contarli. Un `role="alert"` rosso accanto a un modulo intatto
 * farebbe credere che il gesto sia diventato impossibile, e chi ha appena perso
 * un telefono smetterebbe di provarci.
 *
 * ## Perche' sulla riga di questo dispositivo non c'e' nessun pulsante
 *
 * Perche' chiudere la propria sessione e' uscire, e uscire sta dieci righe piu'
 * giu' nella stessa schermata, con il suo nome e la sua frase. Un secondo
 * pulsante che fa la stessa cosa con un'altra etichetta e' un modo per premerlo
 * credendo di premere l'altro. Il server la rifiuta comunque con un 409 — quella
 * e' la difesa contro un client che sbaglia, non la ragione per cui qui manca.
 */
function Dispositivi({
  stato,
  puoiChiudere,
  inVolo,
  onChiudi,
}: {
  stato: Async<OpenSessionsResponse>;
  puoiChiudere: boolean;
  inVolo: string | null;
  onChiudi: (sessionId: string) => void;
}): React.JSX.Element {
  if (stato.kind === "attesa") {
    return <p className="muto">Conto i dispositivi collegati…</p>;
  }

  if (stato.kind === "errore") {
    return <p className="muto">Non sono riuscito a leggere l&apos;elenco dei dispositivi.</p>;
  }

  const sessioni = stato.dato.sessions;

  return (
    <>
      <ul className="dispositivi">
        {sessioni.map((sessione) => {
          const quando = formatQuando(sessione.createdAt) ?? "in un momento che non so leggere";
          return (
            // La chiave e' l'id, e da quando i pulsanti esistono non e' piu' una
            // formalita'. Con la posizione, React riusa l'elemento della riga
            // sparita per quella che le scivola sotto: il pulsante che aveva il
            // fuoco resta a fuoco e adesso scollega un altro dispositivo, e
            // premere due volte di seguito — la cosa piu' naturale del mondo
            // quando si sta ripulendo un elenco — chiude una riga che nessuno
            // aveva guardato.
            <li key={sessione.id} className="dispositivo">
              <span>Collegato {quando}</span>
              {sessione.current ? (
                <span className="dispositivo__questo">questo dispositivo</span>
              ) : (
                <button
                  // `type="button"` e non il predefinito: qui dentro c'e' un
                  // `<form>`, e un pulsante senza tipo e' un submit. Premere
                  // «Scollega» su una riga farebbe partire «scollega gli altri»,
                  // cioe' il piu' distruttivo dei due gesti al posto del piu'
                  // piccolo, con la password gia' scritta nel campo.
                  type="button"
                  className="bottone bottone--piatto dispositivo__chiudi"
                  disabled={!puoiChiudere || inVolo === sessione.id}
                  // Tre pulsanti «Scollega» identici uno sotto l'altro non si
                  // distinguono leggendoli a voce. Il nome accessibile ripete la
                  // data della riga, ed e' l'unica cosa che le distingue.
                  // L'`aria-label` vince sul contenuto, quindi resta lo stesso
                  // anche mentre l'etichetta visibile dice «Un attimo».
                  aria-label={`Scollega il dispositivo collegato ${quando}`}
                  onClick={() => {
                    onChiudi(sessione.id);
                  }}
                >
                  {inVolo === sessione.id ? "Un attimo…" : "Scollega"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="muto">
        Di ognuno so soltanto da quando e&apos; collegato: non tengo traccia
        ne&apos; di dove sei ne&apos; di quando lo hai usato l&apos;ultima volta.
      </p>
    </>
  );
}
