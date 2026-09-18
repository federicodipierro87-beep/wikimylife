import type { ProcedureSummary } from "@wikimylife/shared";
import { badgesOf, formatCosto, formatDurata, formatQuando } from "../format";
import { navigate } from "../router";

/**
 * Una scheda in lista.
 *
 * Stessa riga in elenco e in ricerca: sono due liste della stessa cosa, e due
 * componenti diversi si sarebbero allontanati alla prima modifica.
 *
 * E' un `<button>` e non un `<div onClick>`: la tastiera, il lettore di schermo
 * e il tocco lungo funzionano gratis, e non c'e' nessun `tabIndex` da mettere a
 * mano.
 *
 * ## Le categorie qui si leggono e basta
 *
 * Sono `<span>` e non `<button>`, quindi da qui non si filtra l'elenco toccando
 * una categoria — che sarebbe il gesto naturale, e infatti e' scritto fra i
 * difetti noti. La ragione e' meccanica: questa riga *e'* un `<button>`, e un
 * bottone dentro un bottone e' HTML non valido, con un comportamento che ogni
 * browser inventa per conto suo. Renderle premibili vorrebbe dire smontare la
 * riga-bottone e rifarla con un `<div>`, cioe' rimettere a mano il `tabIndex`,
 * il ruolo e l'attivazione da tastiera che il paragrafo qui sopra dice di aver
 * ottenuto gratis. Si perderebbe una cosa che funziona per tutti per guadagnare
 * una scorciatoia; le chip della riga dei filtri, in cima all'elenco, fanno gia'
 * lo stesso lavoro.
 */
export function ProcedureCard({ p }: { p: ProcedureSummary }): React.JSX.Element {
  const badges = badgesOf(p);
  const durata = formatDurata(p.durataStimataMin);
  const costo = formatCosto(p.costoTotaleCent);
  const quando = formatQuando(p.updatedAt);

  return (
    <button
      type="button"
      className="riga"
      onClick={() => {
        navigate({ name: "scheda", id: p.id });
      }}
    >
      <span className="riga__titolo">{p.titolo}</span>

      {badges.length > 0 && (
        <span className="riga__badge">
          {badges.map((b) => (
            <span key={b.kind} className={`badge badge--${b.kind}`}>
              {b.label}
            </span>
          ))}
        </span>
      )}

      {p.trigger !== null && <span className="riga__trigger">{p.trigger}</span>}

      <span className="riga__meta">
        {[
          p.numeroPassi > 0 ? `${String(p.numeroPassi)} passi` : null,
          durata,
          costo,
          p.luogoNome,
          quando,
        ]
          .filter((x): x is string => x !== null)
          .join(" · ")}
      </span>

      {/* Sotto la riga di mezzo e non sopra il titolo: le categorie servono a
          riconoscere una scheda fra venti, non a leggerla. E il contenitore
          esiste solo se c'e' dentro qualcosa, perche' `.riga__categorie` ha una
          sua spaziatura e vuoto lascerebbe un buco identico su tutte le schede
          che non sono state ancora categorizzate — cioe' quasi tutte. */}
      {p.tag.length > 0 && (
        <span className="riga__categorie">
          {p.tag.map((t) => (
            <span key={t} className="chip chip--fermo">
              {t}
            </span>
          ))}
        </span>
      )}

      {p.contieneDatiSensibili && (
        <span className="riga__sensibile" title="Contiene dati sensibili">
          Dati sensibili
        </span>
      )}
    </button>
  );
}
