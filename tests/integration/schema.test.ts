import {
  cardStatusValues,
  EMBEDDING_DIMENSIONS,
  recordingStatusValues,
  scopeValues,
  visibilityValues,
} from "@wikimylife/shared";
import { afterAll, describe, expect, it } from "vitest";
import { disconnectTestPrisma, testPrisma } from "./helpers/db.js";

/**
 * Lo schema fisico, interrogato dal catalogo di Postgres.
 *
 * Questo file esiste per una ragione sola, e non e' verificare che la migration
 * di oggi funzioni — quella l'abbiamo appena eseguita. E' la difesa contro le
 * migration future.
 *
 * L'indice HNSW e la colonna `embedding` vivono su un tipo che Prisma dichiara
 * `Unsupported`. La drift detection non li vede. Il giorno in cui qualcuno
 * lancera' `prisma migrate dev` senza `--create-only` e accettera' l'SQL
 * generato, Prisma potrebbe emettere un `DROP INDEX` e il repository
 * continuerebbe a compilare, i test unitari continuerebbero a passare, e la
 * ricerca semantica degraderebbe in una scansione sequenziale che nessuno nota
 * finche' le procedure non diventano decine di migliaia.
 *
 * Qui invece diventa rosso.
 *
 * Gli enum si verificano allo stesso modo: sono definiti due volte, in
 * `packages/shared` (che non puo' importare `@prisma/client`, deve restare
 * isomorfo) e in `schema.prisma`. `apps/api/src/db/enum-parity.ts` fa fallire
 * `tsc` se divergono a livello di tipo, ma non sa niente di cosa esiste davvero
 * nel database: un enum aggiunto allo schema e mai migrato passerebbe la
 * compilazione. Questo test chiude anche quel buco.
 */

const prisma = testPrisma();

afterAll(async () => {
  await disconnectTestPrisma();
});

async function enumValues(name: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ label: string }[]>`
    SELECT e.enumlabel AS label
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = ${name}
    ORDER BY e.enumsortorder
  `;
  return rows.map((r) => r.label);
}

describe("estensione pgvector", () => {
  it("e' installata", async () => {
    const rows = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `;

    expect(rows).toHaveLength(1);
  });

  it("l'operatore coseno funziona", async () => {
    // Se l'estensione fosse installata in un altro schema, fuori dal
    // search_path, la riga sopra passerebbe e questa no.
    const rows = await prisma.$queryRaw<{ distance: number }[]>`
      SELECT '[1,0]'::vector <=> '[0,1]'::vector AS distance
    `;

    expect(rows[0]?.distance).toBeCloseTo(1, 10);
  });
});

describe("colonna Procedure.embedding", () => {
  it("e' di tipo vector", async () => {
    const rows = await prisma.$queryRaw<{ udt_name: string; is_nullable: string }[]>`
      SELECT udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Procedure'
        AND column_name = 'embedding'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.udt_name).toBe("vector");
    // Nullable: una procedura esiste prima che il worker calcoli il vettore.
    expect(rows[0]?.is_nullable).toBe("YES");
  });

  it("ha esattamente le dimensioni che il codice si aspetta", async () => {
    // La costante in `packages/shared` e la larghezza della colonna sono due
    // dichiarazioni della stessa cosa in due linguaggi diversi. Se divergono, il
    // sintomo naturale sarebbe un errore di Postgres al primo `UPDATE ... SET
    // embedding`, dentro un worker, forse di notte.
    const rows = await prisma.$queryRaw<{ dimensions: number }[]>`
      SELECT a.atttypmod AS dimensions
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'Procedure' AND a.attname = 'embedding'
    `;

    expect(rows[0]?.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(rows[0]?.dimensions).toBe(1536);
  });
});

