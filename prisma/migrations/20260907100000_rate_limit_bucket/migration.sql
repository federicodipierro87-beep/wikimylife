-- `RateLimitBucket`: il limite dei tentativi smette di stare nella memoria di un
-- processo.
--
-- Un conteggio per processo non e' un limite condiviso: con due repliche
-- dell'API il tetto vale il doppio, e ogni redeploy lo azzera. Finche' la
-- replica era una il difetto era teorico; scriverlo nel database lo toglie
-- prima di doverlo scoprire scalando.
--
-- Non c'e' Redis, che sarebbe il rimedio classico: un quarto servizio da
-- gestire, pagare e monitorare per proteggere l'account di una persona, quando
-- il database c'e' gia' ed e' gia' sulla strada di ogni login — `/login` deve
-- comunque leggere `User` per verificare una password.

CREATE TABLE "RateLimitBucket" (
    -- La chiave la compone il middleware: "{ip} {metodo} {rotta}". E' testo di
    -- lunghezza libera perche' un IPv6 con un percorso lungo non deve poter
    -- troncarsi in silenzio in una chiave che ne contiene un'altra.
    --
    -- PRIMARY KEY e non solo UNIQUE: e' il vincolo su cui l'INSERT fa
    -- ON CONFLICT DO UPDATE, ed e' quel conflitto — con il lock di riga che si
    -- porta dietro — a rendere l'incremento atomico fra repliche. Senza, due
    -- richieste simultanee leggerebbero lo stesso conteggio e scriverebbero lo
    -- stesso valore: un tentativo su due sparirebbe proprio sotto attacco, che
    -- e' l'unico momento in cui questo codice conta qualcosa.
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- La pulizia cancella per intervallo — "tutte le finestre gia' chiuse" — e
-- senza indice sarebbe una scansione dell'intera tabella. E' opportunistica e
-- gira dentro una richiesta di login: una scansione la pagherebbe qualcuno che
-- sta aspettando di entrare.
CREATE INDEX "RateLimitBucket_resetAt_idx" ON "RateLimitBucket"("resetAt");
