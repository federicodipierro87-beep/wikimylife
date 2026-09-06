import {
  CardStatus,
  Outcome,
  Scope,
  Visibility,
  embeddingInput,
  isObsoleta,
  searchText,
  type ApplyRedactionBody,
  type CreateExecutionBody,
  type EmbeddingProvider,
  type ListProceduresQuery,
  type ProcedureDetail,
  type ProcedureList,
  type ProcedureSummary,
  type RedactionReport,
  type UpdateProcedureBody,
} from "@wikimylife/shared";
import { AppError } from "../errors/AppError.js";
import type { Clock } from "./ports/Clock.js";
import { idProposti, patchDiRedazione, proposteDi } from "./redaction/proposals.js";
import type {
  AddExecutionData,
  ProcedureDetailRow,
  ProcedureRepository,
  ProcedureScalarPatch,
  ProcedureSummaryRow,
  UpdateProcedureData,
} from "./ports/ProcedureRepository.js";

/**
 * Lettura e modifica delle schede.
 *
 * Qui vivono le tre regole che il brief chiama trasversali e che quindi non
 * possono stare ne' nella rotta ne' nell'interfaccia:
 *
 *  1. §9 — una scheda di ambito `CLIENTE` non diventa `PUBBLICA`, mai;
 *  2. §9 — una scheda con `contieneDatiSensibili` non diventa `PUBBLICA` senza
 *     che prima qualcuno tolga quel flag, cioe' senza «una revisione esplicita»;
 *  3. §8 — un'esecuzione con esito `CAMBIATA` riporta la scheda in
 *     `DA_RIVEDERE`.
 *
 * Nessun import di express, di Prisma o di un SDK: le regole si provano con un
 * repository in memoria e un `Clock` fermo, che e' il solo modo di verificare la
 * soglia dell'anno senza fake timer globali.
 */

// ---------------------------------------------------------------------------
// Da riga a contratto HTTP
// ---------------------------------------------------------------------------

