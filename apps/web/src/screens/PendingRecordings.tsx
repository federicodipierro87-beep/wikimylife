import type { RecordingState } from "@wikimylife/shared";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { avvisoDi, formatDurataAudio, formatQuando } from "../format";
import { messaggioDi } from "../session";
import { useAsync } from "../useAsync";

/**
 * Cio' che e' stato raccontato e non e' ancora una scheda.
 *
 * Sta in cima all'elenco delle procedure e non su una schermata sua. Una
 * schermata separata avrebbe voluto una voce di menu, e una voce di menu si
 * apre solo se si sospetta gia' che qualcosa sia andato storto — mentre il
 * punto e' proprio che non lo si sospetta: si racconta una procedura, si mette
 * via il telefono, e la scheda semplicemente non c'e'. Qui la si vede senza
 * cercarla, nel posto in cui si andrebbe comunque a guardare se ci sia.
 *
 * Sparisce da sola quando non resta niente in sospeso: una sezione «0 in
 * lavorazione» sarebbe rumore permanente su una schermata che nel caso normale
 * non ha niente da dire.
 */

/** Ogni quanto si richiede la lista, e solo se qualcosa si sta muovendo. */
const RITMO_MS = 5000;

export function PendingRecordings(): React.JSX.Element | null {
  const { stato, ricarica } = useAsync<readonly RecordingState[]>(
    async () => (await apiClient.listPendingRecordings()).items,
    [],
  );

  // Il polling parte solo se c'e' qualcosa che puo' cambiare da solo. Una lista
  // di sole registrazioni ferme non cambia finche' non si preme un pulsante, e
  // continuare a chiederla sarebbe una richiesta ogni cinque secondi per
  // ricevere sempre la stessa risposta — su una connessione mobile, per giorni.
  const inMovimento =
    stato.kind === "pronto" &&
    stato.dato.some((r) => r.status === "BOZZA_AUDIO" || r.status === "IN_ELABORAZIONE");

  useEffect(() => {
    if (!inMovimento) {
      return;
    }
    const timer = setInterval(ricarica, RITMO_MS);
    return () => {
      clearInterval(timer);
    };
  }, [inMovimento, ricarica]);

  if (stato.kind !== "pronto" || stato.dato.length === 0) {
    // Un errore qui non si mostra: questa sezione e' un di piu' sopra la lista
    // delle schede, e un avviso rosso in cima per una richiesta accessoria
    // fallita farebbe sembrare rotta una schermata che funziona.
    return null;
  }

  return (
    <section className="sospese">
      <h2>In lavorazione</h2>
      <ul className="elenco">
        {stato.dato.map((r) => (
          <li key={r.id}>
            <Sospesa r={r} onCambiata={ricarica} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Sospesa({
  r,
  onCambiata,
}: {
  r: RecordingState;
  onCambiata: () => void;
}): React.JSX.Element | null {
  const [attesa, setAttesa] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  const avviso = avvisoDi(r);
  if (avviso === null) {
    return null;
  }

  async function riprova(): Promise<void> {
    setAttesa(true);
    setErrore(null);
    try {
      await apiClient.retryRecording(r.id);
      onCambiata();
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
    } finally {
      setAttesa(false);
    }
  }

  return (
    <article className={`sospesa sospesa--${avviso.kind}`}>
      <p className="sospesa__stato">{avviso.testo}</p>

      {/* Quando, quanto lunga, e dove: e' tutto cio' che resta per riconoscere
          quale dei vocali di ieri sia questo, visto che senza estrazione non
          c'e' un titolo. */}
      <p className="muto">
        {formatQuando(r.recordedAt) ?? "—"} · {formatDurataAudio(r.durationMs)}
        {r.placeLabel === null ? "" : ` · ${r.placeLabel}`}
      </p>

      {avviso.dettaglio !== null && <p className="sospesa__dettaglio">{avviso.dettaglio}</p>}

      {/* La trascrizione c'e' anche quando l'estrazione e' fallita, ed e' gia'
          stata pagata: mostrarla e' l'unico modo di non perdere quello che si
          era detto, anche se non e' diventato una scheda. */}
      {r.transcript !== null && <p className="sospesa__trascrizione">«{r.transcript}»</p>}

      {errore !== null && (
        <p className="avviso avviso--errore" role="alert">
          {errore}
        </p>
      )}

      {avviso.riprovabile && (
        <button
          type="button"
          className="bottone bottone--piatto"
          disabled={attesa}
          onClick={() => {
            void riprova();
          }}
        >
          {attesa ? "Rimetto in coda…" : "Riprova adesso"}
        </button>
      )}
    </article>
  );
}
