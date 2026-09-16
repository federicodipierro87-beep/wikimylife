import type { RecordingState } from "@wikimylife/shared";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../api";
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
 *
 * ## Perche' avvisa chi sta sopra
 *
 * Il server toglie dalla lista dei sospesi tutto cio' che e' `ESTRATTO`.
 * Quindi nel momento esatto in cui un vocale diventa una scheda, il suo id
 * sparisce da qui — e da qui in giu' non succede piu' niente: il polling si
 * spegne (non c'e' piu' niente in movimento) e l'elenco delle schede, che ha
 * chiesto la sua pagina una volta sola al montaggio, non ha nessun motivo di
 * richiederla. Il vocale svanisce dallo schermo e la scheda non compare, finche'
 * qualcuno non ricarica a mano. `onSparita` e' il solo punto in cui
 * quell'istante e' visibile.
 *
 * L'evento e' «un id ha lasciato la lista», non «e' passato del tempo»: far
 * ripollare l'elenco da se' sarebbe una richiesta paginata ogni cinque secondi
 * per tutta la sessione, anche quando non si sta elaborando niente.
 *
 * Non si distingue «nata» da «cancellata». La lista si accorcia per due motivi
 * soli, e tutti e due cambiano l'elenco sotto: ricaricare e' giusto in
 * entrambi i casi, e una cancellazione costa una richiesta di lista in piu'.
 */

/** Ogni quanto si richiede la lista, e solo se qualcosa si sta muovendo. */
const RITMO_MS = 5000;

export function PendingRecordings({
  /**
   * Obbligatoria, non facoltativa. `onSparita?` terrebbe compilante chiunque
   * monti questa sezione senza pensarci, e il difetto — la scheda che nasce e
   * non compare — tornerebbe in silenzio, identico a prima e senza un errore.
   */
  onSparita,
}: {
  onSparita: () => void;
}): React.JSX.Element | null {
  const apiClient = useApi();
  const { stato, ricarica } = useAsync<readonly RecordingState[]>(
    async () => (await apiClient.listPendingRecordings()).items,
    [apiClient],
  );

  // Gli id dell'ultimo giro andato a buon fine. `null` finche' non ne e'
  // arrivato nemmeno uno: il primo giro non e' una sparizione, e' il momento in
  // cui si scopre cosa c'era.
  const visti = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    // Solo i giri `pronto`. Un `attesa` ha la lista vuota per costruzione — e'
    // lo stato in cui `useAsync` si mette a ogni ricaricamento — e un `errore`
    // non dice che qualcosa e' sparito, dice che non lo sappiamo: leggerli come
    // sparizioni farebbe ricaricare l'elenco a ogni tick e a ogni guasto di
    // rete.
    if (stato.kind !== "pronto") {
      return;
    }

    const adesso = new Set(stato.dato.map((r) => r.id));
    const prima = visti.current;
    visti.current = adesso;

    if (prima === null) {
      return;
    }

    // Per id e non per lunghezza: se nello stesso giro uno esce e un altro
    // entra, la lunghezza non cambia e la scheda appena nata resterebbe
    // invisibile — cioe' esattamente il difetto che questo avviso esiste per
    // togliere.
    for (const id of prima) {
      if (!adesso.has(id)) {
        onSparita();
        return;
      }
    }
  }, [stato, onSparita]);

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
  const apiClient = useApi();
  const [attesa, setAttesa] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  // La cancellazione e' l'unica cosa irreversibile che questa schermata sappia
  // fare, e il pulsante sta accanto a «Riprova adesso» su un telefono: il
  // secondo tocco non e' una cerimonia, e' la differenza fra buttare via un
  // vocale e sfiorare lo schermo.
  const [confermaElimina, setConfermaElimina] = useState(false);

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

  async function elimina(): Promise<void> {
    setAttesa(true);
    setErrore(null);
    try {
      await apiClient.deleteRecording(r.id);
      // Nessuna rimozione ottimistica: la lista si ricarica. Se il server ha
      // rifiutato perche' nel frattempo un worker l'ha presa, la registrazione
      // deve restare visibile — sparire dalla lista e ricomparire al giro dopo
      // sarebbe peggio che non sparire.
      onCambiata();
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
      setConfermaElimina(false);
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

      <div className="sospesa__azioni">
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

        {/* Si puo' eliminare in qualsiasi stato: anche mentre e' in
            elaborazione, perche' e' proprio allora che si rimpiange di aver
            registrato. Se il worker l'ha in mano il server risponde 409 e il
            messaggio dice di riprovare — meglio di un pulsante assente, che
            non spiegherebbe niente. */}
        {confermaElimina ? (
          <>
            <button
              type="button"
              className="bottone bottone--pericolo"
              disabled={attesa}
              onClick={() => {
                void elimina();
              }}
            >
              {attesa ? "Elimino…" : "Elimina davvero"}
            </button>
            <button
              type="button"
              className="bottone bottone--piatto"
              disabled={attesa}
              onClick={() => {
                setConfermaElimina(false);
              }}
            >
              Annulla
            </button>
          </>
        ) : (
          <button
            type="button"
            className="bottone bottone--piatto"
            disabled={attesa}
            onClick={() => {
              setConfermaElimina(true);
            }}
          >
            Elimina
          </button>
        )}
      </div>
    </article>
  );
}
