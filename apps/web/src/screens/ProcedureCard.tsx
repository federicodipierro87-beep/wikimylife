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

      {p.contieneDatiSensibili && (
        <span className="riga__sensibile" title="Contiene dati sensibili">
          Dati sensibili
        </span>
      )}
    </button>
  );
}
