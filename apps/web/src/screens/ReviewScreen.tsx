import type { ProcedureDetail, RecordingState } from "@wikimylife/shared";
import { useState } from "react";
import { apiClient } from "../api";
import { revisioneDa } from "../format";
import { goBack, navigate } from "../router";
import { messaggioDi } from "../session";
import { useAsync } from "../useAsync";

/**
 * La revisione di una scheda `DA_RIVEDERE`.
 *
 * ## Le domande sono suggerimenti, mai un modulo
 *
 * Il modello dichiara `campiIncerti` e propone `domandeSuggerite`; questa
 * schermata le mostra e basta. Non c'e' nessun campo obbligatorio, nessun
 * pulsante disabilitato finche' non si risponde, e «Va bene cosi'» e' sempre
 * disponibile — chiude la revisione marcando la scheda `COMPLETA` senza
 * chiedere altro.
 *
 * E' una decisione, non una dimenticanza. Una scheda incompleta ma vera vale
 * piu' di una scheda completa e inventata, e obbligare a rispondere a «quanto
 * costava la marca da bollo?» chi non se lo ricorda produce esattamente il
 * secondo tipo.
 *
 * ## Perche' le domande arrivano dalle registrazioni
 *
 * `_meta` non e' una colonna della scheda: vive nell'estrazione, che si legge
 * dalla registrazione di origine. Copiarlo su `Procedure` avrebbe creato un
 * secondo posto da tenere sincrono per un dato che si consulta una volta.
 */

interface Dati {
  readonly procedura: ProcedureDetail;
  readonly registrazioni: readonly RecordingState[];
}

export function ReviewScreen({ id }: { id: string }): React.JSX.Element {
  const { stato } = useAsync<Dati>(async () => {
    const procedura = await apiClient.getProcedure(id);
    const registrazioni = await Promise.all(
      procedura.recordings.map((r) => apiClient.getRecording(r.id)),
    );
    return { procedura, registrazioni };
  }, [id]);

  if (stato.kind === "attesa") {
    return (
      <main className="schermata">
        <p className="muto">Carico…</p>
      </main>
    );
  }

  if (stato.kind === "errore") {
    return (
      <main className="schermata">
        <p className="avviso avviso--errore" role="alert">
          {stato.messaggio}
        </p>
      </main>
    );
  }

  return <Revisione dati={stato.dato} />;
}

function Revisione({ dati }: { dati: Dati }): React.JSX.Element {
  const { procedura } = dati;
  const suggerimenti = revisioneDa(dati.registrazioni.map((r) => r.extraction?._meta ?? null));

  const [titolo, setTitolo] = useState(procedura.titolo);
  const [note, setNote] = useState("");
  const [attesa, setAttesa] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  async function salva(completa: boolean): Promise<void> {
    const aggiunta = note.trim();
    const nuovoTitolo = titolo.trim();
    const cambiaTitolo = nuovoTitolo !== "" && nuovoTitolo !== procedura.titolo;

    // Un `PATCH {}` e' un errore di validazione: se non c'e' niente da salvare
    // e nemmeno lo stato cambia, questo pulsante e' «va bene cosi'».
    if (!completa && !cambiaTitolo && aggiunta === "") {
      navigate({ name: "scheda", id: procedura.id });
      return;
    }

    setAttesa(true);
    setErrore(null);
    try {
      await apiClient.updateProcedure(procedura.id, {
        ...(cambiaTitolo ? { titolo: nuovoTitolo } : {}),
        // Le risposte finiscono in coda ai passi invece che in un campo
        // "note": la scheda non ha un posto per il testo libero, e inventarne
        // uno adesso vorrebbe dire aggiungere una colonna che nessuna delle
        // due parti sa leggere.
        ...(aggiunta === ""
          ? {}
          : {
              steps: [
                ...procedura.steps.map((s) => ({
                  azione: s.azione,
                  dettaglio: s.dettaglio,
                  durataStimataMin: s.durataStimataMin,
                })),
                { azione: aggiunta, dettaglio: null, durataStimataMin: null },
              ],
            }),
        ...(completa ? { status: "COMPLETA" as const } : {}),
      });
      navigate({ name: "scheda", id: procedura.id });
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
    } finally {
      setAttesa(false);
    }
  }

  return (
    <main className="schermata revisione">
      <header className="testata">
        <button
          type="button"
          className="bottone bottone--piatto"
          onClick={goBack}
          aria-label="Torna indietro"
        >
          ‹
        </button>
      </header>

      <h1>Completala, se vuoi</h1>
      <p className="muto">
        Quando hai raccontato questa procedura alcune cose non erano chiare. Se
        te le ricordi puoi aggiungerle adesso; altrimenti la scheda resta valida
        com&apos;e&apos;.
      </p>

      <label className="campo">
        <span>Titolo</span>
        <input
          type="text"
          value={titolo}
          onChange={(e) => {
            setTitolo(e.target.value);
          }}
          maxLength={200}
        />
      </label>

      {suggerimenti.domande.length > 0 && (
        <section className="sezione">
          <h2>Quello che era rimasto in sospeso</h2>
          <ul className="lista-puntata">
            {suggerimenti.domande.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </section>
      )}

      {suggerimenti.domande.length === 0 && suggerimenti.campiIncerti.length > 0 && (
        <p className="muto">
          Parti poco chiare: {suggerimenti.campiIncerti.join(", ")}.
        </p>
      )}

      <label className="campo">
        <span>Vuoi aggiungere un passo? (facoltativo)</span>
        <textarea
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
          }}
          rows={4}
          maxLength={2000}
          placeholder="Es. «Chiedere il modulo AP70 allo sportello 3»"
        />
      </label>

      {errore !== null && (
        <p className="avviso avviso--errore" role="alert">
          {errore}
        </p>
      )}

      <div className="revisione__azioni">
        <button
          type="button"
          className="bottone bottone--primario"
          disabled={attesa}
          onClick={() => {
            void salva(true);
          }}
        >
          {attesa ? "Salvo…" : "Salva e segna come completa"}
        </button>
        <button
          type="button"
          className="bottone bottone--piatto"
          disabled={attesa}
          onClick={() => {
            void salva(false);
          }}
        >
          Salva e lasciala da rivedere
        </button>
        <button
          type="button"
          className="bottone bottone--piatto"
          disabled={attesa}
          onClick={() => {
            navigate({ name: "scheda", id: procedura.id });
          }}
        >
          Va bene cosi&apos;
        </button>
      </div>
    </main>
  );
}
