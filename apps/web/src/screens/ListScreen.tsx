import { PROCEDURE_PAGE_SIZE, type ProcedureList, type TagList } from "@wikimylife/shared";
import { useCallback, useState } from "react";
import { useApi } from "../api";
import { navigate } from "../router";
import { useAsync } from "../useAsync";
import { PendingRecordings } from "./PendingRecordings";
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
 *
 * ## Le categorie sono i tag, e sono un indice e non un raggruppamento
 *
 * «Categoria» e' la parola che si legge a schermo; nel database, nel contratto
 * e in tutto il resto del codice la stessa cosa si chiama `tag`. Sono due
 * parole per una cosa sola, e il costo e' che chi cerca «categoria» nel codice
 * non trova niente: e' scritto qui e su `packages/shared/src/api/tags.ts`, che
 * sono i due capi del filo.
 *
 * La riga delle categorie **non** raggruppa l'elenco in sezioni, e non e' una
 * semplificazione: non si puo'. Una scheda porta fino a trenta tag, quindi non
 * appartiene a *una* categoria e non c'e' una sezione in cui metterla; e le
 * sezioni giuste si potrebbero disegnare solo avendo davanti tutte le schede,
 * mentre qui ne arrivano venti per volta. Un raggruppamento costruito su una
 * pagina direbbe «Casa (3)» guardando tre schede su quaranta.
 *
 * Quindi le chip sono un **filtro**, con il numero che dice quanto c'e' dietro
 * — il conteggio lo fa il server sull'archivio intero, con lo stesso WHERE
 * della lista, quindi «7» sono davvero le sette schede che la chip apre. Il
 * prezzo, che va saputo: non si vedono mai due categorie insieme, e una scheda
 * con cinque tag compare sotto cinque chip diverse senza avere una casa.
 */

const AMBITI = [
  { valore: undefined, etichetta: "Tutte" },
  { valore: "PERSONALE", etichetta: "Personale" },
  { valore: "LAVORO", etichetta: "Lavoro" },
  { valore: "CLIENTE", etichetta: "Clienti" },
] as const;

