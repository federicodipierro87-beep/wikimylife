import { PROCEDURE_PAGE_SIZE, type ProcedureList } from "@wikimylife/shared";
import { useState } from "react";
import { apiClient } from "../api";
import { navigate } from "../router";
import { useAsync } from "../useAsync";
import { ProcedureCard } from "./ProcedureCard";

/**
 * L'elenco delle schede, dalla piu' recente.
 *
 * L'ordinamento lo decide il server (§: per ultimo aggiornamento) e non e'
 * configurabile qui: una procedura toccata ieri e' quella che serve oggi, e un
 * menu «ordina per» sarebbe una scelta chiesta a chi non ha motivo di farla.
 *
 * Il filtro di ambito c'e' perche' PERSONALE e LAVORO sono due teste diverse:
 * chi cerca come si rimborsa una nota spese non vuole in mezzo come si cambia
 * la residenza.
 */

const AMBITI = [
  { valore: undefined, etichetta: "Tutte" },
  { valore: "PERSONALE", etichetta: "Personale" },
  { valore: "LAVORO", etichetta: "Lavoro" },
  { valore: "CLIENTE", etichetta: "Clienti" },
] as const;

export function ListScreen(): React.JSX.Element {
  const [ambito, setAmbito] = useState<(typeof AMBITI)[number]["valore"]>(undefined);
  const [offset, setOffset] = useState(0);

  const { stato } = useAsync<ProcedureList>(
    () =>
      apiClient.listProcedures({
        limit: PROCEDURE_PAGE_SIZE,
        offset,
        ...(ambito === undefined ? {} : { scope: ambito }),
      }),
    [ambito, offset],
  );

  return (
    <main className="schermata">
      <header className="testata">
        <h1>Le tue procedure</h1>
        <button
          type="button"
          className="bottone bottone--piatto"
          onClick={() => {
            navigate({ name: "cerca" });
          }}
        >
          Cerca
        </button>
      </header>

      <div className="filtri" role="tablist" aria-label="Ambito">
        {AMBITI.map((a) => (
          <button
            key={a.etichetta}
            type="button"
            role="tab"
            aria-selected={a.valore === ambito}
            className={`chip ${a.valore === ambito ? "chip--attivo" : ""}`}
            onClick={() => {
              setAmbito(a.valore);
              // Cambiare filtro con `offset` a 40 mostrerebbe una lista vuota
              // e sembrerebbe «non c'e' niente in Lavoro».
              setOffset(0);
            }}
          >
            {a.etichetta}
          </button>
        ))}
      </div>

      {stato.kind === "attesa" && <p className="muto">Carico…</p>}

      {stato.kind === "errore" && (
        <p className="avviso avviso--errore" role="alert">
          {stato.messaggio}
        </p>
      )}

      {stato.kind === "pronto" && stato.dato.items.length === 0 && (
        <div className="vuoto">
          <p>Qui non c&apos;e&apos; ancora niente.</p>
          <p className="muto">
            Premi il pulsante rosso e racconta una procedura che hai appena
            finito di fare. Al resto pensa l&apos;app.
          </p>
        </div>
      )}

      {stato.kind === "pronto" && stato.dato.items.length > 0 && (
        <>
          <ul className="elenco">
            {stato.dato.items.map((p) => (
              <li key={p.id}>
                <ProcedureCard p={p} />
              </li>
            ))}
          </ul>

          <Paginazione
            lista={stato.dato}
            onOffset={(nuovo) => {
              setOffset(nuovo);
              window.scrollTo({ top: 0 });
            }}
          />
        </>
      )}
    </main>
  );
}

/**
 * Avanti e indietro, non i numeri di pagina.
 *
 * Con venti elementi per pagina e un archivio personale, la pagina 7 non e' un
 * posto dove qualcuno vuole andare: cio' che sta oltre la seconda pagina si
 * trova cercandolo.
 */
function Paginazione({
  lista,
  onOffset,
}: {
  lista: ProcedureList;
  onOffset: (offset: number) => void;
}): React.JSX.Element | null {
  const fine = lista.offset + lista.items.length;
  if (lista.offset === 0 && fine >= lista.total) {
    return null;
  }

  return (
    <nav className="paginazione">
      <button
        type="button"
        className="bottone bottone--piatto"
        disabled={lista.offset === 0}
        onClick={() => {
          onOffset(Math.max(0, lista.offset - lista.limit));
        }}
      >
        Precedenti
      </button>
      <span className="muto">
        {String(lista.offset + 1)}–{String(fine)} di {String(lista.total)}
      </span>
      <button
        type="button"
        className="bottone bottone--piatto"
        disabled={fine >= lista.total}
        onClick={() => {
          onOffset(lista.offset + lista.limit);
        }}
      >
        Successive
      </button>
    </nav>
  );
}
