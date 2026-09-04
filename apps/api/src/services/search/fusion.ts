import { SearchMatch, type SearchMatch as SearchMatchType } from "@wikimylife/shared";
import type { ScoredProcedureId } from "../ports/ProcedureRepository.js";

/**
 * Fusione dei due canali di ricerca della §7, con Reciprocal Rank Fusion.
 *
 * ## Perche' non si sommano i punteggi
 *
 * `ts_rank_cd` restituisce numeri piccoli e senza scala fissa, che dipendono
 * dalla lunghezza del documento e da quante volte i termini vi compaiono. La
 * similarita' coseno sta in [-1, 1] e sui vettori di un modello di embedding, in
 * pratica, quasi tutta fra 0.6 e 0.95 — perche' due testi qualsiasi in italiano
 * si somigliano gia' parecchio.
 *
 * Sommarli, anche normalizzati, significa inventare un tasso di cambio fra due
 * grandezze che non ne hanno uno. E qualunque normalizzazione (min-max sui
 * risultati tornati) dipenderebbe dall'insieme che si sta normalizzando: la
 * stessa scheda prenderebbe punteggi diversi a seconda di chi altro e' finito
 * nella lista.
 *
 * RRF butta via i punteggi e tiene solo la POSIZIONE:
 *
 *     score(d) = Σ  1 / (k + rank(d, lista))
 *
 * Una scheda prima nel full-text e assente dalla semantica prende 1/61 ≈ 0.0164.
 * Una scheda terza in entrambe prende 2/63 ≈ 0.0317, e vince: e' esattamente il
 * comportamento che si vuole da una ricerca ibrida, cioe' premiare l'accordo fra
 * canali piu' dell'eccellenza in uno solo.
 *
 * `k = 60` e' il valore del lavoro originale di Cormack, Clarke e Buettcher
 * (2009). Serve a smorzare il vantaggio delle primissime posizioni: senza, la
 * differenza fra il primo e il secondo (1 contro 0.5) sarebbe piu' grande di
 * quella fra il secondo e il ventesimo.
 *
 * ## Perche' in TypeScript e non in SQL
 *
 * Si potrebbe fare con due CTE e una `FULL OUTER JOIN`. Sarebbe una query di
 * quaranta righe, verificabile solo con Postgres acceso, per un calcolo che non
 * tocca il disco: entrambe le liste sono gia' in memoria, lunghe qualche decina
 * di elementi. Qui invece e' una funzione pura, e i suoi casi limite — accordo,
 * disaccordo, un canale vuoto, un pareggio — si provano senza container.
 *
 * Le query restano due, e restano indicizzate: e' li' che sta il lavoro vero.
 */

export const RRF_K = 60;

export interface FusedHit {
  readonly id: string;
  readonly score: number;
  readonly matchedBy: SearchMatchType;
}

/**
 * A parita' di punteggio l'ordine dev'essere comunque deterministico, altrimenti
 * due ricerche identiche potrebbero rispondere in ordine diverso. Le due liste
 * arrivano gia' ordinate dal database, quindi la prima apparizione e' un criterio
 * stabile e sensato.
 */
interface Accumulatore {
  score: number;
  daTesto: boolean;
  daSemantica: boolean;
  primaApparizione: number;
}

export function fuseRankings(input: {
  readonly fullText: readonly ScoredProcedureId[];
  readonly semantic: readonly ScoredProcedureId[];
  readonly k?: number | undefined;
}): readonly FusedHit[] {
  const k = input.k ?? RRF_K;
  const acc = new Map<string, Accumulatore>();
  let ordine = 0;

  function assorbi(lista: readonly ScoredProcedureId[], canale: "testo" | "semantica"): void {
    lista.forEach((row, index) => {
      const corrente = acc.get(row.id) ?? {
        score: 0,
        daTesto: false,
        daSemantica: false,
        primaApparizione: ordine++,
      };
      corrente.score += 1 / (k + index + 1);
      if (canale === "testo") {
        corrente.daTesto = true;
      } else {
        corrente.daSemantica = true;
      }
      acc.set(row.id, corrente);
    });
  }

  assorbi(input.fullText, "testo");
  assorbi(input.semantic, "semantica");

  return [...acc.entries()]
    .map(([id, a]) => ({
      id,
      score: a.score,
      matchedBy:
        a.daTesto && a.daSemantica
          ? SearchMatch.ENTRAMBE
          : a.daTesto
            ? SearchMatch.TESTO
            : SearchMatch.SEMANTICA,
      primaApparizione: a.primaApparizione,
    }))
    .sort((x, y) => y.score - x.score || x.primaApparizione - y.primaApparizione)
    .map(({ id, score, matchedBy }) => ({ id, score, matchedBy }));
}

/**
 * L'ordinamento finale chiesto dal brief: «rilevanza, poi freschezza
 * (`ultimaVerifica`), poi `volteEseguita`».
 *
 * La freschezza NON entra nel punteggio, entra dopo, come criterio di
 * spareggio. E' una differenza che si vede alla prima ricerca: sommare un bonus
 * di freschezza al punteggio farebbe risalire una scheda verificata ieri ma che
 * parla d'altro sopra a quella giusta di due anni fa. Una ricerca che non
 * restituisce cio' che si e' cercato non e' una ricerca fresca, e' una ricerca
 * rotta.
 *
 * `ultimaVerifica === null` va in fondo fra i pari punteggio: e' una scheda che
 * nessuno ha mai confermato.
 */
export function confrontaPerRilevanza(
  a: { score: number; ultimaVerifica: Date | null; volteEseguita: number },
  b: { score: number; ultimaVerifica: Date | null; volteEseguita: number },
): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  const va = a.ultimaVerifica?.getTime() ?? Number.NEGATIVE_INFINITY;
  const vb = b.ultimaVerifica?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (va !== vb) {
    return vb - va;
  }
  return b.volteEseguita - a.volteEseguita;
}
