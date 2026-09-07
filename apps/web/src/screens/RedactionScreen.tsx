import type { RedactionProposal, RedactionReport } from "@wikimylife/shared";
import { useState } from "react";
import { apiClient } from "../api";
import { goBack, navigate } from "../router";
import { messaggioDi } from "../session";
import { useAsync } from "../useAsync";

/**
 * La passata di redazione della §9.
 *
 * ## Perche' e' una schermata e non un dialogo
 *
 * La §9 chiede che le sostituzioni si facciano «confermare una per una». Un
 * dialogo con una lista dentro sarebbe stato piu' rapido da aprire e da
 * chiudere, ed e' proprio la rapidita' il problema: qui si sta decidendo cosa
 * cancellare per sempre da una scheda, e la fretta e' il modo in cui si accetta
 * tutto senza leggere.
 *
 * ## Nessuna casella e' spuntata all'inizio
 *
 * Partire con tutto selezionato avrebbe fatto della schermata un pulsante
 * «conferma» con del testo intorno, che e' il contrario del «una per una».
 * Chi vuole davvero accettare tutto ha «Seleziona tutto» a un tocco; chi non
 * l'ha letto non ottiene lo stesso risultato per inerzia.
 *
 * ## Il contesto e' il dato, non l'etichetta
 *
 * Ogni proposta mostra la frase intorno con il dato evidenziato dentro.
 * Guardare `+39 011 5551234` estratto dal suo contesto non permette di decidere
 * niente: e' leggendo «chiedere allo sportello, +39 011 5551234, dal lunedi'»
 * che si capisce se era il centralino di un ufficio — che si condivide — o il
 * cellulare della persona che ci lavora.
 *
 * ## Il flag non si tocca da qui
 *
 * Dopo la redazione la scheda resta marcata come contenente dati sensibili, e
 * la schermata lo dice. Toglierlo perche' i rilevatori non trovano piu' niente
 * vorrebbe dire far dichiarare a quattro espressioni regolari che la scheda e'
 * pulita: il nome dell'ex moglie di un cliente non ha un checksum. La
 * «revisione esplicita» che la §9 chiede resta un gesto di chi legge.
 */

const NOMI: Record<RedactionProposal["kind"], string> = {
  CODICE_FISCALE: "codice fiscale",
  IBAN: "IBAN",
  EMAIL: "email",
  TELEFONO: "telefono",
  NOME_PERSONA: "nome",
  INDIRIZZO: "indirizzo",
  IDENTIFICATIVO: "identificativo",
  ALTRO: "dato personale",
};

export function RedactionScreen({ id }: { id: string }): React.JSX.Element {
  const { stato, ricarica } = useAsync<RedactionReport>(
    () => apiClient.proposeRedaction(id),
    [id],
  );

  if (stato.kind === "attesa") {
    return (
      <main className="schermata">
        <p className="muto">Cerco…</p>
      </main>
    );
  }

  if (stato.kind === "errore") {
    return (
      <main className="schermata">
        <Testata />
        <p className="avviso avviso--errore" role="alert">
          {stato.messaggio}
        </p>
      </main>
    );
  }

  return <Passata report={stato.dato} onScaduta={ricarica} />;
}

function Testata(): React.JSX.Element {
  return (
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
  );
}

