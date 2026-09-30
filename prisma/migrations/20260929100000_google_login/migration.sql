-- L'accesso con Google: [D12] in docs/deviazioni-schema.md.
--
-- ## Perche' la password diventa facoltativa
--
-- Chi si iscrive con Google non sceglie una password, e inventargliene una
-- casuale vorrebbe dire un segreto che nessuno conosce ma che `login` continua
-- a verificare. Un NULL dice la verita': questo conto non si apre con una
-- password. Il servizio lo tratta come una password sbagliata — con la stessa
-- verifica fittizia del ramo «utente inesistente», perche' la latenza non dica
-- quali conti sono solo Google.
--
-- ## Perche' `googleSub` e non l'email di Google
--
-- L'indirizzo di un account Google puo' cambiare; il `sub` no, ed e' l'unico
-- campo che Google garantisce stabile. L'email serve una volta sola, per
-- collegare un conto che esisteva gia' con la password; da li' in poi l'accesso
-- passa dal `sub`.
--
-- UNIQUE perche' due conti con lo stesso account Google sarebbero due porte
-- con la stessa chiave, e la prima che apre vince a caso. In Postgres un indice
-- unico ammette piu' NULL, che e' esattamente il caso di tutti i conti che con
-- Google non c'entrano.

ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

ALTER TABLE "User" ADD COLUMN "googleSub" TEXT;

CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");
