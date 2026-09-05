import type { Outcome, ProcedureDetail } from "@wikimylife/shared";
import { useState } from "react";
import { apiClient } from "../api";
import {
  badgesOf,
  formatCosto,
  formatDurata,
  formatQuando,
  pitfallsInOrdine,
  sezioniDi,
  type SezioneKind,
} from "../format";
import { goBack, navigate } from "../router";
import { messaggioDi } from "../session";
import { useAsync } from "../useAsync";
import { AudioPlayer } from "./AudioPlayer";

/**
 * La scheda.
 *
 * ## L'ordine di lettura non e' negoziabile
 *
 * Prima cosa serve, poi cosa va storto, poi come si fa. E' l'ordine in cui le
 * informazioni servono, non quello in cui sono state raccontate: chi legge i
 * passi per primi arriva alla riga «serve il documento X» quando e' gia' uscito
 * di casa senza. Le trappole prima dei passi per lo stesso motivo — «l'ufficio
 * chiude alle 11» e' inutile letto dopo essere partiti alle 11.
 *
 * ## In fondo c'e' sempre la prova
 *
 * La §3 e' esplicita: la trascrizione grezza si conserva e si mostra sempre.
 * Quando il modello ha capito un'altra cosa, quello e' l'unico posto dove
 * ritrovare cio' che era stato detto davvero — e accanto c'e' l'audio, che e'
 * l'unica cosa in tutta l'app che non si puo' rigenerare.
 */

const ESITI: readonly { esito: Outcome; etichetta: string; classe: string }[] = [
  { esito: "FUNZIONATO", etichetta: "Ha funzionato", classe: "esito--ok" },
  { esito: "CAMBIATA", etichetta: "E' cambiata", classe: "esito--cambiata" },
  { esito: "FALLITA", etichetta: "Non ha funzionato", classe: "esito--fallita" },
];

export function DetailScreen({ id }: { id: string }): React.JSX.Element {
  const { stato, ricarica } = useAsync<ProcedureDetail>(() => apiClient.getProcedure(id), [id]);

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
        <button type="button" className="bottone bottone--piatto" onClick={goBack}>
          ‹ Indietro
        </button>
        <p className="avviso avviso--errore" role="alert">
          {stato.messaggio}
        </p>
      </main>
    );
  }

  return <Scheda p={stato.dato} onCambiata={ricarica} />;
}

function Scheda({
  p,
  onCambiata,
}: {
  p: ProcedureDetail;
  onCambiata: () => void;
}): React.JSX.Element {
  const badges = badgesOf(p);

  return (
    <main className="schermata scheda">
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

      <h1 className="scheda__titolo">{p.titolo}</h1>

      {badges.length > 0 && (
        <div className="riga__badge">
          {badges.map((b) => (
            <span key={b.kind} className={`badge badge--${b.kind}`}>
              {b.label}
            </span>
          ))}
        </div>
      )}

      {p.obsoleta && (
        <p className="avviso avviso--obsoleta">
          Verificata l&apos;ultima volta {formatQuando(p.ultimaVerifica) ?? "molto tempo fa"}.
          Le cose potrebbero essere cambiate.
        </p>
      )}

      {p.status === "DA_RIVEDERE" && (
        <button
          type="button"
          className="bottone bottone--piatto"
          onClick={() => {
            navigate({ name: "revisione", id: p.id });
          }}
        >
          Il racconto aveva dei buchi — completala
        </button>
      )}

      {p.trigger !== null && (
        <p className="scheda__trigger">
          <strong>Quando serve:</strong> {p.trigger}
        </p>
      )}
      {p.esito !== null && (
        <p className="scheda__esito">
          <strong>Cosa ottieni:</strong> {p.esito}
          {p.validitaEsito !== null && <span className="muto"> ({p.validitaEsito})</span>}
        </p>
      )}

      <SommarioRapido p={p} />

      {/*
        L'ordine lo decide `sezioniDi`, non questo JSX: e' una regola di
        prodotto e sta dove si puo' provare con un `expect`. Qui restano solo i
        contenuti.
      */}
      {sezioniDi(p).map((sezione) => (
        <section key={sezione.kind} className="sezione">
          <h2>{sezione.titolo}</h2>
          <Contenuto kind={sezione.kind} p={p} />
        </section>
      ))}

      <Conferma procedureId={p.id} onFatto={onCambiata} />

      <Origine p={p} />
    </main>
  );
}

