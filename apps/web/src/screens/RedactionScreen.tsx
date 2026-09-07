import type {
  RedactionAssistance,
  RedactionProposal,
  RedactionReport,
} from "@wikimylife/shared";
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
 *
 * ## Le proposte di un modello non si mescolano con quelle di un checksum
 *
 * Da quando la passata assistita esiste, questa lista contiene due cose molto
 * diverse. `MRTMTT25D09F205Z` e' un codice fiscale perche' l'ultima lettera
 * torna: chi lo legge sta decidendo se toglierlo, non se e' un codice fiscale.
 * «Mario Rossi» e' un nome perche' un modello linguistico l'ha detto, e li' la
 * domanda e' un'altra — potrebbe essere una ditta, un santo, una via.
 *
 * Presentarle uguali avrebbe fatto credere alle seconde la certezza delle
 * prime. Ogni proposta assistita porta scritto da dove viene, con un segno che
 * si vede senza doverlo cercare: e' l'unica informazione che cambia il modo di
 * leggere la frase intorno.
 *
 * ## Cosa dire quando non c'e' niente da dire
 *
 * Un elenco vuoto ha tre significati diversi, e la differenza importa a chi sta
 * per condividere una scheda: non ho trovato nulla dei quattro formati e i nomi
 * non li ho nemmeno cercati; non ho trovato nulla e i nomi li ho cercati; non ho
 * trovato nulla dei quattro formati e i nomi avrei dovuto cercarli ma il
 * modello non ha risposto. La terza e' un guasto, e mostrarla come le altre due
 * vorrebbe dire far leggere «e' pulita» a chi ha davanti una passata a meta'.
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
        <Degradata assistenza={report.assistenza} />
        <p className="muto">{VUOTO[report.assistenza]}</p>
        {report.contieneDatiSensibili && <FlagResta assistenza={report.assistenza} />}
      </main>
    );
  }

  return (
    <main className="schermata redazione">
      <Testata />

      <h1>Prima di condividerla</h1>
      <Degradata assistenza={report.assistenza} />
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
            <label
              className={
                p.origine === "ASSISTITA" ? "proposta proposta--assistita" : "proposta"
              }
            >
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
                  {p.origine === "ASSISTITA" && (
                    // Il bordo colorato non basta: chi non distingue i colori
                    // vedrebbe due proposte identiche, e la differenza fra «lo
                    // dice un checksum» e «lo dice un modello» e' l'unica cosa
                    // che qui cambia una decisione.
                    <> · <span className="proposta__fonte">letto, non calcolato</span></>
                  )}
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

      <FlagResta assistenza={report.assistenza} />

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

/**
 * Il guasto, e solo il guasto.
 *
 * `NON_CONFIGURATA` non compare: e' la configurazione predefinita, non una
 * mancanza, e annunciare a ogni passata «esisterebbe una funzione che non hai»
 * sarebbe pubblicita' travestita da avviso. `ESEGUITA` non compare per la
 * ragione opposta — dire che e' andata bene invita a fidarsi, che e'
 * esattamente cio' che questa schermata non vuole.
 */
function Degradata({ assistenza }: { assistenza: RedactionAssistance }): React.JSX.Element | null {
  if (assistenza !== "NON_RIUSCITA") {
    return null;
  }

  return (
    <p className="avviso avviso--degradata" role="status">
      La lettura assistita non ha risposto. Qui sotto c&apos;e&apos; solo quello
      che riconosco da solo — codici fiscali, IBAN, email, telefoni. Nomi e
      indirizzi, questa volta, non li ho cercati.
    </p>
  );
}

/**
 * Le tre versioni dell'elenco vuoto.
 *
 * Un `Record` e non una catena di `if`: i tre casi sono un'enum, e il giorno in
 * cui ne nascesse un quarto il compilatore chiederebbe di scrivere anche quello
 * invece di lasciarlo cadere in un ramo `else` scritto per altri.
 */
const VUOTO: Record<RedactionAssistance, string> = {
  NON_CONFIGURATA:
    "Nessun codice fiscale, IBAN, email o numero di telefono in questa scheda. " +
    "Vuol dire solo questo: quello che riconosco sono quattro formati, e un nome " +
    "o un indirizzo non hanno un formato.",
  ESEGUITA:
    "Nessun codice fiscale, IBAN, email o numero di telefono, e nemmeno un nome " +
    "o un indirizzo che io abbia saputo riconoscere. Resta una lettura, non una " +
    "garanzia: un numero di pratica che sembra un numero qualsiasi non l'ho visto.",
  NON_RIUSCITA:
    "Niente di quello che riconosco da solo. Sui nomi non posso dirti niente: " +
    "riprova fra un minuto, oppure rileggila tu.",
};

function FlagResta({ assistenza }: { assistenza: RedactionAssistance }): React.JSX.Element {
  return (
    <p className="muto redazione__flag">
      La scheda resta marcata come «contiene dati sensibili» anche dopo.{" "}
      {assistenza === "ESEGUITA"
        ? // Con la passata assistita accesa la conclusione non cambia, ma la
          // ragione si': non e' piu' che i nomi non li cerco, e' che cercarli
          // e' un parere. Ripetere la frase di prima sarebbe stato falso.
          "Quattro formati li calcolo, i nomi li leggo: la seconda cosa e' un'opinione, e su un'opinione non si dichiara pulita una scheda."
        : "Quello che riconosco sono quattro formati, e un nome o l'indirizzo di casa di qualcuno non ne hanno uno."}{" "}
      Toglilo tu, quando l&apos;hai riletta.
    </p>
  );
}
