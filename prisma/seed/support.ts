import type { Prisma, PrismaClient } from "@prisma/client";
import type { CardStatus, Outcome, PrereqType, RefType, Scope, Severity } from "@wikimylife/shared";
import {
  EMBEDDING_DIMENSIONS,
  deterministicUnitVector,
  embeddingInput,
  searchText,
  toVectorLiteral,
} from "@wikimylife/shared";

/**
 * Costruzione di una procedura del seed.
 *
 * Il punto di questo file: le invarianti della §6 (`costoTotaleCent`,
 * `volteEseguita`, `ultimaVerifica`) NON si scrivono a mano nei dati di prova,
 * si calcolano dalle righe figlie. Un seed con `volteEseguita: 2` accanto a tre
 * Execution e' un database che mente, e il test che lo verifica passerebbe solo
 * perche' entrambi i numeri sono stati copiati dallo stesso errore.
 */

export interface StepInput {
  readonly ordine: number;
  readonly azione: string;
  readonly dettaglio: string | null;
  readonly durataStimataMin: number | null;
}

export interface PrereqInput {
  readonly descrizione: string;
  readonly tipo: PrereqType;
  readonly obbligatorio: boolean;
}

export interface PitfallInput {
  readonly descrizione: string;
  readonly gravita: Severity;
}

export interface CostInput {
  readonly descrizione: string;
  readonly importoCent: number;
  readonly valuta: string;
}

export interface ReferenceInput {
  readonly tipo: RefType;
  readonly valore: string;
}

export interface ExecutionInput {
  readonly eseguitaIl: Date;
  readonly esito: Outcome;
  readonly nota: string | null;
}

export interface ProcedureBlueprint {
  readonly id: string;
  readonly userId: string;
  readonly titolo: string;
  readonly trigger: string;
  readonly esito: string;
  readonly validitaEsito: string | null;
  readonly luogoNome: string | null;
  readonly luogoDettaglio: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly scope: Scope;
  readonly status: CardStatus;
  readonly contieneDatiSensibili: boolean;
  readonly tags: readonly string[];
  readonly steps: readonly StepInput[];
  readonly prereqs: readonly PrereqInput[];
  readonly pitfalls: readonly PitfallInput[];
  readonly costs: readonly CostInput[];
  readonly refs: readonly ReferenceInput[];
  readonly executions: readonly ExecutionInput[];
}

export interface ProcedureInvariants {
  readonly costoTotaleCent: number;
  readonly durataStimataMin: number | null;
  readonly volteEseguita: number;
  readonly ultimaVerifica: Date | null;
}

/**
 * Le tre invarianti, in un posto solo.
 *
 * `ultimaVerifica` considera solo `FUNZIONATO`: una Execution `CAMBIATA` dice
 * che la procedura non funziona piu' com'e' scritta, quindi non e' una verifica
 * — semmai il contrario (§8). Questo e' il motivo per cui la procedura B del
 * seed, che ha una esecuzione ma `CAMBIATA`, ha `ultimaVerifica = null`.
 */
export function computeInvariants(blueprint: ProcedureBlueprint): ProcedureInvariants {
  const costoTotaleCent = blueprint.costs.reduce((sum, c) => sum + c.importoCent, 0);

  const durate = blueprint.steps
    .map((s) => s.durataStimataMin)
    .filter((d): d is number => d !== null);
  const durataStimataMin =
    durate.length === 0 ? null : durate.reduce((sum, d) => sum + d, 0);

  const verifiche = blueprint.executions
    .filter((e) => e.esito === "FUNZIONATO")
    .map((e) => e.eseguitaIl.getTime());
  const ultimaVerifica = verifiche.length === 0 ? null : new Date(Math.max(...verifiche));

  return {
    costoTotaleCent,
    durataStimataMin,
    // §6: `volteEseguita` conta le esecuzioni registrate, di qualunque esito.
    volteEseguita: blueprint.executions.length,
    ultimaVerifica,
  };
}

/** Il testo da cui nasce l'embedding: titolo + trigger + tag (§7). */
export function procedureEmbeddingText(blueprint: ProcedureBlueprint): string {
  return embeddingInput({
    titolo: blueprint.titolo,
    trigger: blueprint.trigger,
    tag: blueprint.tags,
  });
}