export function ListScreen(): React.JSX.Element {
  const apiClient = useApi();
  const [ambito, setAmbito] = useState<(typeof AMBITI)[number]["valore"]>(undefined);
  const [categoria, setCategoria] = useState<string | undefined>(undefined);
  const [offset, setOffset] = useState(0);

  const { stato, ricarica } = useAsync<ProcedureList>(
    () =>
      apiClient.listProcedures({
        limit: PROCEDURE_PAGE_SIZE,
        offset,
        ...(ambito === undefined ? {} : { scope: ambito }),
        ...(categoria === undefined ? {} : { tag: categoria }),
      }),
    [apiClient, ambito, categoria, offset],
  );

  // Le categorie dipendono dall'ambito ma **non** dalla categoria scelta. Se ci
  // dipendessero, premere «Casa» richiederebbe le categorie delle sole schede
  // di Casa e la riga si accorcerebbe a una chip sola: il filtro si mangerebbe
  // il menu da cui e' stato scelto, e per cambiare idea bisognerebbe indovinare
  // dov'e' finito «Tutte».
  const { stato: statoTag, ricarica: ricaricaTag } = useAsync<TagList>(
    () => apiClient.listTags(ambito === undefined ? {} : { scope: ambito }),
    [apiClient, ambito],
  );

  // Una scheda che nasce puo' portarsi dietro una categoria che non esisteva, o
  // far salire di uno un conteggio gia' a schermo. Ricaricare solo l'elenco
  // lascerebbe la riga delle chip a raccontare l'archivio di un minuto fa —
  // cioe' proprio il numero su cui questa schermata chiede di fidarsi.
  const ricaricaTutto = useCallback((): void => {
    ricarica();
    ricaricaTag();
  }, [ricarica, ricaricaTag]);

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
        {/* L'unica porta per l'account, e sta qui e non nella barra bassa: la
            barra ha tre voci e il tasto rosso al centro, che e' grande perche'
            deve restare premibile di fretta con una mano sola. Una quarta voce
            lo avrebbe stretto per una schermata che si apre due volte l'anno. */}
        <button
          type="button"
          className="bottone bottone--piatto"
          onClick={() => {
            navigate({ name: "account" });
          }}
        >
          Account
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
              // E la categoria si lascia andare, per un motivo piu' scomodo.
              // La riga delle chip si ricarica sul nuovo ambito, quindi una
              // categoria che li' non esiste sparisce dalla riga — ma il filtro
              // resterebbe applicato. Si guarderebbe una lista vuota con
              // nessuna chip accesa e niente da premere per capire perche'. Il
              // costo e' che passando da Personale a Lavoro si perde «Casa»
              // anche quando in Lavoro «Casa» c'e'; il guadagno e' che cio' che
              // e' acceso a schermo e cio' che e' nella query sono sempre la
              // stessa cosa.
              setCategoria(undefined);
            }}
          >
            {a.etichetta}
          </button>
        ))}
      </div>

      {/* Un secondo `role="tablist"` con la sua etichetta, e non una fila sola
          con dentro tutto: per chi legge con uno screen reader due gruppi senza
          nome sarebbero una lista unica di otto voci in cui «Tutte» compare due
          volte e non si capisce a cosa si riferisca nessuna delle due. I due
          filtri si sommano — gli ambiti sono quattro, fissi e mutuamente
          esclusivi; le categorie sono N e cambiano da sole — e costano due righe
          su uno schermo di telefono.
          La riga non c'e' quando non c'e' niente da filtrare: su un archivio
          senza nessun tag sarebbe un «Tutte» solitario, cioe' un comando che non
          fa niente. */}
      {statoTag.kind === "pronto" && statoTag.dato.items.length > 0 && (
        <div className="filtri" role="tablist" aria-label="Categoria">
          {/* «Tutte» sta scritta a mano e non arriva dal server: senza, da una
              categoria non si tornerebbe indietro se non ricaricando la
              pagina. */}
          <button
            type="button"
            role="tab"
            aria-selected={categoria === undefined}
            className={`chip ${categoria === undefined ? "chip--attivo" : ""}`}
            onClick={() => {
              setCategoria(undefined);
              setOffset(0);
            }}
          >
            Tutte
          </button>
          {statoTag.dato.items.map((t) => (
            <button
              key={t.nome}
              type="button"
              role="tab"
              aria-selected={t.nome === categoria}
              className={`chip ${t.nome === categoria ? "chip--attivo" : ""}`}
              onClick={() => {
                setCategoria(t.nome);
                setOffset(0);
              }}
            >
              {t.nome} <span className="chip__conteggio">{String(t.conteggio)}</span>
            </button>
          ))}
        </div>
      )}

      {/* Le dipendenze di `useAsync` qui sopra sono ambito e pagina: nessuna
          delle due cambia quando un vocale diventa una scheda, quindi senza
          questo richiamo la scheda nuova non comparirebbe finche' non si tocca
          un filtro o non si ricarica la pagina a mano. Chi sa che e' successo
          e' la sezione dei sospesi, perche' l'id le e' sparito da sotto. */}
      <PendingRecordings onSparita={ricaricaTutto} />

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

      {/* In fondo, e in fondo davvero: sotto la paginazione e fuori dal ramo
          che dipende da quante schede ci sono. Il cestino esiste anche quando
          l'elenco e' vuoto — anzi, e' l'unico caso in cui potrebbe esserci
          dentro tutto quello che si sta cercando. */}
      <footer className="pie">
        <button
          type="button"
          className="bottone bottone--piatto"
          onClick={() => {
            navigate({ name: "cestino" });
          }}
        >
          Cestino
        </button>
      </footer>
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
