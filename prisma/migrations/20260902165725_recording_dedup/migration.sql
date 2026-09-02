-- [D9] Deduplicazione della §5: la scheda non si crea, il sospetto si conserva.
--
-- ATTENZIONE — questo file e' stato modificato a mano dopo
-- `prisma migrate dev --create-only`. Prisma aveva generato anche:
--
--     DROP INDEX "Procedure_embedding_hnsw_idx";
--
-- E' il rischio numero uno annotato nel piano di Fase 1, verificatosi alla
-- prima occasione utile: l'indice HNSW sta su una colonna `Unsupported`,
-- quindi e' invisibile al modello di Prisma, che lo considera spazzatura da
-- rimuovere a ogni diff. La riga e' stata cancellata. Se fosse passata,
-- la ricerca semantica sarebbe silenziosamente degradata a scansione
-- sequenziale: nessun errore, solo lentezza crescente.
--
-- La rete di sicurezza e' `tests/integration/schema.test.ts`, che asserisce
-- l'esistenza dell'indice dopo `migrate deploy`.

-- AlterEnum
-- Ammesso dentro la transazione della migration perche' il valore nuovo non
-- viene usato qui: Postgres vieta solo di usarlo nella stessa transazione in
-- cui lo si aggiunge.
ALTER TYPE "RecordingStatus" ADD VALUE 'DUPLICATO_SOSPETTO';

-- AlterTable
ALTER TABLE "Recording" ADD COLUMN     "duplicateOfId" TEXT,
ADD COLUMN     "duplicateSimilarity" DOUBLE PRECISION;

-- AddForeignKey
-- ON DELETE SET NULL: cancellare la procedura suggerita non deve cancellare la
-- registrazione, che contiene l'audio e la trascrizione originali.
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "Procedure"("id") ON DELETE SET NULL ON UPDATE CASCADE;
