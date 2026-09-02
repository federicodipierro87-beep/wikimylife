-- Scritta a mano: Prisma non genera indici su colonne `Unsupported`.
--
-- HNSW e non IVFFlat, per due motivi concreti:
--   1. si costruisce su una tabella vuota — IVFFlat ha bisogno di dati per
--      calcolare le liste, quindi andrebbe ricostruito dopo il primo carico;
--   2. non richiede manutenzione al crescere delle righe.
--
-- `vector_cosine_ops` perche' sia la deduplicazione della §5 (similarita' > 0.85)
-- sia la ricerca semantica della §7 usano la distanza coseno, cioe' l'operatore
-- `<=>`. Un indice creato con un'altra classe di operatori semplicemente non
-- verrebbe usato dal planner, senza dare errore: il degrado sarebbe silenzioso.
--
-- m = 16, ef_construction = 64 sono i valori predefiniti di pgvector: adeguati
-- fino a qualche centinaio di migliaia di righe.
--
-- ATTENZIONE — REGOLA PERMANENTE
-- Questo indice e' invisibile alla drift detection di Prisma, perche' insiste
-- su una colonna `Unsupported`. Ogni `prisma migrate dev` va lanciato con
-- `--create-only`, l'SQL va letto, e ogni `DROP INDEX` non voluto va cancellato
-- a mano. La rete di sicurezza e' tests/integration/schema.test.ts.

CREATE INDEX "Procedure_embedding_hnsw_idx"
  ON "Procedure"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
