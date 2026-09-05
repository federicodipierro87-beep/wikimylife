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

  useEffect(() => {
    const pulito = testo.trim();
    const timer = setTimeout(() => {
      setQuery(pulito.length >= MIN_CARATTERI ? pulito : "");
    }, RITARDO_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [testo]);

  const { stato } = useAsync<SearchResult | null>(
    () =>
      query === ""
        ? Promise.resolve(null)
        : apiClient.search({ q: query, limit: SEARCH_PAGE_SIZE }),
    [query],
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
            {stato.dato.items.length === 0
              ? `Niente per «${stato.dato.q}».`
              : `${String(stato.dato.items.length)} risultati per «${stato.dato.q}».`}
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
        </>
      )}
    </main>
  );
}
