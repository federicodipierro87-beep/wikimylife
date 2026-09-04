import type {
  EmbeddingProvider,
  SearchHit,
  SearchQuery,
  SearchResult,
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
 * ## Perche' si chiede piu' del necessario a ciascun canale
 *
 * Se l'utente vuole 20 risultati, ogni canale ne restituisce
 * `limit * MOLTIPLICATORE`. La ragione e' il modo stesso in cui funziona RRF:
 * una scheda che sta ventunesima nel full-text e prima nella semantica dovrebbe
 * finire in cima, ma se al full-text avessimo chiesto solo venti righe non
 * sapremmo nemmeno che il testo la contiene, e la classificheremmo come
 * `SEMANTICA` invece che `ENTRAMBE`. Il costo e' qualche riga in piu' da due
 * indici; il beneficio e' che l'accordo fra canali viene visto davvero.
 *
 * ## Cosa succede se l'embedding non si puo' calcolare
 *
 * La ricerca semantica ha bisogno di una chiamata di rete al provider. Se
 * fallisce, la ricerca NON fallisce: si degrada al solo full-text. E' l'unica
 * scelta difendibile — l'alternativa e' che un timeout di un servizio esterno
 * renda inutilizzabile la funzione principale dell'app su dati che sono gia'
 * tutti in casa.
 */

/** Quante righe chiedere a ciascun canale, in rapporto a quelle richieste. */
const MOLTIPLICATORE_CANALE = 3;
/** Tetto assoluto: oltre, RRF non cambia piu' le prime venti posizioni. */
const MAX_PER_CANALE = 100;

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
      const perCanale = Math.min(query.limit * MOLTIPLICATORE_CANALE, MAX_PER_CANALE);
      const options = {
        limit: perCanale,
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

      const fused = fuseRankings({ fullText, semantic });
      if (fused.length === 0) {
        return { q: query.q, items: [] };
      }

      // Si tagliano gli id PRIMA di leggere le righe: idratare cento schede per
      // mostrarne venti sarebbe lavoro buttato, e la fusione ha gia' deciso
      // l'ordine di rilevanza.
      const vincitori = fused.slice(0, query.limit);
      const righe = await repo.summariesByIds(
        userId,
        vincitori.map((f) => f.id),
      );
      const perId = new Map(righe.map((r) => [r.id, r]));

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

      return { q: query.q, items };
    },
  };
}
