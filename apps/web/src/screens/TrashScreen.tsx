import {
  CardStatus,
  PROCEDURE_PAGE_SIZE,
  type EmptyTrashResult,
  type ProcedureList,
  type ProcedureSummary,
} from "@wikimylife/shared";
import { useState } from "react";
import { useApi } from "../api";
import { formatQuando } from "../format";
import { goBack, navigate } from "../router";
import { messaggioDi } from "../session";
import { useAsync } from "../useAsync";

/**
 * Il cestino, e l'unico posto da cui si svuota.
 *
 * ## Perche' una schermata e non un filtro della lista
 *
 * I filtri della lista sono gli ambiti — personale, lavoro, clienti — e sono
 * tutti dello stesso tipo: mostrano un sottoinsieme delle stesse schede, con le
 * stesse azioni. Il cestino no. Contiene cose che non sono piu' in uso e offre
 * due gesti che altrove non esistono, di cui uno non si annulla. Metterlo come
 * quarto chip avrebbe voluto dire che «Clienti» e «Cestino» si premono per
 * sbaglio l'uno al posto dell'altro, e che da un tocco distratto si arriva a un
 * pulsante rosso.
 *
 * ## Perche' ci si arriva dal fondo della lista
 *
 * Perche' il cestino non e' una cosa che si cerca senza saperlo — al contrario
 * dei vocali in sospeso, che stanno in cima proprio perche' nessuno li andrebbe
 * a guardare. Qui e' l'opposto: ci si va quando si e' gia' deciso, e allora si
 * scorre. In testata c'e' spazio per due pulsanti e sono occupati da cose che
 * si premono ogni giorno.
 *
 * ## Perche' l'elenco non riusa `ProcedureCard`
 *
 * Perche' quella riga e' un `<button>` che apre la scheda, e qui ogni voce ha
 * gia' due pulsanti dentro. Un pulsante dentro un pulsante non e' HTML valido,
 * e il browser lo risolve a modo suo — di solito sganciando il tocco da
 * entrambi. La riga qui e' un `<article>` con tre bottoni dichiarati.
 *
 * ## Perche' «svuota» sta in fondo e non in testata
 *
 * Perche' e' il gesto piu' distruttivo dell'applicazione, e in testata sarebbe
 * la prima cosa sotto il pollice di chi apre la schermata per ripescare una
 * scheda. In fondo ci arriva chi ha gia' scorso l'elenco, cioe' chi ha appena
 * visto cosa sta per buttare via.
 */

