import { createContext, useContext, useEffect, useRef, useState } from "react";
import { inGuscioNativo } from "./serviceWorker";

/**
 * Il pulsante di Google, e l'unico posto dell'app che parla con Google.
 *
 * ## Cosa fa, e cosa no
 *
 * Disegna il pulsante ufficiale di Google e, quando l'utente si e' fatto
 * riconoscere, consegna l'ID token a chi lo ha chiesto. Non decide niente: se
 * quel token apra un conto, ne colleghi uno o ne crei uno lo decide il server
 * (`auth.service.ts`, `loginWithGoogle`). Qui non c'e' nessuna regola del
 * prodotto, com'e' giusto in un frontend.
 *
 * ## Perche' il pulsante di Google e non uno disegnato qui
 *
 * Perche' Google lo chiede, e perche' e' il solo modo in cui il token arriva
 * senza reindirizzare la pagina: il pulsante apre una finestrella di Google e
 * restituisce il token a una funzione. Un pulsante nostro dovrebbe passare dal
 * flusso con i reindirizzamenti, cioe' uscire dall'app e rientrarci — e perdere
 * per strada lo stato di una schermata a meta'.
 *
 * ## Perche' un contesto
 *
 * Perche' il pulsante vero carica uno script da `accounts.google.com`, che nei
 * test non esiste e non deve esistere. Le schermate chiedono il pulsante al
 * contesto; `main.tsx` ci mette quello vero, i test uno finto che e' un
 * `<button>` qualunque. Senza contesto — il valore predefinito — il pulsante
 * non c'e', ed e' esattamente cio' che deve succedere quando Google non e'
 * configurato: nessuna schermata mostra una porta che non si apre.
 */

export interface PropsPulsanteGoogle {
  /** «Continua con Google» all'accesso, «Accedi con Google» per confermare. */
  readonly testo: "continue_with" | "signin_with";
  readonly onToken: (idToken: string) => void;
}

export interface AccessoGoogle {
  readonly Pulsante: (props: PropsPulsanteGoogle) => React.JSX.Element;
}

export const GoogleContext = createContext<AccessoGoogle | null>(null);

export function useGoogle(): AccessoGoogle | null {
  return useContext(GoogleContext);
}

/**
 * Se su questo sito l'accesso con Google si puo' offrire.
 *
 * ## Perche' non dentro il guscio nativo
 *
 * Perche' Google rifiuta l'accesso da dentro una WebView («disallowed
 * useragent»): e' una sua regola contro le app che potrebbero leggere la
 * password digitata nella pagina di Google. Nell'app Android e iOS il pulsante
 * aprirebbe una finestra che non si apre, o una pagina di errore di Google.
 * Li' servira' un plugin nativo, ed e' un giro a parte; fino ad allora il
 * pulsante nell'app non c'e'.
 *
 * Una funzione pura e non un `if` in `main.tsx`, perche' e' l'unica decisione
 * di questo file che valga la pena provare da sola.
 */
export function googleDisponibile(clientId: string | undefined, finestra: object): boolean {
  return clientId !== undefined && clientId.trim() !== "" && !inGuscioNativo(finestra);
}

// ---------------------------------------------------------------------------
// Il pulsante vero
// ---------------------------------------------------------------------------

/**
 * La parte di Google Identity Services che si usa, scritta a mano.
 *
 * Il pacchetto di tipi di Google porta con se' tutta l'API; qui servono due
 * funzioni e una manciata di opzioni, e dichiararle a mano dice anche quali
 * sono — cioe' quanto di Google questo file tocca davvero.
 */
interface GoogleAccountsId {
  initialize(config: {
    readonly client_id: string;
    readonly callback: (risposta: { readonly credential: string }) => void;
    readonly ux_mode: "popup";
    readonly auto_select: boolean;
    readonly cancel_on_tap_outside: boolean;
  }): void;
  renderButton(
    contenitore: HTMLElement,
    opzioni: {
      readonly type: "standard";
      readonly theme: "outline" | "filled_black";
      readonly size: "large";
      readonly text: "continue_with" | "signin_with";
      readonly shape: "pill";
      readonly logo_alignment: "center";
      readonly width: number;
      readonly locale: string;
      readonly click_listener: () => void;
    },
  ): void;
}