function Contenuto({
  kind,
  p,
}: {
  kind: SezioneKind;
  p: ProcedureDetail;
}): React.JSX.Element {
  switch (kind) {
    case "prereq":
      return (
        <ul className="lista-puntata">
          {p.prereqs.map((pr) => (
            <li key={pr.id} className={pr.obbligatorio ? "" : "muto"}>
              <span className="tipo">{pr.tipo.toLowerCase()}</span> {pr.descrizione}
              {!pr.obbligatorio && <span className="muto"> — se ce l&apos;hai</span>}
            </li>
          ))}
        </ul>
      );

    case "pitfall":
      return (
        <ul className="lista-trappole">
          {pitfallsInOrdine(p.pitfalls).map((t) => (
            <li key={t.id} className={`trappola trappola--${t.gravita.toLowerCase()}`}>
              {t.gravita === "BLOCCANTE" && <span className="trappola__marchio">Ti blocca</span>}
              {t.descrizione}
            </li>
          ))}
        </ul>
      );

    case "step":
      return (
        <ol className="lista-passi">
          {p.steps.map((s) => (
            <li key={s.id}>
              <span className="passo__azione">{s.azione}</span>
              {s.dettaglio !== null && <span className="passo__dettaglio">{s.dettaglio}</span>}
              {s.durataStimataMin !== null && (
                <span className="muto">{formatDurata(s.durataStimataMin)}</span>
              )}
            </li>
          ))}
        </ol>
      );

    case "costo":
      return (
        <ul className="lista-puntata">
          {p.costs.map((c) => (
            <li key={c.id}>
              {c.descrizione} — <strong>{formatCosto(c.importoCent)}</strong>
            </li>
          ))}
        </ul>
      );

    case "ref":
      return (
        <ul className="lista-puntata">
          {p.refs.map((r) => (
            <li key={r.id}>
              <span className="tipo">{r.tipo.toLowerCase()}</span>{" "}
              {r.tipo === "URL" ? (
                // `noopener` non e' rituale: senza, la pagina aperta puo'
                // riscrivere `window.opener.location` e portare altrove chi
                // torna indietro.
                <a href={r.valore} target="_blank" rel="noreferrer noopener">
                  {r.valore}
                </a>
              ) : (
                r.valore
              )}
            </li>
          ))}
        </ul>
      );
  }
}

function SommarioRapido({ p }: { p: ProcedureDetail }): React.JSX.Element | null {
  const voci = [
    formatDurata(p.durataStimataMin),
    formatCosto(p.costoTotaleCent),
    p.luogoNome,
    p.volteEseguita > 0 ? `fatta ${String(p.volteEseguita)} volte` : null,
  ].filter((x): x is string => x !== null);

  return voci.length === 0 ? null : <p className="scheda__sommario">{voci.join(" · ")}</p>;
}

/**
 * I tre pulsanti della §8.
 *
 * Sono tre e sono grandi perche' si premono in piedi, appena usciti da uno
 * sportello, con una mano sola. Un menu a tendina con tre voci sarebbe stato lo
 * stesso numero di opzioni e tre volte i tocchi.
 *
 * `CAMBIATA` riporta la scheda in `DA_RIVEDERE`: e' il server a deciderlo, e
 * infatti qui si ricarica invece di aggiornare lo stato a mano — cosi'
 * l'interfaccia non puo' raccontare una versione diversa da quella salvata.
 */
function Conferma({
  procedureId,
  onFatto,
}: {
  procedureId: string;
  onFatto: () => void;
}): React.JSX.Element {
  const [aperta, setAperta] = useState<Outcome | null>(null);
  const [nota, setNota] = useState("");
  const [attesa, setAttesa] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  async function invia(esito: Outcome): Promise<void> {
    setAttesa(true);
    setErrore(null);
    try {
      await apiClient.recordExecution(procedureId, {
        esito,
        nota: nota.trim() === "" ? null : nota.trim(),
      });
      setAperta(null);
      setNota("");
      onFatto();
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
    } finally {
      setAttesa(false);
    }
  }

  return (
    <section className="sezione conferma">
      <h2>L&apos;hai appena fatta?</h2>

      <div className="esiti">
        {ESITI.map((e) => (
          <button
            key={e.esito}
            type="button"
            className={`esito ${e.classe} ${aperta === e.esito ? "esito--scelto" : ""}`}
            disabled={attesa}
            onClick={() => {
              setAperta(aperta === e.esito ? null : e.esito);
            }}
          >
            {e.etichetta}
          </button>
        ))}
      </div>

      {aperta !== null && (
        <div className="conferma__nota">
          <label className="campo">
            <span>
              {aperta === "FUNZIONATO"
                ? "Vuoi aggiungere qualcosa? (facoltativo)"
                : "Cos'e' cambiato? (facoltativo)"}
            </span>
            <textarea
              value={nota}
              onChange={(e) => {
                setNota(e.target.value);
              }}
              rows={3}
              maxLength={2000}
            />
          </label>
          <button
            type="button"
            className="bottone bottone--primario"
            disabled={attesa}
            onClick={() => {
              void invia(aperta);
            }}
          >
            {attesa ? "Salvo…" : "Salva"}
          </button>
        </div>
      )}

      {errore !== null && (
        <p className="avviso avviso--errore" role="alert">
          {errore}
        </p>
      )}
    </section>
  );
}

/**
 * Da dove viene la scheda: la trascrizione grezza e l'audio.
 *
 * In fondo e chiuso in un `<details>`, non nascosto: chi legge la procedura per
 * usarla non deve scorrere il trascritto per arrivare ai passi, e chi sospetta
 * che il modello abbia frainteso lo trova dove si aspetta di trovarlo.
 */
function Origine({ p }: { p: ProcedureDetail }): React.JSX.Element | null {
  if (p.recordings.length === 0) {
    return null;
  }

  return (
    <section className="sezione origine">
      <h2>Da cosa nasce</h2>
      {p.recordings.map((r) => (
        <details key={r.id} className="origine__vocale">
          <summary>
            Vocale del {formatQuando(r.recordedAt) ?? r.recordedAt}
            <span className="muto"> · {Math.round(r.durationMs / 1000)}s</span>
          </summary>
          <AudioPlayer recordingId={r.id} />
          {r.transcript === null ? (
            <p className="muto">Trascrizione non disponibile.</p>
          ) : (
            <p className="trascrizione">{r.transcript}</p>
          )}
        </details>
      ))}
    </section>
  );
}