export function TrashScreen(): React.JSX.Element {
  const apiClient = useApi();
  const [offset, setOffset] = useState(0);
  const { stato, ricarica } = useAsync<ProcedureList>(
    () =>
      apiClient.listProcedures({
        status: CardStatus.ARCHIVIATA,
        limit: PROCEDURE_PAGE_SIZE,
        offset,
      }),
    [apiClient, offset],
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
        <h1>Cestino</h1>
      </header>

      {stato.kind === "attesa" && <p className="muto">Carico…</p>}

      {stato.kind === "errore" && (
        <p className="avviso avviso--errore" role="alert">
          {stato.messaggio}
        </p>
      )}

      {stato.kind === "pronto" && stato.dato.items.length === 0 && (
        <div className="vuoto">
          <p>Il cestino e&apos; vuoto.</p>
          <p className="muto">
            Le schede archiviate finiscono qui. Restano leggibili, e da qui si
            rimettono a posto o si cancellano per sempre.
          </p>
        </div>
      )}

      {stato.kind === "pronto" && stato.dato.items.length > 0 && (
        <>
          {/* Sopra l'elenco e non sotto: dice cosa sta per succedere a chi
              guarda i pulsanti, non a chi ne ha gia' premuto uno. */}
          <p className="muto">
            Cancellare per sempre una scheda toglie anche i vocali da cui e&apos;
            nata, e la loro registrazione audio. Non si torna indietro.
          </p>

          <ul className="elenco">
            {stato.dato.items.map((p) => (
              <li key={p.id}>
                <VoceCestinata p={p} onCambiata={ricarica} />
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

      {/* Fuori dal blocco qui sopra, e non e' una svista di indentazione: dopo
          uno svuotamento riuscito il cestino e' vuoto, quel blocco sparisce, e
          un pulsante montato dentro si porterebbe via il proprio messaggio
          d'esito nel momento esatto in cui c'e' da leggerlo. Qui invece resta
          montato, e mentre `ricarica()` riporta lo stato ad `attesa` continua a
          dire com'e' andata. */}
      <SvuotaIlCestino
        quante={stato.kind === "pronto" ? stato.dato.total : 0}
        onSvuotato={() => {
          // Alla prima pagina, se non ci si era gia'. Restare all'offset 40 dopo
          // aver cancellato tutto mostrerebbe un cestino che sembra vuoto perche'
          // si sta guardando oltre la fine — e le schede eventualmente saltate
          // sarebbero invisibili. Il ramo `else` non chiama anche `ricarica`
          // perche' cambiare `offset` e' gia' una dipendenza di `useAsync`:
          // farebbero due richieste per lo stesso motivo.
          if (offset === 0) {
            ricarica();
          } else {
            setOffset(0);
          }
        }}
      />
    </main>
  );
}

/**
 * Il gesto sull'intero cestino.
 *
 * ## Perche' il numero sta sul pulsante rosso e non su quello grigio
 *
 * Perche' e' li' che serve. «Svuota il cestino» e' una richiesta, e chi la fa sa
 * gia' cosa ha buttato; «Cancella per sempre 34 schede» e' l'ultima cosa che si
 * legge prima che sia troppo tardi, ed e' l'unico punto in cui il numero puo'
 * ancora far cambiare idea. Il numero e' `total`, non quante se ne vedono: la
 * pagina ne mostra venti, e cancellarne trentaquattro dopo aver letto «venti»
 * sarebbe una bugia detta da un pulsante rosso.
 *
 * ## Perche' l'esito e' un messaggio e non un silenzio
 *
 * Perche' `saltate` esiste. Una scheda ripristinata da un'altra scheda del
 * browser mentre lo svuotamento e' in corso non viene cancellata — ed e' giusto
 * — ma cosi' il cestino dopo lo svuotamento non e' vuoto, e senza una riga che
 * lo dica sembrerebbe un guasto.
 */
function SvuotaIlCestino({
  quante,
  onSvuotato,
}: {
  quante: number;
  onSvuotato: () => void;
}): React.JSX.Element | null {
  const apiClient = useApi();
  const [attesa, setAttesa] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [conferma, setConferma] = useState(false);
  const [esito, setEsito] = useState<EmptyTrashResult | null>(null);

  async function svuota(): Promise<void> {
    setAttesa(true);
    setErrore(null);
    setEsito(null);
    try {
      const risultato = await apiClient.emptyTrash();
      setEsito(risultato);
      setConferma(false);
      onSvuotato();
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
      // Come nella voce singola: la conferma si richiude, perche' un pulsante
      // rosso che resta aperto dopo un errore invita a un secondo tocco che
      // nessuno ha piu' deciso.
      setConferma(false);
    } finally {
      setAttesa(false);
    }
  }

  if (quante === 0 && esito === null && errore === null) {
    return null;
  }

  return (
    <section className="svuota">
      {esito !== null && (
        <p className="avviso" role="status">
          {esitoDelloSvuotamento(esito)}
        </p>
      )}

      {errore !== null && (
        <p className="avviso avviso--errore" role="alert">
          {errore}
        </p>
      )}

      {quante > 0 &&
        (conferma ? (
          <div className="svuota__azioni">
            <button
              type="button"
              className="bottone bottone--pericolo"
              disabled={attesa}
              onClick={() => {
                void svuota();
              }}
            >
              {attesa ? "Cancello…" : `Cancella per sempre ${schede(quante)}`}
            </button>
            <button
              type="button"
              className="bottone bottone--piatto"
              disabled={attesa}
              onClick={() => {
                setConferma(false);
              }}
            >
              Annulla
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="bottone bottone--piatto"
            onClick={() => {
              setConferma(true);
            }}
          >
            Svuota il cestino
          </button>
        ))}
    </section>
  );
}

/** «1 scheda», «12 schede»: il singolare esiste perche' un cestino con dentro
 *  una cosa sola e' il caso piu' frequente di tutti. */
function schede(n: number): string {
  return n === 1 ? "1 scheda" : `${String(n)} schede`;
}

/**
 * Gli esiti possibili detti in italiano.
 *
 * Zero cancellate e zero saltate non e' un guasto: e' il cestino che qualcuno ha
 * gia' svuotato altrove fra il caricamento della pagina e il tocco. Dirlo
 * «cancellate 0 schede» sarebbe vero e illeggibile. Ma vale solo se il cestino
 * adesso e' davvero vuoto: zero e zero con qualcosa ancora dentro non e' un
 * cestino gia' svuotato, e' uno svuotamento che non e' partito.
 *
 * L'ultima frase — quante ne restano — nei casi normali non compare mai, perche'
 * `emptyTrash` ripete finche' non e' zero. Compare quando quel ciclo si e'
 * fermato contro il suo tetto, ed e' li' per non dire «fatto» a chi ha davanti
 * un cestino ancora pieno: fra un messaggio brutto e uno falso, il secondo e'
 * quello che fa premere di nuovo senza sapere perche'.
 */
function esitoDelloSvuotamento(esito: EmptyTrashResult): string {
  if (esito.cancellate === 0 && esito.saltate === 0 && esito.rimaste === 0) {
    return "Il cestino era gia' vuoto.";
  }

  const via =
    esito.cancellate === 1
      ? "1 scheda cancellata per sempre."
      : `${String(esito.cancellate)} schede cancellate per sempre.`;

  const ripescate =
    esito.saltate === 0
      ? ""
      : esito.saltate === 1
        ? " 1 scheda e' stata ripristinata mentre si cancellava, e non e' stata toccata."
        : ` ${String(esito.saltate)} schede sono state ripristinate mentre si cancellava, e non sono state toccate.`;

  const restano =
    esito.rimaste === 0
      ? ""
      : ` Nel cestino ${esito.rimaste === 1 ? "resta 1 scheda" : `restano ${String(esito.rimaste)} schede`}: premi di nuovo per continuare.`;

  return `${via}${ripescate}${restano}`;
}

function VoceCestinata({
  p,
  onCambiata,
}: {
  p: ProcedureSummary;
  onCambiata: () => void;
}): React.JSX.Element {
  const apiClient = useApi();
  const [attesa, setAttesa] = useState<"ripristino" | "cancello" | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  // Come per l'eliminazione di un vocale: il secondo tocco non e' una
  // cerimonia, e' la distanza fra buttare via una procedura e sfiorare lo
  // schermo. Qui in piu' non c'e' nessun cestino piu' in giu' da cui ripescare.
  const [conferma, setConferma] = useState(false);

  async function ripristina(): Promise<void> {
    setAttesa("ripristino");
    setErrore(null);
    try {
      // `DA_RIVEDERE` e non `COMPLETA`: lo stato in cui era prima non e'
      // scritto da nessuna parte, e dire «completa» a una scheda che qualcuno
      // aveva messo via sarebbe la sola delle due bugie che non si nota.
      await apiClient.updateProcedure(p.id, { status: CardStatus.DA_RIVEDERE });
      onCambiata();
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
    } finally {
      setAttesa(null);
    }
  }

  async function cancella(): Promise<void> {
    setAttesa("cancello");
    setErrore(null);
    try {
      await apiClient.deleteProcedureForever(p.id);
      onCambiata();
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
      // La conferma si richiude: se il server ha rifiutato — 409 perche'
      // qualcuno l'ha ripescata da un'altra scheda aperta — il pulsante rosso
      // non deve restare li' pronto per un secondo tentativo che non e' piu'
      // quello che l'utente aveva in mente.
      setConferma(false);
    } finally {
      setAttesa(null);
    }
  }

  return (
    <article className="cestinata">
      <button
        type="button"
        className="cestinata__titolo"
        onClick={() => {
          navigate({ name: "scheda", id: p.id });
        }}
      >
        {p.titolo}
      </button>

      <p className="muto">
        {[
          p.numeroPassi > 0 ? `${String(p.numeroPassi)} passi` : null,
          formatQuando(p.updatedAt),
        ]
          .filter((x): x is string => x !== null)
          .join(" · ")}
      </p>

      {errore !== null && (
        <p className="avviso avviso--errore" role="alert">
          {errore}
        </p>
      )}

      <div className="cestinata__azioni">
        <button
          type="button"
          className="bottone bottone--piatto"
          disabled={attesa !== null}
          onClick={() => {
            void ripristina();
          }}
        >
          {attesa === "ripristino" ? "Ripristino…" : "Ripristina"}
        </button>

        {conferma ? (
          <>
            <button
              type="button"
              className="bottone bottone--pericolo"
              disabled={attesa !== null}
              onClick={() => {
                void cancella();
              }}
            >
              {attesa === "cancello" ? "Cancello…" : "Cancella per sempre"}
            </button>
            <button
              type="button"
              className="bottone bottone--piatto"
              disabled={attesa !== null}
              onClick={() => {
                setConferma(false);
              }}
            >
              Annulla
            </button>
          </>
        ) : (
          <button
            type="button"
            className="bottone bottone--piatto"
            disabled={attesa !== null}
            onClick={() => {
              setConferma(true);
            }}
          >
            Elimina
          </button>
        )}
      </div>
    </article>
  );
}

/** La stessa dell'elenco, e per le stesse ragioni. */
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
