import { useState } from "react";
import { messaggioDi, useSession } from "../session";

/**
 * Entrata e registrazione, nello stesso modulo.
 *
 * Due schermate separate per due campi identici sarebbero due schermate da
 * mantenere. Il pulsante che cambia sotto e' abbastanza: chi si sta iscrivendo
 * lo fa una volta sola nella vita dell'account.
 */
export function LoginScreen(): React.JSX.Element {
  const { login, signup } = useSession();
  const [nuovo, setNuovo] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errore, setErrore] = useState<string | null>(null);
  const [attesa, setAttesa] = useState(false);

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
    <main className="schermata schermata--centrata">
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
    </main>
  );
}