function toSummary(row: ProcedureSummaryRow, adesso: Date): ProcedureSummary {
  return {
    id: row.id,
    titolo: row.titolo,
    trigger: row.trigger,
    esito: row.esito,
    scope: row.scope,
    clientLabel: row.clientLabel,
    visibility: row.visibility,
    status: row.status,
    durataStimataMin: row.durataStimataMin,
    costoTotaleCent: row.costoTotaleCent,
    luogoNome: row.luogoNome,
    ultimaVerifica: row.ultimaVerifica?.toISOString() ?? null,
    volteEseguita: row.volteEseguita,
    contieneDatiSensibili: row.contieneDatiSensibili,
    // Calcolato a ogni lettura e non conservato: una colonna `obsoleta` sarebbe
    // vera oggi e falsa domani senza che nessuno abbia scritto niente, quindi
    // andrebbe ricalcolata da un job notturno per restare onesta. Un `>` in
    // memoria costa meno e non puo' andare fuori sincrono.
    obsoleta: isObsoleta(row.ultimaVerifica, adesso),
    numeroPassi: row.numeroPassi,
    tag: [...row.tag],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProcedureDetail(row: ProcedureDetailRow, adesso: Date): ProcedureDetail {
  return {
    ...toSummary(row, adesso),
    validitaEsito: row.validitaEsito,
    luogoDettaglio: row.luogoDettaglio,
    latitude: row.latitude,
    longitude: row.longitude,
    forkedFromId: row.forkedFromId,
    steps: row.steps.map((s) => ({ ...s })),
    prereqs: row.prereqs.map((p) => ({ ...p })),
    pitfalls: row.pitfalls.map((p) => ({ ...p })),
    costs: row.costs.map((c) => ({ ...c })),
    refs: row.refs.map((r) => ({ ...r })),
    attachments: row.attachments.map((a) => ({ ...a })),
    executions: row.executions.map((e) => ({
      id: e.id,
      eseguitaIl: e.eseguitaIl.toISOString(),
      esito: e.esito,
      nota: e.nota,
    })),
    recordings: row.recordings.map((r) => ({
      id: r.id,
      recordedAt: r.recordedAt.toISOString(),
      durationMs: r.durationMs,
      transcript: r.transcript,
    })),
  };
}

export const toProcedureSummary = toSummary;

// ---------------------------------------------------------------------------
// Regole della §9
// ---------------------------------------------------------------------------

/**
 * Lo stato che la scheda avrebbe dopo la patch, per i tre campi che si
 * condizionano a vicenda.
 *
 * Va calcolato prima di scrivere, e su tutti e tre insieme: `PATCH { scope:
 * "CLIENTE" }` su una scheda gia' `PUBBLICA` e `PATCH { visibility: "PUBBLICA"
 * }` su una scheda gia' `CLIENTE` sono la stessa violazione da due direzioni
 * diverse. Controllare solo il campo che arriva ne prenderebbe una sola.
 */
export function verificaVisibilita(risultante: {
  scope: Scope;
  visibility: Visibility;
  contieneDatiSensibili: boolean;
}): void {
  if (risultante.visibility !== Visibility.PUBBLICA) {
    return;
  }
  if (risultante.scope === Scope.CLIENTE) {
    throw AppError.conflict(
      "Una scheda di ambito CLIENTE non puo' essere pubblica: il divieto e' nel codice, non nell'interfaccia",
    );
  }
  if (risultante.contieneDatiSensibili) {
    throw AppError.conflict(
      "Una scheda marcata come contenente dati sensibili non puo' diventare pubblica: togli prima il flag, dopo averla riletta",
    );
  }
}

// ---------------------------------------------------------------------------
// Servizio
// ---------------------------------------------------------------------------

export interface ProceduresService {
  list(userId: string, query: ListProceduresQuery): Promise<ProcedureList>;
  find(userId: string, id: string): Promise<ProcedureDetail>;
  update(userId: string, id: string, patch: UpdateProcedureBody): Promise<ProcedureDetail>;
  archive(userId: string, id: string): Promise<ProcedureDetail>;
  addExecution(userId: string, id: string, body: CreateExecutionBody): Promise<ProcedureDetail>;
  proposeRedaction(userId: string, id: string): Promise<RedactionReport>;
  applyRedaction(userId: string, id: string, body: ApplyRedactionBody): Promise<ProcedureDetail>;
}

export interface ProceduresServiceDeps {
  readonly repo: ProcedureRepository;
  readonly embeddings: EmbeddingProvider;
  readonly clock: Clock;
}

export function createProceduresService(deps: ProceduresServiceDeps): ProceduresService {
  const { repo, clock } = deps;

  async function detailOrThrow(userId: string, id: string): Promise<ProcedureDetailRow> {
    const row = await repo.findById(userId, id);
    if (row === null) {
      // 404 anche quando la riga esiste ma e' di un altro: un 403 confermerebbe
      // che quell'id e' stato assegnato a qualcuno.
      throw AppError.notFound("Scheda non trovata");
    }
    return row;
  }

  /**
   * La `PATCH`, come funzione e non solo come metodo.
   *
   * Serve un nome perche' `applyRedaction` la richiama: la redazione non e'
   * un'altra via di scrittura, e' una `PATCH` il cui contenuto lo calcola il
   * server invece di riceverlo. Se scrivesse per conto suo sul repository si
   * porterebbe dietro l'obbligo di ricordarsi di `searchText` e
   * `verificaVisibilita`, e quell'obbligo verrebbe dimenticato il giorno in cui
   * si aggiunge il terzo campo derivato.
   */
  async function aggiorna(
    userId: string,
    id: string,
    patch: UpdateProcedureBody,
  ): Promise<ProcedureDetail> {
    const current = await detailOrThrow(userId, id);

    verificaVisibilita({
      scope: patch.scope ?? current.scope,
      visibility: patch.visibility ?? current.visibility,
      contieneDatiSensibili: patch.contieneDatiSensibili ?? current.contieneDatiSensibili,
    });

    const { tag, steps, prereqs, pitfalls, costs, refs, ...scalars } = patch;
    const nuoviTag = tag ?? current.tag;
    const nuoviPassi = steps ?? current.steps;
    const nuoviPrereq = prereqs ?? current.prereqs;
    const nuoveTrappole = pitfalls ?? current.pitfalls;

    // L'embedding si ricalcola solo se cambia il testo da cui dipende
    // (`titolo + trigger + tag`, §7). Correggere un refuso in una trappola non
    // deve costare una chiamata di rete, e soprattutto non deve far fallire il
    // PATCH quando il provider di embedding e' giu'.
    const testoVecchio = embeddingInput({
      titolo: current.titolo,
      trigger: current.trigger,
      tag: current.tag,
    });
    const testoNuovo = embeddingInput({
      titolo: patch.titolo ?? current.titolo,
      trigger: patch.trigger === undefined ? current.trigger : patch.trigger,
      tag: nuoviTag,
    });

    const embedding =
      testoNuovo === testoVecchio ? undefined : await deps.embeddings.embed(testoNuovo);

    const scalarPatch: ProcedureScalarPatch = scalars;
    const data: UpdateProcedureData = {
      scalars: scalarPatch,
      ...(tag === undefined ? {} : { tag }),
      ...(steps === undefined ? {} : { steps }),
      ...(prereqs === undefined ? {} : { prereqs }),
      ...(pitfalls === undefined ? {} : { pitfalls }),
      ...(costs === undefined ? {} : { costs }),
      ...(refs === undefined ? {} : { refs }),
      // Ricomposto sempre e per intero, dalla stessa funzione che usa la
      // pipeline di ingestione. Ricomporlo solo «quando serve» vorrebbe dire
      // decidere ogni volta quali campi lo compongono, cioe' tenere quella
      // lista in due posti.
      searchText: searchText({
        titolo: patch.titolo ?? current.titolo,
        trigger: patch.trigger === undefined ? current.trigger : patch.trigger,
        esito: patch.esito === undefined ? current.esito : patch.esito,
        steps: nuoviPassi,
        prereqs: nuoviPrereq,
        pitfalls: nuoveTrappole,
        tag: nuoviTag,
      }),
      ...(embedding === undefined ? {} : { embedding }),
    };

    const updated = await repo.update(userId, id, data);
    if (updated === null) {
      throw AppError.notFound("Scheda non trovata");
    }
    return toProcedureDetail(updated, clock.now());
  }

  return {
    async list(userId: string, query: ListProceduresQuery): Promise<ProcedureList> {
      const page = await repo.list(userId, {
        scope: query.scope,
        status: query.status,
        tag: query.tag,
        limit: query.limit,
        offset: query.offset,
      });
      const adesso = clock.now();
      return {
        items: page.items.map((row) => toSummary(row, adesso)),
        total: page.total,
        limit: query.limit,
        offset: query.offset,
      };
    },

    async find(userId: string, id: string): Promise<ProcedureDetail> {
      return toProcedureDetail(await detailOrThrow(userId, id), clock.now());
    },

    update: aggiorna,

    async archive(userId: string, id: string): Promise<ProcedureDetail> {
      const archived = await repo.archive(userId, id);
      if (archived === null) {
        throw AppError.notFound("Scheda non trovata");
      }
      return toProcedureDetail(archived, clock.now());
    },

    async addExecution(
      userId: string,
      id: string,
      body: CreateExecutionBody,
    ): Promise<ProcedureDetail> {
      const current = await detailOrThrow(userId, id);

      if (current.status === CardStatus.ARCHIVIATA) {
        // Non un 404: la scheda si vede, si legge, e l'id e' giusto. E' proprio
        // l'operazione a non avere senso — e dirlo permette all'interfaccia di
        // proporre «ripristinala prima».
        throw AppError.conflict(
          "La scheda e' archiviata: ripristinala prima di registrare un'esecuzione",
        );
      }

      const eseguitaIl = body.eseguitaIl === undefined ? clock.now() : new Date(body.eseguitaIl);

      const data: AddExecutionData = {
        eseguitaIl,
        esito: body.esito,
        nota: body.nota,
        // Solo `FUNZIONATO` e' una verifica. `CAMBIATA` dice che la procedura
        // non funziona piu' com'e' scritta e `FALLITA` che non ha funzionato
        // affatto: aggiornare `ultimaVerifica` in quei casi renderebbe fresca
        // una scheda proprio nel momento in cui si e' scoperto che e' sbagliata.
        //
        // E non si arretra mai: registrare oggi un'esecuzione di sei mesi fa non
        // deve invecchiare la scheda.
        ...(body.esito === Outcome.FUNZIONATO &&
        (current.ultimaVerifica === null || eseguitaIl > current.ultimaVerifica)
          ? { ultimaVerifica: eseguitaIl }
          : {}),
        ...statoDopo(current.status, body.esito),
      };

      const updated = await repo.addExecution(userId, id, data);
      if (updated === null) {
        throw AppError.notFound("Scheda non trovata");
      }
      return toProcedureDetail(updated, clock.now());
    },

    /**
     * La passata di redazione della §9, meta' proposta.
     *
     * Non tocca niente e non conserva niente: le proposte si ricalcolano a ogni
     * chiamata dal testo com'e' in quel momento. Una tabella di proposte in
     * attesa sarebbe la cosa ovvia da aggiungere, e sarebbe un secondo posto
     * dove il codice fiscale dell'utente resta scritto anche dopo che la scheda
     * e' stata ripulita.
     *
     * Si puo' chiedere su qualsiasi scheda, anche senza il flag: il flag dice
     * cosa ha pensato l'estrazione, non cosa c'e' davvero nel testo. Una scheda
     * scritta a mano non passa dall'estrazione e non ha mai il flag.
     */
    async proposeRedaction(userId: string, id: string): Promise<RedactionReport> {
      const row = await detailOrThrow(userId, id);
      return {
        procedureId: row.id,
        proposte: [...proposteDi(row)],
        contieneDatiSensibili: row.contieneDatiSensibili,
      };
    },

    /**
     * L'altra meta': si applica solo cio' che e' stato confermato.
     *
     * Il flag non lo tocca. La §9 chiede «una revisione esplicita» prima della
     * pubblicazione, e togliere `contieneDatiSensibili` perche' i rilevatori
     * non trovano piu' niente vorrebbe dire far dichiarare alle regex che la
     * scheda e' pulita — quando l'unica cosa che sanno e' che non riconoscono
     * piu' nessuno dei quattro formati che conoscono. Il nome dell'ex moglie di
     * un cliente non ha un checksum. Il flag resta finche' non lo toglie una
     * persona, con la `PATCH`, e quella e' la revisione esplicita.
     */
    async applyRedaction(
      userId: string,
      id: string,
      body: ApplyRedactionBody,
    ): Promise<ProcedureDetail> {
      const row = await detailOrThrow(userId, id);
      const disponibili = idProposti(row);

      // Tutto o niente. Un id che non si ritrova significa che il testo e'
      // cambiato fra la lettura e questa chiamata: gli offset degli altri id
      // valgono per una versione della scheda che non esiste piu', e applicarli
      // lo stesso cancellerebbe caratteri scelti guardando un altro testo.
      const sconosciute = body.conferme.filter((c) => !disponibili.has(c));
      if (sconosciute.length > 0) {
        throw AppError.conflict(
          `La scheda e' cambiata da quando hai chiesto le proposte: ${String(sconosciute.length)} conferme non corrispondono piu' a niente. Rileggi le proposte e riprova`,
        );
      }

      const patch = patchDiRedazione(row, new Set(body.conferme));
      return aggiorna(userId, id, patch);
    },
  };
}

/**
 * Il diagramma della §8, nell'unico punto in cui si applica.
 *
 * `CAMBIATA` → `DA_RIVEDERE`: la procedura c'e' ancora ma cio' che vi e' scritto
 * non corrisponde piu'.
 *
 * `FUNZIONATO` su una scheda `DA_RIVEDERE` → `COMPLETA`: e' l'altra freccia
 * dello stesso diagramma, e senza di essa una scheda tornata `DA_RIVEDERE` non
 * potrebbe piu' uscirne se non a mano.
 *
 * `FALLITA` non muove niente: la §8 non ha una freccia per lei, e inventarne una
 * significherebbe decidere al posto dell'utente se la colpa e' della scheda o
 * della giornata.
 */
function statoDopo(
  attuale: CardStatus,
  esito: Outcome,
): { status?: CardStatus } {
  if (esito === Outcome.CAMBIATA && attuale !== CardStatus.DA_RIVEDERE) {
    return { status: CardStatus.DA_RIVEDERE };
  }
  if (esito === Outcome.FUNZIONATO && attuale === CardStatus.DA_RIVEDERE) {
    return { status: CardStatus.COMPLETA };
  }
  return {};
}
