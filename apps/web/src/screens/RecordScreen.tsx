import { useState } from "react";
import { formatDurataAudio } from "../format";
import { useCapture } from "../recording/CaptureProvider";
import { avvisoSpazio } from "../recording/spazio";
import { navigate } from "../router";
import { messaggioDi } from "../session";

/**
 * Un solo grande pulsante.
 *
 * E' la schermata piu' importante dell'app e quella con meno cose dentro, per
 * lo stesso motivo: se registrare richiede di scegliere qualcosa — un titolo,
 * una categoria, un progetto — la registrazione non avviene. Titolo, categoria
 * e tutto il resto li ricava lo stadio 3 dal parlato.
 *
 * Dopo lo stop non si aspetta niente. Si torna alla lista, dove l'indicatore
 * della coda racconta il resto senza bloccare nessuno.
 */
export function RecordScreen(): React.JSX.Element {
  const capture = useCapture();
  const [errore, setErrore] = useState<string | null>(null);

  const inCorso = capture.state.kind === "in-corso";
  const salvataggio = capture.state.kind === "salvataggio";
  // Prima di premere e non dopo aver parlato: e' tutta la ragione per cui
  // questo avviso esiste. Durante la registrazione sparisce, perche' a
  // microfono acceso non c'e' piu' niente da decidere.
  const spazio = inCorso ? null : avvisoSpazio(capture.spazio);

  async function premi(): Promise<void> {
    setErrore(null);
    try {
      if (inCorso) {
        await capture.stop();
        navigate({ name: "lista" });
      } else {
        await capture.start();
      }
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
    }
  }

  if (!capture.supportata) {
    return (
      <main className="schermata schermata--centrata">
        <p className="avviso avviso--errore">
          Questo browser non sa registrare audio. Serve un browser recente e una
          connessione sicura (https).
        </p>
      </main>
    );
  }

  return (
    <main className="schermata schermata--centrata registrazione">
      <p className="contatore" aria-live="off">
        {inCorso ? formatDurataAudio(capture.state.elapsedMs) : "0:00"}
      </p>

      <button
        type="button"
        className={`pulsantone ${inCorso ? "pulsantone--attivo" : ""}`}
        onClick={() => {
          void premi();
        }}
        disabled={salvataggio}
        // Il testo visibile e' un'icona: senza questo, chi usa un lettore di
        // schermo trova un pulsante senza nome nella schermata principale.
        aria-label={inCorso ? "Ferma la registrazione" : "Inizia a registrare"}
      >
        <span aria-hidden="true">{inCorso ? "■" : "●"}</span>
      </button>

      <p className="istruzione">
        {salvataggio
          ? "Sto salvando…"
          : inCorso
            ? "Racconta come si fa. Premi per finire."
            : "Premi e racconta una procedura."}
      </p>

      {inCorso && (
        <button
          type="button"
          className="bottone bottone--piatto"
          onClick={() => {
            void capture.cancel();
          }}
        >
          Annulla
        </button>
      )}

      {errore !== null && (
        <p className="avviso avviso--errore" role="alert">
          {errore}
        </p>
      )}

      {!capture.online && (
        <p className="avviso">
          Sei offline. La registrazione si salva sul telefono e parte da sola
          quando torna la rete.
        </p>
      )}

      {spazio !== null && (
        <p className="avviso avviso--spazio" role="status">
          {spazio}
        </p>
      )}
    </main>
  );
}
