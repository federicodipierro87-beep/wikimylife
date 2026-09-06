-- [D11] `Recording.nextAttemptAt`: il backoff fra un tentativo di ingestione e
-- il successivo.
--
-- `retryCount` conta i tentativi ma non li distanzia. Il worker gira ogni
-- cinque secondi, quindi i tre tentativi che il tetto concede si consumavano in
-- quindici secondi: un 503 del fornitore di trascrizione che dura mezzo minuto
-- portava la registrazione in ESTRAZIONE_FALLITA per un guasto che si era gia'
-- risolto da solo. Questa colonna dice da quando la riga torna prendibile, e
-- `claimNext` la legge.
--
-- Nullable e senza default: `NULL` significa "adesso", ed e' il valore giusto
-- per tutto cio' che non ha ancora fallito — comprese le righe gia' in tabella,
-- che infatti non vanno toccate.

ALTER TABLE "Recording" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

-- L'indice del polling diventa composto.
--
-- Questo DROP e' voluto, ed e' l'unico di questa migration: `Recording_status_idx`
-- non sparisce, viene sostituito da un indice che lo contiene come prefisso —
-- `(status)` resta servito da `(status, nextAttemptAt)`, quindi nessuna query
-- esistente perde il suo indice. Tenerli entrambi avrebbe significato pagare due
-- scritture per ogni cambio di stato per non guadagnare niente.
--
-- Serve composto perche' `claimNext` chiede le due colonne insieme: senza la
-- seconda, Postgres troverebbe con l'indice tutte le BOZZA_AUDIO — comprese
-- quelle in attesa di backoff, che dopo un guasto del fornitore sono l'intera
-- coda — e le leggerebbe una per una solo per scartarle.

DROP INDEX "Recording_status_idx";

CREATE INDEX "Recording_status_nextAttemptAt_idx" ON "Recording"("status", "nextAttemptAt");
