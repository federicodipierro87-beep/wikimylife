import {
  SEARCH_MAX_DEPTH,
  type EmbeddingProvider,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
} from "@wikimylife/shared";
import type { Clock } from "./ports/Clock.js";
import type { ProcedureRepository, ScoredProcedureId } from "./ports/ProcedureRepository.js";
import { toProcedureSummary } from "./procedures.service.js";
import { confrontaPerRilevanza, fuseRankings } from "./search/fusion.js";

/**
 * La ricerca ibrida della §7.
 *
 * Tre passi: due interrogazioni indipendenti, una fusione, una lettura.
 *
 * ## Perche' a ciascun canale si chiede sempre lo stesso numero di righe
 *
 * A ciascun canale si chiedono `SEARCH_MAX_DEPTH` righe: una finestra fissa, non
 * un multiplo di quelle che l'utente ha chiesto. Le ragioni sono due, e la
 * seconda e' arrivata dopo.
 *
 * La prima e' il modo stesso in cui funziona RRF: una scheda che sta ventunesima
 * nel full-text e prima nella semantica dovrebbe finire in cima, ma se al
 * full-text avessimo chiesto solo venti righe non sapremmo nemmeno che il testo
 * la contiene, e la classificheremmo come `SEMANTICA` invece che `ENTRAMBE`. Il
 * costo e' qualche riga in piu' da due indici; il beneficio e' che l'accordo fra
 * canali viene visto davvero.
 *
 * La seconda e' la paginazione. Finche' la finestra valeva `limit * 3`, la
 * classifica fusa dipendeva dalla dimensione della pagina: chiedere venti
 * risultati e chiederne cinquanta produceva due ordinamenti diversi, e la
 * seconda pagina non era la continuazione della prima. Con una finestra fissa la
 * fusione e' funzione dei soli `q`, `scope` e dati: `offset` diventa un indice
 * dentro una lista che non si muove, e costa uguale a qualsiasi profondita' —
 * saltare ottanta risultati non e' leggere ottanta righe in piu', perche' le
 * righe si leggono solo per la pagina che si serve.
 *
 * Il prezzo e' dichiarato invece che nascosto: oltre `SEARCH_MAX_DEPTH` non si
 * sfoglia. Cio' che nessuno dei due canali ha messo fra i suoi primi cento non
 * entra nella fusione, e nessuna pagina lo farebbe comparire.
 *
 * ## Cosa succede se l'embedding non si puo' calcolare
 *
 * La ricerca semantica ha bisogno di una chiamata di rete al provider. Se
 * fallisce, la ricerca NON fallisce: si degrada al solo full-text. E' l'unica
 * scelta difendibile — l'alternativa e' che un timeout di un servizio esterno
 * renda inutilizzabile la funzione principale dell'app su dati che sono gia'
 * tutti in casa.
 */

export interface SearchService {
  search(userId: string, query: SearchQuery): Promise<SearchResult>;
}

export interface SearchServiceDeps {
  readonly repo: ProcedureRepository;
  readonly embeddings: EmbeddingProvider;
  readonly clock: Clock;
  /** Per annotare il degrado a solo full-text: non e' un errore, ma va visto. */
  readonly onSemanticUnavailable?: ((error: unknown) => void) | undefined;
}

export function createSearchService(deps: SearchServiceDeps): SearchService {
  const { repo, clock } = deps;

  return {
    async search(userId: string, query: SearchQuery): Promise<SearchResult> {
      const options = {
        limit: SEARCH_MAX_DEPTH,
        ...(query.scope === undefined ? {} : { scope: query.scope }),
      };

      const [fullText, semantic] = await Promise.all([
        repo.searchFullText(userId, query.q, options),
        (async (): Promise<readonly ScoredProcedureId[]> => {
          try {
            const vector = await deps.embeddings.embed(query.q);
            return await repo.searchSemantic(userId, vector, options);
          } catch (error) {
            deps.onSemanticUnavailable?.(error);
            return [];
          }
        })(),
      ]);

      // La classifica servibile e' una sola, e ogni pagina e' una finestra sulla
      // stessa: e' questo che rende `offset` un indice e non una scommessa.
      const servibili = fuseRankings({ fullText, semantic }).slice(0, SEARCH_MAX_DEPTH);
      const fine = query.offset + query.limit;
      const hasMore = servibili.length > fine;

      // Si tagliano gli id PRIMA di leggere le righe: idratare cento schede per
      // mostrarne venti sarebbe lavoro buttato, e la fusione ha gia' deciso
      // l'ordine di rilevanza.
      const vincitori = servibili.slice(query.offset, fine);
      if (vincitori.length === 0) {
        return { q: query.q, items: [], limit: query.limit, offset: query.offset, hasMore };
      }
      const righe = await repo.summariesByIds(
        userId,
        vincitori.map((f) => f.id),
      );
      const perId = new Map(righe.map((r) => [r.id, r]));

      // Il riordino per freschezza vale dentro la pagina, non fra pagine: due
      // schede a pari punteggio che cadono ai lati del taglio non si incontrano
      // mai. Confrontarle vorrebbe dire idratare tutte e cento le candidate a
      // ogni ricerca — e sarebbe pagare l'intera profondita' per rifinire un
      // pareggio. Cio' che la paginazione promette e' che nessuna scheda si
      // ripeta e nessuna sparisca, e quello lo garantisce il taglio sugli id.
      const adesso = clock.now();
      const items: SearchHit[] = vincitori
        .flatMap((f) => {
          const row = perId.get(f.id);
          // Assente = cancellata fra la query e l'idratazione. Si salta invece di
          // lanciare: una riga sparita e' un caso normale, non un errore.
          return row === undefined ? [] : [{ fused: f, row }];
        })
        .sort((a, b) =>
          confrontaPerRilevanza(
            {
              score: a.fused.score,
              ultimaVerifica: a.row.ultimaVerifica,
              volteEseguita: a.row.volteEseguita,
            },
            {
              score: b.fused.score,
              ultimaVerifica: b.row.ultimaVerifica,
              volteEseguita: b.row.volteEseguita,
            },
          ),
        )
        .map(({ fused: f, row }) => ({
          ...toProcedureSummary(row, adesso),
          score: f.score,
          matchedBy: f.matchedBy,
        }));

      // `hasMore` guarda `servibili`, non `items`: se una scheda e' stata
      // cancellata fra la fusione e l'idratazione la pagina esce piu' corta di
      // `limit`, ma la successiva esiste lo stesso e va offerta.
      return { q: query.q, items, limit: query.limit, offset: query.offset, hasMore };
    },
  };
}