type FinestraConGoogle = Window & {
  google?: { readonly accounts: { readonly id: GoogleAccountsId } };
};

const SCRIPT_GOOGLE = "https://accounts.google.com/gsi/client";

/**
 * Crea l'accesso vero. Lo chiama `main.tsx`, una volta.
 *
 * ## Uno script, un `initialize`, tanti pulsanti
 *
 * `initialize` di Google accetta una sola funzione di ritorno per tutta la
 * pagina, mentre di pulsanti ce ne possono essere piu' d'uno insieme — nella
 * schermata dell'account, uno per sezione. Ogni pulsante, quando viene
 * premuto, si segna come destinatario (`click_listener`), e la funzione unica
 * consegna il token all'ultimo premuto. E' l'unico che puo' averlo chiesto:
 * la finestrella di Google e' una alla volta.
 */
export function creaAccessoGoogle(clientId: string, finestra: FinestraConGoogle): AccessoGoogle {
  let destinatario: ((idToken: string) => void) | null = null;
  let pronto: Promise<GoogleAccountsId> | null = null;

  function carica(): Promise<GoogleAccountsId> {
    pronto ??= new Promise<GoogleAccountsId>((risolvi, rifiuta) => {
      const script = finestra.document.createElement("script");
      script.src = SCRIPT_GOOGLE;
      script.async = true;
      script.onload = () => {
        const id = finestra.google?.accounts.id;
        if (id === undefined) {
          rifiuta(new Error("Lo script di Google non ha esposto google.accounts.id"));
          return;
        }
        id.initialize({
          client_id: clientId,
          callback: (risposta) => {
            destinatario?.(risposta.credential);
          },
          ux_mode: "popup",
          // Mai entrare da soli: l'utente deve premere. Un accesso automatico
          // su un telefono condiviso aprirebbe il conto di chi l'ha usato prima.
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        risolvi(id);
      };
      script.onerror = () => {
        // Al prossimo tentativo si riprova da capo: una rete caduta un momento
        // non deve spegnere Google per tutta la vita della pagina.
        pronto = null;
        rifiuta(new Error("Lo script di Google non si e' caricato"));
      };
      finestra.document.head.appendChild(script);
    });
    return pronto;
  }

  function Pulsante({ testo, onToken }: PropsPulsanteGoogle): React.JSX.Element {
    const contenitore = useRef<HTMLDivElement>(null);
    // Il destinatario e' letto al momento del clic, quindi prende sempre la
    // funzione piu' recente: una closure presa al montaggio consegnerebbe il
    // token a una versione vecchia della schermata, con lo stato di allora.
    const ultimoOnToken = useRef(onToken);
    ultimoOnToken.current = onToken;
    const [guasto, setGuasto] = useState(false);

    useEffect(() => {
      let vivo = true;
      carica()
        .then((id) => {
          const nodo = contenitore.current;
          if (!vivo || nodo === null) {
            return;
          }
          const scuro = finestra.matchMedia("(prefers-color-scheme: dark)").matches;
          id.renderButton(nodo, {
            type: "standard",
            theme: scuro ? "filled_black" : "outline",
            size: "large",
            text: testo,
            shape: "pill",
            logo_alignment: "center",
            // Google vuole i pixel, non una percentuale; 400 e' il suo massimo.
            width: Math.min(400, Math.max(200, nodo.clientWidth)),
            locale: "it",
            click_listener: () => {
              destinatario = (idToken) => {
                ultimoOnToken.current(idToken);
              };
            },
          });
        })
        .catch(() => {
          if (vivo) {
            setGuasto(true);
          }
        });
      return () => {
        vivo = false;
      };
    }, [testo]);

    if (guasto) {
      return (
        <p className="muto" role="status">
          Google non risponde adesso. Riprova fra poco.
        </p>
      );
    }

    return <div ref={contenitore} className="google" />;
  }

  return { Pulsante };
}
