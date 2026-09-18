import {
  PROCEDURE_TAG_MAX,
  PROCEDURE_TAG_NAME_MAX,
  type Outcome,
  type ProcedureDetail,
  type TagList,
} from "@wikimylife/shared";
import { useState } from "react";
import { useApi } from "../api";
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
  const apiClient = useApi();
  const { stato, ricarica } = useAsync<ProcedureDetail>(
    () => apiClient.getProcedure(id),
    [apiClient, id],
  );

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

      {p.contieneDatiSensibili && (
        <div className="avviso avviso--sensibile">
          <p>
            Quando l&apos;hai raccontata sono venuti fuori dei dati personali.
            Finche&apos; restano, questa scheda non puo&apos; diventare pubblica.
          </p>
          <button
            type="button"
            className="bottone bottone--piatto"
            onClick={() => {
              navigate({ name: "redazione", id: p.id });
            }}
          >
            Guarda cosa c&apos;e&apos; dentro
          </button>
        </div>
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

      {/*
        Sotto il contenuto e sopra «l'hai appena fatta?»: le categorie non si
        leggono per eseguire la procedura, e il riquadro che le modifica in cima
        spingerebbe i prerequisiti sotto la piega su ogni scheda. Qui e' dove si
        arriva dopo aver letto, cioe' nel momento in cui si sa davvero di cosa
        parla questa scheda e quindi dove va messa.
      */}
      <Categorie p={p} onCambiata={onCambiata} />

      <Conferma procedureId={p.id} onFatto={onCambiata} />

      {/*
        La passata di redazione resta raggiungibile anche senza il flag: il
        flag dice cosa ha pensato l'estrazione, non cosa c'e' nel testo — e una
        scheda corretta a mano dopo l'estrazione non ci ripassa mai.
      */}
      {!p.contieneDatiSensibili && (
        <button
          type="button"
          className="bottone bottone--piatto"
          onClick={() => {
            navigate({ name: "redazione", id: p.id });
          }}
        >
          Controlla i dati personali prima di condividerla
        </button>
      )}

      <Origine p={p} onCambiata={onCambiata} />
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
 * Le categorie della scheda, e l'unico posto dell'app da cui si scrivono.
 *
 * ## Da qui e non dalla revisione
 *
 * `ReviewScreen` sarebbe stato il posto naturale — e' la schermata che esiste
 * per sistemare una scheda — ma esiste solo per le `DA_RIVEDERE`, quindi una
 * scheda uscita `COMPLETA` dall'estrazione non ci passa mai e resterebbe senza
 * modo di essere categorizzata. E il suo `salva()` porta gia' la trappola della
 * sostituzione totale su `steps`: aggiungerci un secondo campo con la stessa
 * semantica raddoppierebbe una superficie che e' gia' documentata come
 * pericolosa. Il prezzo e' un passo in piu' per categorizzare una scheda appena
 * nata: si apre, si legge, si mette la categoria.
 *
 * ## Si manda sempre la lista intera, anche per togliere una sola parola
 *
 * `updateProcedureBodySchema.tag` e' una **sostituzione**, non un'aggiunta:
 * quello che arriva diventa l'elenco completo. Mandare la sola categoria nuova
 * cancellerebbe tutte le altre, e la schermata direbbe «salvato» — e' lo stesso
 * difetto gia' pagato su `steps`, ed e' il motivo per cui qui ogni gesto
 * ricostruisce l'array da `p.tag` invece di mandare un delta.
 *
 * ## Un `<datalist>` e non una tendina
 *
 * Una tendina impedirebbe di inventare una categoria nuova, che e' il gesto che
 * da' senso a tutto il resto: il vocabolario dell'utente non e' scritto da
 * nessuna parte prima che lo scriva lui. Un campo libero da solo, pero',
 * produce «Casa» e «casa» — due categorie che il database tiene separate,
 * perche' il suo `@@unique` distingue le maiuscole. Il `<datalist>` fa le due
 * cose insieme: suggerisce cio' che esiste e non impedisce niente. Non e' una
 * garanzia — chi ignora il suggerimento crea comunque il doppione, e quel
 * difetto resta scritto nel README.
 *
 * ## Il tetto di trenta non e' deciso qui
 *
 * `PROCEDURE_TAG_MAX` e `PROCEDURE_TAG_NAME_MAX` arrivano dal contratto. Se
 * fossero scritti qui sarebbero una regola di dominio nel frontend, e il giorno
 * in cui il contratto cambiasse questa schermata continuerebbe a dire di no.
 */
function Categorie({
  p,
  onCambiata,
}: {
  p: ProcedureDetail;
  onCambiata: () => void;
}): React.JSX.Element {
  const apiClient = useApi();
  const [nuova, setNuova] = useState("");
  const [attesa, setAttesa] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  // Senza ambito: i suggerimenti sono tutte le categorie dell'archivio, anche
  // quelle usate finora solo al lavoro. Filtrarli sull'ambito della scheda
  // renderebbe impossibile accorgersi che «trasferte» esiste gia' mentre si sta
  // per scrivere «trasferta» su una scheda personale, che e' esattamente il
  // caso per cui questo campo suggerisce qualcosa.
  //
  // Se la richiesta fallisce non si dice niente e non si suggerisce niente: il
  // campo resta scrivibile, e un avviso rosso per un elenco di suggerimenti
  // mancato sarebbe piu' rumoroso del danno.
  const { stato: statoTag } = useAsync<TagList>(() => apiClient.listTags(), [apiClient]);

  const nome = nuova.trim();
  // Un'unica condizione per il pulsante e per il tasto Invio. Se fossero due
  // liste di controlli, il giorno in cui una cresce l'altra diventa la porta di
  // servizio: si aggiungerebbe col tasto Invio cio' che il pulsante rifiuta.
  const puoAggiungere =
    !attesa && nome !== "" && !p.tag.includes(nome) && p.tag.length < PROCEDURE_TAG_MAX;

  async function manda(prossime: readonly string[]): Promise<void> {
    setAttesa(true);
    setErrore(null);
    try {
      await apiClient.updateProcedure(p.id, { tag: [...prossime] });
      setNuova("");
      // Si ricarica invece di aggiornare a mano una copia locale: cosi' cio'
      // che si vede e' cio' che il server ha davvero salvato. Vale il doppio
      // qui, dove il server normalizza i doppioni per conto suo.
      onCambiata();
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
    } finally {
      setAttesa(false);
    }
  }

  const suggerimenti =
    statoTag.kind === "pronto"
      ? // Le categorie che la scheda ha gia' non si suggeriscono: sono l'unica
        // cosa che il campo non puo' aggiungere, e proporle sarebbe proporre di
        // premere un pulsante spento.
        statoTag.dato.items.filter((t) => !p.tag.includes(t.nome))
      : [];

  return (
    <section className="sezione categorie">
      <h2>Categorie</h2>

      <div className="categorie__elenco">
        {p.tag.length === 0 ? (
          <p className="muto">Questa scheda non e&apos; in nessuna categoria.</p>
        ) : (
          p.tag.map((t) => (
            <span key={t} className="chip chip--fermo">
              {t}
              {/* La crocetta dice quale, nel nome accessibile: una fila di
                  pulsanti tutti chiamati «×» e' illeggibile per chi non vede lo
                  schermo, ed e' il posto dove si sbaglia categoria. */}
              <button
                type="button"
                className="categorie__togli"
                aria-label={`Togli la categoria ${t}`}
                disabled={attesa}
                onClick={() => {
                  void manda(p.tag.filter((altra) => altra !== t));
                }}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      <div className="categorie__aggiungi">
        <label className="campo">
          <span>Aggiungi una categoria</span>
          <input
            type="text"
            list="categorie-esistenti"
            value={nuova}
            maxLength={PROCEDURE_TAG_NAME_MAX}
            disabled={attesa}
            onChange={(e) => {
              setNuova(e.target.value);
            }}
            onKeyDown={(e) => {
              // Invio aggiunge. Su un telefono il tasto verde della tastiera e'
              // l'unico modo di non dover mirare al pulsante dopo aver scritto,
              // e questo riquadro non e' dentro un `<form>` — quindi senza
              // questa riga Invio non farebbe niente e sembrerebbe un campo
              // rotto.
              if (e.key === "Enter" && puoAggiungere) {
                e.preventDefault();
                void manda([...p.tag, nome]);
              }
            }}
          />
        </label>
        <datalist id="categorie-esistenti">
          {suggerimenti.map((t) => (
            <option key={t.nome} value={t.nome} />
          ))}
        </datalist>
        <button
          type="button"
          className="bottone bottone--primario"
          disabled={!puoAggiungere}
          onClick={() => {
            void manda([...p.tag, nome]);
          }}
        >
          {attesa ? "Salvo…" : "Aggiungi"}
        </button>
      </div>

      {/* Il tetto si spiega solo quando lo si e' raggiunto. Scritto sempre
          sarebbe una riga di regolamento sotto ogni scheda, letta da nessuno
          proprio perche' c'e' sempre. */}
      {p.tag.length >= PROCEDURE_TAG_MAX && (
        <p className="muto">
          Piu&apos; di {String(PROCEDURE_TAG_MAX)} categorie non ci stanno. Toglierne una
          libera un posto.
        </p>
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
  const apiClient = useApi();
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
 *
 * ## Ed e' anche l'unico posto da cui si puo' buttare
 *
 * Il pulsante che cancella un vocale sta qui e non nella lista delle sospese,
 * dove pure ce n'e' uno: quella lista mostra solo cio' che non e' ancora
 * diventato una scheda, quindi da li' non si e' mai potuto cancellare un vocale
 * che ne aveva prodotta una. Questa e' l'unica schermata dell'app in cui la
 * voce e la scheda che ne e' nata sono sotto gli occhi insieme, ed e' l'unica
 * in cui la domanda «e la scheda?» si puo' porre a chi sa gia' quale scheda
 * sia.
 */
function Origine({
  p,
  onCambiata,
}: {
  p: ProcedureDetail;
  onCambiata: () => void;
}): React.JSX.Element | null {
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
          {/*
            Dentro il `<details>`, e non accanto al riassunto: per premerlo
            bisogna aver aperto il vocale, cioe' aver visto di quale si tratta.
            Un pulsante «elimina» in fila sotto tre riquadri chiusi tutti
            intitolati «Vocale del 3 marzo» e' un modo di far buttare via quello
            sbagliato.
          */}
          <EliminaVocale recordingId={r.id} onFatto={onCambiata} />
        </details>
      ))}
    </section>
  );
}

/**
 * Le due cose che «elimina» puo' voler dire, dette prima di sceglierne una.
 *
 * Il secondo tocco non chiede conferma, chiede *quale*: la domanda vera non e'
 * «sei sicuro» — chi ha aperto un vocale e cercato il pulsante e' sicuro — ma
 * cosa ne sia della scheda. Fuori di qui non c'e' nessun posto dove porla: la
 * scheda archiviata non ricorda da dove sia arrivata la richiesta, e la riga
 * che le teneva insieme viene distrutta dalla stessa chiamata.
 *
 * I due bottoni dicono per esteso cosa resta in piedi invece di essere un
 * bottone e una casella da spuntare. Una casella si preme per sbaglio e poi si
 * preme «Elimina davvero» leggendo solo quello; qui non esiste un pulsante
 * chiamato «davvero», esistono due frasi diverse e bisogna sceglierne una.
 *
 * Dopo si ricarica e si resta. Le schede archiviate restano leggibili — e'
 * quello che «archiviata» significa qui — e mandare via chi ha appena premuto
 * gli toglierebbe l'unico modo di vedere che il gesto ha fatto le due cose che
 * aveva promesso: il vocale non c'e' piu', e in cima c'e' il bollino.
 */
function EliminaVocale({
  recordingId,
  onFatto,
}: {
  recordingId: string;
  onFatto: () => void;
}): React.JSX.Element {
  const apiClient = useApi();
  const [aperta, setAperta] = useState(false);
  // Quale delle due, non un booleano: mentre la richiesta e' in volo l'etichetta
  // deve continuare a dire cosa si e' scelto. Un «Elimino…» su entrambi i
  // pulsanti sarebbe il momento peggiore per non saperlo piu'.
  const [attesa, setAttesa] = useState<"solo" | "anche" | null>(null);
  const [errore, setErrore] = useState<string | null>(null);

  async function elimina(ancheLaScheda: boolean): Promise<void> {
    setAttesa(ancheLaScheda ? "anche" : "solo");
    setErrore(null);
    try {
      await apiClient.deleteRecording(recordingId, { ancheLaScheda });
      onFatto();
    } catch (error: unknown) {
      setErrore(messaggioDi(error));
      // Si richiude. Il 409 «e' in elaborazione» e' l'errore probabile qui, e
      // lasciare aperti due pulsanti rossi sotto il messaggio invita a
      // ripremere subito lo stesso che ha appena fallito.
      setAperta(false);
    } finally {
      setAttesa(null);
    }
  }

  return (
    <div className="origine__azioni">
      {errore !== null && (
        <p className="avviso avviso--errore" role="alert">
          {errore}
        </p>
      )}

      {aperta ? (
        <>
          <p className="muto">
            La voce sparisce e non torna: e&apos; l&apos;unica cosa in questa scheda che
            non si possa rifare.
          </p>
          <button
            type="button"
            className="bottone bottone--pericolo"
            disabled={attesa !== null}
            onClick={() => {
              void elimina(false);
            }}
          >
            {attesa === "solo" ? "Elimino il vocale…" : "Solo il vocale"}
            <span className="muto"> — la scheda resta</span>
          </button>
          <button
            type="button"
            className="bottone bottone--pericolo"
            disabled={attesa !== null}
            onClick={() => {
              void elimina(true);
            }}
          >
            {attesa === "anche" ? "Elimino tutti e due…" : "Il vocale e la scheda"}
            <span className="muto"> — la scheda va in archivio</span>
          </button>
          <button
            type="button"
            className="bottone bottone--piatto"
            disabled={attesa !== null}
            onClick={() => {
              setAperta(false);
            }}
          >
            Annulla
          </button>
        </>
      ) : (
        <button
          type="button"
          className="bottone bottone--piatto"
          onClick={() => {
            setAperta(true);
          }}
        >
          Elimina questo vocale
        </button>
      )}
    </div>
  );
}