describe("indice HNSW", () => {
  it("esiste su Procedure", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'Procedure'
    `;

    expect(rows.map((r) => r.indexname)).toContain("Procedure_embedding_hnsw_idx");
  });

  it("usa hnsw con la classe di operatori del coseno", async () => {
    // `vector_l2_ops` al posto di `vector_cosine_ops` non darebbe nessun errore:
    // il planner ignorerebbe l'indice e le query resterebbero corrette, solo
    // lente. E' il tipo di regressione che si scopre solo misurando.
    const rows = await prisma.$queryRaw<{ method: string; definition: string }[]>`
      SELECT am.amname AS method, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname = 'Procedure_embedding_hnsw_idx'
    `;

    expect(rows[0]?.method).toBe("hnsw");
    expect(rows[0]?.definition).toContain("vector_cosine_ops");
  });
});

describe("full-text [D10]", () => {
  it("searchText esiste, e' NOT NULL e ha un default", async () => {
    // Il default vale per le righe che nascono prima che il servizio scriva la
    // colonna: `NULL` la' dentro renderebbe `to_tsvector` nullo e la scheda
    // invisibile alla ricerca senza un solo errore.
    const rows = await prisma.$queryRaw<{ is_nullable: string; column_default: string | null }[]>`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Procedure'
        AND column_name = 'searchText'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_nullable).toBe("NO");
    expect(rows[0]?.column_default).not.toBeNull();
  });

  it("searchVector e' una colonna generata, non una da mantenere a mano", async () => {
    // GENERATED ALWAYS ... STORED e' cio' che rende impossibile che il vettore
    // e il testo divergano: non esiste un percorso di scrittura che aggiorni
    // l'uno senza l'altro, nemmeno un UPDATE fatto a mano in psql.
    const rows = await prisma.$queryRaw<{ udt_name: string; generation_expression: string | null }[]>`
      SELECT udt_name, generation_expression
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Procedure'
        AND column_name = 'searchVector'
    `;

    expect(rows[0]?.udt_name).toBe("tsvector");
    // `italian` e non `simple`: e' cio' che fa funzionare lo stemming.
    expect(rows[0]?.generation_expression).toContain("italian");
  });

  it("l'indice GIN esiste su searchVector", async () => {
    // Stesso rischio dell'HNSW: la colonna e' `Unsupported`, quindi l'indice e'
    // invisibile alla drift detection di Prisma.
    const rows = await prisma.$queryRaw<{ method: string; definition: string }[]>`
      SELECT am.amname AS method, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname = 'Procedure_searchVector_idx'
    `;

    expect(rows[0]?.method).toBe("gin");
    expect(rows[0]?.definition).toContain("searchVector");
  });

  it("la configurazione italiana esiste e fa stemming", async () => {
    // Se il container fosse costruito senza il dizionario italiano, la
    // migration passerebbe e la ricerca smetterebbe di trovare le forme flesse.
    const rows = await prisma.$queryRaw<{ uguali: boolean }[]>`
      SELECT to_tsvector('italian', 'pagare') = to_tsvector('italian', 'pagato') AS uguali
    `;

    expect(rows[0]?.uguali).toBe(true);
  });
});

describe("enum del database", () => {
  it("CardStatus include ESTRAZIONE_FALLITA [D1]", async () => {
    const values = await enumValues("CardStatus");

    expect(values).toContain("ESTRAZIONE_FALLITA");
    expect(values).toEqual([...cardStatusValues]);
  });

  it("RecordingStatus esiste ed e' distinto da CardStatus [D2]", async () => {
    const recording = await enumValues("RecordingStatus");
    const card = await enumValues("CardStatus");

    expect(recording).toEqual([...recordingStatusValues]);
    // Due tipi SQL diversi: assegnare uno stato di scheda a una registrazione e'
    // un errore di tipo in Postgres, non solo in TypeScript.
    expect(recording).not.toEqual(card);
  });

  it("Scope e Visibility combaciano con packages/shared", async () => {
    expect(await enumValues("Scope")).toEqual([...scopeValues]);
    expect(await enumValues("Visibility")).toEqual([...visibilityValues]);
  });
});

describe("vincoli che il dominio da' per scontati", () => {
  it("l'email dell'utente e' unica", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'User' AND indexdef LIKE '%UNIQUE%'
    `;

    expect(rows.map((r) => r.indexname)).toContain("User_email_key");
  });

  it("il tokenHash del refresh token e' unico", async () => {
    // Senza questo vincolo la reuse detection avrebbe una condizione di corsa:
    // due richieste simultanee potrebbero inserire lo stesso hash.
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'RefreshToken' AND indexdef LIKE '%UNIQUE%'
    `;

    expect(rows.map((r) => r.indexname)).toContain("RefreshToken_tokenHash_key");
  });

  it("Recording ha l'indice su status che il worker usera' per il polling [D3]", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'Recording'
    `;

    expect(rows.map((r) => r.indexname)).toContain("Recording_status_idx");
  });

  it("cancellare la scheda suggerita non cancella la registrazione [D9]", async () => {
    // ON DELETE SET NULL e non CASCADE: `duplicateOfId` e' un suggerimento, e
    // un suggerimento che sparisce non deve portarsi via l'audio e la
    // trascrizione originali. CASCADE qui sarebbe perdita di dati silenziosa.
    const rows = await prisma.$queryRaw<{ delete_rule: string }[]>`
      SELECT rc.delete_rule
      FROM information_schema.referential_constraints rc
      WHERE rc.constraint_schema = 'public'
        AND rc.constraint_name = 'Recording_duplicateOfId_fkey'
    `;

    expect(rows[0]?.delete_rule).toBe("SET NULL");
  });
});

describe("storia delle migration", () => {
  it("sono tutte applicate, in ordine e senza fallimenti", async () => {
    const rows = await prisma.$queryRaw<
      { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
    >`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY migration_name
    `;

    expect(rows.map((r) => r.migration_name)).toEqual([
      "20260902090000_enable_pgvector",
      "20260902090100_init",
      "20260902090200_procedure_embedding_hnsw",
      "20260902165725_recording_dedup",
      "20260903100000_procedure_fulltext",
    ]);
    expect(rows.every((r) => r.finished_at !== null && r.rolled_back_at === null)).toBe(true);
  });
});
