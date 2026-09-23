-- Cancellare un utente diventa possibile: tre chiavi esterne da RESTRICT a
-- CASCADE.
--
-- Fino a qui nessuno poteva cancellare un utente, e `RESTRICT` era la scelta
-- giusta: e' la rete che ferma il codice sbagliato prima che porti via la voce
-- di qualcuno. Adesso esiste `DELETE /api/auth/me`, che c'e' perche' la linea
-- guida 5.1.1(v) di Apple vuole che un conto creato dentro l'app si possa
-- cancellare dentro l'app — e senza questa migrazione quella rotta sarebbe una
-- promessa che il database rifiuta: `user.delete()` cadrebbe su
-- "Recording_userId_fkey", e l'utente leggerebbe un errore tecnico invece di
-- vedersi cancellare il conto.
--
-- `RefreshToken_userId_fkey` non compare qui perche' cascadava gia' dall'init.
--
-- ## Perche' CASCADE e non una cancellazione a mano nel servizio
--
-- Perche' l'ordine giusto in cui svuotare sette tabelle legate e' una cosa che
-- il database sa e che il codice dovrebbe ricordarsi. Scritto a mano, il giorno
-- che si aggiunge un figlio di `Procedure` nessuno tocca quella funzione e la
-- cancellazione comincia a fallire in produzione su un vincolo — o peggio,
-- riesce e lascia righe orfane. Qui la regola sta accanto alla relazione che la
-- riguarda, che e' l'unico posto dove qualcuno la vede quando la cambia.
--
-- ## Cio' che la cascata NON porta via
--
-- I byte dell'audio, che stanno in un bucket e non in una tabella. Le chiavi si
-- raccolgono *prima* di cancellare le righe e si consumano dopo: e' il servizio
-- a farlo, con lo stesso disegno di `togliDalBucket` in `procedures.service`.
-- Un `DELETE FROM "User"` dato a mano su questo database lascia l'audio nel
-- bucket per sempre, e non c'e' nessun modo di accorgersene da qui.

-- DropForeignKey
ALTER TABLE "Recording" DROP CONSTRAINT "Recording_userId_fkey";

-- DropForeignKey
ALTER TABLE "Procedure" DROP CONSTRAINT "Procedure_userId_fkey";

-- DropForeignKey
ALTER TABLE "Tag" DROP CONSTRAINT "Tag_userId_fkey";

-- AddForeignKey
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Procedure" ADD CONSTRAINT "Procedure_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