/**
 * [D10] Il testo da cui Postgres genera il `tsvector` italiano.
 *
 * Piu' largo di quello dell'embedding, e di proposito: qui entrano anche passi,
 * prerequisiti e trappole, cioe' le parole esatte che il seed serve a rendere
 * cercabili nei test di integrazione ("marca da bollo" sta al secondo costo
 * della procedura A, non nel titolo).
 */
export function procedureSearchText(blueprint: ProcedureBlueprint): string {
  return searchText({
    titolo: blueprint.titolo,
    trigger: blueprint.trigger,
    esito: blueprint.esito,
    steps: blueprint.steps,
    prereqs: blueprint.prereqs,
    pitfalls: blueprint.pitfalls,
    tag: blueprint.tags,
  });
}

async function upsertTags(
  prisma: PrismaClient,
  userId: string,
  nomi: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const nome of nomi) {
    const tag = await prisma.tag.upsert({
      where: { userId_nome: { userId, nome } },
      update: {},
      create: { userId, nome },
    });
    ids.push(tag.id);
  }
  return ids;
}

/**
 * Scrive l'embedding.
 *
 * `Procedure.embedding` e' `Unsupported("vector(1536)")`: Prisma la esclude dal
 * client tipizzato, quindi l'unica via e' SQL grezzo. Il vettore va come
 * PARAMETRO bindato e castato — mai concatenato nella stringa, anche se qui il
 * contenuto e' generato in casa: la regola vale sempre, altrimenti in Fase 2
 * qualcuno copiera' questa riga con un input che arriva da fuori.
 */
export async function writeEmbedding(
  prisma: PrismaClient,
  procedureId: string,
  text: string,
): Promise<void> {
  const literal = toVectorLiteral(deterministicUnitVector(text, EMBEDDING_DIMENSIONS));
  await prisma.$executeRaw`UPDATE "Procedure" SET embedding = ${literal}::vector WHERE id = ${procedureId}`;
}

/**
 * Crea la procedura con tutte le righe figlie, in una transazione.
 *
 * A monte deve essere gia' passato `resetSeedData`: qui si crea, non si fa
 * upsert riga per riga. Fare upsert dei figli richiederebbe chiavi naturali che
 * lo schema non ha (un Pitfall non ha unicita' oltre all'id), e l'idempotenza
 * si ottiene molto meglio cancellando in blocco e ricreando.
 */
export async function createProcedure(
  prisma: PrismaClient,
  blueprint: ProcedureBlueprint,
): Promise<void> {
  const invariants = computeInvariants(blueprint);
  const tagIds = await upsertTags(prisma, blueprint.userId, blueprint.tags);

  const data: Prisma.ProcedureCreateInput = {
    id: blueprint.id,
    user: { connect: { id: blueprint.userId } },
    titolo: blueprint.titolo,
    trigger: blueprint.trigger,
    esito: blueprint.esito,
    validitaEsito: blueprint.validitaEsito,
    durataStimataMin: invariants.durataStimataMin,
    costoTotaleCent: invariants.costoTotaleCent,
    luogoNome: blueprint.luogoNome,
    luogoDettaglio: blueprint.luogoDettaglio,
    latitude: blueprint.latitude,
    longitude: blueprint.longitude,
    scope: blueprint.scope,
    // Lo stato si scrive sempre esplicitamente: il `@default(BOZZA_AUDIO)` dello
    // schema esiste per la spec, non per essere usato.
    status: blueprint.status,
    contieneDatiSensibili: blueprint.contieneDatiSensibili,
    ultimaVerifica: invariants.ultimaVerifica,
    volteEseguita: invariants.volteEseguita,
    searchText: procedureSearchText(blueprint),
    steps: { create: blueprint.steps.map((s) => ({ ...s })) },
    prereqs: { create: blueprint.prereqs.map((p) => ({ ...p })) },
    pitfalls: { create: blueprint.pitfalls.map((p) => ({ ...p })) },
    costs: { create: blueprint.costs.map((c) => ({ ...c })) },
    refs: { create: blueprint.refs.map((r) => ({ ...r })) },
    executions: { create: blueprint.executions.map((e) => ({ ...e })) },
    tags: { create: tagIds.map((tagId) => ({ tag: { connect: { id: tagId } } })) },
  };

  await prisma.procedure.create({ data });
  await writeEmbedding(prisma, blueprint.id, procedureEmbeddingText(blueprint));
}
