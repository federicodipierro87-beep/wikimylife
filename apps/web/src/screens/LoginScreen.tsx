import { useState } from "react";
import { useGoogle } from "../google";
import { messaggioDi, useSession } from "../session";
import { CollegamentoPrivacy } from "./Privacy";

/**
 * Entrata e registrazione, nello stesso modulo.
 *
 * Due schermate separate per due campi identici sarebbero due schermate da
 * mantenere. Il pulsante che cambia sotto e' abbastanza: chi si sta iscrivendo
 * lo fa una volta sola nella vita dell'account.
 */
export function LoginScreen(): React.JSX.Element {
  const { login, signup, loginWithGoogle } = useSession();
  const google = useGoogle();
  const [nuovo, setNuovo] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errore, setErrore] = useState<string | null>(null);
  const [attesa, setAttesa] = useState(false);

  /**
   * Il token di Google, al server. Stesso errore e stessa attesa del modulo:
   * sono due porte della stessa schermata, e un messaggio rosso deve stare in
   * un posto solo, qualunque porta lo abbia prodotto.
   */
  async function conGoogle(idToken: string): Promise<void> {
    setErrore(null);
    setAttesa(true);
    try {
      await loginWithGoogle(idToken);
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
    } finally {
      setAttesa(false);
    }
  }

  async function invia(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setErrore(null);
    setAttesa(true);
    try {
      await (nuovo ? signup(email, password) : login(email, password));
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
    } finally {
      setAttesa(false);
    }
  }

  return (
    <main className="schermata schermata--centrata accesso">
      {/* Lo stesso file dell'icona sulla schermata Home, e non un disegno
          rifatto qui: chi ha appena toccato l'icona deve ritrovarla, e un
          secondo disegno si sarebbe allontanato dal primo alla prima modifica
          di `scripts/icone.ts`. `alt` vuoto perche' il nome lo dice gia' il
          titolo subito sotto, e letto due volte e' rumore. */}
      <img className="marchio__icona" src="/icona.svg" alt="" width="72" height="72" />
      <h1 className="marchio">WikiMyLife</h1>
      <p className="sottotitolo">Racconta una volta. Ritrovalo per sempre.</p>

      <form
        className="modulo"
        onSubmit={(e) => {
          void invia(e);
        }}
      >
        <label className="campo">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            autoComplete="email"
            inputMode="email"
            required
          />
        </label>

        <label className="campo">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            // Il gestore di password deve sapere se sta salvando o compilando:
            // sbagliare questo attributo e' il motivo per cui tante iscrizioni
            // finiscono con una password mai salvata.
            autoComplete={nuovo ? "new-password" : "current-password"}
            required
          />
        </label>

        {errore !== null && (
          <p className="avviso avviso--errore" role="alert">
            {errore}
          </p>
        )}

        <button type="submit" className="bottone bottone--primario" disabled={attesa}>
          {attesa ? "Un attimo…" : nuovo ? "Crea l'account" : "Entra"}
        </button>

        {/* Dentro il pannello e sotto il pulsante principale: e' la seconda
            porta, non la prima. Chi ha gia' un conto con la password lo trova
            dov'era; chi ha Google lo trova a un pollice di distanza. E il
            pulsante e' lo stesso nei due modi — accesso e iscrizione — perche'
            con Google la differenza la fa il server, non chi preme. */}
        {google !== null && (
          <div className="accesso__google">
            <p className="separatore" aria-hidden="true">
              oppure
            </p>
            <google.Pulsante
              testo="continue_with"
              onToken={(idToken) => {
                void conGoogle(idToken);
              }}
            />
          </div>
        )}
      </form>

      <button
        type="button"
        className="bottone bottone--piatto"
        onClick={() => {
          setNuovo(!nuovo);
          setErrore(null);
        }}
      >
        {nuovo ? "Ho gia' un account" : "Non ho un account"}
      </button>

      <CollegamentoPrivacy />
    </main>
  );
}
