-- Scritta a mano. DEVE restare la migration con il timestamp piu' basso.
--
-- Motivo: `prisma migrate dev` ricostruisce l'intera storia delle migration in
-- uno shadow database vuoto per calcolare il diff. Se questa non gira per
-- prima, la init si ferma su
--   ERROR: type "vector" does not exist
-- perche' la colonna "Procedure"."embedding" e' dichiarata `vector(1536)`.
--
-- Non si usa la preview feature `postgresqlExtensions`: una migration di tre
-- righe e' piu' prevedibile di una feature che puo' cambiare forma, e su
-- Railway/pgvector l'estensione va comunque creata da un ruolo che ne ha il
-- diritto.

CREATE EXTENSION IF NOT EXISTS vector;
