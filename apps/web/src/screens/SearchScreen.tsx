import { SEARCH_PAGE_SIZE, type SearchResult } from "@wikimylife/shared";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { goBack } from "../router";
import { useAsync } from "../useAsync";
import { ProcedureCard } from "./ProcedureCard";

/**
 * La ricerca.
 *
 * `q` sotto i due caratteri non parte: e' il minimo dello schema condiviso, e
 * mandare "a" al server significherebbe farsi restituire l'archivio intero
 * ordinato per caso.
 *
 * Il ritardo di 300 ms non e' cosmetico: ogni ricerca calcola un embedding, che
 * e' una chiamata a pagamento verso OpenAI. Senza, digitare "residenza" ne
 * farebbe partire nove.
 */

const RITARDO_MS = 300;
const MIN_CARATTERI = 2;

export function SearchScreen(): React.JSX.Element {
  const [testo, setTesto] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const pulito = testo.trim();
    const timer = setTimeout(() => {
      setQuery(pulito.length >= MIN_CARATTERI ? pulito : "");
      // Cambiata la domanda, la pagina tre della domanda di prima non vuol dire
      // piu' niente: si riparte dalla prima.
      setOffset(0);
    }, RITARDO_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [testo]);

  const { stato } = useAsync<SearchResult | null>(
    () =>
      query === ""
        ? Promise.resolve(null)
        : apiClient.search({ q: query, limit: SEARCH_PAGE_SIZE, offset }),
    [query, offset],
  );

  return (
    <main className="schermata">
      <header className="testata">
        <button
          type="button"
          className="bottone bottone--piatto"
          onClick={goBack}
          aria-label="Torna indietro"
        >
          ‹
        </button>
        <input
          className="ricerca"
          type="search"
          value={testo}
          onChange={(e) => {
            setTesto(e.target.value);
          }}
          placeholder="Come si fa a…"
          // Il campo di ricerca e' il motivo per cui si arriva qui: metterci
          // sopra il cursore da soli risparmia un tocco su tre.
          autoFocus
          enterKeyHint="search"
        />
      </header>

      {query === "" && (
        <p className="muto">
          Scrivi cosa devi fare, con le tue parole. La ricerca guarda sia le
          parole esatte sia il senso: «rinnovare la carta d&apos;identita&apos;»
          trova anche «CIE scaduta».
        </p>
      )}

      {stato.kind === "attesa" && query !== "" && <p className="muto">Cerco…</p>}

      {stato.kind === "errore" && (
        <p className="avviso avviso--errore" role="alert">
          {stato.messaggio}
        </p>
      )}

      {stato.kind === "pronto" && stato.dato !== null && (
        <>
          <p className="muto" aria-live="polite">
            {riassunto(stato.dato)}
          </p>

          <ul className="elenco">
            {stato.dato.items.map((hit) => (
              <li key={hit.id}>
                <ProcedureCard p={hit} />
                <p className="riga__perche">
                  {hit.matchedBy === "TESTO"
                    ? "Contiene le tue parole"
                    : hit.matchedBy === "SEMANTICA"
                      ? "Parla della stessa cosa"
                      : "Le tue parole e lo stesso argomento"}
                </p>
              </li>
            ))}
          </ul>

          <Paginazione
            risultato={stato.dato}
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
 * Quanti risultati, o quali.
 *
 * Sulla prima e unica pagina il numero e' un conteggio vero e si dice cosi'.
 * Appena si sfoglia diventa una frazione di qualcosa di cui non si sa il totale
 * — la ricerca conosce le schede entrate nella fusione, non quante ne esistono —
 * e allora si dichiara l'intervallo, che e' l'unica cosa esatta.
 */
function riassunto(r: SearchResult): string {
  if (r.items.length === 0) {
    return r.offset === 0 ? `Niente per «${r.q}».` : `Non c'e' altro per «${r.q}».`;
  }
  if (r.offset === 0 && !r.hasMore) {
    return `${String(r.items.length)} risultati per «${r.q}».`;
  }
  return `Risultati ${String(r.offset + 1)}–${String(r.offset + r.items.length)} per «${r.q}».`;
}

/**
 * Avanti e indietro, come nell'elenco, ma senza il «di quanti».
 *
 * L'elenco sa il totale perche' conta righe; la ricerca no, e mettere un numero
 * li' in mezzo vorrebbe dire inventarlo. `hasMore` basta: e' esattamente la
 * risposta alla sola domanda che il pulsante pone.
 */
function Paginazione({
  risultato,
  onOffset,
}: {
  risultato: SearchResult;
  onOffset: (offset: number) => void;
}): React.JSX.Element | null {
  if (risultato.offset === 0 && !risultato.hasMore) {
    return null;
  }

  return (
    <nav className="paginazione">
      <button
        type="button"
        className="bottone bottone--piatto"
        disabled={risultato.offset === 0}
        onClick={() => {
          onOffset(Math.max(0, risultato.offset - risultato.limit));
        }}
      >
        Precedenti
      </button>
      <span className="muto">Pagina {String(risultato.offset / risultato.limit + 1)}</span>
      <button
        type="button"
        className="bottone bottone--piatto"
        disabled={!risultato.hasMore}
        onClick={() => {
          onOffset(risultato.offset + risultato.limit);
        }}
      >
        Successive
      </button>
    </nav>
  );
}
