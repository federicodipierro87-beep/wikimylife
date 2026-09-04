-- [D10] Ricerca full-text italiana (§7). Scritta a mano: Prisma non sa
-- dichiarare ne' una colonna generata ne' un indice GIN su `tsvector`.
--
-- Il disegno era gia' deciso in docs/deviazioni-schema.md dalla Fase 1, perche'
-- condizionava il modo in cui la Fase 2 scrive le procedure. Qui si esegue.
--
-- Perche' due colonne e non una sola colonna generata sui campi della riga:
-- Postgres pretende che l'espressione di una colonna generata sia IMMUTABLE e
-- confinata alla riga corrente, quindi vieta le subquery. Ma le cose che la
-- gente cerca davvero — "quella cosa dove poi serviva la marca da bollo" —
-- stanno nei passi e nelle trappole, cioe' in tabelle figlie.
--
-- Quindi: `searchText` denormalizzata e mantenuta dall'applicazione (da
-- `searchText()` in packages/shared, funzione pura e unica), e sopra di essa un
-- `tsvector` generato. Il vettore non puo' andare fuori sincrono con il testo
-- perche' non e' l'applicazione a scriverlo.
--
-- `to_tsvector('italian', ...)` con la configurazione scritta a mano come
-- letterale: la variante a un argomento dipende da `default_text_search_config`
-- e per questo NON e' IMMUTABLE — Postgres rifiuterebbe la colonna generata.

ALTER TABLE "Procedure" ADD COLUMN "searchText" text NOT NULL DEFAULT '';

-- Backfill una-tantum delle righe gia' esistenti (le procedure del seed e
-- qualunque cosa la Fase 2 abbia gia' scritto). Da qui in poi la colonna la
-- mantiene l'applicazione: questo blocco non e' la fonte di verita', e'
-- l'allineamento iniziale. L'ordine dei pezzi e le regole di trim ricalcano
-- `searchText()` in packages/shared; una divergenza residua si riassorbe alla
-- prima modifica della scheda, perche' il `tsvector` e' un insieme di lessemi e
-- non una stringa.
UPDATE "Procedure" p
SET "searchText" = coalesce(
  concat_ws(
    E'\n',
    NULLIF(btrim(p."titolo"), ''),
    NULLIF(btrim(p."trigger"), ''),
    NULLIF(btrim(p."esito"), ''),
    (SELECT string_agg(
              concat_ws(E'\n', NULLIF(btrim(s."azione"), ''), NULLIF(btrim(s."dettaglio"), '')),
              E'\n' ORDER BY s."ordine")
       FROM "Step" s WHERE s."procedureId" = p."id"),
    (SELECT string_agg(NULLIF(btrim(pr."descrizione"), ''), E'\n' ORDER BY pr."id")
       FROM "Prerequisite" pr WHERE pr."procedureId" = p."id"),
    (SELECT string_agg(NULLIF(btrim(pf."descrizione"), ''), E'\n' ORDER BY pf."id")
       FROM "Pitfall" pf WHERE pf."procedureId" = p."id"),
    (SELECT NULLIF(string_agg(btrim(t."nome"), ', ' ORDER BY t."nome"), '')
       FROM "TagOnProcedure" tp
       JOIN "Tag" t ON t."id" = tp."tagId"
      WHERE tp."procedureId" = p."id")
  ),
  ''
);

ALTER TABLE "Procedure" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('italian', "searchText")) STORED;

-- GIN e non GiST: l'indice si costruisce piu' lentamente e occupa piu' spazio,
-- ma le interrogazioni sono circa tre volte piu' veloci, e qui si legge molto
-- piu' spesso di quanto si scriva. GiST avrebbe senso solo con aggiornamenti
-- continui.
CREATE INDEX "Procedure_searchVector_idx" ON "Procedure" USING gin ("searchVector");

-- ATTENZIONE — REGOLA PERMANENTE (la stessa dell'indice HNSW)
-- `searchVector` e' `Unsupported("tsvector")` nello schema Prisma, e Prisma non
-- sa che e' GENERATED ALWAYS: la drift detection non vede ne' l'espressione ne'
-- l'indice GIN. Ogni `prisma migrate dev` va lanciato con `--create-only`, l'SQL
-- va letto, e ogni `DROP INDEX` / `DROP COLUMN` non voluto va cancellato a mano.
-- La rete di sicurezza e' tests/integration/schema.test.ts.