function Passata({
  report,
  onScaduta,
}: {
  report: RedactionReport;
  onScaduta: () => void;
}): React.JSX.Element {
  const [scelte, setScelte] = useState<ReadonlySet<string>>(new Set());
  const [attesa, setAttesa] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  function commuta(idProposta: string): void {
    setScelte((precedenti) => {
      const nuove = new Set(precedenti);
      if (!nuove.delete(idProposta)) {
        nuove.add(idProposta);
      }
      return nuove;
    });
  }

  async function applica(): Promise<void> {
    setAttesa(true);
    setErrore(null);
    try {
      await apiClient.applyRedaction(report.procedureId, [...scelte]);
      navigate({ name: "scheda", id: report.procedureId });
    } catch (error: unknown) {
      // Il 409 del server significa «la scheda e' cambiata da quando hai
      // chiesto le proposte»: gli id in mano a questa schermata valgono per un
      // testo che non esiste piu'. Si ricarica invece di lasciare l'utente a
      // ripremere un pulsante che continuera' a fallire.
      setErrore(messaggioDi(error));
      onScaduta();
      setScelte(new Set());
    } finally {
      setAttesa(false);
    }
  }

  if (report.proposte.length === 0) {
    return (
      <main className="schermata redazione">
        <Testata />
        <h1>Non ho trovato niente</h1>
        <p className="muto">
          Nessun codice fiscale, IBAN, email o numero di telefono in questa
          scheda. Vuol dire solo questo: quello che riconosco sono quattro
          formati, e un nome o un indirizzo non hanno un formato.
        </p>
        {report.contieneDatiSensibili && <FlagResta />}
      </main>
    );
  }

  return (
    <main className="schermata redazione">
      <Testata />

      <h1>Prima di condividerla</h1>
      <p className="muto">
        Ho trovato {report.proposte.length}{" "}
        {report.proposte.length === 1 ? "dato personale" : "dati personali"}.
        Scegli quali togliere: leggi la frase intorno, perche&apos; non tutto
        quello che sembra privato lo e&apos;.
      </p>

      <div className="redazione__massa">
        <button
          type="button"
          className="bottone bottone--piatto"
          onClick={() => {
            setScelte(new Set(report.proposte.map((p) => p.id)));
          }}
        >
          Seleziona tutto
        </button>
        {scelte.size > 0 && (
          <button
            type="button"
            className="bottone bottone--piatto"
            onClick={() => {
              setScelte(new Set());
            }}
          >
            Deseleziona tutto
          </button>
        )}
      </div>

      <ul className="lista-proposte">
        {report.proposte.map((p) => (
          <li key={p.id}>
            <label className="proposta">
              <input
                type="checkbox"
                checked={scelte.has(p.id)}
                onChange={() => {
                  commuta(p.id);
                }}
              />
              <span className="proposta__corpo">
                <span className="proposta__dove">
                  {p.etichetta} · <span className="tipo">{NOMI[p.kind]}</span>
                </span>
                <Contesto proposta={p} />
                <span className="proposta__esito">
                  diventa <code>{p.sostituzione}</code>
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      {errore !== null && (
        <p className="avviso avviso--errore" role="alert">
          {errore}
        </p>
      )}

      <FlagResta />

      <div className="redazione__azioni">
        <button
          type="button"
          className="bottone bottone--primario"
          disabled={attesa || scelte.size === 0}
          onClick={() => {
            void applica();
          }}
        >
          {attesa
            ? "Tolgo…"
            : scelte.size === 0
              ? "Scegli cosa togliere"
              : `Togli ${String(scelte.size)} su ${String(report.proposte.length)}`}
        </button>
        <button
          type="button"
          className="bottone bottone--piatto"
          disabled={attesa}
          onClick={() => {
            navigate({ name: "scheda", id: report.procedureId });
          }}
        >
          Lascia tutto com&apos;e&apos;
        </button>
      </div>
    </main>
  );
}

/**
 * La frase intorno, con il dato evidenziato.
 *
 * Il contesto arriva dal server come una stringa sola, e il dato ci sta dentro
 * una volta: si spezza sulla prima occorrenza invece di usare
 * `dangerouslySetInnerHTML`, che qui vorrebbe dire iniettare in pagina del
 * testo scritto da un modello linguistico.
 */
function Contesto({ proposta }: { proposta: RedactionProposal }): React.JSX.Element {
  const taglio = proposta.contesto.indexOf(proposta.valore);

  if (taglio < 0) {
    return <span className="proposta__contesto">{proposta.contesto}</span>;
  }

  return (
    <span className="proposta__contesto">
      {proposta.contesto.slice(0, taglio)}
      <mark>{proposta.valore}</mark>
      {proposta.contesto.slice(taglio + proposta.valore.length)}
    </span>
  );
}

function FlagResta(): React.JSX.Element {
  return (
    <p className="muto redazione__flag">
      La scheda resta marcata come «contiene dati sensibili» anche dopo: quello
      che riconosco sono quattro formati, e un nome o l&apos;indirizzo di casa di
      qualcuno non ne hanno uno. Toglilo tu, quando l&apos;hai riletta.
    </p>
  );
}
