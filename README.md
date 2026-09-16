# WikiMyLife

Trasforma note vocali in schede-procedura riutilizzabili: registri come hai fatto
una cosa, e la prossima volta la ritrovi scritta.

Siamo alla **Fase 5 — Deploy**, più il giro di irrobustimento che l'ha seguita:
API e worker su Railway, la build statica su Netlify, l'audio su object storage
compatibile S3, il CORS ristretto al solo dominio del frontend, un limite ai
tentativi di accesso, le intestazioni di sicurezza con la CSP, e un tetto ai
tentativi automatici di ingestione. Sotto ci sono le fondamenta della Fase 1 (monorepo, schema
dati, pgvector, seed, `packages/shared`, autenticazione JWT), la pipeline della
Fase 2 (upload multipart, worker, validazione deterministica della §5,
deduplicazione per similarità coseno), le rotte di lettura, modifica e ricerca
della Fase 3, e la PWA installabile della Fase 4 — quella con il pulsante grande
al centro che registra, mette in coda su IndexedDB se manca la rete, e manda
tutto da sola appena torna.

I provider di trascrizione, estrazione ed embedding hanno **due implementazioni
ciascuno**: quella reale (Whisper, Claude, `text-embedding-3-small`) e una fake
deterministica. Con i default di `.env.example` la pipeline gira per intero senza
una sola chiave API.

La specifica autoritativa è [`wikimylife-schema.md`](./wikimylife-schema.md).
Ogni scostamento dalla sezione 6 è marcato `[Dn]` e motivato in
[`docs/deviazioni-schema.md`](./docs/deviazioni-schema.md).

---

## Da zero a funzionante

Serve Node ≥ 22.11 (c'è un `.nvmrc`) e Docker.

```powershell
Copy-Item .env.example .env

# Il segreto JWT: l'API rifiuta di avviarsi con meno di 32 caratteri.
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# incollalo in JWT_ACCESS_SECRET dentro .env

docker compose up -d
npm install
npm run build
npm run db:migrate
npm run db:seed
```

Poi, in tre terminali:

```powershell
npm run dev:api      # http://localhost:3000
npm run dev:worker   # nessuna porta: interroga il database ogni 5 secondi
npm run dev:web      # http://localhost:5173
```

Senza il worker l'upload funziona lo stesso — risponde `202` e la registrazione
resta in `BOZZA_AUDIO` finché qualcuno non la elabora. È il comportamento
previsto, non un guasto.

> **PowerShell**: `curl` è un alias di `Invoke-WebRequest` e non si comporta come
> curl. Negli esempi qui sotto si usa `curl.exe`.
>
> Se la porta 5432 è già occupata da un Postgres locale, mappa `5433:5432` in
> `docker-compose.yml` e allinea `DATABASE_URL` e `DATABASE_URL_TEST`.

`docker compose up -d` tira su due cose: il Postgres con pgvector e un MinIO, che
parla il protocollo S3 e fa da bucket. I bucket sono due — `wikimylife` per lo
sviluppo e `wikimylife-test` per la suite d'integrazione, che lo svuota fra un
file e l'altro — e li crea un container che muore subito dopo, per cui vederlo
`exited` in `docker compose ps` è normale. La console sta su
[localhost:9101](http://localhost:9101), utente e password `wikimylife` /
`wikimylife-segreto`.

> Le porte del bucket sono **9100 e 9101**, non le 9000 e 9001 di default: chi ha
> MinIO ha buone probabilità di averlo per più di un progetto, e due `compose`
> che chiedono la stessa porta non partono insieme. Se cambi lo scarto, cambialo
> anche in `S3_ENDPOINT` e `S3_ENDPOINT_TEST`.

---

## Com'è fatto

```
apps/api        Express 5 + Prisma. Riceve l'audio e risponde subito.
apps/worker     Secondo processo: trascrive, estrae, valida, persiste.
apps/web        PWA Vite + React. Consuma packages/shared senza alias né polyfill.
packages/shared Codice isomorfo: contratti Zod, enum, interfacce, client API.
prisma/         Schema, migration, seed.
tests/          unit (senza Docker) e integration (Postgres e bucket veri).
docs/           Le deviazioni dalla specifica, con le motivazioni.
netlify.toml    Netlify serve file e nient'altro: redirect SPA e header.
apps/*/railway.toml   Come si costruisce e come parte ciascun servizio — ma
                Railway non li legge piu': vanno ricopiati nel pannello.
.github/workflows/ci.yml   Typecheck, unit, integrazione e build a ogni push.
```

`packages/shared` si importa come `@wikimylife/shared` grazie ai workspace npm:
nessun path alias, nessun `tsconfig-paths`. La build è `tsc -b` con project
references.

### Tre regole che vale la pena conoscere prima di scrivere codice

**1. `packages/shared` deve restare isomorfo.** Ci girano sopra sia la PWA sia
l'API sia il worker. Non può contenere `window`, `document`,
`localStorage`, `process`, `Buffer`, `node:*` né importare `@prisma/client`. Il
`tsconfig` ha `types: []` per impedire l'accesso ai tipi di Node, ma `lib` deve
includere `DOM` per i tipi di `fetch` — quindi il compilatore *permetterebbe*
`document`. La rete di sicurezza è `tests/unit/guards.test.ts`, che legge i
sorgenti e fallisce se ne trova traccia.

**2. `process.env` si legge in due file, e basta.** `apps/api/src/config/env.ts`
per l'applicazione e `prisma/seed/config.ts` per il seed. Tutto il resto riceve
la configurazione come parametro. Lo stesso test di guardia fa fallire la suite
se compare un terzo lettore, e vieta anche `any` esplicito su tutto il repo.

**3. Lo `userId` non è mai un parametro opzionale.** La firma è
`updateProcedure(userId, id, patch)`, il `WHERE` è sempre composto, mai un
`findUnique` seguito da un `if`. Una risorsa di qualcun altro risponde **404**,
non 403: un 403 confermerebbe che quell'id esiste. Vale anche per `/retry`: la
registrazione di un altro utente non si riprocessa, e non lo si viene a sapere.

---

## La pipeline di ingestione

```
POST /api/recordings           multipart: audio + metadati di cattura
                               → 202 { id, status: "BOZZA_AUDIO" }
GET  /api/recordings           quelle che non sono ancora una scheda
GET  /api/recordings/:id       stato di avanzamento
POST /api/recordings/:id/retry riprocessa dalla trascrizione → 202
DEL  /api/recordings/:id       cancella riga e audio → 204, 409 se in elaborazione
     ?ancheLaScheda=1          e archivia la procedura che ne era nata
```

L'API non elabora niente: salva i byte, scrive la riga, risponde. Il resto lo fa
il worker, che gira su `npm run dev:worker`.

**L'audio si salva prima di ogni altra cosa.** Prima i byte sullo storage, poi la
riga nel database — nell'ordine inverso una registrazione potrebbe puntare a un
file che non esiste. Se la trascrizione o l'estrazione cadono, la riga torna in
`BOZZA_AUDIO` con l'errore registrato e il worker la riprende da solo al giro
successivo: l'audio non si perde mai.

**Cancellare una registrazione è l'unica cancellazione dura del progetto.** La
scheda si archivia, perché è un testo che si può riscrivere e che qualcuno
potrebbe rivolere; la registrazione no. Chi chiede di eliminare un audio sta
chiedendo che la propria voce sparisca, e uno stato `CANCELLATA` con i byte
ancora nel bucket sarebbe la risposta sbagliata a quella domanda. Qui l'ordine è
l'opposto del caricamento, e per la stessa ragione: prima la riga, poi
l'oggetto. Alla creazione i byte vanno per primi perché sono il dato non
riproducibile; alla cancellazione la riga va per prima perché è lei a essere
condivisa con il worker, e toglierla per seconda lascerebbe per il tempo di una
chiamata di rete una riga reclamabile che punta a un audio che non c'è più.

**`?ancheLaScheda=1` si porta via anche ciò che quel vocale aveva prodotto.**
Senza il parametro la procedura resta, ed è il caso di chi vuole tenersi la
scheda e non la propria voce: è ciò che la rotta ha sempre fatto, e cambiarlo in
silenzio avrebbe archiviato le schede di chi aveva imparato che non succedeva.
Con il parametro le due cose avvengono **nella stessa transazione**, e alle due
metà si fa ciò che «cancellare» significa per ciascuna: l'audio sparisce dal
bucket, la scheda passa ad `ARCHIVIATA` e si può ripescare dal cestino.

Insieme e non in fila, perché in fila esisterebbe sempre un ordine sbagliato.
Cancellare prima lascia, se l'archiviazione fallisce, una voce persa per sempre
e una scheda che l'utente credeva via — con un 500 che non si può nemmeno
ritentare. Archiviare prima lascia, quando la cancellazione risponde 409 perché
un worker ha ripreso in mano la riga, una scheda finita nel cestino per una
richiesta che ha risposto errore: il peggiore dei due mondi, perché la risposta
dice di no e metà è successa lo stesso. Dentro una transazione non c'è un ordine
sbagliato perché non c'è un mezzo risultato.

Il valore è `1` o `0` e nient'altro, e lo schema è `.strict()`. Un
`z.coerce.boolean()` avrebbe letto `?ancheLaScheda=false` come vero — `"false"`
è una stringa non vuota — e avrebbe archiviato la scheda di chi stava chiedendo
il contrario; senza lo `.strict()`, `?ancheLascheda=1` con la `s` minuscola
sarebbe passato per una richiesta senza opzioni, restituendo un 204 che dice che
è andato tutto bene. Su un'operazione distruttiva un refuso deve essere un 400,
non un'interpretazione generosa di cosa distruggere.

Si può cancellare in ogni stato tranne `IN_ELABORAZIONE`, e quel rifiuto è un
**409**, non un 404: la registrazione esiste ed è di chi la chiede, il no è
temporaneo, e dirle «non trovata» manderebbe a cercare un errore che non c'è. La
condizione sullo stato sta dentro la `DELETE` e non in un `if` che la precede —
fra una lettura e una cancellazione separate un worker farebbe in tempo a
reclamare la riga. Una registrazione già `ESTRATTO` si cancella, e la scheda
resta in piedi: è il caso di chi vuole tenere la procedura e non la voce, e il
legame va in una direzione sola, perché è la registrazione a nominare la scheda,
non il contrario.

**La coda è una tabella, anzi: è una colonna.** `Recording.status` con il suo
indice `[D3]`. Niente Redis, e nemmeno una tabella `Job` — sarebbe un secondo
stato da tenere allineato al primo, che serve comunque per rispondere a
`GET /api/recordings/:id`. `claimNext` è un compare-and-swap
(`UPDATE ... WHERE status = 'BOZZA_AUDIO'` e si guarda il conteggio), quindi due
worker in parallelo non si pestano e scalare a due repliche non richiede di
toccare una riga di codice.

```
BOZZA_AUDIO ──claim──> IN_ELABORAZIONE ──┬──> ESTRATTO            crea la Procedure
     ▲                                   ├──> DUPLICATO_SOSPETTO  [D9] non crea niente
     │                                   └──> ESTRAZIONE_FALLITA  dopo 2 tentativi
     └──── errore STT, o POST /retry ────────────────────────────────┘
```

**La validazione della §5 è codice, non un secondo giro di LLM.**
`services/validation/extractionValidation.ts`: passi rinumerati se l'ordine non è
contiguo, titolo entro 80 caratteri, importi non negativi, confidenza,
riconoscimento di `NOTA_SEMPLICE`. Ogni problema diventa una issue con un codice;
se nessuna è bloccante la scheda nasce comunque, in `DA_RIVEDERE`. È il
comportamento richiesto: meglio una scheda incompleta da correggere che un vocale
buttato via.

**Quando nessuna scheda nasce, il messaggio dice quale regola ha bloccato.**
`motivoDelRifiuto` costruisce la frase che finisce su `lastErrorMessage`, e da lì
arriva intatta sotto gli occhi di chi ha registrato: `lastError.message` nel
contratto, `dettaglio` in `format.ts`, una riga nella lista delle registrazioni in
sospeso. Prima era una sola per tutti i rifiuti — «Estrazione non conforme al
contratto dopo 2 tentativi» — che nominava un contratto che l'utente non ha mai
visto mentre il motivo vero stava già calcolato nella riga sopra.

Due scelte dentro quella funzione, ed è la seconda quella che conta.

*Solo le bloccanti.* Una regola non bloccante, per definizione, non è il motivo
per cui ci si è fermati: con quella sola la scheda sarebbe nata in `DA_RIVEDERE`.
Elencarla accanto a quella che blocca la farebbe sembrare colpevole. Il prezzo è
che a volte si legge il sintomo invece della causa — un'estrazione
`NON_CLASSIFICABILE` non ha titolo, quindi blocca su `titolo.mancante` mentre
`meta.tipo_non_procedura`, che spiegherebbe il perché, resta non bloccante e
muto. Mitigato dal fatto che la trascrizione grezza si stampa comunque sotto il
messaggio (§3): di solito è lei a raccontare il resto.

*I messaggi di Zod non si citano mai.* Le issue del primo livello portano
`zodIssue.message`, e senza un `errorMap` — non ce n'è uno — quella è prosa
inglese di libreria: «Expected string, received null». Metterla lì sostituirebbe
una frase italiana inutile con una inglese inutile, e soprattutto appenderebbe
ciò che legge l'utente al testo di un terzo, riscrivibile in una minor senza che
un test se ne accorga. È la stessa ragione per cui `definitivo.ts` non classifica
gli errori leggendone il corpo. Per quel ramo c'è una frase fissa nostra, e i
dettagli restano dove servono a chi ripara: nel log e negli `issues` del
contratto.

**La deduplicazione confronta gli embedding, non le parole.** Se la similarità
coseno con una procedura *dello stesso utente* supera **0.85**, il worker non
crea un duplicato: mette la registrazione in `DUPLICATO_SOSPETTO` con
`duplicateOfId` e la similarità, ed espone comunque l'estrazione. La decisione è
dell'utente, e `POST /retry` cancella il suggerimento e rimette in coda.

**Il prompt vive in un file versionato.** `prompts/extraction.v1.ts` contiene la
§4.2 alla lettera — `tests/unit/extractionPrompt.test.ts` rilegge il blocco dalla
specifica e li confronta carattere per carattere, invece di tenerne una seconda
copia che divergerebbe in silenzio. In `Recording.extractionModel` finisce la
coppia `modello (versione del prompt)`, per esempio
`claude-sonnet-4-5-20250929 (extraction.v1)`: per riprocessare lo storico serve
sapere quale delle due è cambiata.

La trascrizione grezza si conserva sempre, anche quando l'estrazione riesce, e
`rawExtraction` contiene l'output integrale del modello — anche i campi che il
codice non usa, come `domandeSuggerite`.

---

## Leggere, modificare, cercare

```
GET    /api/procedures                 lista, filtri scope / status / tag, paginata
GET    /api/procedures/:id             scheda completa con tutte le relazioni
PATCH  /api/procedures/:id             modifica manuale
DELETE /api/procedures/:id             soft delete → ARCHIVIATA
     ?definitivo=1                     cancellazione vera, solo dal cestino
DELETE /api/procedures                 svuota il cestino, max 50 per volta
     ?status=ARCHIVIATA&definitivo=1   obbligatori tutti e due, alla lettera
POST   /api/procedures/:id/executions  registra un'esecuzione (§8)
GET    /api/search?q=                  ricerca ibrida (§7), paginata con offset
```

**Le liste nascondono il cestino, ma non lo cancellano.** `DELETE` porta la
scheda in `ARCHIVIATA` e risponde `200` con la scheda archiviata, non `204`: c'è
ancora tutto da vedere, e la si recupera con una `PATCH` sullo stato. La lista
esclude le archiviate finché non le si chiede esplicitamente con
`?status=ARCHIVIATA`.

**`?definitivo=1` è il secondo giro, e vale solo dal cestino.** Su una scheda che
non è `ARCHIVIATA` è un `409` che dice qual è il passo mancante, e non è una
formalità: è ciò che rende impossibile perdere una procedura in uso con una sola
chiamata sbagliata, e ciò che permette all'interfaccia di chiedere «sicuro?» in un
momento diverso da quello in cui si è premuto «elimina». Riuscendo risponde `204`
e non è idempotente — la seconda volta è un `404`, perché dire «fatto» a chi
cancella una scheda che non esiste più nasconderebbe l'unico caso in cui quel
`404` conta: due schermate aperte sulla stessa scheda.

Si porta via anche le registrazioni da cui la scheda è nata, e i loro byte nel
bucket. Il testo dei campi è un rifacimento delle frasi dette; la trascrizione e
l'audio *sono* le frasi dette, e toglierne uno solo sarebbe una cancellazione per
finta. C'è anche una ragione meno nobile: `Recording.procedureId` è
`ON DELETE SET NULL`, quindi un vocale lasciato indietro resterebbe `ESTRATTO`
con la scheda azzerata — e `listPending` filtra proprio gli `ESTRATTO`. Nessuna
schermata lo mostrerebbe più e nessun gesto potrebbe più toglierlo.

I *sospetti duplicati* invece non si toccano: sono un altro racconto, che a
quella scheda somigliava soltanto. Restano, ma tornano a `BOZZA_AUDIO` con
`duplicateOfId` e `nextAttemptAt` azzerati, perché lasciarli `DUPLICATO_SOSPETTO`
con il legame sciolto dal `SET NULL` produrrebbe un avviso che non ha più niente
da nominare e un pulsante «tienilo comunque» che punta a una scheda che non c'è.

**Svuotare il cestino è quella stessa cancellazione, ripetuta.** La `DELETE`
sulla collezione vuole due parametri e li vuole alla lettera: `status=ARCHIVIATA`
e `definitivo=1`. Nessuno dei due ha un valore alternativo — `status=COMPLETA` è
un `400`, `definitivo=0` è un `400`, e mancarne uno è un `400` — perché non sono
un filtro ma un interruttore a due chiavi. Servono soprattutto per una ragione
che non si vede leggendo la rotta: `DELETE /api/procedures/`, con l'id vuoto,
finisce qui e non sulla `/:id`, e senza i due parametri una sbarra di troppo in
un URL cancellerebbe l'archivio di chi l'ha scritta invece di rispondere `400`.

Dentro, le schede si cancellano **una per volta**, chiamando la stessa
`deleteForUser` del pulsante singolo su ognuno degli id appena letti. Una
`deleteMany` con `IN (...)` sarebbe una richiesta sola invece di quaranta, ma
avrebbe anche una seconda copia delle regole — i figli in cascata, i vocali, i
duplicati rimessi in coda — che nessuno terrebbe allineata alla prima. E ne
perderebbe una che sugli insiemi non ha un equivalente pulito: sotto READ
COMMITTED, una scheda ripristinata da un'altra schermata fra la `SELECT` e la
`DELETE` si vedrebbe portare via i vocali pur sopravvivendo, perché la guardia
che lo impedisce è `if (cancellate.count === 0) return NON_ARCHIVIATA`, ed è
scritta per una riga per volta.

Per la stessa ragione `ASSENTE` e `NON_ARCHIVIATA` qui non sono errori: contano
fra le `saltate`. Quegli id li ha scelti il server un istante prima, quindi le
uniche cause possibili sono una cancellazione o un ripristino arrivati nel
frattempo da un'altra schermata aperta — e nessuna delle due è uno sbaglio di chi
ha premuto «svuota». Farne un `409` fermerebbe uno svuotamento quasi riuscito
senza dire quante ne erano già andate. La risposta è `200` con
`{ cancellate, saltate, rimaste }` e non un `204` proprio perché quei numeri sono
l'unica cosa che chi ha premuto non poteva sapere prima.

**E ne porta via al massimo cinquanta per richiesta.** Una scheda per volta è la
scelta giusta per tutte le ragioni dette sopra, ma ha un prezzo che cresce con il
cestino: ogni scheda è una transazione più un giro sul bucket, e un cestino da
mille supera in scioltezza il timeout di qualunque proxy messo davanti al server.
A quel punto la connessione cade a metà, chi ha premuto non riceve nessun numero,
e ricaricando trova un cestino misteriosamente più corto. `EMPTY_TRASH_BATCH_SIZE`
taglia l'elenco a cinquanta, e la risposta aggiunge `rimaste`.

`rimaste` è il cestino **dopo** questa richiesta, e viene da un `COUNT` fatto alla
fine, non da `quante ne avevo meno quante ne ho cancellate`. La differenza si vede
in un caso solo, ed è il caso che questa rotta incontra davvero: una scheda
ripescata da un'altra schermata conta fra le `saltate` ma è *uscita* dal cestino,
quindi la sottrazione direbbe «ne resta una» e manderebbe chi legge a premere di
nuovo su un cestino vuoto. I due numeri non si sovrappongono mai.

Il taglio non compare nell'URL: non c'è nessun `?limit=`. La query resta quella
di prima, due parametri e due valori letterali, perché renderla componibile
significherebbe riaprire la porta a `?status=COMPLETA` che la riga precedente ha
appena chiuso. Chi svuota un cestino grosso manda la stessa richiesta più volte —
e a farlo è `ApiClient.emptyTrash()`, non la schermata, che di tutto questo non sa
niente.

**Gli array si sostituiscono in blocco.** Una `PATCH` con `steps` cancella i
passi e li riscrive, rinumerati `1..n` — il client manda lo stato finale, non un
diff. Mandare `"steps": []` significa davvero «nessun passo». I campi derivati
(`volteEseguita`, `ultimaVerifica`, `costoTotaleCent`) non si scrivono: mandarli
è un `400`, perché sono conseguenze e non decisioni.

**Le due regole della §9 vivono nel servizio, non nell'interfaccia.** Una scheda
con `scope = CLIENTE` o `contieneDatiSensibili = true` non può diventare
`PUBBLICA`: è un `409`, e la transazione non parte nemmeno. Si può però togliere
il flag e pubblicare nella stessa `PATCH`, perché è una revisione esplicita —
esattamente quello che la §9 chiede.

**La passata di redazione è due rotte, non una** (§9). `GET
/api/procedures/:id/redazione` propone le sostituzioni, `POST` applica quelle
confermate. Sono due perché il «una per una» che chiede la §9 è un passo umano
in mezzo, e una rotta sola l'avrebbe tolto. Il dettaglio sta più sotto, in
[Redigere prima di condividere](#redigere-prima-di-condividere-9).

**Un'esecuzione `CAMBIATA` riporta la scheda in `DA_RIVEDERE`** (§8). Una
`FALLITA` non muove niente: `ultimaVerifica` è l'ultima volta che la procedura ha
*funzionato*, e un tentativo andato male non la aggiorna né la cancella. Il flag
`obsoleta` è calcolato, non salvato: `ultimaVerifica` più vecchia di un anno.

### La ricerca ha due canali e non li somma

`ts_rank_cd` restituisce numeri piccoli e senza scala fissa; la similarità coseno
sta fra 0.6 e 0.95 quasi sempre. Sommarli, anche normalizzati, significa
inventare un tasso di cambio fra due grandezze che non ne hanno uno. Quindi
**Reciprocal Rank Fusion**: conta la *posizione* in ciascuna lista, non il
punteggio. Una scheda che entrambi i canali mettono terza batte una che un canale
solo mette prima — l'accordo fra due misure indipendenti vale più dell'eccellenza
in una sola. A parità: prima la più fresca, poi la più eseguita.

Ogni risultato dice da dove viene (`matchedBy`: `TESTO`, `SEMANTICA`, `ENTRAMBE`).

Due dettagli che sembrano piccoli e non lo sono:

- La query si costruisce con **`websearch_to_tsquery`**, non `to_tsquery`: la
  seconda solleva un errore su una parentesi spaiata, e le query le scrivono le
  persone. Cercare `marca da bollo (2024` deve dare risultati, non un `500`.
- Il canale semantico ha un **pavimento** (`SEARCH_MIN_SIMILARITY`). Una query ai
  vicini più prossimi non sa dire «nessun risultato»: `ORDER BY <=> LIMIT 20`
  restituisce venti schede anche quando la più vicina non c'entra niente. Senza
  il pavimento, cercare «criptovalute» in un archivio di pratiche burocratiche
  restituisce pratiche burocratiche.

Se il provider di embedding cade, la ricerca **risponde lo stesso** col solo
full-text e lascia una riga di warning nei log. I dati sono già tutti in casa: un
timeout esterno non deve rendere inutilizzabile la funzione principale dell'app.

**La finestra che si chiede ai due canali è fissa, e per questo si può
sfogliare.** Per un po' ciascun canale restituiva `limit * 3` righe, con un tetto
a cento: sembrava un'ottimizzazione ragionevole — chiedi in proporzione a quanto
ti serve — ed era invece la ragione per cui `GET /api/search` non poteva avere un
`offset`. Se la finestra dipende da `limit`, la classifica fusa dipende dalla
dimensione della pagina: chiedere venti risultati e chiederne cinquanta produce
due ordinamenti diversi, e la seconda pagina non è la continuazione della prima
ma un pezzo di un'altra lista. Con una finestra fissa a `SEARCH_MAX_DEPTH` la
fusione torna a essere una funzione dei soli `q`, `scope` e dati: `offset`
diventa un indice dentro una lista che non si muove.

Il vantaggio non è solo la correttezza. Un `OFFSET` SQL fa scartare al database
le righe saltate, e la pagina cinque costa più della prima; qui la profondità
sposta una finestra già in memoria e le righe si leggono soltanto per la pagina
che si serve, quindi `offset=80` costa esattamente quanto `offset=0`. Il prezzo è
il tetto, ed è dichiarato: oltre `SEARCH_MAX_DEPTH` non si sfoglia, perché ciò
che nessuno dei due canali ha messo fra i suoi primi cento non è entrato nella
fusione e nessuna pagina lo farebbe comparire. Il limite è del metodo, non della
paginazione — chiedere `offset=1000` prende un `400` invece di una pagina vuota
che sembrerebbe la fine dei risultati.

La risposta porta `limit`, `offset` e **`hasMore`**, non un `total` come la lista.
La lista conta righe e sa quante ne esistono; la ricerca sa solo quante ne sono
entrate nella fusione, e un numero lì verrebbe letto come «risultati trovati» e
sarebbe falso ogni volta che i canali hanno troncato. Un booleano dice l'unica
cosa che si sa davvero, ed è anche l'unica che serve a decidere se disegnare il
pulsante.

### Il full-text è denormalizzato di proposito

Le cose che si cercano davvero — *«quella dove poi serviva la marca da bollo»* —
stanno nei passi e nelle trappole, cioè in tabelle figlie. Una colonna generata
non può contenere una subquery. Quindi `Procedure.searchText` è una stringa
mantenuta dall'applicazione con `searchText()` di `packages/shared`, e
`searchVector` è un `tsvector` **`GENERATED ALWAYS ... STORED`** sopra di essa.

Il vettore non può andare fuori sincrono col testo perché non è l'applicazione a
scriverlo: non esiste un percorso di scrittura che aggiorni l'uno senza l'altro,
nemmeno un `UPDATE` fatto a mano in psql. Il dizionario è `italian` e non
`simple`, ed è ciò che fa sì che «pagamento» trovi «pagare». Dettagli in
`docs/deviazioni-schema.md` `[D10]`.

### Redigere prima di condividere (§9)

Il divieto — niente `PUBBLICA` per una scheda `CLIENTE` o marcata sensibile —
c'era da subito. Quello che mancava era la via d'uscita: la §9 chiede una
passata che «proponga le sostituzioni e le faccia confermare una per una
all'utente», e senza di essa l'unico modo di ripulire una scheda era riscriverla
a mano.

**I rilevatori dicono di no più spesso di quanto dicano di sì.** Sono quattro —
codice fiscale, IBAN, email, telefono — e i primi due passano da un checksum
vero (il carattere di controllo ministeriale, il mod-97 dell'ISO 13616) prima di
essere proposti. Non è pignoleria: qui i due errori non costano uguale. Un falso
negativo lo intercetta la persona che sta leggendo le proposte; un falso
positivo cancella in silenzio del testo buono, e nessuno se ne accorge finché
non serve. Per la stessa ragione i numeri di telefono si riconoscono solo in tre
forme prefissate: un archivio di pratiche burocratiche è pieno di numeri di
protocollo, importi, CAP e date, e prenderli per numeri di telefono sarebbe il
modo più rapido di rendere questa funzione inutilizzabile.

**Gli id delle proposte sono derivati dal contenuto**, non generati:
`steps.2.azione:14:TELEFONO` è campo, offset e tipo. Non c'è nessuna tabella
dove conservarli fra la `GET` e la `POST` — e una tabella di proposte in attesa
sarebbe un secondo posto dove il codice fiscale di qualcuno resta scritto anche
dopo che la scheda è stata ripulita. Il server ricalcola le proposte sul testo
com'è in quel momento e accetta solo gli id che ritrova: se la scheda è cambiata
nel frattempo, gli offset non tornano e la chiamata fallisce con un `409` invece
di cancellare caratteri scelti guardando un altro testo. È tutto o niente, per
lo stesso motivo.

#### La metà assistita

Il brief chiede «assistita dall'LLM per il resto», e il resto è quasi tutto:
nomi di persona, indirizzi di casa, numeri di pratica. Un modello legge i campi
di testo della scheda e propone; le sue proposte entrano nella stessa lista
delle altre, con una differenza segnata a schermo.

**Si accende, non è accesa.** `REDACTION_PROVIDER=nessuno` è il valore
predefinito, ed è legittimo anche in produzione — è l'unico dei cinque provider
che ha un modo di non esserci. Accenderlo significa mandare a un terzo il testo
integrale e non redatto delle schede su cui si apre la redazione, cioè
esattamente il testo che uno non vorrebbe spedire in giro. La §9 lo giustifica;
la giustificazione però dev'essere una riga scritta in chiaro, non l'effetto
collaterale di aver configurato l'estrazione. In produzione `nessuno` passa e
`fake` no: spegnere la passata è una scelta, fingerla è una schermata che dice
«non ho trovato altro» a chi sta per pubblicare il nome di un cliente.

**Il modello non manda offset, manda valori.** Contare i caratteri è ciò che un
modello linguistico sbaglia, e un offset sbagliato di due cancella due lettere
di troppo. Il server cerca i valori nel testo, controlla i confini di parola
(«Rossi» non deve mangiare metà di «Rossini»), scarta ciò che non trova —
un'allucinazione è il caso normale, non l'eccezione — e non propone mai un
tratto già rivendicato da un rilevatore deterministico, perché due sostituzioni
sullo stesso tratto corromperebbero il testo.

Il prompt sta in `prompts/redaction.v1.ts`, versionato come quello
dell'estrazione, e l'enum dei campi nello schema del tool si chiude sui soli
percorsi effettivamente mandati: un modello che inventasse un `steps.9.azione`
inesistente verrebbe fermato dal validatore di Anthropic, non dal nostro.

**Gli id assistiti portano un'impronta.** Qui la ricostruzione non funziona: un
modello non è deterministico, e ricalcolare sulla `POST` vorrebbe dire
richiamarlo — a pagamento, con esito diverso, e con le conferme che spariscono
mentre l'utente le sta confermando. L'id diventa allora
`titolo:11:11:NOME_PERSONA:9c1e4b7a`: campo, inizio, lunghezza, tipo e i primi
otto esadecimali dello `sha256` del valore. Il server rilegge quel tratto e
confronta l'impronta. Non si ricalcola: si verifica. La garanzia della §9 —
non cancellare testo che l'utente non ha guardato — regge lo stesso, e con un
effetto collaterale che va detto: una modifica altrove nello stesso campo, che
non sposti il tratto, non invalida la conferma. È voluto. Invalidarla avrebbe
significato far fallire una redazione perché nel frattempo si era corretto un
refuso a fine riga.

Gli id deterministici restano a tre segmenti e continuano a essere ricalcolati.
Unificarli sull'impronta sarebbe stato più elegante e avrebbe trasformato la
`POST` in un «cancella questo intervallo» firmato da chi lo chiede: cioè, di
nuovo, la `PATCH` con un nome più rassicurante.

**Il guasto non è silenzioso.** Il report porta `assistenza`, che vale
`ESEGUITA`, `NON_CONFIGURATA` o `NON_RIUSCITA`. Tre valori e non un booleano
perché «non l'ho mai accesa» e «l'ho accesa e non ha risposto» significano cose
diverse per chi sta per condividere una scheda, e perché una scheda pulita e un
modello morto producono lo stesso elenco vuoto. Quando il provider cade la
richiesta riesce comunque, con le sole proposte certe: gli IBAN sono lì e non
hanno bisogno di nessuno per essere trovati. Il timeout è di venti secondi
contro i centoventi dell'estrazione — quella gira in un worker, questa dentro
una `GET` con qualcuno fermo davanti.

**Il corpo della `POST` non contiene testo.** Solo id. Accettare testo avrebbe
reso questa rotta un doppione della `PATCH` con un nome più rassicurante, cioè
l'unico modo di far passare per redazione una modifica qualunque.

**La scrittura passa dalla `PATCH`,** non dal repository. Scavalcarla sarebbe
stato più corto e avrebbe saltato il ricalcolo di `searchText`: una scheda
redatta resterebbe cercabile per il codice fiscale che le è stato tolto, e
nessun test se ne accorgerebbe, perché nessuno cerca un codice fiscale. Il test
di integrazione lo verifica sull'indice vero — cerca, redige, ricerca, e si
aspetta zero.

**Il flag non si toglie da solo,** nemmeno con la passata assistita accesa.
Dopo la redazione `contieneDatiSensibili` resta, e la schermata lo dice. Farlo
sparire perché i rilevatori non trovano più niente vorrebbe dire far dichiarare
a quattro espressioni regolari che la scheda è pulita, quando l'unica cosa che
sanno è di non riconoscere più i formati che conoscono. Aggiungere un modello
non cambia la conclusione, cambia la ragione: quattro formati si calcolano, i
nomi si leggono, e su una lettura non si dichiara pulita una scheda. La
«revisione esplicita» che la §9 chiede resta un gesto di una persona, e passa
dalla `PATCH` come prima.

**Fuori dalla passata restano le trascrizioni e le note delle esecuzioni.** La
trascrizione è il verbale di ciò che l'utente ha detto: riscriverla farebbe
perdere la corrispondenza fra l'audio e il suo testo, che è l'unica cosa che
permette di capire da dove è uscita una scheda sbagliata (§3). Le note delle
esecuzioni sono il diario privato di chi ha eseguito la procedura, e non escono
dalla scheda quando la scheda esce. La §9 parla di ciò che si condivide, e ciò
che si condivide è la scheda.

**A schermo le due metà non si mescolano.** Ogni proposta assistita porta un
bordo colorato e la scritta «letto, non calcolato». Presentarle uguali avrebbe
prestato a un parere la certezza di un checksum, che è il modo in cui si
cancella per sempre il nome di un'azienda scambiato per quello di una persona.
Il segno è doppio — colore e testo — perché il colore da solo non arriva a chi
non lo distingue, proprio sulla differenza che qui cambia una decisione.

---

## L'app

Nove schermate, un router a `hashchange` di trenta righe, nessuna libreria di
componenti e nessun framework CSS. Il bundle sta in **72 kB compressi**, foglio
di stile compreso.

```
apps/web/src/
  recording/   MediaRecorder, GPS, coda IndexedDB, svuotamento, disco pieno, contesto React
  screens/     login, registrazione, lista, ricerca, scheda, revisione, redazione, cestino, account
  format.ts    le regole di presentazione, pure e testate
  routes.ts    rotta ⇄ hash, puro e testato
  router.ts    le tre righe che toccano location e history
```

**Lo stop non aspetta niente.** È la promessa della §2, e vale solo se è vera
alla lettera: premuto stop, l'audio va in IndexedDB, lo svuotamento della coda
parte senza essere atteso, e la schermata cambia. Si può chiudere l'app in
quell'istante — la registrazione è su disco e partirà da sola.

Per lo stesso motivo **il GPS non blocca il salvataggio**. Parte insieme al
microfono e scrive in un riferimento mutabile man mano che arriva: prima le
coordinate, poi l'etichetta del luogo. Allo stop quel riferimento si legge e
basta. Se il geocoding non ha finito, il luogo semplicemente non c'è — è un
contorno del racconto, non il racconto.

**La coda ordina con un `seq` monotono**, non con `Date.now()`: due
registrazioni salvate nello stesso millisecondo avrebbero un ordine arbitrario.
Ogni operazione apre la propria transazione, perché una transazione tenuta viva
attraverso un `await` si auto-annulla, e attende `oncomplete` invece del
successo della singola richiesta, perché una `put` può riuscire mentre la
transazione fallisce sulla quota del disco.

**Quando quella quota finisce, l'audio non si perde.** È il caso che rende
falsa la promessa della §2, e non dipende da noi: la quota di IndexedDB la
decide il browser per origine, la stringe quando il dispositivo si riempie, e
non la annuncia — l'unico segnale è una scrittura rifiutata, che arriva dopo lo
stop, quando l'unica copia della registrazione è una variabile locale.
Trattenerla è tutta la differenza fra «l'audio non è su disco» e «l'audio non
esiste più»: resta in memoria, diventa un avviso sopra la barra bassa, e da lì
ha tre uscite — riprovare, scaricare il file, buttarlo. Nessuna delle tre è
quella giusta, ed è il motivo per cui le sceglie l'utente.

**Il tetto alla coda è il rifiuto di registrare.** Finché c'è una registrazione
non salvata, `start()` non parte: registrarne un'altra significherebbe quasi
certamente non poter salvare nemmeno quella, e intanto tenere due file in
memoria invece di uno. È scomodo apposta. Un tetto che cancella le
registrazioni vecchie per fare posto alle nuove sarebbe la stessa perdita di
dati, decisa da noi invece che dal browser.

**Lo scaricamento è l'unica via d'uscita che esiste davvero.** Se il browser non
ha spazio, nessun posto del browser ne ha: né un'altra coda, né la memoria, che
sparisce chiudendo la scheda. Il filesystem del dispositivo è un budget diverso,
e ci si arriva con un `<a download>` e un nome che contiene data e ora — fra una
settimana, in una cartella Download, `registrazione.webm` non dice a nessuno
quale pomeriggio fosse. Il pulsante «riprova» invece compare solo quando è
mancato lo spazio: se IndexedDB non c'è proprio — Firefox in navigazione
privata — riprovare fallisce identico, e offrirlo sarebbe una bugia. Distinguere
i due casi vuol dire guardare `error.name`, e includere i due nomi di Gecko
accanto a `QuotaExceededError`, perché il messaggio è localizzato e il nome no.

**Lo spazio si dice prima, ma non diventa un divieto.**
`navigator.storage.estimate()` dà `usage` e `quota` per l'origine, e da lì si
ricavano i minuti di parlato che ci stanno ancora: sotto i dieci compare un
avviso sopra il pulsante, e compare *prima* di premerlo — che è tutto il punto,
perché la difesa precedente scatta a danno avvenuto, quando l'utente ha già
parlato. Un avviso e non un blocco perché quel numero non è una misura: i
browser lo arrotondano apposta per non farne un'impronta digitale, la quota è
una previsione sullo spazio libero del disco, e un altro programma può occuparlo
un secondo dopo. Uno «spazio esaurito» sbagliato che impedisce di registrare
sarebbe la peggiore delle due perdite — un salvataggio fallito adesso ha una via
d'uscita, una registrazione mai fatta no. Per lo stesso motivo `null` in ingresso
— Safari senza `storage`, contesto non sicuro, `estimate()` che lancia — resta
«non lo so» e non diventa mai «è pieno». La stima si aggiorna quando cambia la
coda e non a intervalli: lo spazio libero si muove quando si registra e quando
si carica, e chiederlo ogni cinque secondi costerebbe senza dire niente di
nuovo. I byte al secondo sono una costante prudente, perché `MediaRecorder` non
dichiara il bitrate che userà e i browser non concordano: sovrastimare fa
comparire l'avviso un po' presto, sottostimare lo fa comparire quando non serve
più.

**Lo svuotamento distingue i guasti che passano da quelli che non passano.** Un
401 o un 413 non migliorano riprovando: la riga resta in coda marcata con
l'errore, così l'utente la vede. Una rete assente o un 500 fermano il giro e
lasciano la riga in testa, pronta per il prossimo `online`. È seriale di
proposito: in parallelo, dieci upload su una linea mobile si rubano banda a
vicenda e finiscono tutti in timeout invece che nove su dieci a buon fine.

**L'ordine di lettura della scheda non sta nel JSX.** `sezioniDi()` restituisce
la sequenza — prima cosa serve, poi cosa può andare storto, poi come si fa — e
il componente disegna ciò che riceve. La regola della §2 si cambia in una
funzione che ha i test, non in mezzo al markup. Le trappole `BLOCCANTE` portano
un marchio testuale e non solo un colore, perché il rosso da solo non è
un'informazione per chi non lo distingue.

**Il player scarica l'audio con `fetch`, non con `<audio src>`**, che non manda
l'intestazione `Authorization`. Parte solo quando si apre il pannello, e
l'object URL si revoca allo smontaggio: qualche megabyte per registrazione,
moltiplicato per le schede aperte in una sessione, è memoria che non torna più
da sola.

**La ricerca aspetta 300 ms e almeno due caratteri.** Senza freno, «pratica» è
sette ricerche ibride, cioè sette embedding pagati per vederne uno solo.

**La revisione non obbliga a niente.** Si salva, si lascia da rivedere, o si
esce senza toccare nulla. Se non è cambiato niente non parte nessuna `PATCH`
vuota, che il contratto rifiuterebbe con un 400 incomprensibile per chi ha solo
premuto un pulsante.

**Ciò che non è ancora una scheda si vede in cima all'elenco.** Una registrazione
che fallisce non produce nessuna procedura, e le procedure sono l'unica cosa che
l'app elencava: fino a ieri l'audio era al sicuro e l'errore registrato, ma per
chi aveva parlato al telefono la registrazione era sparita — e `/retry` esisteva
per un id che nessuna schermata poteva conoscere. Sta lì e non su una schermata
sua perché una voce di menu si apre solo se si sospetta già che qualcosa sia
andato storto, mentre il punto è che non lo si sospetta. Ogni riga porta quando,
quanto lunga e dove, che è quanto resta per riconoscere un vocale senza titolo,
e la trascrizione se c'è: è stata pagata comunque, ed è l'unico modo di non
perdere quello che si era detto.

Il pulsante «riprova» compare solo dove premerlo cambia qualcosa. Durante
un'attesa cambia — salta il backoff. Su una in lavorazione no, e il server lo
rifiuterebbe. Su un duplicato nemmeno: la deduplicazione è deterministica,
quindi rielaborare lo stesso audio ricade nello stesso verdetto, e un pulsante
che riporta al punto di partenza è peggio di nessun pulsante — lì la riga dice a
quale scheda somiglia e suggerisce di aprire quella. Il polling parte solo se in
lista c'è qualcosa che può muoversi da solo: una lista di sole registrazioni
ferme non cambia finché nessuno preme niente, e continuare a chiederla sarebbe
una richiesta ogni cinque secondi per ricevere sempre la stessa risposta.

**La redazione parte con niente selezionato.** Partire con tutto spuntato avrebbe
reso la schermata un pulsante «conferma» con del testo intorno, e il «una per
una» della §9 sarebbe rimasto solo nella forma. Ogni proposta mostra il contesto
con il dato evidenziato, perché è lì che si vede la differenza fra il centralino
di un ufficio e il cellulare di una persona — il numero da solo non la contiene.
È una schermata e non un dialogo: la fretta è esattamente ciò che fa condividere
un codice fiscale per sbaglio, e un dialogo la incoraggia.

**«Non ho trovato niente» ha tre versioni**, una per ogni valore di
`assistenza`. Con la passata assistita spenta la frase elenca i quattro formati
che il server sa calcolare, e si ferma lì: non ha guardato i nomi, e dirlo
altrimenti sarebbe una rassicurazione inventata. Con la passata riuscita
aggiunge che nemmeno un nome o un indirizzo è stato riconosciuto, e che resta
una lettura e non una garanzia. Con la passata caduta lo dice, con un avviso
sopra. È l'unico dei tre casi che merita un avviso: `NON_CONFIGURATA` sarebbe
pubblicità travestita da allarme, `ESEGUITA` un invito a fidarsi.

**La schermata dell'account si chiama «Il tuo account» e non «Impostazioni»**, perché
non ci sono impostazioni: la lingua viene dal dispositivo, l'ordinamento lo
decide il server, i provider stanno nell'API. Nasce con le tre cose che
esistevano già e che nessuno poteva premere — con quale account si sta
parlando, il cambio password, l'uscita. Le ultime due erano codice raggiungibile
solo da un terminale: `POST /api/auth/password` si chiamava con `curl`, e
`logout` stava in `session.tsx` da sempre senza che lo invocasse nessuno, quindi
uscire voleva dire svuotare lo storage del browser. Ci si arriva da un pulsante
nella testata dell'elenco e non da una quarta voce nella barra bassa: la barra
ha tre voci intorno al tasto rosso, che è grande perché deve restare premibile
di fretta con una mano sola, e stringerlo per una schermata che si apre due
volte l'anno sarebbe stato il peggior scambio possibile.

Il campo «ripeti la password nuova» non è cortesia: **non esiste recupero
password in nessuna parte di questo prodotto**, quindi una password nuova
digitata male e confermata male non chiude fuori per dieci minuti — chiude fuori
e basta. Per lo stesso motivo i tre `autoComplete` sono espliciti
(`current-password` sul primo, `new-password` sugli altri due): sbagliarli non
dà nessun sintomo mentre si sviluppa, e produce un gestore di password che dopo
il cambio conserva ancora quella vecchia. Delle regole del server, qui se ne
ripete una sola — la lunghezza minima, importata da `PASSWORD_MIN_LENGTH` così
che il numero esista in un posto solo. Il criterio non è «controllare presto» ma
se il server, davanti allo stesso sbaglio, sappia dire qualcosa di utile: sulla
password uguale alla precedente lo sa (`CONFLICT`, con una frase mostrabile così
com'è), sulla lunghezza risponderebbe «La richiesta non è valida», che è vero e
non dice cosa correggere. Dopo un cambio riuscito i campi si svuotano, perché
`currentPassword` contiene ormai una password morta e un secondo invio
stamperebbe «password sbagliata» sotto «password cambiata»; dopo un rifiuto
invece restano, perché il campo sbagliato è uno solo e ridigitare due volte una
password nuova che era giusta sono due occasioni in più di sbagliarla.

**Fra il cambio password e l'uscita c'è «Scollega gli altri dispositivi»**, che è
arrivata dopo perché prima la rotta non esisteva. Le tre sezioni stanno in
quest'ordine per quanto tolgono: la prima cambia una credenziale e chiude ogni
sessione, compresa quella su cui si sta premendo; la seconda chiude tutto tranne
quella; la terza chiude solo quella. È l'unica cosa che le distingue davvero —
sotto ognuna c'è una riga che dice cosa lascia in piedi, perché il pulsante da
premere si somiglia in tutti e tre i casi, e chi arriva qui di solito ha in testa
un problema («ho perso il telefono», «la password è in giro») e non un verbo. La
sezione di mezzo tiene il proprio stato per sé invece di condividerlo con quella
sopra: un successo del cambio password non deve accendere una frase sotto un
riquadro che non ha fatto niente, e un messaggio verde nel posto sbagliato, qui,
si legge come «l'ho fatto» su un gesto che nessuno ha compiuto.

Il suo risultato è un numero e non un «fatto», e nemmeno un numero stampato
crudo: «non c'era nessun altro dispositivo collegato», «un altro dispositivo è
stato scollegato» e «tre altri dispositivi sono stati scollegati» sono tre frasi
perché sono tre notizie. Lo zero è quella che conta di più ed è quella che un
«fatto» distruggerebbe: chi ha appena perso un telefono e legge «fatto» crede di
averlo scollegato, mentre la verità è che quel telefono non era collegato — il
che vuol dire che il problema, se c'è, è da un'altra parte.

**Dentro quel modulo, sopra il campo della password, c'è l'elenco dei dispositivi
collegati**, e ogni riga che non sia quella in mano ha accanto un pulsante che
chiude quella sola. L'elenco non è una sezione a sé e adesso meno che mai: serve
a tre cose, e nessuna delle tre funziona lontano dal modulo — dire quanti
dispositivi ci sono *prima* di premere; dare un metro al numero che torna dopo,
perché è ciò che trasforma «ne ho scollegate due» da un'affermazione in una
verifica; e ospitare i pulsanti che consumano la password scritta nel campo qui
sotto. Sta *dentro* il `<form>` e non sopra di esso, e non è una sfumatura:
separarli vorrebbe dire un campo password fuori da qualunque form — che i gestori
di password trattano peggio — e renderebbe `type="button"` sui pulsanti di riga
una precauzione senza effetto invece della cosa che impedisce a un clic su una
riga di far partire «scollega gli altri», cioè il più distruttivo dei due gesti
al posto del più piccolo, con la password già scritta nel campo. Dopo una revoca
riuscita — di una riga o di tutte — l'elenco si ricarica, e dopo un rifiuto no:
lì non è stato revocato niente, la lista a schermo è ancora quella giusta, e
rileggerla la farebbe sparire e riapparire identica sotto un messaggio d'errore,
come se il guasto riguardasse anche lei.

**Chiudere una sessione sola chiede la password**, ed è lo stesso campo di
«scollega gli altri». Senza, chi ha in mano un telefono rubato chiuderebbe le
altre una per una e otterrebbe esattamente ciò che quel campo esiste per
impedire. Per la stessa ragione il campo si svuota anche dopo aver chiuso una
riga sola, e non solo dopo il gesto grande: tutti i pulsanti tornano spenti
insieme, quindi un secondo clic distratto sulla riga accanto non parte da solo, e
chi vuole chiuderne due riscrive la password. Sono due decisioni, non un
trascinamento. Finché il campo è vuoto i pulsanti di riga restano spenti, con la
stessa disciplina del pulsante in fondo: una richiesta che partisse comunque
tornerebbe indietro con un `VALIDATION_FAILED`, cioè un errore rosso al posto di
un pulsante che si vede non essere ancora pronto.

**Sulla riga di questo dispositivo non c'è nessun pulsante**, ed è una decisione
e non una dimenticanza: chiudere la propria sessione è l'uscita, che sta dieci
righe più giù nella stessa schermata. Il server, se quella richiesta gli arriva
lo stesso, risponde `409 CONFLICT` invece di lasciarla passare — lasciarla
passare vorrebbe dire revocare il refresh token di chi sta chiamando mentre la
risposta dice «fatto», e il client scoprirebbe di essere fuori alla richiesta
dopo, con una rotazione che fallisce su un token appena ucciso da sé. E il 409
arriva **dopo** la verifica della password, mai prima: invertirli farebbe del
codice di stato un oracolo — 409 su una riga vorrebbe dire «questa è la tua», 401
«non lo è» — e chi avesse rubato un access token imparerebbe quale riga
dell'elenco è la propria senza sapere la password.

**Una sessione già chiusa risponde `{ revoked: 0 }`, non 404**, e la schermata lo
dice con una frase sua: «Quel dispositivo era già scollegato». Capita davvero —
due schede aperte sullo stesso account, lo stesso pulsante premuto due volte, un
elenco vecchio di qualche minuto — e la seconda volta il risultato voluto c'è
già: un 404 direbbe «è andata male» a chi ha ottenuto ciò che chiedeva. Ma non
dice nemmeno «fatto», per la stessa ragione dello zero qui sopra — far credere di
aver appena chiuso un dispositivo che era già andato è l'unica cosa peggiore
delle due.

Due dettagli della lista pesano più di quanto sembri. La chiave di ogni riga è
l'`id` e non la posizione: con la posizione React riusa l'elemento della riga
sparita per quella che le scivola sotto, e il pulsante che aveva il fuoco resta a
fuoco puntando ormai a un altro dispositivo — premere due volte di seguito, la
cosa più naturale del mondo mentre si ripulisce un elenco, chiuderebbe una riga
che nessuno aveva guardato. E il nome accessibile di ogni pulsante ripete la data
della riga («Scollega il dispositivo collegato 2 mesi fa»), perché tre «Scollega»
identici uno sotto l'altro non si distinguono leggendoli a voce; l'`aria-label`
vince sul contenuto, quindi resta lo stesso anche mentre l'etichetta visibile
dice «Un attimo». Mentre una riga è in volo si spegne quella sola: lo stato è
l'id della riga premuta e non un booleano condiviso, che spegnerebbe l'elenco
intero per una richiesta che ne riguarda una.

Di ogni dispositivo si legge **una cosa sola**: da quando è collegato, in
italiano relativo — «Collegato 3 giorni fa», «Collegato 2 mesi fa» — e quello in
mano porta scritto «questo dispositivo». Sotto l'elenco c'è una riga che dice
cos'altro non si sa, ed è lì apposta: senza, la lista sembrerebbe la versione
ridotta di un registro più completo tenuto da qualche altra parte. Niente da
dove, niente con che cosa, niente «ultimo uso» — le ragioni stanno più sotto,
dove c'è la rotta. Un elenco che lo dicesse sarebbe più utile nel momento in cui
serve, e un registro degli spostamenti del proprietario in tutti gli altri,
leggibile da chiunque prenda in mano uno qualsiasi dei dispositivi elencati.

Se l'elenco non si carica, la frase che compare è grigia e non un avviso rosso.
Senza righe non ci sono nemmeno i pulsanti di riga, ma il pulsante in fondo
funziona ancora e continua a scollegare gli altri dispositivi anche se non si è
riusciti a contarli: un `role="alert"` accanto a un modulo intatto direbbe che il
gesto è diventato impossibile, e chi ha appena perso un telefono smetterebbe di
provarci. Resta il gesto grosso al posto di quello mirato, che è il verso giusto
in cui degradare — chi non riesce a vedere l'elenco non può nemmeno scegliere
dentro l'elenco.

**Il cestino è una schermata e non un quarto chip.** I filtri dell'elenco sono
gli ambiti — personale, lavoro, clienti — e sono tutti dello stesso tipo:
mostrano un sottoinsieme delle stesse schede, con le stesse azioni. Il cestino
no. Contiene cose che non sono più in uso e offre gesti che altrove non
esistono, di cui due non si annullano. Come quarto chip avrebbe voluto dire che
«Clienti» e «Cestino» si premono per sbaglio l'uno al posto dell'altro, e che da
un tocco distratto si arriva a un pulsante rosso. Ci si va dal fondo dell'elenco
e non dalla testata: al contrario dei vocali in sospeso — che stanno in cima
proprio perché nessuno li andrebbe a cercare — qui ci si va quando si è già
deciso, e allora si scorre. In testata c'è posto per due pulsanti, e sono
occupati da cose che si premono ogni giorno. Il pulsante però sta **fuori** dal
ramo che disegna le schede: il cestino esiste anche quando l'elenco è vuoto, ed
è anzi l'unico caso in cui potrebbe contenere tutto quello che si sta cercando.

**Il secondo tocco non è una cerimonia.** È la distanza fra buttare via una
procedura e sfiorare lo schermo, e qui sotto non c'è nessun altro cestino da cui
ripescare. Se il server rifiuta — un `409`, perché nel frattempo la scheda è
stata ripristinata da un'altra schermata aperta — la conferma si richiude invece
di restare lì pronta per un secondo tentativo che non è più quello che chi ha
premuto aveva in mente. L'avvertenza su cosa comporta cancellare sta **sopra**
l'elenco e non dentro la conferma: parla a chi guarda i pulsanti, non a chi ne ha
già premuto uno. E la voce non riusa `ProcedureCard`, che è un `<button>` che
apre la scheda: qui ogni riga ne ha già tre dentro, e un pulsante dentro un
pulsante non è HTML valido — il browser lo risolve a modo suo, di solito
sganciando il tocco da entrambi.

**«Svuota il cestino» dice quante, e le conta tutte.** Il numero sul pulsante
rosso è `total` e non `items.length`: con trentaquattro archiviate e venti per
pagina, «Cancella 20 schede per sempre» sarebbe una frase falsa detta nel
momento peggiore, e chi la legge non ha modo di accorgersene finché non torna a
guardare. Anche il pulsante sta **fuori** dal ramo che disegna le schede, ma per
un motivo diverso da quello del pulsante nell'elenco: dentro, sparirebbe
portandosi via il proprio messaggio d'esito nell'istante esatto in cui c'è da
leggerlo, perché la ricarica riporta la lista in attesa e il cestino appena
svuotato non ha più righe. Per questo scompare quando `quante` è zero **ma non**
finché c'è un esito o un errore da mostrare.

Finito lo svuotamento non si ricarica la pagina in cui si era: se l'offset non è
zero si torna alla prima, perché la pagina tre di un cestino vuoto è una schermata
vuota che sembra un guasto. E l'esito non è mai «fatto»: sono `cancellate` e
`saltate`, al singolare o al plurale a seconda del numero, con una seconda frase
solo quando qualcosa è rimasto — «1 scheda è stata ripristinata nel frattempo».

**Un cestino grosso non è affare di questa schermata.** Il server ne porta via
cinquanta per richiesta, e chi ripete la chiamata finché non è finita è
`ApiClient.emptyTrash()`, che accumula i totali e ne restituisce uno solo: il
pulsante manda un gesto e riceve un numero, esattamente come prima. Metterlo qui
sarebbe stato più breve di una decina di righe, e avrebbe messo nel frontend una
regola di dominio — quando è finito uno svuotamento — che nessun'altra schermata
avrebbe modo di rispettare. Il prezzo dichiarato è che durante uno svuotamento
lungo non si può mostrare un avanzamento: fra la prima e l'ultima richiesta il
pulsante dice «Cancello…» e basta.

Resta perciò un terzo numero, `rimaste`, che nei casi normali non compare mai —
il ciclo si ferma proprio quando arriva a zero. Compare quando quel ciclo si è
arreso: cinquanta giri sono il suo tetto, e oltre quello la frase diventa «Nel
cestino restano 12 schede: premi di nuovo per continuare». È brutta apposta.
L'alternativa era dire «fatto» a chi ha davanti un cestino ancora pieno, e fra un
messaggio brutto e uno falso il secondo è quello che fa premere di nuovo senza
sapere perché.

Zero, zero e zero diventano «Il cestino era già vuoto», che è l'unica cosa vera da
dire a chi ha premuto un pulsante che non ha cancellato niente. Tutti e tre e non
i primi due: zero cancellate e zero saltate con qualcosa ancora dentro non è un
cestino già svuotato, è uno svuotamento che non è partito, e chiamarlo nello
stesso modo sarebbe la bugia più cara di questa schermata.

### Il service worker fa una cosa sola

Tiene in cache il guscio, così che aprire l'app senza rete mostri il pulsante di
registrazione invece del dinosauro del browser. Senza guscio in cache non c'è
nessun pulsante da premere, e la coda offline non servirebbe a niente.

> **`/api/` non entra mai in cache.** È la regola che non si tocca. Una risposta
> in cache significherebbe mostrare la scheda di ieri come quella di oggi, o —
> molto peggio — servire a un utente la lista di un altro rimasta nel browser.

Per il guscio va **prima in rete e poi in cache**. Il contrario sarebbe più
veloce ma terrebbe viva un'app vecchia fino alla chiusura di ogni scheda aperta,
e un'app vecchia che parla con un'API nuova è il guasto che nessuno riesce a
riprodurre. Sono sessanta righe scritte a mano: `vite-plugin-pwa` con Workbox
porta con sé qualche megabyte e una configurazione da imparare per ottenere le
stesse due regole.

Si registra dopo `load` e **solo in produzione**: in sviluppo un guscio servito
da cache mentre Vite sostituisce i moduli a caldo mostra codice di dieci minuti
prima senza dare modo di accorgersene.

### Provare l'offline, a mano

Con `npm run dev:api`, `npm run dev:worker` e `npm run dev:web` avviati, su
`http://localhost:5173`:

1. Entra con le credenziali del seed, premi il pulsante grande, parla, premi
   stop. La schermata torna alla lista **subito**.
2. Apri i DevTools → Network → **Offline**, e registra di nuovo. In fondo
   appare «1 in attesa»: l'audio è in IndexedDB (Application → IndexedDB →
   `wikimylife` → `uploads`).
3. Chiudi la scheda del browser. Riaprila, sempre offline: il guscio è servito
   dalla cache e la riga è ancora in coda.
4. Rimetti **Online**. La coda si svuota da sola entro un istante, senza
   toccare niente, e il worker produce la scheda.

Per il guscio offline serve la build vera, perché in sviluppo il service worker
non si registra:

```powershell
npm run build --workspace @wikimylife/web
npm run preview --workspace @wikimylife/web   # http://localhost:4173
```

---

## pgvector e tsvector — la regola permanente sulle migration

`Procedure.embedding` è una colonna `vector(1536)` e `Procedure.searchVector` è
un `tsvector` generato: Prisma le dichiara entrambe `Unsupported`. Ne discende
una cosa da sapere prima di toccare lo schema:

> **L'indice HNSW, l'indice GIN e l'espressione `GENERATED ALWAYS` sono
> invisibili alla drift detection di Prisma.** Ogni migration va generata con
> `--create-only`, l'SQL va letto, e ogni `DROP INDEX`, `DROP COLUMN` o
> `DROP EXTENSION` non voluto va cancellato a mano prima di applicarla.

```powershell
npm run db:migrate:create -- --name descrizione_della_modifica
# leggi prisma/migrations/<timestamp>_descrizione/migration.sql
npm run db:migrate
```

Un `DROP INDEX` accettato per distrazione non romperebbe niente: il codice
compilerebbe, i test unitari passerebbero, le query resterebbero corrette. Solo
diventerebbero scansioni sequenziali, e ce ne si accorgerebbe quando le procedure
sono decine di migliaia. La rete di sicurezza è
`tests/integration/schema.test.ts`, che interroga il catalogo di Postgres.

Gli embedding si leggono e si scrivono in SQL grezzo, perché i campi
`Unsupported` sono esclusi dal client tipizzato — sempre con parametri bindati e
castati, mai per concatenazione:

```ts
await prisma.$executeRaw`UPDATE "Procedure" SET embedding = ${literal}::vector WHERE id = ${id}`;
```

---

## Verificare che tutto funzioni

### Schema, pgvector e full-text

```powershell
docker compose exec db psql -U wikimylife -d wikimylife -c "\dx"
#   → vector

docker compose exec db psql -U wikimylife -d wikimylife -c "\d+ \""Procedure\"""
#   → embedding    | vector(1536)
#   → searchVector | tsvector | generated always as (to_tsvector('italian'::regconfig, "searchText")) stored

docker compose exec db psql -U wikimylife -d wikimylife -c "SELECT indexname FROM pg_indexes WHERE tablename='Procedure';"
#   → Procedure_embedding_hnsw_idx
#   → Procedure_searchVector_idx

# Il dizionario italiano c'è e fa stemming: se questa dà `f`, la ricerca
# smetterebbe di trovare le forme flesse senza un solo errore.
docker compose exec db psql -U wikimylife -d wikimylife -c "SELECT to_tsvector('italian','pagare') = to_tsvector('italian','pagato');"
#   → t
```

### Le invarianti del seed

I campi denormalizzati della §5 devono coincidere con le righe da cui derivano.
Questa query li confronta: le tre colonne `_ok` devono essere tutte `t`.

```sql
SELECT p.titolo,
       p."costoTotaleCent" = COALESCE((SELECT SUM(c."importoCent") FROM "Cost" c WHERE c."procedureId" = p.id), 0) AS costo_ok,
       p."volteEseguita"   = (SELECT COUNT(*) FROM "Execution" e WHERE e."procedureId" = p.id)                     AS volte_ok,
       p."ultimaVerifica" IS NOT DISTINCT FROM
         (SELECT MAX(e."eseguitaIl") FROM "Execution" e WHERE e."procedureId" = p.id AND e.esito = 'FUNZIONATO')   AS verifica_ok
FROM "Procedure" p ORDER BY p.titolo;
```

La procedura VPN ha una sola `Execution` con esito `CAMBIATA`: `volteEseguita`
vale 1 ma `ultimaVerifica` è `NULL`. È la regola della §8 — una procedura
eseguita e trovata cambiata non è una procedura verificata.

### L'operatore coseno sui dati del seed

```sql
SELECT a.titolo, b.titolo, 1 - (a.embedding <=> b.embedding) AS similarita
FROM "Procedure" a, "Procedure" b WHERE a.id < b.id;
```

Due procedure che non c'entrano niente devono stare **ben sotto 0.85**, che è la
soglia di deduplicazione: se la superassero, la Fase 2 nascerebbe suggerendo di
fondere il casellario giudiziale con la VPN aziendale.

### L'autenticazione, a mano

Con `npm run dev:api` in esecuzione:

```powershell
curl.exe http://localhost:3000/health
#   → {"status":"ok","db":"up",...}

# Login con le credenziali del seed (SEED_USER_EMAIL / SEED_USER_PASSWORD)
curl.exe -X POST http://localhost:3000/api/auth/login `
  -H "content-type: application/json" `
  -d "{\"email\":\"demo@wikimylife.local\",\"password\":\"wikimylife-demo-2026\"}"

curl.exe http://localhost:3000/api/auth/me -H "authorization: Bearer <accessToken>"
#   → l'utente

curl.exe -X POST http://localhost:3000/api/auth/refresh `
  -H "content-type: application/json" -d "{\"refreshToken\":\"<refreshToken>\"}"
#   → una coppia nuova

# E ora la cosa che conta: riusa il VECCHIO refresh token.
curl.exe -X POST http://localhost:3000/api/auth/refresh `
  -H "content-type: application/json" -d "{\"refreshToken\":\"<VECCHIO refreshToken>\"}"
#   → 401 TOKEN_REUSED

# Anche la coppia nuova, quella legittima, è morta:
curl.exe -X POST http://localhost:3000/api/auth/refresh `
  -H "content-type: application/json" -d "{\"refreshToken\":\"<NUOVO refreshToken>\"}"
#   → 401 TOKEN_REUSED

# E l'access token emesso PRIMA di tutto questo, che non è ancora scaduto:
curl.exe http://localhost:3000/api/auth/me -H "authorization: Bearer <accessToken>"
#   → 401 UNAUTHORIZED
```

L'ultima parte è il comportamento più importante della Fase 1. Quando un refresh
token già ruotato viene ripresentato, il server non può sapere chi sia il ladro:
se il token rubato arriva dopo la rotazione legittima ha una copia l'attaccante,
se arriva prima ce l'ha l'utente. In entrambi i casi la catena in circolazione è
compromessa, quindi si revoca l'intera famiglia e si costringe a rifare login.
Revocare solo il token riusato lascerebbe all'attaccante una catena valida per
trenta giorni.

E la revoca arriva fino in fondo, che è l'ultima riga del blocco. Un JWT firmato
dice «l'ho emesso io e non è scaduto»; non dice «questa sessione è ancora
aperta», e le due cose smettono di coincidere esattamente nel momento peggiore —
quando si preme "esci" perché il telefono è sparito, o quando la reuse detection
ha appena scoperto un furto. Per questo l'access token porta anche `fid`,
l'identificatore della famiglia da cui è nato, e `requireAuth` chiede a Postgres
se quella famiglia ha ancora almeno un refresh non revocato prima di lasciar
passare la richiesta. Senza, la difesa scattava e l'attaccante restava dentro per
un altro quarto d'ora.

Il prezzo è una lettura in più su ogni richiesta autenticata, ed è precisamente
il costo che l'access token esiste per evitare — quindi vale la pena dire quanto
sia: una riga su `@@index([familyId])`, verso lo stesso database che ogni rotta
protetta interroga comunque subito dopo per fare il proprio lavoro. Nessuna
richiesta autenticata si concludeva senza toccare Postgres; adesso lo tocca una
volta in più. L'alternativa era tenere il risultato in una cache di processo:
quasi gratis, ma avrebbe accorciato la finestra invece di chiuderla, e con più
repliche la sua durata sarebbe dipesa da quale replica risponde.

La famiglia e non l'utente, infine, perché le sessioni restano indipendenti:
uscire dal telefono non deve buttare fuori dal portatile, e una revoca per
account l'avrebbe fatto.

Tranne una volta. C'è un gesto in cui la revoca per account è esattamente quella
giusta, ed è cambiare password:

```powershell
# Fai login da due "dispositivi": due chiamate a /login, due famiglie diverse.
# Poi, con l'access token del primo:
curl.exe -X POST http://localhost:3000/api/auth/password `
  -H "content-type: application/json" `
  -H "authorization: Bearer <accessToken del PRIMO login>" `
  -d "{\"currentPassword\":\"wikimylife-demo-2026\",\"newPassword\":\"una-password-piu-lunga\"}"
#   → 200, e nel corpo una coppia di token NUOVA

# Il refresh del SECONDO dispositivo, che non ha fatto niente di male:
curl.exe -X POST http://localhost:3000/api/auth/refresh `
  -H "content-type: application/json" -d "{\"refreshToken\":\"<refreshToken del SECONDO login>\"}"
#   → 401 TOKEN_REUSED

# Anche l'access token con cui hai appena chiamato è morto:
curl.exe http://localhost:3000/api/auth/me -H "authorization: Bearer <quello di prima>"
#   → 401 UNAUTHORIZED — ma la risposta del cambio te ne ha già dato uno nuovo
```

Chi cambia password lo fa quasi sempre per un motivo solo: sospetta che sia in
giro. Una revoca che risparmiasse le altre sessioni lascerebbe in piedi
esattamente quelle di cui si sospetta, e la persona che ha appena cambiato
password crederebbe di aver chiuso la porta. Quindi qui cade tutto — e la
password nuova e la revoca vengono scritte nella **stessa transazione**, perché
dei due modi di fallire a metà uno è molto peggio dell'altro: password cambiata
ma sessioni ancora aperte è un danno silenzioso, mentre sessioni chiuse e
password ancora vecchia è un fastidio che si vede subito e si riprova.

La sessione da cui parte la richiesta è l'unica che sopravvive, ed è per questo
che la risposta contiene una coppia di token intera invece di un `{"ok":true}`:
i token vecchi sono morti un istante fa, e questo è l'unico momento in cui si
possono sostituire senza chiedere un secondo login. Sopravvive perché è l'unica
di cui in quell'istante si sappia qualcosa — chi la usa ha appena dimostrato di
conoscere la password. E `currentPassword` è obbligatoria anche se la rotta sta
dietro `requireAuth`: il token dice «questa è una sessione aperta», non «di là
dallo schermo c'è il proprietario».

C'è però un caso in cui cambiare password è la risposta sbagliata a un problema
vero, ed è il telefono perso da chi la password la tiene in un gestore: quella
credenziale sta al sicuro dov'è, e cambiarla vuol dire aggiornarla ovunque per un
motivo che non la riguarda — che è poi la ragione per cui, dovendo scegliere fra
il fastidio e il rischio, poi non la cambia nessuno. Serve l'altro gesto:

```powershell
# Di nuovo due login, due famiglie, con la password nuova di prima.
# Poi, con l'access token del primo:
curl.exe -X POST http://localhost:3000/api/auth/sessions/revoke `
  -H "content-type: application/json" `
  -H "authorization: Bearer <accessToken del PRIMO login>" `
  -d "{\"currentPassword\":\"una-password-piu-lunga\"}"
#   → 200 {"revoked":1} — quante ne sono cadute, non {"ok":true}

# Il SECONDO dispositivo è fuori, refresh compreso:
curl.exe -X POST http://localhost:3000/api/auth/refresh `
  -H "content-type: application/json" -d "{\"refreshToken\":\"<refreshToken del SECONDO login>\"}"
#   → 401 TOKEN_REUSED

# Il PRIMO, quello da cui è partita la richiesta, non è stato toccato:
curl.exe http://localhost:3000/api/auth/me -H "authorization: Bearer <quello di prima>"
#   → 200, e nessun token nuovo da mettere via: non ce n'era bisogno

# E il numero si può guardare in faccia, prima e dopo:
curl.exe http://localhost:3000/api/auth/sessions -H "authorization: Bearer <quello di prima>"
#   → 200 {"sessions":[{"createdAt":"2026-…","current":true}]}
#     Una riga sola, ed è questa. Prima della revoca ce n'erano due.
```

Le differenze dal cambio password sono tre, e nessuna è di comodo. La prima è che
la sessione chiamante viene **risparmiata** invece di essere revocata e riemessa.
I token nuovi del cambio password esistono solo dentro quella risposta HTTP: se
la risposta si perde per strada, chi stava chiudendo fuori gli altri resta fuori
lui, e non ha più niente in mano per rientrare se non un secondo login. Qui non
viaggia nessuna credenziale, quindi riprovare è gratis. Quale famiglia
risparmiare non lo dice il corpo della richiesta — sarebbe il chiamante a
dichiarare quale sessione salvare, cioè esattamente la cosa che non deve poter
scegliere: lo dice il `fid` dentro l'access token firmato, di cui `requireAuth`
ha appena verificato che la famiglia sia viva, e che da questa versione finisce
in `req.auth` accanto allo userId.

La seconda è che la risposta è un numero. Zero, uno e nove sono tre notizie
diverse, e la più utile è proprio lo zero: vuol dire «il telefono che stai
cercando non era collegato», mentre un «fatto» scritto sopra la stessa situazione
fa credere di averlo appena scollegato. Il conto sono i refresh token vivi
revocati, che è il numero di dispositivi perché una famiglia viva ne ha
esattamente uno — la rotazione è una transazione che ne revoca uno e ne crea uno,
e non c'è nessun percorso che ne lasci due.

La terza è che `currentPassword` qui è obbligatoria per un motivo **in più**
rispetto al cambio password, e il motivo nasce dalla prima differenza. Il gesto
risparmia la sessione da cui parte: se non chiedesse niente, chi ha in mano il
telefono rubato potrebbe premerlo e restare l'unico collegato, buttando fuori il
proprietario da tutto il resto. Il campo che sembra un fastidio è l'unica cosa
che tiene l'arma dalla parte giusta.

`GET /api/auth/sessions` è il metro di quel numero, ed è arrivata dopo per la
stessa ragione per cui era la risposta a essere un numero: «ne ho scollegate due»
significa qualcosa solo a chi sapeva che ce n'erano tre. Risponde con una riga
per dispositivo collegato e, di ogni riga, **tre campi soli** — `id`, `createdAt`
e `current`. Non chiede la password perché non fa niente: è una lettura, e ciò
che mostra lo sa già chiunque abbia in mano una sessione viva, perché è il
proprio account.

`createdAt` è il momento del **login**, non quello dell'ultima rotazione, e la
differenza è tutta la ragione per cui questa rotta esiste in questa forma. Una
famiglia viva ha un solo refresh token vivo, e il suo `issuedAt` si sposta a ogni
giro: leggerlo darebbe «ultimo accesso» sotto un altro nome, cioè il registro
degli spostamenti che questo prodotto ha deciso di non tenere. La nascita è
`MIN(issuedAt)` su tutte le righe della famiglia, comprese le decine che la
rotazione ha già revocato — che è il motivo per cui l'adattatore fa due
interrogazioni e non una: «viva» è una proprietà della riga corrente, «nata» è
un'aggregazione su tutta la storia. Per lo stesso motivo non escono né IP né
user-agent.

L'`id` invece esce, ed è il `familyId`. Fino al commit che ha aggiunto la rotta
qui sotto non c'era, e il commento accanto allo schema diceva perché: senza un
gesto che lo consumi, un identificativo di sessione spedito a ogni apertura di
una schermata è solo un id che prima o poi finisce in un log. Adesso il gesto c'è
— e l'id, la rotta che lo consuma e il pulsante che lo manda sono atterrati
insieme, in un commit solo, apposta.

La rotta sta dietro `requireAuth` e **fuori** dal limite dei tentativi, per la
ragione già scritta per `/me`: non accetta nessun segreto, quindi non c'è niente
da indovinare a colpi di richieste, e limitarla spegnerebbe l'elenco proprio a
chi ricarica la schermata mentre cerca di capire quale dispositivo scollegare.

`POST /api/auth/sessions/revoke-one` ne chiude **una**, e l'id viaggia nel
**corpo** insieme alla password:

```powershell
# L'id di una riga di GET /sessions, cioè un familyId.
$corpo = @{ sessionId = "<id di una riga>"; currentPassword = "password-lunga-12" } |
  ConvertTo-Json

curl.exe -X POST http://localhost:3000/api/auth/sessions/revoke-one `
  -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d $corpo
# {"revoked":1}

# Premuto una seconda volta sullo stesso id:
# {"revoked":0}   <- e non un 404: il risultato voluto c'era già.
```

**Perché il corpo e non il percorso**, che sarebbe stato più REST. La chiave del
limite dei tentativi si costruisce così
(`apps/api/src/http/middleware/rateLimit.ts`):

```ts
const key = `${req.ip ?? "sconosciuto"} ${req.method} ${req.baseUrl}${req.path}`;
```

`req.path` è il percorso **concreto**, non lo schema della rotta. Con l'id nel
percorso ogni id aprirebbe un secchiello nuovo, e una rotta che accetta una
password diventerebbe un oracolo senza limite: basta cambiare l'UUID a ogni
tentativo per non incontrare mai il 429. `POST /sessions/:id/revoke` e
`DELETE /sessions/:id` cadono tutte e due per questo. È anche il motivo per cui
il commento di `GET /sessions` avvisava che «un giorno qualcuno scriverà
`router.get("/sessions/:id")` e il primo a rompersi sarà l'altro»: con l'id nel
corpo quel giorno non arriva, e le tre rotte sotto `/sessions` non si contendono
niente.

Scartata anche la terza strada — allargare `/sessions/revoke` con un `sessionId`
facoltativo — perché farebbe decidere a un **campo assente** se il gesto ne
chiude una o tutte, e un corpo malformato sceglierebbe il ramo più distruttivo.
Due gesti diversi, due rotte.

Il servizio fa cinque cose in quest'ordine, e l'ordine è la sicurezza: rilegge
l'utente (401 se non c'è più), verifica la password (401), rifiuta con `409` un
`sessionId` uguale al proprio `fid`, revoca, risponde col conto. Le ragioni del
409 e del suo posto in coda alla verifica stanno più sopra, nella schermata.

La revoca passa da `revokeFamilyOfUser`, che **non** è `revokeFamily`, due righe
più su nella stessa porta. Quello non ha lo `userId`: va bene per la rilevazione
del riuso e per l'uscita, che partono da una riga già letta e già attribuita, ma
raggiungibile da una rotta HTTP diventerebbe «revoca la sessione di chiunque, se
ne indovini l'id». Il nuovo ha un `WHERE` a tre parti — `userId`, `familyId`,
`revokedAt: null` — e ognuna delle tre ha un difetto suo se manca: senza
`userId` si revoca la famiglia di un altro utente, senza `familyId` si revocano
tutte le proprie, senza `revokedAt: null` si ricontano righe già morte e il
numero mente. I due metodi restano separati apposta: uno è sicuro *perché* non
ha lo `userId`, l'altro *perché* ce l'ha.

Come `/sessions/revoke` e `/password`, questa rotta sta **dentro** il limite dei
tentativi: è autenticata ma accetta una password, quindi è un posto da cui
indovinarla, e paga un argon2 per tentativo.

### Un vocale che diventa una scheda, a mano

Servono due terminali: `npm run dev:api` e `npm run dev:worker`. Con i provider
`fake` non serve nessuna chiave — la trascrizione è deterministica e l'estrazione
restituisce una procedura di prova.

```powershell
$token = "<accessToken del login qui sopra>"

# Un file audio qualunque: con i provider fake il contenuto non viene letto.
[IO.File]::WriteAllBytes("$PWD\voce.webm", [byte[]](0x1a,0x45,0xdf,0xa3,1,2,3,4))

# I metadati §2 in un file, per non litigare con le virgolette di PowerShell.
# Obbligatori: recordedAt, durationMs, mimeType. Il resto ha un default.
[IO.File]::WriteAllText("$PWD\meta.json",
  '{"recordedAt":"2026-03-01T10:00:00.000Z","durationMs":42000,"mimeType":"audio/webm"}')

curl.exe -X POST http://localhost:3000/api/recordings `
  -H "authorization: Bearer $token" `
  -F "metadata=<meta.json" `
  -F "audio=@voce.webm;type=audio/webm"
#   → 202 {"id":"...","status":"BOZZA_AUDIO","procedureId":null,...}

# Il worker la prende entro cinque secondi. Poi:
curl.exe http://localhost:3000/api/recordings/<id> -H "authorization: Bearer $token"
#   → status: "ESTRATTO", procedureId valorizzato, transcript presente
```

Ricarica **lo stesso vocale una seconda volta**: la seconda registrazione finisce
in `DUPLICATO_SOSPETTO` con `duplicateOfId` uguale alla prima procedura e
`duplicateSimilarity` a 1, e nel database resta una sola `Procedure`.

```sql
SELECT status, "procedureId", "duplicateOfId", round("duplicateSimilarity"::numeric, 3)
FROM "Recording" ORDER BY "createdAt";
SELECT count(*) FROM "Procedure";
```

Poi rimettila in coda e guarda cosa succede — il suggerimento sparisce, la
registrazione torna elaborabile, e alla fine è di nuovo un duplicato:

```powershell
curl.exe -X POST http://localhost:3000/api/recordings/<id-della-seconda>/retry `
  -H "authorization: Bearer $token"
```

E la proprietà, con l'access token di un **altro** utente:

```powershell
curl.exe http://localhost:3000/api/recordings/<id> -H "authorization: Bearer $altroToken"
#   → 404 NOT_FOUND — identico a un id inesistente
```

Infine butta via il duplicato. È l'unica cancellazione dura del progetto: sparisce
la riga e sparisce il file, e non resta nessuno `status` a ricordarla.

```powershell
curl.exe -X DELETE http://localhost:3000/api/recordings/<id-della-seconda> `
  -H "authorization: Bearer $token" -i
#   → 204, corpo vuoto
#   → un secondo DELETE sullo stesso id: 404 NOT_FOUND
```

Con lo storage `local` l'audio se n'è andato insieme alla riga: sotto
`STORAGE_LOCAL_DIR` il file non c'è più. Cancella invece la **prima**, quella
arrivata a `ESTRATTO`, e guarda che la scheda sopravvive:

```powershell
curl.exe -X DELETE http://localhost:3000/api/recordings/<id-della-prima> `
  -H "authorization: Bearer $token"
curl.exe http://localhost:3000/api/procedures/<procedureId> -H "authorization: Bearer $token"
#   → 200: la scheda c'è ancora, senza più la voce da cui è nata
```

### Leggere e cercare, a mano

Con l'API avviata e il seed applicato (`npm run db:seed`), i due esempi sono le
schede del casellario e della VPN.

```powershell
$token = "<accessToken del login qui sopra>"
$h = @{ authorization = "Bearer $token" }

curl.exe "http://localhost:3000/api/procedures" -H "authorization: Bearer $token"
#   → { items: [2 schede], total: 2, limit: 20, offset: 0 }

curl.exe "http://localhost:3000/api/procedures?scope=LAVORO" -H "authorization: Bearer $token"
#   → solo la VPN

# Refuso nel nome del filtro: 400, non venti risultati ignorando la chiave.
curl.exe "http://localhost:3000/api/procedures?limti=5" -H "authorization: Bearer $token"
#   → 400 VALIDATION_FAILED
```

La ricerca, e le tre cose che vale la pena vedere accadere:

```powershell
# 1. Trova una parola che sta solo in un passo, non nel titolo.
curl.exe "http://localhost:3000/api/search?q=tabaccheria" -H "authorization: Bearer $token"
#   → il casellario, matchedBy: "TESTO"

# 2. Stemming italiano: singolare per plurale.
curl.exe "http://localhost:3000/api/search?q=credenziale" -H "authorization: Bearer $token"
#   → la VPN — «credenziali» nel testo

# 3. Una query che nessuno saprebbe interpretare non fa 500.
curl.exe "http://localhost:3000/api/search?q=vpn%20(%20%22or%20!%20&" -H "authorization: Bearer $token"
#   → 200
```

La §8 e la §9, in sei chiamate:

```powershell
$id = "seed-proc-casellario"

# CAMBIATA riporta la scheda in DA_RIVEDERE.
curl.exe -X POST "http://localhost:3000/api/procedures/$id/executions" -H "authorization: Bearer $token" `
  -H "content-type: application/json" -d '{\"esito\":\"CAMBIATA\",\"nota\":\"Ora il modulo e online\"}'
#   → 200, status: "DA_RIVEDERE", volteEseguita incrementato

# La VPN ha contieneDatiSensibili: true. Pubblicarla è un 409, non un warning.
curl.exe -X PATCH "http://localhost:3000/api/procedures/seed-proc-vpn" -H "authorization: Bearer $token" `
  -H "content-type: application/json" -d '{\"visibility\":\"PUBBLICA\"}'
#   → 409 CONFLICT

# La passata di redazione propone e non tocca niente.
curl.exe "http://localhost:3000/api/procedures/seed-proc-vpn/redazione" -H "authorization: Bearer $token"
#   → proposte[], ognuna con campo, etichetta, valore, sostituzione, contesto e
#     origine; più assistenza, che con i default vale "NON_CONFIGURATA" — cioè
#     nessuno ha guardato i nomi, e non che non ce ne fossero

# Si applica solo quello che si conferma, per id. Nessun testo nel corpo.
curl.exe -X POST "http://localhost:3000/api/procedures/seed-proc-vpn/redazione" -H "authorization: Bearer $token" `
  -H "content-type: application/json" -d '{\"conferme\":[\"steps.1.dettaglio:24:EMAIL\"]}'
#   → 200 con la scheda redatta; un id che non si ritrova più è un 409

# DELETE archivia: la riga resta, la scheda sparisce dalla lista e dalla ricerca.
curl.exe -X DELETE "http://localhost:3000/api/procedures/$id" -H "authorization: Bearer $token"
#   → 200, status: "ARCHIVIATA"
curl.exe "http://localhost:3000/api/search?q=casellario" -H "authorization: Bearer $token"
#   → items: []
curl.exe "http://localhost:3000/api/procedures?status=ARCHIVIATA" -H "authorization: Bearer $token"
#   → eccola
```

E la proprietà, di nuovo, perché è la regola che non deve avere eccezioni:

```powershell
curl.exe "http://localhost:3000/api/procedures/$id" -H "authorization: Bearer $altroToken"
#   → 404 NOT_FOUND — mai 403: un 403 confermerebbe che quell'id esiste
```

---

## Test

```powershell
npm test               # unit + web — nessun Docker, nessuna rete
npm run test:integration   # integration — richiede docker compose up -d
npm run typecheck      # tsc su tutti i progetti, incluso seed e test
```

I tre gruppi sono project Vitest separati e non filtrati per nome file, perché la
promessa deve essere verificabile: se `npm test` avesse bisogno di un container,
il primo contributo di chiunque comincerebbe con mezz'ora di setup. `web` è un
project a sé e non una cartella dentro `unit` per una ragione tecnica e non
organizzativa: l'ambiente è una proprietà del project, e `jsdom` costa qualche
decimo di secondo a file. Farlo pagare anche ai test che non toccano il DOM
sarebbe stato un rallentamento silenzioso su tutta la suite.

**unit** copre il contratto Zod (casi negativi con verifica del *path* della
issue, non solo del fallimento), le guardie sull'isomorfismo, i token, il
servizio di autenticazione con un repository in memoria, l'error handler, il
client API e i provider fake. Del client, il test che ha già ripagato il proprio
costo riguarda le due sole rotte con una query string: i parametri mandati si
confrontano con le chiavi dello schema, non con un URL scritto a mano. La query
si costruisce elencando i campi uno per uno, e `offset` era stato aggiunto al
contratto della ricerca e dimenticato lì — premere «Successive» ricaricava la
prima pagina, e niente falliva da nessuna parte. Sempre del client, `emptyTrash()`
è l'unico metodo in cui una chiamata non è una richiesta, e quindi l'unico in cui
si può sbagliare a fermarsi: i casi guardano le due uscite del ciclo prese una
per volta (togliere quella sul cestino vuoto e togliere quella sulla passata che
non tocca niente devono far cadere cose diverse), che una passata di sole
`saltate` **non** conti come «non ho toccato niente» — fermarsi lì lascerebbe il
cestino mezzo pieno — che i totali si sommino invece di essere l'ultima passata,
che il tetto dei cinquanta giri esista davvero, e che il token viaggi su ogni
richiesta e non solo sulla prima, che è il difetto che si vedrebbe soltanto in
mano a chi ha molte schede. Della Fase 2: la validazione della §5 caso per caso
(JSON malformato, ordine non contiguo, confidenza bassa, importi negativi,
`NOTA_SEMPLICE`), il prompt confrontato carattere per carattere con la specifica,
e la pipeline con un repository in memoria — compreso il duplicato rilevato. Della
Fase 3: la composizione di `searchText()`, la fusione RRF come funzione pura (che
l'accordo batta l'eccellenza in un canale solo, l'ordinamento a parità, il
degrado con un canale vuoto), le regole §8 e §9 del servizio delle procedure, e
l'orchestrazione della ricerca — incluso il provider di embedding che cade e non
deve portarsi via la risposta, e la finestra che i due canali ricevono, che deve
restare la stessa qualunque siano `limit` e `offset`: è quell'invariante, e non
il taglio della pagina, a rendere la seconda pagina la continuazione della prima.
Della Fase 4: lo svuotamento della coda (ordine di
invio, `drain()` rientrante, un 401 che marca invece di riprovare all'infinito,
una rete assente che lascia tutto in coda), le regole di presentazione con un
*adesso* fisso — un test che legge l'orologio di sistema fallisce da solo a
mezzanotte — e il giro rotta ⇄ hash ⇄ rotta. Fra le regole di presentazione,
quella che conta di più è cosa dire di una registrazione che non è ancora una
scheda: una appena caricata e una che ha appena fallito hanno lo stesso
`status`, e un test che guardasse solo quello passerebbe anche con la funzione
sbagliata. Sempre della Fase 4, il rifiuto di IndexedDB: distinguere «non c'è
spazio» da «IndexedDB non c'è» decide se all'utente compare il pulsante che gli
salverebbe l'audio, e la distinzione sta in tre nomi di errore — uno standard e
due di Gecko — che nessuno controlla a mano. Accanto, il nome del file
scaricato, che deve restare un nome anche quando la data non si legge:
un'eccezione lì dentro sarebbe l'audio che non esce dal browser. E il conto
dello spazio residuo, dove ciò che conta di più è che «non lo so» non diventi
mai «è pieno»: un browser senza `storage.estimate` non deve spaventare nessuno,
e una quota `Infinity` non deve produrre un numero di minuti infinito.
Della Fase 5: la firma SigV4 contro
i vettori ufficiali di AWS, e le regole di `loadConfig` che in produzione
rifiutano lo storage effimero, il CORS vuoto e i provider fake. Della sicurezza:
l'aritmetica del limitatore con un orologio iniettato — la finestra che si riapre
a `windowMs` e non un millisecondo prima, i budget separati per IP e per rotta,
`Retry-After` che compare solo negando, e seicento indirizzi che non restano in
memoria — e il tetto ai tentativi di ingestione, compreso che il riscatto manuale
ne ricompri esattamente uno e che il backoff sia una vera attesa: dopo un
fallimento la riga resta in `BOZZA_AUDIO` ma la coda la ignora, il secondo
fallimento aspetta più del primo, e prendere la riga o riscattarla a mano
cancella l'attesa. Accanto, quali fallimenti valga la pena riprovare, dove il
caso che tiene onesto tutto il resto è quello negativo: senza un `503` che invece
aspetta, «tutto è definitivo» passerebbe ogni altro test del blocco, e senza il
`401` che resta transitorio nessuno si accorgerebbe di aver trasformato una
chiave scaduta in un «riprova» a mano per ogni riga della coda. La distinzione si
prova due volte: sulla funzione, con gli errori costruiti dalle classi vere dei
provider — riconoscerli da `name` e `status` significa che un rename non rompe
niente finché qualcuno non lo guarda — e sulla pipeline, dove ciò che conta è che
la riga esca dalla coda *senza* un `nextAttemptAt` nel futuro, che sarebbe una
promessa che nessuno mantiene. Della redazione: i rilevatori presi uno per uno, con
i codici fiscali e gli IBAN validi accanto ai loro gemelli sbagliati di un
carattere — un test che provi solo che il formato giusto passa non dimostra che
il checksum venga guardato — e il servizio, dove conta soprattutto ciò che *non*
succede: le proposte non confermate restano nel testo, gli id di una passata
vecchia danno `409` invece di tagliare a caso, e il flag è ancora acceso quando
tutto è stato applicato. Della metà assistita quasi solo il rifiuto: il valore
che il modello ha inventato non diventa una proposta, «Rossi» non si prende metà
di «Rossini», un tratto già rivendicato da un rilevatore non si propone due
volte, l'impronta sbagliata dà `409` e due conferme sovrapposte pure. Il caso
positivo è una riga; il resto del blocco esiste perché un modello che risponde
benissimo e dice cose non vere è il caso normale, non l'eccezione. Accanto, il
prompt e lo schema del tool: che il testo dei campi arrivi al modello carattere
per carattere — è la proprietà da cui dipende tutto il resto, perché il server
cercherà dentro *quel* testo — e che l'enum dei campi si chiuda sui soli
percorsi mandati. Della cancellazione di una registrazione: che riga e
oggetto spariscano entrambi, che una `IN_ELABORAZIONE` dia `409` e resti dov'è,
e i due casi in cui lo storage non collabora — l'oggetto già assente, che è un
successo perché tutti e tre i provider trattano così una `delete` a vuoto, e il
bucket irraggiungibile, che invece deve lasciare all'utente il suo `204` e la
chiave a chi tiene il bucket. Di `?ancheLaScheda=1`, ciò che il repository in
memoria non può provare perché non ha una transazione: che le due scritture
stiano su due tabelle e finiscano insieme, e soprattutto che dal `409` non esca
una scheda archiviata — con due statement in fila, nell'ordine sbagliato, lì ci
sarebbero un errore e una procedura nel cestino. Accanto, i due modi di scrivere
male il parametro: `=false` letto come un sì e `?ancheLascheda=1` con la `s`
minuscola letto come un'assenza. Sono entrambi `400`, e sono entrambi test che
esistono per un difetto che avrebbe cancellato il lavoro di qualcuno senza
dirlo. Della scopa, dove non si prova che funzioni ma che ognuna delle tre
regole basti *da sola* a salvare un oggetto, e dove il caso peggiore ha un test
suo: se la domanda «chi ti nomina?» fallisse in silenzio, la risposta sarebbe
«nessuno» per tutti, quindi un errore del database interrompe la passata invece
di saltare il blocco. Accanto, da quando `SWEEP_MODE` parte da `elenca`, le due
decisioni del worker: quando la passata deve partire — quasi mai, e mai con la
coda piena — e `toccaCancellare`, che è il confronto da tre caratteri fra un
default innocuo e un `DELETE` sui file di chiunque non abbia mai letto questa
sezione. Il worker non ha altri test perché il suo entry point finisce con un
`await main()`: entrambe le decisioni stanno in un modulo a parte esattamente
per poter essere provate.

**web** monta tredici fra schermate e pezzi di schermata in `jsdom` e ne prova le
proprietà, non l'aspetto. Non è una copertura: è l'elenco dei posti dove una
regressione non produce nessun sintomo visibile.

Della schermata di redazione, che nessuna casella sia spuntata all'apertura —
è la §9 alla lettera, e un valore iniziale diverso trasformerebbe la pagina in
un «conferma» che cancella dati che nessuno ha letto — che ad `applyRedaction`
arrivino esattamente gli id spuntati e nessun altro, e che un `409` azzeri le
scelte invece di lasciare selezionate caselle che si riferiscono a un testo che
non esiste più. Accanto, le due cose che il CSS non protegge: la scritta «letto,
non calcolato» sulle proposte di un modello, che è l'unica differenza fra
un'ipotesi e un checksum per chi non distingue i colori, e il fatto che la frase
di contesto finisca in pagina come testo — arriva da un modello linguistico che
ha letto un audio, ed è l'ingresso meno fidato che questa applicazione abbia.

Della schermata di ingresso, che il messaggio del server si veda (è l'unico
punto dell'app dove l'errore *è* la risposta, non un dettaglio), che «Failed to
fetch» non arrivi mai all'utente, che `autoComplete` passi a `new-password`
quando si sta creando un account — sbagliarlo non ha nessun sintomo durante lo
sviluppo e produce un account con una password che il gestore non ha mai
salvato — e che il pulsante spento durante la richiesta impedisca davvero la
seconda iscrizione di chi non vede reazione.

Dell'account, la schermata dove si sbaglia una volta sola: senza recupero
password, ogni difetto qui è un archivio perso, e nessuno di quelli che contano
si vede provandola a mano. I tre `autoComplete` sono lo stesso guasto silenzioso
della schermata di ingresso, moltiplicato — un `current-password` sul campo
sbagliato fa sì che il gestore, dopo il cambio, conservi ancora la vecchia. Che
`currentPassword` e `newPassword` non finiscano scambiate nel corpo non lo
mostra nessuna prova manuale, se per fare in fretta si digita due volte la
stessa stringa. Che la ripetizione *fermi* la richiesta e non la accompagni è
tutta la difesa che esiste contro un refuso. E i due comportamenti dei campi
dopo l'invio sono opposti apposta: vuoti dopo un successo, perché `attuale`
contiene ormai una password morta e il secondo invio stamperebbe «sbagliata»
sotto «cambiata»; intatti dopo un rifiuto, perché ridigitare una password nuova
che era giusta è un'occasione in più di perdersi. Accanto, che l'errore sparisca
appena si corregge il campo che l'ha causato — «non coincidono» appeso sopra il
campo che le ha appena fatte coincidere si legge come «non hai corretto
abbastanza» — che il doppio tocco non mandi due cambi di fila, e che «Esci»
chiami davvero `logout`, che per tutta la vita di `session.tsx` prima di questa
schermata non lo chiamava nessuno.

Della sezione di mezzo, che il numero diventi tre frasi diverse e non tre numeri.
Zero, uno e molti hanno una forma grammaticale ciascuno, e lo zero soprattutto
deve leggersi «non c'era nessun altro dispositivo collegato» e non «zero
dispositivi scollegati», che è la stessa informazione travestita da successo: il
caso esiste perché è l'unico posto della schermata dove un refuso non somiglia a
un difetto. Accanto, che la password parta nel corpo e non resti nel campo dopo
l'invio, che un rifiuto del server diventi un messaggio d'errore e non un
conteggio, e che i due moduli non si passino gli esiti — un cambio password
riuscito non deve stampare niente sotto la sezione che non ha fatto nulla, che è
esattamente ciò che succederebbe con uno stato solo. E le tre sezioni insieme:
che ognuna dica cosa lascia in piedi, e che i tre pulsanti abbiano tre nomi
diversi, perché sono tre gesti irreversibili in tre modi diversi e distinguerli è
tutto il lavoro di questa schermata.

Dell'elenco dei dispositivi, quale riga porta l'etichetta e cosa succede dopo.
Che «questo dispositivo» stia su una riga sola non basta a dire che stia sulla
riga giusta: il caso mette di proposito il dispositivo corrente al **secondo**
posto, perché una schermata che marcasse sempre il primo passerebbe qualunque
prova fatta con la sessione corrente in cima — ed è l'ordine che viene naturale
scrivendo l'esempio a mano. Accanto, il caso opposto, che nessun'altra riga la
porti. Le date si leggono relative e non ISO, e un dispositivo solo non è un caso
speciale che rompe la lista. Poi le due cose che non si vedono provando a mano:
che dopo una revoca riuscita l'elenco si **ricarichi** — senza, la schermata
scrive «due scollegati» sopra una lista che ne mostra ancora tre, cioè si
contraddice da sola — e che dopo un rifiuto **non** si ricarichi, il che si prova
contando le letture partite e non guardando lo schermo, perché una lista
ricaricata identica è indistinguibile da una lista rimasta ferma. Infine il
guasto dell'elenco: il modulo della revoca resta usabile e in pagina non compare
nessun `role="alert"`, che è la differenza fra «non sono riuscito a contarli» e
«non puoi più scollegarli».

Dei pulsanti che ne chiudono uno solo, che premerne uno riguardi **quello**. La
lista dei casi è quasi tutta di errori che a mano non si vedono: che parta l'id
di quella riga e non quello della prima — con tre righe identiche un bug del
genere è invisibile finché non si guarda il corpo della richiesta; che si spenga
la sola riga premuta, provato guardando che le altre due restino premibili;
che il nome accessibile del pulsante in volo nomini **ancora** il suo
dispositivo, perché è il solo modo di sapere quale riga si sta aspettando; e che
la riga chiusa venga **smontata** invece di essere riciclata per quella che le
scivola sotto, che è il caso scritto apposta per uccidere `key={indice}` e si
prova sull'identità del nodo (`isConnected`) e non su ciò che c'è scritto sopra,
perché con tre date diverse una riga riciclata mostra il testo giusto lo stesso.
Poi i due opposti, come sempre: il pulsante c'è sulle altre righe e **non** sulla
riga `current`; è spento a campo vuoto e acceso appena si scrive. E i tre effetti
di contorno: l'elenco si ricarica e il campo si svuota dopo un gesto riuscito;
uno zero si legge «era già scollegato» e non «fatto»; un rifiuto si legge e la
riga torna premibile. Infine il caso che tiene su il `type="button"`: premere
«Scollega» su una riga **non** manda `revokeOtherSessions`, cioè non fa partire
il gesto grosso dal pulsante del piccolo.

Della sezione «In lavorazione», quando smette di chiedere. Il polling è il caso
esemplare del guasto senza sintomo: se resta acceso quando non doveva, la
schermata è identica e corretta, la prova manuale passa, e l'unico segno è una
richiesta ogni cinque secondi su una connessione mobile finché la pagina resta
aperta. I casi contano i giri con i timer finti: continua finché qualcosa è in
movimento, non parte affatto su una lista di sole registrazioni ferme, e si
spegne *da solo* nel momento in cui l'ultima elaborazione finisce. Accanto, che
un errore lì non produca un avviso rosso in cima a una schermata che funziona, e
che eliminare chieda il secondo tocco.

Del dettaglio, quattro punti su cinquecento righe. È la schermata più lunga
dell'app e quasi tutto quello che contiene è un campo stampato accanto al suo
titolo: se sparisse si vedrebbe aprendo la pagina, e provarlo sarebbe scrivere
due volte lo stesso JSX. I casi stanno dove la schermata *decide* qualcosa e
dove una decisione sbagliata produce una pagina che sembra a posto.

Il primo è il gesto che butta via una voce, l'unico irreversibile
dell'applicazione: da lì partono due chiamate quasi identiche che fanno due cose
molto diverse, e la differenza fra «solo il vocale» e «il vocale e la scheda» è
un booleano invisibile sullo schermo — in tutti e due i casi la pagina si
ricarica e il vocale sparisce. Si guarda che il primo tocco apra la domanda
invece di eseguire, che ciascuno dei due pulsanti mandi il proprio valore, che
con tre vocali sotto la stessa scheda si cancelli quello su cui si è premuto e
non il primo della lista (ogni riquadro ha il proprio stato: se fosse uno solo,
l'errore non si vedrebbe in prova a mano, perché un vocale sparisce comunque), e
che dopo un `409` la scheda resti intera — nessuna sparizione ottimistica, o
l'utente crederebbe di aver cancellato ciò che è ancora lì.

Il secondo sono i tre pulsanti della §8. Sono tre rettangoli affiancati con tre
frasi corte, e mandano tre valori di un enum: dopo ognuno la pagina si ricarica e
torna uguale a prima, tranne un contatore e — per `CAMBIATA` — uno stato che
riporta la scheda in `DA_RIVEDERE`. Un pulsante che manda l'esito del vicino
produce quindi una schermata perfettamente funzionante che archivia il contrario
di quello che è successo, e se ne accorge solo chi rilegge la scheda mesi dopo.
Si guarda che il primo tocco apra la nota senza registrare niente — sono
bersagli grandi, pensati per essere premuti in piedi davanti a uno sportello,
cioè esattamente la situazione in cui si tocca quello sbagliato — che ognuno dei
tre mandi il proprio, che ripremerlo richiuda invece di registrare due volte, e
che la domanda sotto cambi con l'esito: «vuoi aggiungere qualcosa?» sotto «non ha
funzionato» è una domanda generica fatta all'unica persona che sa la risposta
specifica, nell'unico istante in cui ce l'ha in mente. Accanto, la nota vuota:
lo schema del server la accetta anche vuota, quindi una stringa vuota non viene
rifiutata — viene salvata, e la differenza fra «non ha lasciato una nota» e «ha
lasciato una nota vuota» non produce nessun errore da nessuna parte. E il
rifiuto, dove contano due cose insieme: che non ricarichi, e che non svuoti il
campo. Chi ha appena scritto tre righe su cosa è andato storto le ha scritte una
volta sola.

Il terzo sono le porte verso altrove. Redazione e revisione da questa schermata
in poi non hanno nessun altro ingresso, e il pulsante della redazione sta
**fuori** dal ramo del bollino apposta: il flag dice cosa ha pensato
l'estrazione, non cosa c'è nel testo, e una scheda corretta a mano dopo
l'estrazione non ci ripassa mai. Annidarlo dentro quel ramo toglierebbe la §9
esattamente alle schede su cui nessuno l'ha ancora fatta girare, e la pagina —
guardata — sarebbe identica.

Il quarto è ciò che porta fuori dall'app: `target="_blank"` con
`rel="noreferrer noopener"` sui riferimenti di tipo URL, che sono la stringa
meno fidata che questa schermata stampi — le ha scritte un modello ascoltando un
audio — e l'unica che diventa cliccabile. Senza `noopener` la pagina che si apre
può riscrivere `window.opener.location`, cioè cambiare sotto i piedi la scheda a
cui si torna indietro; senza `noreferrer` si consegna a un sito qualunque
l'indirizzo da cui si è partiti. Nessuna delle due cose ha un sintomo: il link
funziona. Accanto, che un riferimento di un altro tipo resti testo, perché un
`href` è l'unico posto di questa pagina in cui una stringa smette di esserlo.

Dell'ordine delle sezioni e delle formattazioni non si prova qui quasi niente:
sono funzioni pure in `format.ts` e hanno già il loro file. Resta un caso solo,
ed è l'unica cosa che una funzione pura non può dimostrare — che sia questa
schermata a chiamare `sezioniDi` invece di aver ricopiato l'ordine nel JSX. Un
JSX che elencasse le cinque sezioni a mano, che è come si scrive di solito,
passerebbe tutti i casi di `format.test.ts` mostrando i passi per primi.
Ventitré mutazioni provate su questo file, ventitré cadute.

Dell'elenco, il filtro di ambito e la paginazione. Né l'uno né l'altra si
rompono in modo visibile: una schermata che sbaglia a paginare mostra una lista,
che è esattamente ciò che ci si aspetta di vedere — solo che è la lista
sbagliata, oppure è vuota. E una lista vuota, qui, ha già un significato scritto
a schermo: «Qui non c'è ancora niente», che a chi ha ottanta procedure non dice
«difetto di paginazione», dice «hai perso l'archivio». I casi guardano che
passare a «Lavoro» dalla pagina due riparta dalla prima — restando all'offset 20
si chiederebbe la seconda pagina di un ambito che ne ha tre in tutto, e la
risposta vuota diventerebbe quella frase — che «Tutte» non si porti dietro
l'ambito di prima, che «Precedenti» sia spento sulla prima pagina e «Successive»
sull'ultima (accesi chiederebbero rispettivamente un offset negativo, che il
server rifiuta, e una pagina vuota), che la barra resti però disegnata
sull'ultima pagina, o da lì si tornerebbe indietro solo ricaricando, e che
sparisca del tutto quando l'archivio sta in una pagina sola. Nello stesso file,
due casi che non parlano di liste: che il pulsante «Account» nella testata porti
davvero all'account, e che quello «Cestino» in fondo porti davvero al cestino.
Sono le uniche due porte che esistono — la barra bassa ha tre voci e nessuna è
una di queste — e di là ci sono il cambio password, l'uscita e la cancellazione
definitiva: se una sparisse in una riscrittura, o navigasse altrove, quella
schermata tornerebbe irraggiungibile, che è lo stato esatto in cui la rotta del
cambio password è rimasta per un commit intero. Del pulsante del cestino c'è un
caso in più: che ci sia anche quando l'elenco è vuoto. Dentro il ramo che disegna
le schede — dove sta la paginazione, e dove sarebbe finito senza pensarci —
sparirebbe proprio a chi ha archiviato tutto e sta cercando dove sia finito
l'archivio, e «Qui non c'è ancora niente» diventerebbe l'ultima parola dell'app.

Del cestino, la conferma. È l'unica schermata da cui si perde qualcosa, e un
`deleteProcedureForever` partito per sbaglio non si vede, non dà errore e non si
annulla: il server ha una sola difesa — la scheda dev'essere già `ARCHIVIATA` — e
qui lo sono tutte. Quindi i casi contano le chiamate partite e non solo il testo
rimasto, perché un caso che guardasse soltanto la riga sparita passerebbe
identico contro una schermata che cancella al primo tocco. Che il primo tocco non
mandi niente al server; che il secondo cancelli *quella* riga, e che di pulsanti
rossi accesi ce ne sia uno solo — la conferma sta nella voce e non nella
schermata, o il tocco successivo cadrebbe su quella che capita per prima nel DOM;
che «Annulla» richiuda senza aver chiesto niente; e che dopo un `409` il rosso si
spenga, perché quel `409` significa che qualcuno ha ripescato la scheda da
un'altra schermata, e lasciarlo acceso inviterebbe a insistere su una cosa che
nel frattempo è diventata un'altra. Accanto, che «Ripristina» rimetta la scheda a
`DA_RIVEDERE` e non a `COMPLETA`: lo stato che aveva prima non è scritto da
nessuna parte, e «completa» è la sola delle due bugie che non si nota.

Dello svuotamento, il numero e ciò che resta a schermo. Il caso che conta di più
non guarda una riga sparita ma una frase: un cestino di trentaquattro schede con
venti per pagina deve far scrivere «Cancella 34 schede per sempre», e un caso che
si accontentasse di «Cancella» passerebbe contro una schermata che promette di
cancellarne venti e ne cancella trentaquattro. Poi le due metà del messaggio
d'esito, ognuna con il suo singolare e il suo plurale — «1 scheda cancellata» e
«3 schede cancellate», «1 scheda è stata ripristinata» e «2 schede sono state
ripristinate» — perché sono quattro rami di due ternari, e tre su quattro non si
vedono mai provando a mano. Zero e zero devono dire «era già vuoto» e non
«fatto». Accanto, quello che succede dopo: che l'elenco si rilegga davvero e
dalla prima pagina (gli offset delle richieste partite sono `[0, 20, 0]` se si
svuota stando alla seconda), che dopo un guasto del server il rosso si spenga e
il messaggio compaia, che un secondo tentativo cancelli l'errore del primo invece
di lasciarlo lì a contraddire l'esito appena arrivato, e che il rosso sia spento
mentre la richiesta è in volo — è il pulsante da cui si perdono trentaquattro
schede, e premerlo due volte non deve poter partire due volte.

Da quando c'è il tetto, tre casi in più, e sono i tre in cui `rimaste` cambia una
frase. Il primo è l'unico che separa due messaggi opposti a partire dagli stessi
due numeri: zero cancellate e zero saltate con tre ancora nel cestino **non** è
«era già vuoto». Il secondo è il ciclo che si è arreso — «restano 12 schede: premi
di nuovo per continuare», con il pulsante grigio che torna e quello rosso che no,
perché quella domanda ha già avuto la sua risposta. Il terzo è il singolare, che
qui cambia anche il verbo: «resta 1 scheda» e non «restano 1 schede», due rami di
due ternari annidati che un solo `String(n)` mancherebbe entrambi.

Della ricerca, quante volte parte. Ogni ricerca calcola un embedding, cioè una
chiamata a pagamento verso OpenAI, e i 300 ms di silenzio fra l'ultimo tasto e
la partenza sono l'unica cosa che separa una parola scritta da una richiesta. Se
sparissero, la schermata funzionerebbe *meglio* del solito — i risultati
comparirebbero prima — e il conto arriverebbe a fine mese moltiplicato per nove:
nessuna prova manuale lo vedrebbe. Il caso principale scrive «residenza» una
lettera alla volta e conta le chiamate: una. Accanto, che una lettera sola non
parta (il minimo dello schema condiviso è due, e mandarne una sarebbe un avviso
rosso comparso mentre si scrive), che gli spazi intorno non entrino nella
domanda, che svuotare il campo non faccia partire una ricerca vuota, e che
cambiare domanda riparta dalla prima pagina — restare all'offset 20 farebbe
scrivere «Non c'è altro per «passaporto»» a chi non ha ancora visto niente. Qui
i gesti si mandano con `fireEvent` e non con `userEvent`: i due non si mescolano
con i timer finti — React 18 pianifica su un `MessageChannel` che i timer finti
non toccano — e in questo file i timer finti non sono negoziabili, perché il
tempo *è* l'oggetto del test.

Del player dell'audio, `revokeObjectURL`. Un object URL non revocato non si
vede: la schermata è giusta, l'audio si sente, e intanto un blob di qualche
megabyte resta in memoria finché la scheda del browser non si chiude — dieci
schede aperte una dopo l'altra e su un telefono l'applicazione viene uccisa dal
sistema, il che si racconta come «si chiude da sola» e non assomiglia a nessuna
riga di codice. Lo sbaglio opposto, revocare troppo presto, lascia un `<audio>`
con un `src` che non punta più a niente. Quindi i casi non contano le revoche:
guardano *quando* avvengono e *quale* URL portano via. Che smontando si revochi
esattamente quello creato, e non un momento prima; che cambiando registrazione
il vecchio venga liberato invece di restare appeso sotto la scheda nuova; che
aprire una scheda non scarichi niente finché nessuno lo chiede (§3: sempre
accessibile, non sempre scaricato); e che il pulsante spento durante il download
impedisca il secondo tocco, che scaricherebbe di nuovo gli stessi megabyte
lasciando il primo blob in memoria senza che nessuno abbia più il suo URL per
revocarlo. `URL.createObjectURL` e `URL.revokeObjectURL` non esistono in `jsdom`
e vengono messe a mano: tengono l'elenco di ciò che hanno creato e revocato, che
è l'unico modo di dire che l'URL revocato è *quello* — chiamarla il numero
giusto di volte sull'oggetto sbagliato passerebbe qualunque conteggio.

Della registrazione, l'ordine di due righe. È la schermata più importante
dell'app e quella con meno cose dentro, e per anni è rimasta senza un caso
proprio perché *sembra* non decidere niente: un pulsante, un contatore, una
frase. In realtà decide cinque cose, e la prima vale da sola l'intero file.
`premi()` fa `await capture.stop()` e **poi** `navigate({ name: "lista" })`.
Quell'ordine è tutta la garanzia: se il salvataggio fallisce, l'eccezione salta
la navigazione e chi ha parlato resta qui, davanti all'avviso che spiega come
recuperare l'audio. Spostare la navigazione in un `finally`, o metterla prima
dell'`await` — che è come la si scrive quando si ottimizza la reattività —
produce una schermata che passa ogni prova manuale, perché a mano il
salvataggio riesce sempre, e che il giorno in cui il telefono è pieno porta
l'utente alla lista con aria soddisfatta mentre dieci minuti di parlato stanno
per essere raccolti dal garbage collector. Il caso non guarda un messaggio:
guarda che dopo un `stop()` fallito l'hash sia rimasto dov'era.

Le altre quattro sono l'avviso dello spazio e il microfono. L'avviso compare
**prima** di premere e sparisce a microfono acceso, perché a quel punto l'unica
cosa che può ottenere è far interrompere chi sta parlando: i due casi usano lo
stesso `spazio` e cambiano solo il momento, che è l'unico modo di dire che è il
momento a decidere. «Non lo so» non diventa «pieno» — Safari senza
`navigator.storage`, un contesto non sicuro, una `estimate()` che ha lanciato
sono tre modi di non sapere, e trasformarli in un avviso vorrebbe dire
spaventare chi lo spazio ce l'ha, su un intero browser, per sempre. E «pieno»
avvisa senza impedire: il caso verifica che il pulsante resti premibile e che
premerlo accenda davvero il microfono, perché un `disabled` aggiunto per
prudenza cancellerebbe la decisione scritta in `spazio.ts` — fra un avviso
sbagliato e una registrazione mai fatta, la seconda è la perdita peggiore.
Infine il microfono che manca: si dice, e non si mostra un pulsantone che non
farebbe niente, che sarebbe la peggiore delle due schermate.

Nello stesso file l'avviso dell'audio non salvato, che vive sopra ogni
schermata e ha una decisione sola: quale delle tre uscite mostrare. «Riprova a
salvare» c'è solo quando è mancato lo spazio, perché è l'unico caso in cui
premerlo può cambiare qualcosa — se IndexedDB non c'è proprio, riprovare
fallisce identico. Mostrarlo sempre non rompe niente: fa premere un pulsante
che fallirà ogni volta, con un audio che vive solo finché la scheda resta
aperta. I casi guardano i due versi, e poi che i tre pulsanti chiamino tre cose
diverse: due pulsanti collegati allo stesso gesto sono il modo più silenzioso
di perdere una registrazione, perché uno «Scarica» che scarta non lascia
traccia. E che senza niente da salvare il riquadro **non esista** nel DOM — si
guarda il contenitore e non i pulsanti, per la ragione imparata sul cestino: un
riquadro vuoto con il suo bordo disegna una riga in cima all'applicazione che
nessuno collega a una riga di codice.

Per arrivarci, due cose sono esportate apposta. `CaptureContext`, perché
`CaptureProvider` costruisce da sé un `MediaRecorder`, un GPS e un IndexedDB, e
montarlo vorrebbe dire tre finti di hardware per provare che un pulsante cambia
etichetta; con il contesto in mano il test passa alla schermata un `Capture`
scritto a mano, che è esattamente ciò che la schermata vede. E `NonSalvata`,
che sta dentro `App` perché deve comparire sopra qualunque pagina, ma le cui
decisioni sono sue: raggiungerle passando da `App` avrebbe richiesto prima una
sessione, un router e un client. Il finto della cattura lancia sui metodi non
insegnati come quello dell'API, con una differenza che vale la pena sapere —
`premi()` ha un `try/catch`, quindi un `stop()` non insegnato non fa esplodere
il test: finisce nell'avviso rosso della schermata, cioè in uno degli stati che
i casi verificano di proposito. Per questo il messaggio dice di chi è la colpa.
Ventitré mutazioni provate su questo file, ventitré cadute.

Della revisione — che nonostante il nome non ha niente a che vedere con i
duplicati: è la schermata che chiude una scheda `DA_RIVEDERE` — undici casi su
venti guardano l'oggetto che finisce nel `PATCH`, e non ciò che si vede in
pagina. È lì che stanno le decisioni. `steps` è una sostituzione e non
un'aggiunta, quindi la nota facoltativa deve partire insieme a tutti i passi che
c'erano già: mandare il solo passo nuovo cancella in silenzio tutto ciò che
l'utente aveva raccontato, e la schermata dice «salvato». Il titolo entra nel
corpo solo se è cambiato davvero, e un campo svuotato per sbaglio non diventa un
`titolo: ""` — il titolo è il solo modo di ritrovare la scheda in elenco. Lo
stato lo manda un pulsante e non l'altro, che è tutto ciò che distingue «segna
come completa» da «lasciala da rivedere». E quando non c'è proprio niente da
salvare, «lasciala da rivedere» non manda un `PATCH {}`, che sarebbe un 400 di
validazione mostrato a chi ha appena premuto «non ho niente da aggiungere»; ma
quella scorciatoia non deve valere per l'altro pulsante, o «completa» non
segnerebbe niente proprio nel caso in cui è l'unica cosa da segnare.

Gli altri nove casi: che le domande arrivino da **tutte** le registrazioni e non
solo dalla prima — `_meta` non è una colonna della scheda, vive nell'estrazione,
e una scheda nata da tre vocali ha tre incertezze diverse — che una
registrazione ancora senza estrazione non zittisca le domande delle altre, e che
una registrazione che non si carica fermi la schermata invece di aprire un
modulo con metà dei suggerimenti: una revisione a cui manca metà
dell'incertezza si presenta come una revisione completa, e chi la chiude con «Va
bene così» non saprà mai cosa non gli è stato chiesto. Poi il verso opposto, che
è quello che si dimentica: quando le domande ci sono, la riga asciutta dei campi
incerti **non** compare anche lei. E infine il rifiuto del server: l'avviso
appare e non si naviga, perché il passo appena scritto vive solo in quello
`useState`; i tre pulsanti tornano premibili, perché senza il `finally` un
errore lascerebbe la schermata da ricaricare; e mentre il `PATCH` è in volo sono
spenti tutti e tre, perché due salvataggi identici sono due passi identici in
coda alla scheda, e da quella schermata non si tolgono.

Della riga che compare in elenco e in ricerca — il componente più piccolo con un
file di test tutto suo — la ragione del file è che è la stessa riga in due
schermate, quindi ogni suo difetto è un difetto in due posti. Il caso che conta è
dove porta: l'id nell'hash è l'unico modo che l'utente ha di arrivare alla
scheda, e mandare l'indice invece dell'id, o dimenticare la codifica, produce una
riga che si preme, una pagina che si apre, e la scheda sbagliata. Accanto, le tre
condizioni che decidono cosa mostrare: il contenitore dei bollini non esiste
quando non c'è niente da segnalare — ha una spaziatura sua, e vuoto lascerebbe un
buco in mezzo a ogni riga dell'elenco — la riga di mezzo salta i campi che mancano
invece di scrivere `3 passi ·  ·  · · 2 mesi fa`, e «Dati sensibili» compare solo
su chi ce li ha, perché un avviso di dati sensibili su ogni riga smette di voler
dire qualcosa entro il secondo giorno. Ciò che i bollini e la riga di mezzo
*scrivono* non si riprova qui: `badgesOf`, `formatDurata`, `formatCosto` e
`formatQuando` sono funzioni pure e hanno il loro file fra i test unitari.
Ventinove mutazioni provate su questi due file, ventinove cadute.

Il finto dell'API lancia su ogni metodo non insegnato, col proprio nome dentro:
un finto che risponde a tutto con valori plausibili avrebbe fatto passare una
schermata che chiama la rotta sbagliata. Il lancio è sincrono e non una promessa
rifiutata, perché una promessa rifiutata diventerebbe un avviso rosso in pagina,
cioè uno degli stati che questi test verificano di proposito.

Nessuna schermata resta ormai senza casi, il che non vuol dire che siano provate
— la differenza è scritta per esteso fra i difetti noti — e accanto a loro c'è
la ragione per cui `format.ts`, `routes.ts`, `uploader.ts`,
`salvataggio.ts` e `spazio.ts` esistono come moduli
separati e privi di DOM: lì sta il resto di ciò che si può sbagliare in
silenzio, e provarlo senza montare niente costa mille righe di test che girano
in un secondo. `tsconfig.tests.json` continua a non caricare la libreria DOM —
`tests/web/` è escluso e ha il proprio `tsconfig.tests.web.json` — così un
modulo puro che cominciasse a nominare `window` non sarebbe più importabile dai
test unitari, e la separazione non può marcire in silenzio.

Fra i test unitari c'è anche `deploy.test.ts`, che non prova codice ma i tre file
di configurazione del deploy. `netlify.toml` è eseguibile solo dalla piattaforma,
quindi ogni nome che contiene è una promessa verificata al primo deploy e non
prima: uno script `npm run` che non esiste, un `publish` che non è la `outDir` di
Vite, un `for = "/sw.js"` per un file che è stato rinominato. Sono tutti errori
che vivono in un file solo e si scoprono su una macchina lontana. Il test li
riporta a casa: legge i tre `.toml` con un lettore scritto per l'occasione — una
dipendenza TOML per cinquanta righe che abbiamo scritto noi sarebbe stata
sproporzionata — e controlla che i nomi citati esistano da questa parte. Include,
come `guards.test.ts`, un blocco che prova la guardia stessa: senza, un lettore
rotto renderebbe vera ogni asserzione della forma «tutti gli elementi sono
validi».

Sui due `railway.toml` lo stesso test dice **meno di quanto sembri**, da quando
Railway ha deprecato config-as-code: quei file non li esegue più nessuno, e i
valori veri stanno nelle impostazioni dei servizi. Il rosso qui continua a
proteggere da un `healthcheckPath` che nessuna rotta serve o da un `node
apps/api/dist/index.js` che il `tsc` non produce più — che è ciò che serve,
perché quei file adesso sono la fonte da cui qualcuno *ricopia* — ma non dice
più che sia quello il comando in produzione. Il confronto fra questi file e il
pannello nessun test lo fa, e sta fra i difetti noti.

**integration** applica le migration su `DATABASE_URL_TEST`, poi verifica lo
schema fisico contro il catalogo di Postgres, esegue il seed vero e ricontrolla
le invarianti, e prova autenticazione e ingestione end-to-end su HTTP reale —
l'app gira su una porta effimera e ci si parla con `fetch`, che è il motivo per
cui `supertest` non è fra le dipendenze.

Dello scollegamento degli altri dispositivi si prova ciò che il repository in
memoria non può dire. La `where` è fatta di tre pezzi — l'utente, la famiglia
*diversa* da quella che chiama, il token non ancora revocato — e ognuno dei tre,
tolto, produce un danno che in memoria si riprodurrebbe soltanto perché il finto
è scritto uguale. Senza `userId` cadono le sessioni di tutti; senza il `not` cade
anche la propria, cioè il contrario del gesto; senza `revokedAt: null` il conto
include sessioni chiuse la settimana scorsa, e la risposta mente su un numero che
la schermata stampa. I casi guardano quindi da Postgres: che access e refresh
token di chi chiama funzionino ancora dopo la chiamata, e che continuino a
funzionare anche se quella famiglia ha ruotato nel frattempo — è la famiglia a
essere risparmiata, non il singolo token che si aveva in mano; che le righe già
revocate mantengano il `revokedAt` che avevano, letto prima e riletto dopo; che
le righe revocate restino invece di sparire, perché sono loro a far scattare la
reuse detection; e che l'utente accanto non perda niente. Accanto, i due rifiuti
che devono lasciare tutto in piedi — password sbagliata e access token assente —
e i due corpi malfatti, di cui il secondo esiste solo per lo `.strict()` dello
schema.

Le mutazioni provate su questo blocco sono ventitré e cadono tutte: i tre pezzi
della `where`, il `not` invertito, una `deleteMany` al posto della `updateMany`,
la famiglia scambiata con lo userId nel servizio, `requireAuth` che dimentica di
mettere il `fid` in `req.auth`, ciascuno dei due middleware tolto dalla rotta, lo
`.strict()` dello schema, e sette sulla schermata. A tenerle in piedi
concorrono file di tre project diversi, il che è anche il modo più economico di
dire che questo gesto attraversa tutta l'applicazione: un middleware, un
servizio, una riga di SQL e tre frasi in italiano.

Dell'elenco delle sessioni si prova da Postgres ciò che il repository in memoria
rifà a mano. Due cose, e sono proprio le due: il `groupBy` con `_min`, cioè
l'aggregazione che distingue la nascita di una famiglia dalla sua ultima
rotazione — in memoria è un `for` con un confronto, nel database è la query che
decide se l'app racconta «da quando sei collegato» o «quando lo hai usato
l'ultima volta» — e il routing, perché `GET /sessions` e `POST /sessions/revoke`
condividono un prefisso e chi decide se si pestano i piedi è Express, che nei
test unitari non c'è. I casi: due login danno due righe e una sola è `current`;
un `refresh` non aggiunge una terza riga e **non sposta la data**, che è il caso
che tiene in piedi tutta la scelta (contarle invece di raggrupparle farebbe
comparire un dispositivo in più a ogni quarto d'ora di uso); dopo
`sessions/revoke` la lista si accorcia davvero, perché le righe revocate restano
nel database e devono sparire da qui; l'utente accanto non compare. E l'ordine,
che nel `groupBy` non esiste: il dispositivo di chi chiede è il primo dei tre a
essersi collegato, quindi deve risultare **ultimo**. La risposta si legge con lo
schema `.strict()` e non a mano, che è ciò che farebbe fallire il caso se un
giorno uscisse dal servizio un quarto campo. In fondo, le combinazioni sbagliate
di verbo e percorso — `GET /sessions/revoke`, `POST /sessions`,
`GET /sessions/revoke-one` e `POST /sessions/<id>/revoke` devono dare 404 tutte e
quattro — perché la più pericolosa sarebbe la prima: se l'elenco fosse scritto
come `/sessions/:qualcosa`, leggerlo potrebbe finire su un gestore che revoca.
L'elenco è cresciuto insieme alle rotte, ed è cresciuto apposta: è il caso che si
rompe per primo il giorno in cui qualcuno aggiunge la quarta.

Le mutazioni su questo blocco sono ventiquattro e cadono tutte: tre sul servizio
(`current` sempre vero e sempre falso, la data buttata via), quattro
sull'adattatore Prisma (le famiglie chiuse, le sessioni di tutti, il minimo preso
sulla sola riga viva, l'ordine invertito), quattro sul doppio in memoria, tre sul
client, una sul contratto, due sulla rotta e sette sulla schermata. Due sono
dovute essere scritte doppie: togliere lo `userId` da una sola delle due
interrogazioni non cambia niente, perché a filtrare resta l'altra — la mutazione
sopravviveva senza dire niente di vero sui test, e il difetto vero è
dimenticarlo in tutti e due i posti.

Della chiusura di **una** sessione si prova contro Postgres la sola cosa che in
memoria non si potrebbe: che il `WHERE` a tre parti sia scritto in SQL come
nell'idea. Due login veri, il secondo chiuso dal primo, e poi le due metà del
caso — il refresh token appena chiuso non funziona più, e quello di chi ha
chiamato **sì**. È l'errore opposto di quello che si teme, e da solo vale quanto
l'altro: un `WHERE` senza `familyId` chiuderebbe tutto, compreso chi sta
premendo, e la risposta direbbe lo stesso `revoked: 1`. Accanto, la famiglia di
un altro utente: rispondere `0` non basta: il caso va a leggere che la sessione
dell'altro sia ancora viva, perché `0` lo direbbe anche un `WHERE` che ha
cancellato tutto e non ha trovato più niente da contare. Poi il `409` sulla
propria famiglia, con la riga che resta viva; la password sbagliata, che dà `401`
e non revoca nessuna riga — contate prima e ricontate dopo; e una famiglia già
chiusa, che risponde `0` senza spostare il `revokedAt` che aveva, perché è il
`revokedAt: null` del `WHERE` a impedire che il numero menta.

Le mutazioni di questo blocco sono trentatré e cadono tutte. Nove stanno sul
`WHERE` e sul servizio, e cinque di quelle sono state scritte **doppie** apposta:
il filtro a tre parti è scritto due volte — nell'adattatore Prisma e nel doppio
in memoria — e toglierne una copia sola lascia in piedi l'altra suite, che è il
modo in cui una precauzione duplicata finisce per non essere provata da nessuna
parte. Accanto alle doppie ci sono le singole sul solo Prisma, che servono a dire
che anche l'integrazione da sola le vede. Le altre: la verifica della password
tolta e poi resa inerte, l'ordine fra verifica e `409` invertito, il `409` che
diventa un 200, l'utente sparito che smette di essere un 401, la famiglia
scambiata con la propria, il `Clock` scavalcato, l'`id` che smette di uscire
dall'elenco, i due middleware tolti dalla rotta, il percorso cambiato, lo
`.strict()` e i due `.min(1)` dello schema, il percorso e l'`auth` del client, e
dieci sulla schermata — fra cui `key={indice}`, `type="submit"` e il booleano
condiviso al posto dell'id in volo.

L'end-to-end delle registrazioni carica un multipart vero e poi esegue
`ingestionService.processNext()` in-process, sulle **stesse istanze** che servono
le richieste HTTP: un secondo `compose()` per i test avrebbe programmato provider
fake che nessuna richiesta usa. Quattro cose si possono verificare solo lì: che
`Response.formData()` regga un corpo multipart vero, che il `<=>` di pgvector
serva davvero la deduplicazione, che `@@unique([procedureId, ordine])` non
esploda sui passi rinumerati, e che il filtro del backoff sia scritto giusto —
una registrazione appena caricata ha `nextAttemptAt` a `null`, e in memoria un
`null` si confronta come ci si aspetta mentre in SQL no.

La cancellazione ne aggiunge una quinta, ed è la sola che possa smentire il
disegno: che una `DELETE` su `Recording` non si porti via la `Procedure` che
quella riga nominava. La chiave esterna sta sul lato sbagliato per potersene
rassicurare a mente, e in memoria «la scheda sopravvive» sarebbe vero solo
perché il finto repository l'ha lasciata stare. Lì è Postgres a dirlo.

**La cancellazione definitiva è quasi tutta schema, e lo schema in memoria non
c'è.** `procedures.service.test.ts` prova già le tre risposte — `204`, `409`,
`404` — con un repository che vive in una `Map`. Quello che non può provare è
l'unica cosa che qui fa danno: che cosa resta nel database dopo. I figli
spariscono per un `onDelete: Cascade` che nessuna funzione TypeScript nomina;
`Recording.procedureId` e `Recording.duplicateOfId` invece sono `SET NULL`, cioè
la riga resta e resta con un buco. È quel buco l'oggetto dei casi: un vocale a
cui è stato azzerato `procedureId` non è un vocale libero, è un `ESTRATTO` che
`listPending` filtra via e che si apriva solo dalla scheda che non c'è più —
contiene la trascrizione, cioè le frasi dette, e nessun gesto dell'applicazione
può più raggiungerlo. Si prova quindi che i vocali della scheda spariscano con
lei e i loro byte dal bucket; che quelli di *un'altra* scheda restino, audio
compreso, perché un `procedureId` dimenticato nella `where` li porterebbe via
tutti; e che il sospetto duplicato torni a `BOZZA_AUDIO` invece di restare
appeso al nulla. Accanto, le due risposte che non cancellano — il `409` su una
scheda viva, verificando che non sia stata sfiorata, e il `404` della seconda
passata — e i due casi della query: `?definitivo=0` archivia come sempre,
`?definitivo=vero` è un `400`.

Un difetto di questi casi è scritto qui perché le mutazioni lo hanno trovato e
non c'era modo di chiuderlo. I controlli sullo stato sono due — quello letto
prima e quello dentro la `where` della `deleteMany` — e si coprono a vicenda:
tolto uno solo, tutti i casi passano lo stesso. Tolti tutti e due insieme, il
`409` cade. Il secondo esiste per la corsa che il primo non può vedere, cioè
qualcuno che ripesca la scheda dal cestino fra la lettura e la cancellazione, e
una corsa non si mette in scena in un test end-to-end su una connessione sola.
Resta quindi una riga che nessun caso difende da sola, ed è voluta.

**Lo svuotamento aggiunge una `where` in più da sbagliare.** L'elenco degli id
archiviati è l'unica query nuova, e ha due filtri che in memoria si direbbero
uguali fra loro: senza `status` porta via anche le schede vive, senza `userId`
porta via il cestino di tutti. Il secondo è il difetto peggiore che questo
progetto possa avere, e un repository finto non lo troverebbe mai, perché lì
dentro gli utenti sono chiavi di una `Map` che il test ha scritto. I casi sono
quindi quattro: che le vive restino, che il cestino dell'altro utente non venga
sfiorato — contato riga per riga da Postgres, non dalla risposta — che figli,
vocali e byte nel bucket spariscano per *ognuna* delle schede e non solo per la
prima, e che un cestino vuoto risponda `200` con tre zeri. Accanto, i quattro
modi di scrivere male la richiesta, che sono `400` e devono lasciare tutto dov'è:
`status=COMPLETA`, `definitivo=0`, i parametri assenti, e `DELETE
/api/procedures/` con l'id vuoto — quest'ultimo è il motivo per cui i parametri
esistono, e senza un caso che lo fissi nessuno saprebbe più perché.

Il tetto per richiesta ha lì il suo caso, ed è l'unico posto in cui si vede
lavorare il `take` che arriva fino alla `findMany`. Un cestino di
`EMPTY_TRASH_BATCH_SIZE + 6` schede risponde alla prima chiamata con
`cancellate` pari al tetto e `rimaste: 6`, alla seconda con `6` e `rimaste: 0`.
In memoria questo caso passerebbe anche con il `take` buttato via prima di
arrivare a Prisma, perché il repository finto taglia la lista da sé. Quelle
schede si scrivono con una `createMany` diretta invece di passare dalla pipeline
— che è la regola di quel file — e il commento accanto lo giustifica: qui si
contano righe e non contenuti, e cinquantasei ingestioni vere sarebbero un
minuto di attesa per provare un `LIMIT`.

Le mutazioni provate sul tetto e sul ciclo sono ventitré, distribuite su quattro
pacchetti: dieci sul client (ognuna delle due uscite del ciclo tolta da sola, il
ciclo ridotto a una passata sola, il ciclo senza tetto, i totali che smettono di
sommarsi, `rimaste` sommato invece che sostituito, l'uscita che guarda solo le
`cancellate`), due sul contratto, tre sul servizio, quattro sull'adattatore
Prisma e quattro sulla schermata. Ventidue cadono. Delle due che sopravvissero al
primo giro vale la pena dire cosa è successo, perché sono due casi diversi e
hanno richiesto due cure diverse.

La prima era un difetto vero: `EMPTY_TRASH_BATCH_SIZE` portato da cinquanta a
mille non faceva cadere niente, cioè si poteva rimettere esattamente il problema
che questo lavoro esiste per togliere. Sopravviveva perché ogni caso sul tetto usa
la costante **simbolicamente** — `EMPTY_TRASH_BATCH_SIZE + 6` schede, `cancellate`
pari alla costante — e questo è giusto, altrimenti cambiarla vorrebbe dire
riscrivere i test. Ma un test scritto così non difende il *valore*: si muove
insieme a lui. La cura non è incollare un `toBe(50)`, che sarebbe una tautologia
da aggiornare a ogni ripensamento, ma una guardia sull'intervallo — fra dieci e
cento — con scritto accanto perché esistono i due estremi: sopra, il timeout del
proxy che è la ragione di tutto il lavoro; sotto, un numero di andate e ritorni
che costerebbe più del problema.

La seconda sopravvive ancora, ed è **equivalente**: l'`orderBy: { updatedAt:
"asc" }` di `listArchivedIds` girato in `"desc"` non cambia nessun risultato
osservabile. Per lo svuotamento a più passate serve solo che un ordine ci sia,
perché la seconda richiesta non ripresenti le stesse righe; la direzione la decide
un'altra ragione, e nessun test la distingue. Il commento sopra quella riga
diceva più di quanto fosse vero, ed è quello che è stato corretto: non si è
aggiunto un caso per far cadere una mutazione che non descrive nessun difetto.

**La scopa ha un file suo, e nasce da un buco che era scritto qui sotto.**
`storageSweep.test.ts` prova trenta casi in memoria: le tre regole, le pagine, i
blocchi, l'interruzione a metà. Tutti veri, e tutti ciechi sulla stessa cosa —
in quei test le chiavi le scrive il test, quindi il repository finto risponde
«questa la conosco» perché gliel'ha messa dentro chi lo interroga. La domanda
che conta non gliela fa nessuno, ed è se `findExistingAudioKeys` riconosca le
chiavi che `recordings.service.ts` ha davvero scritto. In mezzo ci sono un `IN
(...)` su `Recording.audioUrl`, una colonna di Postgres e la stringa
`${userId}/${randomUUID()}.${est}` costruita al caricamento: un prefisso di
troppo, una normalizzazione, uno `stored.url` salvato al posto di `stored.key`,
e la risposta diventa l'insieme vuoto. Non un errore — l'insieme vuoto, che per
la regola 1 significa «nessuna riga lo nomina», cioè orfano, cioè da cancellare:
ogni audio vivo del sistema, tutto insieme. Il file carica audio dall'HTTP come
farebbe l'app, non costruisce nessuna chiave a mano, e poi passa la scopa con
`cancella` acceso. Oltre a questo prova due cose che solo Postgres può dire: che
`findExistingAudioKeys` *non* filtri per utente — è l'unica query del progetto a
non farlo, sembra una dimenticanza, e diventarlo cancellerebbe tutti gli archivi
tranne uno — e la corsa che la soglia esiste per non perdere, cioè l'istante fra
il `put` e la riga in cui l'audio di qualcuno è indistinguibile da spazzatura, con
la data dell'oggetto scritta dal caricamento vero e non scelta dal test.

**L'altra metà di quel buco è il bucket, e da lì nascono due file.** Quel test
mise sotto la scopa un Postgres vero e lasciò in memoria lo storage; il che vuol
dire che `S3StorageProvider` — trecento righe, una firma SigV4 scritta a mano e
un XML da interpretare — era l'unico pezzo di produzione che nessun test
eseguiva. La firma aveva i suoi casi contro i vettori ufficiali di AWS, e
`storageList.test.ts` leggeva XML battuto a macchina: fra i due non passava mai
una richiesta HTTP. Adesso `docker-compose.yml` ha un MinIO, e passa.

`storage.s3.e2e.test.ts` prova il provider da solo, contro il bucket. I byte
tornano identici — `0x00` e `0xFF` compresi, che è il modo di accorgersi che
qualcuno li abbia fatti passare per una stringa; `exists` risponde in tutte e due
le direzioni; una chiave con spazi, parentesi e un `+` sopravvive al giro, ed è
il caso in cui l'`encodeKey` scritto a mano si separa da `encodeURIComponent`;
`get` su una chiave che non c'è rifiuta invece di restituire zero byte, mentre
`delete` sulla stessa chiave non si lamenta, perché cancellare ciò che non esiste
è il risultato voluto. Poi le tre cose che solo un servizio vero sa fare storte:
che il prefisso di `list` tagli **caratteri e non segmenti di percorso** —
`utente-uno` seleziona anche `utente-uno-bis/`, e chi lo dimenticasse
costruirebbe una scopa che cancella l'archivio del vicino; che oltre il migliaio
di oggetti arrivi un `continuationToken` vero, opaco e in base64, e che
rimandandolo indietro si ottenga il resto senza doppioni; e che un bucket
inesistente o una chiave segreta sbagliata **rifiutino** invece di somigliare a
un bucket vuoto, che è la differenza fra accorgersi di una configurazione rotta e
passare una scopa su un elenco vuoto.

`sweep.s3.e2e.test.ts` rimette la scopa sopra quel bucket. Il caso che vale il
container è l'ultimo: **il segnalibro dopo una cancellazione.** Il servizio
cancella blocco per blocco *mentre* scorre, e il commento che lo giustifica dice
che si può fare perché il segnalibro «dice dopo quale oggetto riprendere e non a
quale posizione» — vero per il protocollo, mai verificato contro qualcuno che lo
implementi. La seconda pagina si chiede con un segnalibro costruito sull'ultima
chiave della prima, e quella chiave a quel punto è stata cancellata da un
istante. Se il servizio rispondesse con una pagina vuota, la passata annuncerebbe
di aver finito: nessun errore, nessun conteggio strano, solo un bucket che non
smette di crescere. Il caso mette milleuno oggetti, di cui uno vivo e ordinato
per ultimo, e conta. Accanto, che l'orfano non sia solo *contato* — `cancellati:
1` dice che la chiamata non ha lanciato, `exists` dice che i byte non ci sono
più — che l'audio vivo si riscarichi dalla rotta da cui lo chiederebbe l'utente,
e che un file estraneo messo nel bucket da qualcun altro sopravviva alla regola
3.

La regola 2 resta invece a `sweep.e2e.test.ts`, e non per pigrizia: invecchiare
un oggetto è un potere che `FakeStorageProvider` ha — `touch()` — e un bucket
vero non dà a nessuno, perché la data la scrive il servizio. Per lo stesso motivo
il file S3 lavora con una grazia **negativa**: la data la scrive MinIO dentro il
container e la soglia la calcola il test fuori, sono due orologi, e con
`graceMs: 0` mezzo secondo di scarto renderebbe «troppo recente» un oggetto
appena scritto un giorno su dieci.

Le mutazioni provate su questi due file sono ventidue e cadono tutte: sette sulla
firma — l'host senza la porta, la query canonica non ordinata,
`x-amz-content-sha256` fuori dalle intestazioni firmate, lo scope con la data
intera al posto del giorno, `encodeKey` che codifica anche le barre, un
`uriEncode` che si accontenta di `encodeURIComponent`, path style e virtual
hosted scambiati — otto sul provider — `put` che dichiara zero byte, `get` che
restituisce byte vuoti invece di lamentarsi, `exists` che dice sempre di sì,
`delete` che non chiama nessuno, i due versi della tolleranza ai 404, `list` che
ignora il prefisso, il segnalibro, o che chiede la versione 1 dell'elenco — tre
sulla scopa, e due sulla guardia che impedisce alla suite di svuotare il bucket
di sviluppo.

Una di quelle ventidue ha lasciato un segno nel codice. Con `delete` ridotta a
un no-op, `svuotaIlBucket` — il `resetDatabase()` del bucket — girava per sempre:
la pagina successiva riportava le stesse chiavi. La mutazione moriva lo stesso,
ma dopo trentaquattro minuti invece dei quaranta secondi delle altre. Adesso
quel ciclo ha un tetto di venti scorse e un messaggio che dice cosa significa
superarlo, e la stessa mutazione muore in quattordici secondi.

L'end-to-end della ricerca costruisce le schede facendole passare per la pipeline
vera invece di scriverle con `prisma.procedure.create`: è l'unico modo perché
`searchText` e l'embedding siano davvero popolati come in produzione. Prova le
cose che nessun test in memoria può provare — che «tabaccheria», parola presente
solo dentro un passo, trovi la scheda; che «credenziale» trovi «credenziali»,
cioè che il dizionario sia `italian` e non `simple`; che una query con parentesi
spaiate non faccia `500`. Il canale semantico lì tace, perché il
`FakeEmbeddingProvider` produce vettori quasi ortogonali: un test scrive a mano
nella colonna l'embedding della query stessa, così il percorso SQL semantico —
indice, cast, pavimento, fusione — resta comunque esercitato.

Lì sta anche l'unico test che può smentire la paginazione. Che il servizio tagli
la classifica dove deve lo dice il test in memoria; che la classifica sia *la
stessa* fra una richiesta e l'altra lo può dire solo Postgres. Cinque schede,
tre pagine da due, e si conta l'unione: se l'ordine dei canali non fosse
deterministico, o se la finestra dipendesse ancora da `limit`, una scheda
comparirebbe due volte e un'altra nessuna. Le cinque si creano in serie e non in
parallelo, perché `updatedAt` è ciò che rompe i pareggi di `ts_rank_cd` e cinque
scritture concorrenti se lo giocherebbero a caso — rendendo non ripetibile
proprio la cosa che il test misura.

La redazione ha lì il suo test che conta: crea una scheda con un codice fiscale
nel titolo, la cerca e la trova, redige, ricerca di nuovo e si aspetta zero
risultati. In memoria sarebbe passato comunque, perché in memoria non esiste un
indice da lasciare indietro. È l'unico modo di accorgersi che una scheda ripulita
sia rimasta cercabile per il dato che le è stato tolto — cioè del solo bug che
renderebbe l'intera funzione una bugia.

La metà assistita ha un file suo, `redaction.e2e.test.ts`, e non un `describe`
dentro gli altri: gira solo con `REDACTION_PROVIDER=fake`, e accenderla per tutti
avrebbe fatto passare da un finto modello anche i test che non c'entrano nulla.
Prova tre cose che i test in memoria non possono nemmeno sfiorare. Che
`compose()` monti davvero il provider quando la variabile lo dice — il primo
`beforeAll` asserisce di avere per le mani un `FakeRedactionProvider`, e l'ultimo
`describe` avvia un secondo server con la configurazione di default per
verificare che lì sia `undefined` e che la risposta dica `NON_CONFIGURATA`. Che
`origine` e `assistenza` sopravvivano al giro in JSON, cioè che il contratto
condiviso e il codice del server stiano dicendo la stessa cosa. E che una
conferma assistita arrivi fino alla `PATCH`: il titolo diventa `Pratica di
[nome]`, e subito dopo la ricerca su quel nome non trova più niente. Sono le
stesse tre righe della metà deterministica, applicate alla metà che non ha un
checksum a difenderla.

Il CORS si prova lì e non con un finto oggetto request, pur non toccando il
database: le cose che si rompono sono cose dello stack — un preflight che
attraversa il parser JSON e muore su un corpo vuoto, un `OPTIONS` che finisce nel
gestore delle rotte inesistenti, un'intestazione impostata dopo che la risposta è
già partita. Nessuna si vede chiamando la funzione middleware a mano.

Vale lo stesso per `security.e2e.test.ts`: che `req.ip` esista davvero dietro
Express, che il `429` esca dall'error handler con il corpo del contratto invece
che come stack, che il middleware sia montato sulle rotte giuste e non su tutte,
e — il test che conta più degli altri — che un `X-Forwarded-For` inventato non
compri un budget nuovo. Accanto a quello ce n'è uno gemello, ed è il caso che
tiene in piedi la scelta dell'id nel corpo: quattro richieste a
`/sessions/revoke-one` con **quattro `sessionId` diversi** devono condividere lo
stesso secchiello, e la quarta è un `429`. Con l'id nel percorso quel caso
fallirebbe, ed è il solo modo di accorgersene senza rileggere `rateLimit.ts`.
Ogni test riparte da un server nuovo, perché i conteggi stanno in memoria di
processo e `resetDatabase()` non li tocca.

`client.e2e.test.ts` è il file che chiude la distanza fra le due metà della
suite. Fino a lì i test web premevano i pulsanti davanti a un `ApiClient` finto e
questi parlavano HTTP vero con un `fetch` scritto a mano in `helpers/server.ts`:
fra le due c'era soltanto un tipo TypeScript, e un tipo non attraversa la rete.
Il pezzo che nessuno eseguiva era proprio `packages/shared/src/api/client.ts` —
le ottocento righe che compongono le intestazioni, ruotano i token su un `401`,
validano le risposte con Zod e scrivono nel deposito sicuro. I suoi test unitari
lo provano davanti a un `fetchImpl` finto, cioè provano la logica e non il
contratto.

Qui il client è quello vero e il server è quello vero, in-process. Ogni caso si
costruisce il proprio client da una fabbrica che installa sempre un `fetchImpl`
che non sostituisce niente: chiama `fetch` e registra ciò che passa. Registrare
sempre, e non solo nel blocco che verifica le intestazioni, è la differenza fra
provarle su una richiesta e provarle su tutte quelle che il file fa partire.

Il `401` non si aspetta, si provoca: il minimo di `ACCESS_TOKEN_TTL_MIN` è un
minuto, e un test che dorme un minuto è un test che qualcuno toglie. Si
costruisce invece lo stato esatto in cui l'applicazione si trova dopo un riavvio
del browser — refresh token nel deposito, memoria vuota — e si chiama una rotta
autenticata. Il ramo che conta di più però è quello opposto, ed è quello che di
solito manca: non tutti i `401` parlano della sessione. Su `/api/auth/password`,
`/sessions/revoke` e `/sessions/revoke-one` «credenziali non valide» significa «hai sbagliato
a digitare», e il token con cui la richiesta è partita è vivo. Trattarlo come gli
altri farebbe ruotare per niente e poi, al secondo rifiuto identico, svuoterebbe
la sessione: butterebbe fuori dall'account proprio chi lo stava proteggendo. Il
caso lo verifica contando le richieste registrate — zero verso
`/api/auth/refresh` — invece di guardare solo l'errore che torna.

Nello stesso blocco c'è l'unico caso che spende un valore letto da una risposta
per costruire la richiesta dopo: si legge `GET /sessions`, si prende l'`id` di
una riga e lo si passa a `revokeSession`. Davanti a un `fetch` finto quell'id
sarebbe una stringa qualunque scritta due volte nello stesso file; qui è il
`familyId` che il servizio ha davvero messo nella risposta, e il caso fallisce
se i due capi del contratto smettono di parlare dello stesso campo.

Il giro della scheda è un `it` solo, lungo, e non dodici corti. Ogni passo dipende
dallo stato che il precedente ha lasciato sul server: `retry` vuole una
registrazione ancora in `BOZZA_AUDIO`, i byte si scaricano finché sono nel bucket,
l'esecuzione si registra finché la scheda non è archiviata, la redazione si
applica finché nessuno ha toccato il testo. Spezzarlo vorrebbe dire ricostruire
quello stato con chiamate diverse da quelle che si stanno provando — cioè provare
il ponte costruendo il ponte con qualcos'altro. I due vincoli d'ordine che
fanno più male hanno anche il loro caso dal verso opposto: un'esecuzione su una
scheda archiviata è un `409`, un `retry` su una registrazione già diventata
scheda è un `404`. Senza quei due, «prima di archiviare» resterebbe un commento
invece di un vincolo.

Lì passano anche i due rami del client che nessun finto può esercitare davvero.
`deleteRecording` e `deleteProcedureForever` non passano da `send()`: rispondono
`204`, e `response.json()` su una risposta vuota lancia. Davanti a un finto il
corpo vuoto lo decide il test; contro un server vero lo decide Express. E
`getRecordingAudio` è l'unica risposta non-JSON di tutto il client — i byte che
tornano si confrontano con quelli caricati, `0xff` e `0x80` compresi, che è il
modo di accorgersi di chi li fa passare per testo.

E c'è il solo caso di tutta la suite in cui due costanti di due pacchetti diversi
si trovano faccia a faccia. `emptyTrash()` è l'unico metodo del client in cui una
chiamata non è una richiesta: ripete finché il cestino non è vuoto, e il numero di
schede che ogni passata porta via lo decide `EMPTY_TRASH_BATCH_SIZE` dentro il
servizio, mentre il numero di passate che il client accetta di fare lo decide
`GIRI_DI_SVUOTAMENTO` dentro il client. Nessun test unitario può metterle una
contro l'altra, perché ognuna delle due metà vede solo la propria. Qui un cestino
di `EMPTY_TRASH_BATCH_SIZE + 6` schede se ne va con una chiamata sola, e la
risposta dice `cancellate: EMPTY_TRASH_BATCH_SIZE + 6` e `rimaste: 0`: se le due
costanti smettessero di andare d'accordo — un tetto alzato oltre ciò che il
servizio restituisce, un ciclo che esce troppo presto — questo è il caso che lo
direbbe, e sarebbe l'unico.

L'applicazione del CORS da lì **non** è verificabile, e il file lo dice invece di
fingere: Node non manda `Origin`, quindi il middleware non scatta mai. Ciò che si
prova è la compatibilità. Il preflight si fa a mano — è l'unico modo di farsi
dire dal server cosa consente, invece di leggere la costante di `cors.ts` e
confrontare il codice con sé stesso — e poi ogni intestazione registrata deve
essere o CORS-safelisted o dentro l'insieme dichiarato. `content-type` non è
safelisted, perché lo è solo con tre valori e `application/json` non è fra
quelli. Accanto c'è il caso senza il quale quell'asserzione passerebbe anche
contro un insieme che contiene tutto: `x-finto` non deve essere consentito. E il
caricamento dell'audio ha il suo, dal verso in cui fa male: passando una
`FormData` il client non deve scrivere il `Content-Type`, perché il boundary lo
conosce solo il runtime che l'ha costruita — scriverlo a mano significherebbe un
`400` su ogni registrazione, cioè sul gesto principale dell'applicazione.

L'ultimo blocco è una guardia, e legge ciò che i cinque precedenti hanno
attraversato. La fabbrica avvolge ogni metodo del client per segnarne il nome in
un insieme; alla fine si confronta quell'insieme con `Object.keys` del client
vero. Funziona perché `createApiClient` restituisce un oggetto letterale e non
un'istanza di classe. `getAccessToken` è l'unico esente, perché è sincrono e non
fa HTTP; tutto il resto deve essere passato di là dal ponte, e il fallimento
nomina i metodi scoperti invece di contarli — chi lo legge è quasi sempre chi ha
appena aggiunto il metodo e non sa ancora che questo file esiste. Accanto, come
in `guards.test.ts`, il caso che verifica che la guardia stia guardando
qualcosa: i metodi sono ventotto. Senza, un `Object.keys` che tornasse vuoto —
per un refactoring del client da oggetto letterale a classe, che è una
riscrittura plausibile — renderebbe la guardia verde per sempre, e nessuno se ne
accorgerebbe perché i test verdi non si rileggono.

Venti mutazioni su `client.ts`, venti cadute: l'`Authorization` tolta dal filo,
il `Content-Type` tolto alle richieste JSON e aggiunto al multipart,
un'intestazione che il server non ha mai dichiarato, il ritenta sul `401` spento,
il refresh token scritto sotto la chiave sbagliata, l'access token conservato
anche lui nel deposito, il `401` sul corpo trattato come un `401` sulla sessione
— una volta in tutti e due i punti insieme e una volta per punto — la sessione
morta dichiarata due volte, il `204` letto come se fosse JSON, i due parametri
dello svuotamento del cestino, la cancellazione definitiva degradata ad
archiviazione, le conferme della redazione perse per strada, la ricerca senza la
parola cercata.

`DATABASE_URL_TEST` non ha un valore di default, di proposito: i test fanno
`TRUNCATE`, e un default che puntasse al database di sviluppo lo svuoterebbe in
silenzio. Le cinque `S3_*_TEST` seguono la stessa regola per la stessa ragione, e
in più `S3_BUCKET_TEST` non può coincidere con `S3_BUCKET`: la suite svuota il
bucket fra un file e l'altro, e su quello di sviluppo vorrebbe dire cancellare
gli audio di chi sta provando l'app. Il `globalSetup` controlla che il bucket
risponda prima ancora del primo test, perché un `list` che fallisce dentro un
`beforeAll` dice «fetch failed», cioè la stessa frase con cui si annuncerebbe una
firma sbagliata.

### La CI, e perché sono tre job

`.github/workflows/ci.yml` gira a ogni push su `master` e su ogni pull request.

| Job | Cosa fa | Cosa dimostra |
|---|---|---|
| `verifica` | `typecheck` + `npm test` | **senza nessun service container** |
| `integrazione` | `npm run test:integration` | Postgres con pgvector, migration versionate, un bucket S3 |
| `build` | `build:web`, `build:api`, `build:worker` | i tre comandi che girano in produzione |

Il primo non ha il database, e non è una svista: il repository promette che
`npm test` giri senza Docker, e una promessa che nessuno verifica scade da sola.
Con un job solo, il giorno in cui un test unitario o una schermata aprisse una
connessione nessuno se ne accorgerebbe — il database ci sarebbe, e sarebbe
verde.

Tre dettagli del job di integrazione. Il database di test lo crea `initdb` con
`POSTGRES_DB`, perché in locale lo crea `docker/initdb` e lì non si può: i
service container partono **prima** del checkout, quindi quella cartella non
esiste ancora sul disco. E `DATABASE_URL` resta deliberatamente non definita —
il `globalSetup` rifiuta di partire se punta dove punta `DATABASE_URL_TEST`, e
in CI di database ce n'è uno solo: definirla sarebbe l'unico modo di sbagliare.
Le migration le applica il `globalSetup` con `migrate deploy` e non un passo del
workflow, così il percorso provato in CI è lo stesso di chi sviluppa e
`schema.test.ts` continua a verificare che le migration versionate bastino da
sole a costruire indice HNSW e colonna generata.

Il bucket invece **non** è un service container: uno non prende un comando, e
l'immagine di MinIO senza `server /data` non fa niente. Lo tira su
`docker compose` dal file di questo repository, che è anche il modo di non
riscrivere una seconda volta versione, credenziali, porta e nomi dei bucket — a
questa altezza del job il checkout c'è già, che è esattamente ciò che a Postgres
manca. Il container che crea i bucket muore appena finito, quindi non lo si può
aspettare con `--wait`: lo si aspetta con `docker wait` e se ne controlla il
codice d'uscita, perché una creazione fallita in silenzio diventerebbe un
«NoSuchBucket» un minuto più tardi, lontano dalla causa.

Il job di build gira con `PRISMA_SKIP_POSTINSTALL_GENERATE` e mette `build:web`
per **primo**, prima che qualunque cosa generi il client Prisma: è la condizione
esatta di Netlify, dove Postgres non c'è e non deve servire. Un import che
tirasse dentro Prisma dal frontend diventerebbe rosso lì invece che in un
deploy.

#### Cosa ha trovato al primo giro

`integrazione` è stato rosso subito, e non per il database: `@wikimylife/shared`
è esportato da `dist/`, `test` aveva da sempre un `pretest` che lo compila e
`test:integration` no. Su una macchina dove qualcuno aveva già lanciato un build
la suite passava; su un checkout pulito nessun test riusciva nemmeno a partire.
Il seed, che gira come processo separato, importa anche `@wikimylife/api` dal
suo `dist`: per questo `pretest:integration` è `tsc -b apps/api` e non
`tsc -b packages/shared`.

Vale la pena scriverlo perché è esattamente il tipo di bug per cui una CI
esiste: non un test sbagliato, ma una dipendenza vera che nessuno aveva mai
dichiarato perché sulla macchina di chi la scriveva era già soddisfatta.

---

## Deploy

Tre servizi su Railway e un sito statico su Netlify. Niente Docker scritto a
mano, niente Functions, nessuna pipeline che spedisce: il repo contiene solo file
di configurazione dichiarativi e comandi npm, e ogni comando che gira in
produzione si può eseguire in locale identico. La CI esiste e prova, ma non
distribuisce — sono le due piattaforme a guardare `master` da sole.

I tre file sono anche l'unica parte del repo che nessun compilatore legge, ed è
il motivo per cui `tests/unit/deploy.test.ts` la legge al posto suo: ogni script,
percorso e rotta che i `.toml` nominano deve esistere davvero, altrimenti `npm
test` diventa rosso qui invece che il deploy laggiù.

| Dove | Cosa | Come parte |
|---|---|---|
| Railway | Postgres con `pgvector` | template ufficiale, estensione creata dalla prima migration |
| Railway | `apps/api` | `npm run start:api` |
| Railway | `apps/worker` | `npm run start:worker` |
| Netlify | `apps/web` (statico) | `netlify.toml` → `npm run build:web` |

**I due `railway.toml` Railway non li legge più.** Sono stati scritti quando
esisteva **Settings → Config-as-code**, che voleva il percorso del file; quella
funzione è deprecata, e provare a impostarla oggi — dal pannello o dall'API —
risponde testualmente:

```
Config as Code (railway.json / railway.toml) is deprecated.
Use Infrastructure as Code (.railway/railway.ts) instead.
```

Quindi i due file adesso sono **documentazione, e basta**: il loro contenuto va
ricopiato a mano nelle impostazioni del servizio (`buildCommand`, `startCommand`,
`watchPatterns`, `healthcheckPath`, `healthcheckTimeout`, `restartPolicy*`).
Restano in repo, e restano sotto `deploy.test.ts`, per una ragione sola: sono
l'unico posto dove è scritto **perché** quei valori sono quelli, e il pannello di
Railway un commento non lo tiene. Ma chi li modifica deve sapere che non sta
cambiando niente di vivo finché non tocca anche il pannello — ed è un difetto
noto, non un assetto voluto.

Entrambi i servizi puntano allo stesso repo e allo stesso `DATABASE_URL`, e hanno
`watchPatterns` diversi: un push che tocca solo `apps/web` non fa ripartire
niente su Railway.

### `NODE_ENV=production` rompe la build, e il messaggio non lo dice

Su Railway la variabile `NODE_ENV=production` esiste **prima** del `npm ci`, e
`npm ci` sotto `production` salta tutto ciò che il lockfile marca come `dev`. Il
risultato è un fallimento che sembra un errore di configurazione TypeScript:

```
error TS2688: Cannot find type definition file for 'node'.
  The file is in the program because:
    Entry point of type library 'node' specified in compilerOptions
```

Il motivo sta in due righe che non si vedono insieme. `apps/api/tsconfig.json`
dichiara `"types": ["node"]`; `@types/node` è una **devDependency**. Ma
`typescript` e `prisma` finiscono in `node_modules` lo stesso, perché qualcosa in
produzione li tira dentro come transitivi — quindi `tsc` **parte**, e fallisce a
metà invece di non esistere. Un compilatore assente si sarebbe notato subito.

Il rimedio è una variabile in più sui due servizi Railway:

```
NPM_CONFIG_INCLUDE=dev
```

L'alternativa — spostare `@types/node` fra le `dependencies` — è peggiore: fa
finta che un pacchetto di soli tipi serva a runtime, e il giorno che qualcuno
guarda le dipendenze di produzione per capire cosa viene spedito trova una
risposta falsa. La build ha bisogno delle devDependencies perché **è una build**;
la cosa da dire alla piattaforma è quella, non un'altra.

Vale per entrambi i servizi, API e worker: costruiscono tutti e due con `tsc`.

**Le migration girano nell'API e in nessun altro posto.** `npm run start:api` è
`prisma migrate deploy && node apps/api/dist/index.js`; il worker parte e basta.
Due processi che facessero `migrate deploy` insieme si contenderebbero
`_prisma_migrations`, e chi perde muore all'avvio — un guasto che si manifesta
solo quando i due deploy capitano nello stesso secondo, cioè raramente e mai in
locale. Le migration sono in avanti e additive, quindi il worker vecchio
sopravvive alla migrazione nuova per i secondi che separano i due redeploy.

**`/health` risponde 200 anche con il database giù**, ed è quello che Railway
interroga. Un 503 farebbe riavviare in ciclo un'API perfettamente viva che sta
solo aspettando Postgres, e un ciclo di riavvii è peggio del guasto che
segnalava: il campo `db` nel corpo dice la verità senza far rimbalzare il
processo. Il worker non ha health check perché non ascolta su nessuna porta —
gliene si assegnasse uno, Railway aspetterebbe una risposta HTTP che non arriva
mai e dichiarerebbe fallito un deploy riuscito.

### L'audio non sta più su disco

`STORAGE_PROVIDER=s3` è **obbligatorio in produzione**: `loadConfig` rifiuta di
avviarsi con `local` o `fake` quando `NODE_ENV=production`. Il filesystem di
Railway è effimero e la perdita non fa rumore — gli upload riescono, le schede si
generano, e i vocali spariscono al primo redeploy. Se ne accorgerebbe qualcuno
mesi dopo, riascoltando una registrazione che non c'è più.

Dietro c'è `S3StorageProvider`, che implementa la stessa interfaccia
`StorageProvider` del provider locale: la pipeline non sa quale dei due sta
usando. Firma le richieste con **AWS Signature Version 4 scritto a mano**, novanta
righe in `apps/api/src/providers/s3/sigv4.ts`, invece di `@aws-sdk/client-s3` e
delle sue cinquanta dipendenze transitive per quattro operazioni (`put`, `get`,
`delete`, `exists`). Il vantaggio non è il peso: le stesse novanta righe firmano
per S3, Cloudflare R2, Backblaze B2 e MinIO, quindi cambiare fornitore è cambiare
`S3_ENDPOINT`, non sostituire una libreria.

Una firma sbagliata è il genere di errore che non si trova rileggendo il codice,
perciò `tests/unit/sigv4.test.ts` la confronta con i **vettori ufficiali di AWS**
— chiave di firma e signature della suite `aws-sig-v4-test-suite`, presi da fuori
e non calcolati con questo codice. È il punto: un test che ricalcola con la
funzione sotto esame confermerebbe qualunque implementazione coerente con sé
stessa.

Il provider **non ritenta**. Un `put` fallito diventa un 500, il client se lo
tiene in coda su IndexedDB e riprova da lì: un retry dentro il server
raddoppierebbe il tempo di una richiesta che il browser ha già rinunciato ad
aspettare, e la coda offline esiste esattamente per questo.

### La scopa: `npm run sweep`

Il database e il bucket non condividono un commit. `DELETE /api/recordings/:id`
toglie la riga e poi l'oggetto, e fra le due c'è una finestra di millisecondi; la
stessa finestra sta fra il `put` del caricamento e la riga che lo nomina. Un
processo che muoia lì in mezzo lascia byte che nessuna riga nomina più. Non è un
problema che una transazione possa risolvere: resterebbe comunque un istante in
cui uno dei due sistemi ha scritto e l'altro no. Si riconcilia dopo.

```bash
npm run sweep                      # elenca e basta
npm run sweep -- --prefix=u1/      # solo una cartella
npm run sweep -- --giorni=7        # più prudente del default
npm run sweep -- --cancella        # e adesso sul serio
```

Il comando **non cancella se non glielo si dice**. Non è timidezza: la prima
passata su un bucket vero è quella in cui si scopre che il `DATABASE_URL`
puntava a un altro ambiente, e un default che cancella trasforma quell'errore in
una perdita irreversibile invece che in una stampa sbagliata.

Un oggetto viene cancellato solo se supera **tutte e tre** le condizioni, e ognuna
copre un modo diverso di sbagliare:

1. **Nessuna riga lo nomina.** `findExistingAudioKeys` è l'unica query del
   progetto senza `userId`, perché la domanda non è «cosa possiede questo utente»
   ma «questo oggetto appartiene a qualcuno», e restringerla darebbe la risposta
   sbagliata proprio per gli oggetti che interessano. Si interroga a blocchi di
   cinquecento chiavi, e **un errore di lettura interrompe la passata** invece di
   saltare il blocco: una domanda senza risposta darebbe come orfano tutto ciò
   che conteneva.
2. **È più vecchio della soglia**, un giorno per default. È l'unica difesa contro
   la corsa col caricamento: nell'istante fra il `put` e la riga, l'audio che
   qualcuno sta caricando adesso è indistinguibile da un orfano. Per questo
   `--giorni=0` è rifiutato.
3. **Ha la forma di una chiave nostra**, `{utente}/{uuid}.{estensione}`. Il bucket
   può non essere solo nostro: un backup messo lì a mano supera le prime due
   condizioni ed è comunque roba di qualcuno.

Il rapporto va su stdout e il registro su stderr, così `npm run sweep > elenco.txt`
lascia un elenco leggibile. Ogni orfano viene scritto *mentre* la passata procede
e *prima* che il suo blocco venga cancellato: se muore a metà, quelle righe sono
l'unica prova di quali chiavi siano sparite, perché il riassunto finale non
arriva mai. L'uscita è `2` per una riga di comando sbagliata, `1` se qualche
cancellazione è fallita — e una chiave che non si lascia cancellare non ferma le
altre, perché la passata dopo la ritrova identica.

Il riassunto dice **quanti** orfani, non quali: la passata non ne tiene in memoria
più di un blocco per volta, e cancella blocco per blocco invece che alla fine. Il
caso peggiore è anche il primo — un bucket trascurato a lungo è fatto quasi solo
di orfani — e tenerne l'elenco vorrebbe dire caricare in memoria il bucket, cioè
la cosa che la paginazione di `list` esiste per evitare. Cancellare mentre si
scorre è sicuro perché il segnalibro di `list` dice *dopo quale oggetto*
riprendere e non *a quale posizione*: su un elenco posizionale ogni chiave tolta
ne farebbe saltare una mai guardata.

Ctrl-C **non ammazza la passata a metà**: chiude il blocco in corso, stampa i
numeri di quello che ha guardato e esce con `1`. Il secondo Ctrl-C invece
interrompe davvero, perché chi lo preme due volte lo sta chiedendo. Un riassunto
parziale lo dice a parole — «Interrotta prima della fine» — visto che
«esaminati 12» senza quella riga sembra il conto del bucket, e chi lo legge
conclude che non c'era altro.

### La stessa scopa, da sola: `SWEEP_MODE`

Il servizio sta in `apps/api/src/services/storageSweep.service.ts` e non sa
niente di chi lo chiama, così lo chiamano in due: il comando qui sopra e il
worker, fra un giro di polling e l'altro. Il worker è il posto perché è l'unico
processo del sistema che si sveglia già da solo; non c'è cron, non c'è uno
scheduler, non c'è un terzo servizio da tenere in piedi.

| | |
|---|---|
| `SWEEP_MODE=spento` | il worker non guarda nemmeno il bucket |
| `SWEEP_MODE=elenca` | **default**: passa, scrive nel registro cosa cancellerebbe, non tocca niente |
| `SWEEP_MODE=cancella` | passa e cancella |
| `SWEEP_EVERY_HOURS` | ogni quanto, `24` per default |
| `SWEEP_GRACE_DAYS` | la soglia della condizione 2, `1` per default |

Tre valori e non un interruttore, per la stessa ragione di `REDACTION_PROVIDER`:
«spenta» e «accesa ma guarda e basta» non sono la stessa cosa. `elenca` non è un
gradino verso `cancella`, è uno stato in cui si può restare per sempre — chi
vuole sapere quanta spazzatura produce il sistema senza delegare a un processo
la decisione di toglierla ha già finito qui. La configurazione della scopa
finisce nel **registro dell'avvio**, dove chi guarda un deploy la vede: è
l'unica cosa che il worker faccia sui file di qualcuno senza che gliel'abbia
chiesto nessuno, e sapere che è accesa non deve costare una visita al pannello
delle variabili.

**Il default è `elenca`, e per un po' è stato `spento`.** Il cambio vale la pena
di essere raccontato, perché la prudenza di prima si era rivelata un difetto con
un nome migliore: una variabile che nessuno imposta raccoglie esattamente tanta
spazzatura quanto un comando che nessuno esegue, e negli ambienti veri la scopa
non passava. Il rischio che teneva fermo `spento` — la prima passata su un bucket
vero è quella in cui si scopre che il `DATABASE_URL` puntava a un altro ambiente,
e allora *tutto* risulta orfano — non è un rischio di `elenca`: è esattamente ciò
che `elenca` serve a mostrare. Con il default di oggi quella configurazione
sbagliata diventa una pagina di registro che grida, invece di una perdita di dati
o del nulla. `cancella` resta una cosa che si chiede a mano, e resta l'unico
valore che tocchi i file di qualcuno: la regola che il comando applicava da
sempre — *guarda, e poi cancella* — ora vale per l'intera applicazione.

Averla accesa costa una scorsa del bucket ogni `SWEEP_EVERY_HOURS`, e solo a coda
vuota: in fattura sono richieste `LIST`, mille oggetti l'una, e niente altro,
perché `elenca` non chiama mai `delete`. Nel registro è una riga per orfano, che
su un sistema sano sono pochissime — un orfano nasce solo da un processo morto
nella finestra di millisecondi fra il `put` e la riga che lo nomina. Se invece
sono tante, quella è la notizia.

A separare le due cose è una riga sola, `toccaCancellare` in
`apps/worker/src/sweepSchedule.ts`, e sta lì invece che dentro `index.ts` per una
ragione precisa: l'entry point del worker finisce con un `await main()` e non è
importabile, quindi finché il confronto stava lì dentro non c'era modo di
scrivere il test che dice che `elenca` non cancella. Ora che la passata avviene
in ogni installazione senza che nessuno l'abbia chiesta, quel `=== "cancella"` è
l'unica cosa che tiene innocuo il default, e un `!==` di troppo non lo
prenderebbe nessun altro test della suite.

Tre dettagli di pianificazione, ognuno per un modo di sbagliare:

- **La coda ha la precedenza.** Se il giro ha elaborato anche una sola
  registrazione, la scopa salta il turno: nessuno deve aspettare la propria
  scheda perché il worker sta pulendo la spazzatura di ieri. Su un sistema
  perennemente carico non passerebbe mai, ed è la risposta giusta — un bucket che
  cresce costa molto meno di una coda che non avanza.
- **La prima passata è un intervallo *dopo* l'avvio**, non all'avvio. Un worker
  che si riavvia in ciclo passerebbe la scopa a ogni riavvio, e la scopa è
  proprio la cosa che non deve girare più spesso di quanto le si è detto.
- **Il timer si riarma anche quando la passata fallisce.** Contare dalla fine e
  non dall'inizio, e riarmare fuori dal ramo felice, è ciò che impedisce a un
  bucket irraggiungibile di trasformarsi in un tentativo ogni cinque secondi.

Un SIGTERM ferma la passata fra un blocco e l'altro, al contrario
dell'elaborazione di un vocale, che invece si lascia finire perché è fatta di
chiamate a modelli già pagate. Qui non c'è niente da salvare: restare a scorrere
un bucket grande dopo un SIGTERM significa solo farsi ammazzare più tardi, e
fermarsi non lascia nulla in sospeso. I candidati del blocco incompleto vengono
**buttati**, non giudicati di fretta: sono chiavi già guardate e non ancora
confrontate col database, e interrogarlo dopo che l'arresto è stato chiesto
significherebbe cancellare durante lo spegnimento. La prossima passata le
ritrova identiche.

**Due repliche del worker non si pestano**, ma per un motivo diverso da quello
della coda — lì c'è un compare-and-swap, qui non c'è nessun lucchetto e non
serve. Cosa cancellare è una funzione pura di (bucket, tabella, ora), quindi due
passate in parallelo prendono le stesse decisioni; e cancellare due volte la
stessa chiave non è un errore né su S3 né sul filesystem, dove `delete` è
idempotente apposta. Il costo di due repliche è quindi una scorsa del bucket
pagata due volte — voci di `LIST` sulla fattura, niente di più — e chi vuole
evitarlo tiene la scopa accesa su una replica sola.

### CORS: il dominio del frontend e nient'altro

`CORS_ORIGINS` è una lista separata da virgola, e in produzione **non può essere
vuota**: senza, la PWA non riuscirebbe nemmeno a fare login, e l'errore che il
browser mostra («errore di rete») non nomina il CORS da nessuna parte.

Il middleware sta in trenta righe (`apps/api/src/http/middleware/cors.ts`) invece
del pacchetto `cors`, per una ragione precisa: la configurazione più comune di
quel pacchetto, `origin: true`, riflette *qualunque* origine, ed è esattamente la
cosa che qui non deve essere scrivibile per sbaglio. Quattro decisioni che vale
la pena conoscere:

- **Rimanda l'origine, mai `*`.** `*` direbbe «chiunque può leggermi», e sarebbe
  falso.
- **`Vary: Origin` c'è sempre, anche quando nega.** È proprio il ramo che nega
  quello che una cache condivisa riuserebbe per un'origine diversa, con
  l'intestazione sbagliata attaccata.
- **Nessun `Allow-Credentials`.** I token viaggiano in `Authorization`, non in
  cookie: dichiarare le credenziali aprirebbe una superficie CSRF che qui non
  esiste.
- **Le risposte d'errore portano le intestazioni CORS.** Senza, il browser mostra
  «errore di rete» al posto del 401 e il client non può distinguere una password
  sbagliata da un'API spenta.

Sta montato prima del parser JSON e prima dell'autenticazione: un preflight non
deve attraversare né l'uno né l'altra. Un `OPTIONS` da un'origine non ammessa
riceve **403, non 404** — il 404 arriverebbe dal gestore delle rotte inesistenti e
manderebbe chi configura il dominio a cercare un errore di routing che non c'è.

Il CORS non è una difesa: una richiesta vera da un'origine non ammessa passa
comunque, è il browser a non farne leggere la risposta. Chi chiama con `curl`
arriva all'API, e lì trova l'autenticazione, che è l'unica difesa e regge.

### La configurazione fallisce all'avvio

In `NODE_ENV=production` `loadConfig` rifiuta: storage `local` o `fake`,
`CORS_ORIGINS` vuoto, e provider `fake` per trascrizione, estrazione o embedding.
Sono quattro modi di avere un deploy che sembra riuscito: risponde 200, scrive
nel database, e il guasto si manifesta giorni dopo come audio spariti o schede
inventate — schede finte in un database vero sono indistinguibili dalle buone.

Le regole stanno in uno `superRefine` sullo schema Zod e non nel codice che
costruisce i provider, così valgono anche per il **worker**, che compone i propri
provider in un processo separato.

Quando manca la configurazione S3 l'errore le elenca **tutte**, non la prima: chi
imposta un servizio nuovo le sbaglia insieme, e dirgliene una per volta
significherebbe quattro deploy.

### Le variabili d'ambiente, e dove vanno

`R` = servizio Railway dell'API, `W` = servizio Railway del worker, `N` = Netlify,
`L` = solo in locale (`.env`).

| Variabile | R | W | N | L | Note |
|---|:-:|:-:|:-:|:-:|---|
| `NODE_ENV` | ✓ | ✓ | | ✓ | `production` sui due servizi Railway: attiva le regole qui sopra |
| `NPM_CONFIG_INCLUDE` | ✓ | ✓ | | | `dev`. Non la legge il codice: la legge `npm ci`. Senza, `NODE_ENV=production` salta `@types/node` e la build muore con `TS2688` |
| `PORT` | | | | ✓ | **non impostarla su Railway**: la impone la piattaforma |
| `LOG_LEVEL` | ✓ | ✓ | | ✓ | `info` in produzione |
| `DATABASE_URL` | ✓ | ✓ | | ✓ | su Railway è il riferimento al servizio Postgres, non un URL copiato |
| `DATABASE_URL_TEST` | | | | ✓ | solo `npm run test:integration`. Nessun default: i test fanno `TRUNCATE` |
| `CORS_ORIGINS` | ✓ | ✓ | | ✓ | in produzione il dominio Netlify. In locale `http://localhost:5173`. **Anche sul worker**, che non la usa ma senza non parte |
| `JWT_ACCESS_SECRET` | ✓ | ✓ | | ✓ | ≥ 32 caratteri. Lo stesso valore nei due servizi |
| `ACCESS_TOKEN_TTL_MIN` | ✓ | | | ✓ | default 15 |
| `REFRESH_TOKEN_TTL_DAYS` | ✓ | | | ✓ | default 30 |
| `SIGNUP_ENABLED` | ✓ | | | ✓ | **`false` dopo aver creato il primo utente** |
| `AUTH_RATE_LIMIT_MAX` | ✓ | | | ✓ | default 10. Da alzare se più persone escono dallo stesso IP |
| `AUTH_RATE_LIMIT_WINDOW_SEC` | ✓ | | | ✓ | default 60 |
| `TRUST_PROXY_HOPS` | | | | | default 1 in produzione, 0 altrove. **Si imposta solo aggiungendo un proxy davanti a Railway** |
| `STORAGE_PROVIDER` | ✓ | ✓ | | ✓ | `s3` in produzione, ed è obbligatorio |
| `S3_BUCKET` | ✓ | ✓ | | | obbligatoria con `s3` |
| `S3_REGION` | ✓ | ✓ | | | obbligatoria con `s3`. Su R2: `auto` |
| `S3_ACCESS_KEY_ID` | ✓ | ✓ | | | obbligatoria con `s3` |
| `S3_SECRET_ACCESS_KEY` | ✓ | ✓ | | | obbligatoria con `s3` |
| `S3_ENDPOINT` | ✓ | ✓ | | | vuoto = AWS. R2: `https://<account>.r2.cloudflarestorage.com` |
| `S3_FORCE_PATH_STYLE` | ✓ | ✓ | | | `true` solo per MinIO e simili |
| `STORAGE_DIR` | | | | ✓ | solo con `STORAGE_PROVIDER=local` |
| `SWEEP_MODE` | | ✓ | | ✓ | solo il worker la legge. Default `elenca`: passa e non tocca. `cancella` si scrive a mano |
| `SWEEP_EVERY_HOURS` | | ✓ | | ✓ | default 24 |
| `SWEEP_GRACE_DAYS` | | ✓ | | ✓ | default 1. Non è la retention: è la difesa dall'audio in corso di caricamento |
| `TRANSCRIPTION_PROVIDER` | ✓ | ✓ | | ✓ | `openai` in produzione |
| `EXTRACTION_PROVIDER` | ✓ | ✓ | | ✓ | `anthropic` in produzione |
| `EMBEDDING_PROVIDER` | ✓ | ✓ | | ✓ | `openai` in produzione |
| `REDACTION_PROVIDER` | ✓ | | | ✓ | default `nessuno`, **e `nessuno` va bene anche in produzione**: accenderlo manda a un terzo il testo non redatto delle schede |
| `OPENAI_API_KEY` | ✓ | ✓ | | ✓ | trascrizione ed embedding |
| `ANTHROPIC_API_KEY` | ✓ | ✓ | | ✓ | estrazione, e redazione assistita se accesa |
| `TRANSCRIPTION_MODEL` | ✓ | ✓ | | ✓ | default `whisper-1` |
| `EXTRACTION_MODEL` | ✓ | ✓ | | ✓ | il nome del modello non è la versione del prompt |
| `REDACTION_MODEL` | ✓ | | | ✓ | default più piccolo dell'estrazione: testo corto, e qualcuno che aspetta |
| `EMBEDDING_MODEL` | ✓ | ✓ | | ✓ | accoppiato a `vector(1536)`: cambiarlo richiede una migration |
| `EMBEDDING_DIMENSIONS` | ✓ | ✓ | | ✓ | 1536 |
| `SEED_USER_EMAIL` `SEED_USER_PASSWORD` | | | | ✓ | il seed non gira in produzione |
| `VITE_API_URL` | | | ✓ | ✓ | il dominio Railway dell'API |

Le API delle chiavi le vede solo Railway: **le `VITE_*` finiscono nel bundle in
chiaro**, quindi su Netlify va un URL e nient'altro. E vale al momento della
build, non dell'avvio: cambiare `VITE_API_URL` richiede un nuovo deploy.

**Il worker ha bisogno di `CORS_ORIGINS`, e non perché serva.** Non espone HTTP e
quel valore non lo usa mai; ma `loadConfig` è uno solo, condiviso fra i due
processi, e il suo controllo di produzione non distingue chi lo sta chiamando.
Senza la variabile il worker non parte affatto:

```
ConfigError: Configurazione non valida:
CORS_ORIGINS: in produzione serve almeno l'origine del frontend
```

Si imposta uguale a quella dell'API. La strada alternativa — insegnare a
`loadConfig` quale processo lo sta invocando, e chiedere solo ciò che a quel
processo serve — è più pulita e non è stata presa: significherebbe due forme
valide della stessa configurazione, e quindi un modo per avviare l'**API** senza
`CORS_ORIGINS` sbagliando il flag. Una variabile inutile sul worker costa una
riga; una configurazione che si valida in due modi costa un buco. Sta fra i
difetti noti, ma è il residuo che si è scelto.

Il worker riceve poi tutte le variabili dei provider e dello storage, perché è
lui a chiamare Whisper e Claude e a scrivere l'audio — l'API lo storage lo tocca
solo per rileggere il file da servire.

### Il primo deploy, nell'ordine

1. **Postgres** su Railway. La prima migration fa `CREATE EXTENSION vector`:
   non serve abilitarla a mano, ma serve un'immagine che ce l'abbia (il template
   Postgres di Railway va bene). Che ce l'abbia davvero si controlla prima di
   costruire qualunque altra cosa, con una riga sola:
   `SELECT extname, extversion FROM pg_available_extensions WHERE name = 'vector'`.
   Scoprirlo dopo significa un'API che muore in `migrate deploy` e un messaggio
   che parla di SQL invece che di immagini.
2. **Il bucket.** `STORAGE_PROVIDER=s3` è obbligatorio, quindi lo storage viene
   prima dell'API e non dopo. Va qualunque cosa parli S3: AWS, Cloudflare R2,
   Backblaze, o i bucket nativi di Railway (`railway bucket create`), che hanno il
   vantaggio di stare nello stesso progetto e lo svantaggio dell'endpoint
   personalizzato — che si mette in `S3_ENDPOINT` lasciando
   `S3_FORCE_PATH_STYLE=false`, perché sono virtual-host.
3. **API**: nuovo servizio dallo stesso repo, variabili della colonna `R`
   (`NPM_CONFIG_INCLUDE=dev` compresa, o la build cade), e le impostazioni di
   build e avvio ricopiate da `apps/api/railway.toml` — che Railway, come detto,
   non legge. Al primo avvio applica tutte le migration. Poi si genera un dominio
   pubblico, **scegliendo la porta a mano**: senza `--port` Railway prova a
   dedurla e con più porte esposte non ci riesce. Quel dominio è `VITE_API_URL`.

   **Dire a un servizio da quale repo costruire non lo fa partire a ogni push.**
   Sono due cose separate e si somigliano abbastanza da sembrarne una: il
   *source* dice dove trovare il codice quando un deploy parte, il *trigger* è
   ciò che fa partire il deploy. Con il solo source, `railway up` e
   `railway redeploy` funzionano, la dashboard mostra il repo giusto, e i push su
   `master` non succede niente — un deploy che sembra automatico e non lo è, che
   è il modo peggiore di non esserlo. Il trigger si crea a parte
   (`deploymentTriggerCreate`, o «Connect repo» dal pannello) e va messo su
   **entrambi** i servizi.
4. **Primo utente**: con `SIGNUP_ENABLED=true`, un `POST /api/auth/signup`, e
   subito dopo la variabile a `false` e redeploy. Il seed non è un'alternativa:
   popola dati di esempio, e in produzione non ci vanno. Che la chiusura abbia
   fatto effetto lo si verifica riprovando la stessa `signup`: deve rispondere
   `403 SIGNUP_DISABLED`. Impostare la variabile e non riprovare significa
   credere a un pannello invece che al server.
5. **Worker**: terzo servizio, variabili della colonna `W` — `CORS_ORIGINS`
   compresa, per la ragione scritta qui sopra — e impostazioni da
   `apps/worker/railway.toml`.
6. **Netlify**: si collega il repo, `netlify.toml` è già lì, si imposta
   `VITE_API_URL` e si fa il deploy. Il dominio che ne esce va in `CORS_ORIGINS`
   sull'API — e l'API va riavviata, perché la lista si legge all'avvio.

Il punto 6 è circolare per costruzione: il frontend ha bisogno del dominio
dell'API e l'API ha bisogno del dominio del frontend. Si rompe deployando prima
l'API, che con un `CORS_ORIGINS` provvisorio parte lo stesso. Il provvisorio si
può anche azzeccare: il dominio di default di Netlify è
`https://<nome-del-sito>.netlify.app`, quindi scegliere il nome del sito prima di
crearlo evita il secondo riavvio. È una comodità, non una garanzia — se quel nome
è già preso Netlify ne assegna un altro, e allora il riavvio serve.

**Il giro si chiude verificando dal di fuori, non dal pannello.** Le quattro cose
che dicono che è davvero in piedi sono: `/health` che risponde `200` con
`"db":"up"`; una preflight `OPTIONS` con `Origin` del sito che torna `204` e
rimanda indietro **quell'origine** e non `*`; un `POST /api/auth/login` che
restituisce dei token veri; e il bundle pubblicato che contiene il dominio
dell'API — perché `VITE_API_URL` è compilata dentro, e un sito che si costruisce
senza vede `undefined` senza lamentarsi.

---

## Sicurezza in produzione

Tre cose che finché il dominio non è pubblico non si notano, e il giorno dopo
sono l'unica cosa che conta: contare i tentativi di accesso, dire al browser cosa
gli è permesso fare, e non ripetere all'infinito una chiamata a pagamento che
fallisce.

### Il limite dei tentativi

`POST /api/auth/signup`, `/login`, `/refresh`, `/password`, `/sessions/revoke` e
`/sessions/revoke-one` passano da
`apps/api/src/http/middleware/rateLimit.ts`: finestra fissa, **dieci tentativi al
minuto per IP e per rotta** di default (`AUTH_RATE_LIMIT_MAX`,
`AUTH_RATE_LIMIT_WINDOW_SEC`). Oltre il limite è un `429` con
`error.code: "RATE_LIMITED"`, `Retry-After`, e le tre `RateLimit-*` — che ci sono
anche quando la richiesta passa, così un client attento rallenta da solo invece
di scoprire il muro sbattendoci.

Quattro decisioni, e il perché:

- **Quaranta righe scritte a mano invece di `express-rate-limit`.** Il pacchetto
  farebbe la stessa cosa; scriverlo ha costretto a guardare da dove viene
  `req.ip`, che è il punto sotto.
- **Finestra fissa, non token bucket.** Il difetto noto è il raddoppio al confine
  fra due finestre: chi è preciso ottiene `2 × max` a cavallo dello scoccare del
  minuto. Non cambia niente — la differenza che serve è fra venti tentativi al
  minuto e diecimila, e venti o quaranta stanno dalla stessa parte.
- **La chiave è IP + metodo + percorso, non l'email.** Contare per email sembra
  più preciso e regala due cose a chi attacca: la possibilità di chiudere fuori
  un utente vero bombardando il suo indirizzo, e la possibilità di distribuire i
  tentativi su indirizzi email diversi senza mai toccare il limite. Il percorso
  che entra nella chiave è `req.path`, cioè quello **concreto** e non lo schema
  della rotta: è la ragione per cui `/sessions/revoke-one` prende l'id nel corpo
  e non nel percorso — con l'id nel percorso ogni id aprirebbe un secchiello
  nuovo, e una rotta che accetta una password diventerebbe un oracolo senza
  limite.
- **Su Postgres, non su Redis e non in memoria.** Redis sarebbe un quarto
  servizio, un'altra variabile e un altro modo di rompersi, per proteggere
  l'account di una persona. Postgres c'è già, e il conteggio ci sta in una riga.

`/password`, `/sessions/revoke` e `/sessions/revoke-one` sono le tre rotte
limitate che stanno anche dietro `requireAuth`, e le due cose non si
contraddicono: sono i tre posti in cui chi ha rubato un access token può provare
a indovinare la password online, e sono le tre che pagano un argon2 per tentativo
— `/password` ne paga due, una verifica e un hash — quindi martellarle costa alla
CPU dell'API molto più che a chi le martella. Le finestre non si mescolano,
perché la chiave contiene la rotta: un cambio password non consuma i tentativi di
`/login`, «scollega gli altri» non consuma quelli del cambio password, e nessuno
dei quattro può esaurire gli altri. Ma i tentativi di `/sessions/revoke-one`
**sì**, si consumano fra loro: cambiare `sessionId` a ogni richiesta non compra
un budget nuovo, ed è esattamente ciò che l'id nel corpo garantisce e che l'id
nel percorso avrebbe regalato.

`/logout`, `/me` e `GET /sessions` non sono limitati. Il primo non regala niente a
chi lo martella; gli altri due stanno già dietro `requireAuth` e non accettano
nessun segreto, quindi non c'è niente da indovinare a colpi di richieste, e
limitarli significherebbe rompere l'app in mano a un utente legittimo che
ricarica — nel caso dell'elenco, spegnerlo proprio a chi lo sta ricaricando per
capire quale dispositivo scollegare.

Le voci scadute si eliminano ogni 500 richieste, dentro la richiesta stessa: un
`setInterval` terrebbe vivo l'event loop e un processo che non muore su `SIGTERM`
viene ucciso dalla piattaforma dopo il timeout, ogni singolo deploy.

#### Una riga, e una sola istruzione

I conteggi stanno in `RateLimitBucket`: `key` (l'IP più la rotta), `count`,
`resetAt`. Una riga per finestra aperta, che sparisce con la pulizia. Non serve
nessuna variabile d'ambiente nuova: il deposito è `DATABASE_URL`, che c'era già.

La cosa che conta non è la tabella, è l'istruzione. La versione ovvia —
leggi la riga, decidi il numero nuovo, scrivilo — ha tre viaggi, e fra il primo e
il terzo passa altra gente: venti richieste in parallelo leggono quasi tutte lo
stesso conteggio e scrivono quasi tutte lo stesso numero. Il limitatore si
lascerebbe scavalcare esattamente da chi manda tante richieste insieme, cioè
nell'unico momento in cui serve. Non è teoria: `tests/integration` ha visto un
deposito ingenuo arrivare a **1** su venti tentativi simultanei, diciannove persi.

Quello vero è un `INSERT ... ON CONFLICT ("key") DO UPDATE` con dentro un `CASE`
che decide se la finestra è scaduta, e un `RETURNING` che riporta il conteggio
appena scritto. Un viaggio solo, e Postgres prende il lock sulla riga: venti
richieste simultanee contano da 1 a 20, nessun numero saltato e nessuno
ripetuto. È il test che giustifica la complessità del `CASE`.

#### Se Postgres non risponde, si passa

Il deposito ora può fallire, e la scelta è **lasciare passare** e scriverlo nel
log — non rispondere `503`. La ragione è che le rotte protette hanno bisogno del
database comunque: `/login` deve leggere `User` per verificare una password. Se
Postgres è giù, nella finestra in cui il limite manca non c'è niente da forzare —
tutte quelle richieste falliscono lo stesso, più a valle. Negare l'accesso in
quel momento significherebbe solo trasformare un guasto del database in
un'indisponibilità più larga di quella che è già.

Quando succede, il limitatore **non dichiara le `RateLimit-*`**: non sa a che
punto sia il conteggio, e un `RateLimit-Remaining` inventato è peggio di uno
assente. La pulizia periodica che fallisce viene ingoiata allo stesso modo: è
manutenzione, e non deve far cadere la richiesta di chi passava di lì.

#### La stessa regola scritta due volte

L'aritmetica della finestra ora esiste in due posti: dentro il `CASE` in SQL, e
in `tests/support/InMemoryRateLimitStore.ts` per i test che girano senza Docker.
Due scritture della stessa regola divergono, e questa divergerebbe in silenzio —
il `429` continuerebbe a uscire, e nessuno si accorgerebbe che la finestra non si
riapre più.

Perciò le regole stanno scritte una volta sola, in
`tests/support/rateLimitStoreContract.ts`, e girano contro entrambe: `npm test`
le passa la Map, `npm run test:integration` le passa Postgres. Quello che solo
Postgres può avere — l'atomicità, e due depositi sullo stesso database che sono
lo stesso deposito — sta nel file di integrazione, perché chiedere alla Map di
dimostrarlo sarebbe chiederle di mentire.

### `TRUST_PROXY_HOPS`, senza cui niente di tutto questo conta

Un limitatore per IP vale quanto vale l'IP, e dietro un proxy l'IP arriva in
`X-Forwarded-For`. La prima versione di questo codice aveva
`app.set("trust proxy", true)`, che è il valore che si trova ovunque e che dice a
Express di fidarsi di **tutti** gli indirizzi di quell'intestazione e di prendere
il primo da sinistra. Il primo da sinistra lo scrive il client: bastava mandare
`X-Forwarded-For: 1.2.3.4` e cambiarlo a ogni richiesta per avere un budget nuovo
ogni volta. Il limitatore avrebbe continuato a rispondere `429` a chi non
falsificava niente — cioè a sembrare a posto.

Con un **numero** Express conta da destra, e a destra ci sono le voci che hanno
scritto i proxy, non il client. `TRUST_PROXY_HOPS` vale `1` in produzione (il
proxy di Railway) e `0` in sviluppo, dove non c'è nessun proxy e
`X-Forwarded-For` va ignorato del tutto. Va alzato solo mettendo un'altra cosa
davanti — una CDN, per esempio — e allora va alzato davvero: un valore più basso
del numero di salti riporta esattamente il problema di prima.

Il test che tiene in piedi tutti gli altri è in `security.e2e.test.ts`: consuma
il budget, poi riprova con un `X-Forwarded-For` inventato e si aspetta comunque
`429`.

### Le intestazioni

L'API manda **cinque** intestazioni (`securityHeaders.ts`): `nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Resource-Policy: same-origin`, e `Strict-Transport-Security` **solo
in produzione**. Quest'ultima condizione non è pignoleria: un browser che
ricevesse HSTS da `http://localhost` rifiuterebbe il testo in chiaro su *tutto*
localhost per un anno — Vite compreso, e per progetti che non c'entrano niente.

`Cross-Origin-Resource-Policy: same-origin` sembra contraddire il CORS e non lo
fa: blocca le richieste `no-cors`, quelle di `<img src>` e `<audio src>`, non
quelle in modalità CORS. La PWA sta su un'altra origine ma chiede l'audio con
`fetch` e un header `Authorization`, quindi è per forza CORS e passa. Il che vuol
dire anche: il giorno in cui il player tornasse a `<audio src={url}>`
smetterebbe di funzionare, e quella riga è il posto da guardare.

Cinque e non le quindici di `helmet`, perché `helmet` è pensato per un server che
rende HTML. Questo rende JSON e byte di audio; l'unica pagina la serve Netlify, e
lì la protezione va scritta in `netlify.toml`. Installarlo sull'API darebbe la
sensazione di aver coperto il frontend senza averlo coperto, che è il modo più
efficace di non tornarci mai più sopra.

### La CSP, che sta su Netlify

`netlify.toml` manda la CSP, la `Permissions-Policy` e l'HSTS sul documento,
perché è il documento che va protetto ed è Netlify a servirlo.

La direttiva è stretta sul serio: `script-src 'self'; style-src 'self'`, **senza
`'unsafe-inline'` da nessuna parte**. Funziona perché la build non contiene un
solo script né uno stile inline — Vite mette tutto in file con hash, e nel codice
non c'è un `style={{...}}`. È fragile e va detto: il primo `<style>` aggiunto a
`index.html` sparirebbe senza spiegazioni.

Due concessioni, entrambe necessarie:

- `media-src 'self' blob:` — il player scarica l'audio con `fetch` (perché quell
  URL vuole un header `Authorization`, che un `src` non può portare) e lo passa a
  `<audio>` come object URL. Senza `blob:` la riproduzione si rompe e il motivo
  non compare da nessuna parte se non nella console.
- `connect-src 'self' https:` e non il dominio esatto dell'API, che cambia con il
  progetto Railway: inchiodarlo qui significherebbe mettere una variabile
  d'ambiente dentro un file versionato. Resta un limite vero — blocca `http:`,
  `data:` e `ws:` — ma chi ha un solo deploy fa bene a sostituirlo con l'origine
  precisa.

`Permissions-Policy` concede `microphone=(self)` e `geolocation=(self)` e nega
tutto il resto: sono le due cose che la PWA usa davvero.

**L'HSTS che esce non è quello scritto nel file.** `netlify.toml` chiede
`max-age=31536000; includeSubDomains`, con accanto un commento che spiega perché
*non* c'è `preload`; quello che il sito risponde davvero è:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

Lo aggiunge Netlify, che su `*.netlify.app` lo fa di suo — il dominio è già nella
lista di precarico dei browser, quindi per quel nome la direttiva descrive uno
stato di fatto e non una richiesta nuova. Lo stesso valore mandato dall'API su
Railway arriva invece intatto, senza `preload`: la differenza è la piattaforma,
non il codice.

Vale la pena saperlo per due ragioni, e nessuna delle due è la sicurezza di
oggi. La prima è che **un header dichiarato in un file non è un header servito**,
e l'unico modo di sapere cosa arriva è chiederlo al dominio vero — il che rende
`deploy.test.ts` una prova di coerenza interna e non di comportamento. La
seconda è che il giorno in cui il sito passerà a un dominio proprio, quel
`preload` potrebbe seguirlo su un nome che nella lista **non** c'è, e iscrivere
un dominio al precarico è la decisione difficile da revocare che il commento nel
file voleva evitare. Non è un problema adesso; è un posto da guardare quel
giorno.

### Il tetto ai tentativi di ingestione, e la distanza fra uno e l'altro

`MAX_INGESTION_ATTEMPTS = 3` in `ingestion.service.ts`. Al terzo fallimento
automatico la registrazione passa a `ESTRAZIONE_FALLITA` invece di tornare in
`BOZZA_AUDIO`.

Serve perché senza, tornare in `BOZZA_AUDIO` non è una seconda occasione ma un
ciclo: `claimNext` prende la registrazione in attesa più vecchia, e la più
vecchia in attesa è di nuovo quella. Ogni giro è una chiamata Whisper pagata, e
il worker ne fa un giro ogni cinque secondi — per sempre, o finché qualcuno non
guarda la fattura. Un `429` di OpenAI ci mette dentro l'intera coda in una volta.

Tre e non uno, perché la maggior parte dei fallimenti che rimettono in coda sono
transitori, e un tentativo solo butterebbe via registrazioni che al secondo giro
sarebbero passate. Tre e non dieci, perché oltre il terzo la causa non è
transitoria e continuare è solo spesa.

`POST /api/recordings/:id/retry` **non** è soggetto al tetto, ed è voluto:
`requeue` incrementa `retryCount`, quindi ogni riscatto manuale compra
esattamente un tentativo e il fallimento successivo richiude. È la differenza fra
una decisione e un ciclo. `ESTRAZIONE_FALLITA` resta un capolinea per la coda,
non per l'utente: l'audio è ancora nello storage, e il messaggio d'errore dice
che si è smesso di riprovare invece di ripetere solo cosa è andato storto — al
terzo giro «trascrizione fallita» sembra il primo giro.

Il tetto da solo però contava i tentativi senza distanziarli, e il worker fa un
giro ogni cinque secondi: tre tentativi si consumavano in una quindicina di
secondi, cioè erano un tentativo fatto tre volte. Un'indisponibilità di OpenAI
di un minuto — il guasto più banale che esista — bruciava l'intero credito di una
registrazione prima che avesse una possibilità, e la lasciava ferma ad aspettare
che un umano premesse «riprova» su qualcosa che si era già guarito da solo.

`RITARDI_RITENTATIVO = [1 minuto, 10 minuti, 1 ora]` li distanzia. La scala è
×10 e non ×2 perché fra un fallimento e il successivo l'unica informazione
disponibile è «è fallito di nuovo»: il primo scaglione copre un singolo
singhiozzo, il secondo una finestra di rate limit, il terzo un'indisponibilità
vera. Raddoppiando, il terzo tentativo cadrebbe venti secondi dopo il primo — di
nuovo dentro lo stesso guasto. Nessun jitter, perché i tentativi sono già
sfasati fra loro dal momento in cui ciascuna riga è fallita.

Il quando sta su una colonna, `Recording.nextAttemptAt` ([D11](docs/deviazioni-schema.md#d11)),
e non in un calcolo dentro la query di polling: `lastErrorAt + f(retryCount)`
darebbe la stessa risposta, ma costringerebbe a riscrivere `f` in SQL e le due
copie divergerebbero al primo aggiustamento degli scaglioni. `null` vuol dire
«adesso» e non «mai» — è il valore di ogni registrazione appena caricata — ed è
il motivo per cui il filtro è `nextAttemptAt IS NULL OR nextAttemptAt <= $1`: in
SQL `NULL <= now()` non è falso, è *sconosciuto*, e la metà mancante avrebbe
nascosto al worker ogni registrazione nuova. Il test che conta è in
`tests/integration/recordings.e2e.test.ts`, contro Postgres, perché in memoria
quella `OR` non ha modo di essere sbagliata.

Il riscatto manuale azzera l'attesa. Il backoff protegge dal ciclo automatico, e
chi preme «riprova» ha appena letto l'errore e deciso: fargli scontare un ritardo
pensato per una macchina sarebbe punirlo per aver guardato. Per lo stesso motivo
`nextAttemptAt` sta nel contratto HTTP: senza, un'attesa di un minuto è
indistinguibile da un blocco, e un'interfaccia che non sa dirlo invita a premere
«riprova» proprio mentre il tempo sta già facendo il suo lavoro.

**Tre tentativi distanziati sono la risposta giusta a un guasto passeggero, e
un'ora e mezza di finta speranza per tutto il resto.** Un `429` passa da sé e
aspettare è l'unica cosa sensata; un audio che il fornitore rifiuta perché è in
un formato che non sa leggere darà la stessa risposta al terzo giro che al primo,
e nel frattempo la registrazione risulta «in lavorazione» a chi l'ha fatta.
`services/ingestion/definitivo.ts` toglie dalla coda subito ciò che riprovare non
cambierebbe: un `413`, `415` o `422` da un fornitore — stati che parlano del
contenuto della richiesta e non del server che la riceve — e un oggetto che lo
storage non ha (404 da S3, `ENOENT` dal filesystem).

La classificazione è sbilanciata di proposito. Chiamare «transitorio» qualcosa di
definitivo costa novanta minuti di tentativi inutili e finisce comunque in
`ESTRAZIONE_FALLITA`: è esattamente ciò che succedeva prima, quindi non peggiora
niente. Chiamare «definitivo» qualcosa di transitorio toglie invece i tentativi
automatici, e riaverli richiede una persona che apra l'app — una volta per riga,
se la causa era comune a tutta la coda. Per questo `401` e `403` restano
transitori benché sembrino definitivi: una chiave scaduta si ripara con una
variabile d'ambiente, e quei novanta minuti sono la finestra per accorgersene
senza che nessuno perda niente. Per lo stesso motivo un `404` da un fornitore
resta transitorio — url o modello sbagliati, cioè ancora configurazione — mentre
un `404` dallo storage no, perché lì significa che l'oggetto non c'è.

**Nell'elenco c'era anche il `400`, e a toglierlo è stato il primo deploy vero.**
La premessa era che con un corpo costruito dal nostro codice «richiesta
malformata» potesse voler dire solo che l'audio dentro non è quello che dichiara.
È falsa: una chiave Anthropic legata all'organizzazione e non a un workspace fa
rispondere `400 — This API key is not scoped to a workspace`, cioè il caso di
configurazione per eccellenza, quello che il paragrafo qui sopra promette di
lasciare transitorio. In produzione la registrazione è uscita dalla coda al primo
tentativo su tre, e all'utente è stato scritto che era colpa di com'era fatta la
sua trascrizione. Il difetto era strutturale, non una svista: `413`, `415` e `422`
sono stati che *per definizione* parlano dell'entità spedita — troppo grande,
formato non gestito, contenuto letto e rifiutato — e non esiste una lettura di
quei tre in cui il soggetto sia chi sta chiamando. Il `400` è il generico delle
richieste malformate, e una richiesta comprende il corpo ma anche le intestazioni
e la forma delle credenziali: è ambiguo per costruzione, e la regola
dell'asimmetria decide i pareggi verso il transitorio.

Scartata l'alternativa di distinguere *dentro* il `400` cercando nel messaggio i
marcatori della configurazione. Il corpo della risposta arriva a quel modulo solo
perché `ProviderHttpError` lo concatena nel `message` troncato a 500 caratteri,
quindi il marcatore può cadere fuori dalla finestra; e legare la classificazione
alla prosa inglese di un fornitore significa che il giorno in cui la riscrive
nessun test cade e il difetto torna in silenzio. Quel modulo riconosce gli errori
dalla forma, mai dal testo — la stessa ragione per cui non importa le classi.

Il modulo non importa `ProviderHttpError` né `S3StorageError`: riconosce gli
errori da `name` e `status`, perché il servizio di ingestione non dipende da
nessuna implementazione di provider ed è quell'indipendenza a renderlo provabile
senza chiavi API. Il test invece costruisce gli errori con le classi vere, così
un rename le fa divergere e qualcuno se ne accorge.

Il codice d'errore resta quello vero anche quando lo stato diventa
`ESTRAZIONE_FALLITA`: «formato rifiutato» e «troppi tentativi» non si riparano
allo stesso modo, e la scheda deve poterlo dire. Cambia il messaggio, che aggiunge
che rimandare la stessa cosa darebbe lo stesso esito — l'unica riga che distingue,
per chi legge, «non ha ancora funzionato» da «non funzionerà».

---

## Dipendenze

Oltre allo stack imposto (TypeScript, Express, Prisma, Zod, React, Vite, Vitest)
ce ne sono **due**, entrambe conseguenza dell'autenticazione:

- **`jose`** — JWT HS256. Zero dipendenze transitive, ESM nativo.
  `jsonwebtoken` è CJS e ne porta sei.
- **`@node-rs/argon2`** — argon2id con binari napi precompilati: niente
  `node-gyp` su Windows né toolchain sul server.

Fra le sole dipendenze di sviluppo, `jsdom`, `@testing-library/react` e
`@testing-library/user-event` sono arrivate dopo, quando è diventato chiaro che
le tre regole che costano privacy o dati — nessuna casella spuntata, solo gli id
scelti, il polling che si spegne — non stanno in nessun modulo puro: stanno in
uno `useState` iniziale e in un `useEffect`, e l'unico modo di provarle è
montare. Il resto è ancora fuori: `@testing-library/jest-dom` non c'è, perché
`.checked` e `.disabled` si leggono con una riga, e `@vitejs/plugin-react`
nemmeno, perché il JSX lo compila l'esbuild che Vitest ha già dentro — quel
plugin porta Babel e il fast refresh, che in un test non ha niente da
aggiornare.

Non installate, e il perché:

| Pacchetto | Al suo posto |
|---|---|
| `dotenv` | `process.loadEnvFile()` di Node ≥ 20.12 |
| `supertest` | `listen(0)` + `fetch`, quindici righe |
| `pino` | un logger JSON su stdout di venti righe |
| `cors` | trenta righe: `origin: true` non dev'essere scrivibile per sbaglio |
| `@aws-sdk/client-s3` | SigV4 a mano, novanta righe, provate sui vettori AWS |
| `helmet` | cinque intestazioni scritte a mano: le altre dieci proteggono un HTML che l'API non serve |
| `express-rate-limit` | quaranta righe, e la certezza su cosa viene contato |
| `eslint` | il test di guardia copre le due regole che ci interessano |
| `uuid` `nanoid` | `crypto.randomUUID()` |
| `react-router` | `hashchange`, trenta righe per nove schermate |
| `@tanstack/react-query` | `useAsync`, venti righe: carica e ricarica |
| `vite-plugin-pwa` `workbox` | un service worker di sessanta righe |
| `tailwind` e simili | un foglio di stile di 2 kB compressi |
| `@testing-library/jest-dom` | `.checked` e `.disabled` si leggono senza matcher |
| `@vitejs/plugin-react` | il JSX lo compila l'esbuild che Vitest ha già dentro |

---

## Cosa non c'è ancora, e si sa

- **Il limite dei tentativi ferma la forza bruta, non la pazienza.** Adesso il
  conteggio è condiviso, quindi le repliche e i riavvii non lo diluiscono più; la
  finestra fissa resta però una finestra fissa, e chi prova dieci password al
  minuto per un mese non incontra mai il muro. Fermarlo vorrebbe dire contare per
  account e su giorni, cioè un'altra cosa da questa.
- **Una sessione si chiude da sola, ma si sceglie al buio e non si annulla.** Il
  gesto per riga adesso c'è — `POST /api/auth/sessions/revoke-one` e un pulsante
  su ogni riga che non sia quella in mano — quindi chi riconosce due dispositivi
  su tre può chiudere solo il terzo. Restano due cose. La prima è che **niente
  chiede conferma**: il pulsante chiude subito, e le righe si distinguono solo
  per una data (il difetto qui sotto), quindi un dito che scivola su quella
  accanto chiude un dispositivo che andava bene. Il freno che c'è è indiretto —
  il campo della password si svuota dopo ogni gesto, quindi il secondo clic
  distratto non parte — ma è un freno sulla *raffica*, non sul primo colpo. La
  seconda è che la conferma non nomina niente: dice «Il dispositivo è stato
  scollegato» e la lista si accorcia, ma non dice **quale**, e su tre righe con
  date vicine quella frase non basta a sapere se si è chiuso ciò che si voleva.
  Il rimedio a tutti e due è lo stesso, ed è il difetto qui sotto: finché una
  riga non ha un nome, non c'è niente da scrivere in una conferma né da
  rileggere in un avviso. Il costo, per ora, è un login in più sul dispositivo
  sbagliato.

- **E di ogni sessione si sa una cosa sola: quando è nata.** Niente indirizzo,
  niente dispositivo, niente «ultimo uso». È una scelta e non una mancanza: un
  elenco che dicesse da dove e con che cosa ci si è collegati sarebbe più utile
  nel momento in cui serve e un registro degli spostamenti del proprietario in
  tutti gli altri, leggibile da chiunque prenda in mano uno qualsiasi dei
  dispositivi elencati. Ma il prezzo va scritto qui e non nascosto sotto la
  motivazione: due telefoni aperti lo stesso pomeriggio sono due righe
  indistinguibili, e chi deve decidere quale buttare, da questo elenco, non lo
  scopre. La data di nascita distingue «il telefono di ieri» da «quello di due
  anni fa», e si ferma lì. Da quando ogni riga ha un pulsante, questo costo è
  salito: prima significava «non so contare cosa sto chiudendo», adesso
  significa «non so quale sto chiudendo», ed è una domanda a cui la schermata
  chiede di rispondere. La strada che non passa da un registro degli spostamenti
  è un nome scelto dall'utente al primo accesso da un dispositivo nuovo — dato
  da chi lo possiede e non dedotto da chi lo osserva — e oggi non c'è.
- **Non si recupera una password dimenticata.** Non c'è rotta, non c'è mail, non
  c'è nulla: chi dimentica la password perde l'archivio. La schermata
  dell'account fa quel che può — chiede la nuova due volte e dice che non c'è
  modo di recuperarla — ma è un avviso, non un rimedio. Il rimedio vero richiede
  un canale che oggi il prodotto non ha (un mittente, un dominio, un token a
  scadenza da custodire), e mezza implementazione sarebbe peggio di nessuna:
  un reset per mail fatto male è la porta di servizio da cui si entra
  nell'account senza saperne la password.
- **Un access token emesso prima di questo cambiamento non vale più.** Non porta
  `fid`, quindi non è revocabile, quindi viene rifiutato invece di essere
  accettato "finché non scade" — una scorciatoia del genere non la toglie più
  nessuno. Il client, davanti a un 401, ruota una volta e prosegue: il prezzo è
  una richiesta in più, una volta sola, al primo giro dopo il deploy.
- **`vector(1536)` accoppia lo schema a `text-embedding-3-small`.** Passare a
  `-large` (3072 dimensioni) richiede una migration e il re-embedding di tutte le
  procedure.
- **Il duplicato si fonde a mano.** `POST /retry` scarta il suggerimento e
  riprocessa; "aggiorna quella esistente invece di crearne una nuova" si fa con
  una `PATCH` sulla scheda indicata da `duplicateOfId`, leggendo l'estrazione
  dalla registrazione. Non esiste una rotta che unisca le due in un colpo solo,
  ed è voluto: la fusione è una decisione, e va vista prima di essere scritta.
- **La ricerca pagina fino a cento risultati, e non oltre.** `offset` c'è ed è
  esatto, ma solo dentro la finestra che i due canali restituiscono: una scheda
  che non sta fra le prime cento né per testo né per vettori non compare a nessuna
  pagina. Per un archivio personale è un tetto che quasi nessuno tocca, e superarlo
  non è questione di paginare meglio — vorrebbe dire cambiare il metodo, perché è
  la fusione stessa a lavorare su liste troncate.
- **Fra una pagina e l'altra il pareggio non si rompe.** Dentro una pagina, due
  schede a pari punteggio RRF si ordinano per freschezza e poi per numero di
  esecuzioni; ai lati del taglio no, perché le righe si leggono solo per la pagina
  che si serve e due candidate su pagine diverse non si incontrano mai. Confrontarle
  significherebbe idratare tutte e cento le candidate a ogni ricerca, cioè pagare
  l'intera profondità per rifinire un pareggio. Ciò che la paginazione garantisce
  è che nessuna scheda si ripeta e nessuna sparisca; l'ordine *fine* vale nella
  pagina.
- **Delle cause di fallimento si riconoscono solo quelle dichiarate, e adesso
  sono tre.** Un fornitore che rifiuta il contenuto con un `413`, `415` o `422`
  esce subito dalla coda; tutto il resto continua a comprare tre tentativi. I
  guasti definitivi che non si annunciano con uno di quei tre numeri esistono —
  un `500` che nasconde un audio illeggibile, un `200` con un corpo che non si
  interpreta — e per quelli l'ora e mezza si paga ancora. Da quando il `400` è
  uscito dall'elenco il debito è cresciuto di un caso noto e non ipotetico: un
  fornitore che rifiuta il contenuto con un `400` invece che con uno dei tre — una
  trascrizione più lunga del massimo, per esempio — adesso si porta via i novanta
  minuti prima di finire in `ESTRAZIONE_FALLITA`. È il prezzo dichiarato di non
  chiamare definitivo un numero ambiguo, e si paga nella direzione che costa
  meno. Allungare l'elenco richiede di misurare fallimenti veri, non di
  indovinarli: finché non ci sono, ogni aggiunta rischia di togliere i tentativi
  automatici a chi ne aveva bisogno.
- **Di un'estrazione rifiutata si legge la regola che ha bloccato, non sempre la
  causa.** Il messaggio adesso nomina il motivo, ma nomina solo le regole
  *bloccanti*, e in `domainIssues` ce n'è una sola: `titolo.mancante`. Quando il
  modello classifica `NON_CLASSIFICABILE` — il caso vero: un vocale senza parlato,
  con Whisper che allucina — il titolo manca *perché* non è stata riconosciuta una
  procedura, e quello che si legge è il sintomo. La causa esiste, è calcolata, ed è
  già nel contratto: `RecordingState.issues` le porta tutte, bloccanti e non,
  ricalcolate da `rawExtraction` a ogni lettura. Nessuna schermata le mostra —
  `issues` non compare in tutto `apps/web/src`, verificato — quindi oggi quel campo
  viaggia per il solo `tests/integration/recordings.e2e.test.ts`. Mostrarle è il
  lavoro che manca; finché non c'è, la trascrizione stampata sotto il messaggio è
  l'unica cosa che racconta il resto.
- **La metà assistita della §9 non è provata contro un modello vero.** Il
  contratto, la verifica delle impronte, il rifiuto delle allucinazioni e il
  degrado hanno i loro test, ma tutti contro un fake che risponde ciò che il
  test ha deciso. Quanto valga davvero il prompt — se «Agenzia delle Entrate»
  sopravvive, se un indirizzo di ufficio non viene proposto, se un nome in mezzo
  a una frase storta si trova — non lo dice nessuna suite: lo direbbe una
  raccolta di schede vere annotate a mano, che non esiste. Finché non c'è, la
  qualità di quella passata è un'affermazione di questo README, non un risultato
  misurato.
- **La passata assistita non guarda ogni scheda, e nemmeno può.** Gira quando
  qualcuno apre la redazione, cioè quando ha già deciso di condividere. Una
  scheda con dentro il nome di un cliente che non viene mai condivisa non passa
  mai da lì, e il flag `contieneDatiSensibili` resta acceso senza che nessuno
  gli abbia dato un'occhiata. Farla girare all'ingestione avrebbe voluto dire
  una chiamata a pagamento per ogni vocale, quasi sempre su schede che nessuno
  condividerà.
- **Le sostituzioni sono segnaposto e basta.** «Mario Rossi» diventa `[nome]`,
  e due persone diverse nella stessa scheda diventano lo stesso `[nome]`: chi
  legge la procedura dopo non capisce più che erano due. Numerarli
  (`[nome 1]`, `[nome 2]`) avrebbe conservato la struttura e insieme un dato in
  più — quante persone distinte comparivano — che è esattamente ciò che una
  scheda condivisa non deve dire.
- **Ogni schermata ha dei casi, e non è la stessa cosa di ogni schermata
  provata.** I dodici file di `apps/web/src/screens` compaiono tutti in
  `tests/web`, più `NonSalvata` che sta dentro `App.tsx`: da qui in poi il
  debito non è più «quali schermate mancano» ma «quanto di ognuna è coperto», e
  la risposta cambia molto da una all'altra. Del dettaglio sono provati
  quattro
  punti su cinquecento righe — la voce che si butta, i tre esiti, le due porte
  verso altrove, i riferimenti che escono dall'app — e tutto ciò che sta in
  mezzo non ha nessun caso: i campi stampati, il sommario in cima, il blocco
  della trascrizione, i badge, il player dentro il riquadro del vocale. È una
  scelta, non una dimenticanza — quella roba, se sparisce, si vede aprendo la
  pagina — ma va detta per quello che è, perché «il dettaglio è provato» e «il
  dettaglio funziona» restano due frasi diverse. Dell'elenco e della ricerca si
  prova cosa chiedono al server e quali pulsanti sono spenti, non che le schede
  si vedano per intero. La più scoperta resta quella che nessun `jsdom` potrebbe
  coprire: che il pulsante di registrazione sia davvero collegato al microfono
  non lo dice nessun test, perché `MediaRecorder` in un ambiente finto è un
  oggetto che finge. Lo dice solo premerlo su un telefono vero.
- **Il ponte arriva al client vero, e si ferma sotto la schermata.**
  `client.e2e.test.ts` fa parlare l'`ApiClient` vero con il server vero, quindi
  un `fetch` che non allega l'header o una risposta che il client decodifica
  diversamente dal finto adesso si vedono. Ciò che resta scoperto è sopra e
  intorno. **Sopra:** React, gli hook e la coda offline restano davanti a un
  client finto, e che quel pulsante chiami *quel* metodo lo dice ancora soltanto
  un tipo TypeScript; il service worker non è eseguito da nessun test. **Il
  CORS:** dal Node dei test non parte mai un `Origin`, quindi il middleware non
  scatta e ciò che si verifica è la dichiarazione — che ogni intestazione mandata
  sia fra quelle consentite — non il rifiuto di un'origine estranea, che resta
  materia di `cors.e2e.test.ts` e di `fetch` a mano. **Ai lati:** la metà
  assistita della §9 non gira (il provider è spento, e la risposta dice
  `NON_CONFIGURATA`), la metà semantica della ricerca non si distingue da quella
  full-text perché gli embedding finti sono quasi ortogonali, il single-flight
  della rotazione è provato ma soltanto davanti a un `fetch` finto
  (`tests/unit/apiClient.test.ts`, «due richieste parallele condividono una sola
  rotazione»: due `me()` in `Promise.all`, entrambi `401`, e si conta una sola
  chiamata a `refresh`) — che due `401` in parallelo non brucino due token
  contro un server che la rilevazione del riuso ce l'ha per davvero non lo dice
  nessuno — e i byte
  dell'audio vengono da un `Blob` costruito a mano, non da `MediaRecorder`.
  Chiudere il primo residuo vorrebbe dire un browser pilotato, cioè una terza
  infrastruttura di test.
- **I minuti che restano sono una stima, non una misura.** L'avviso sopra il
  pulsante di registrazione moltiplica lo spazio libero per una costante di byte
  al secondo decisa a tavolino, perché `MediaRecorder` non dichiara il bitrate
  che userà. Su un browser che comprime meglio della costante l'avviso compare
  con dieci minuti di anticipo inutile; su uno che comprime peggio arriva tardi.
  Misurarlo davvero si potrebbe — la coda conosce durata e byte di ogni
  registrazione che ci è passata — ma vorrebbe dire tenere una media che al primo
  avvio non esiste ancora, cioè proprio quando serve.
- **Un audio non salvato vive solo finché l'app è aperta.** Se IndexedDB rifiuta
  la scrittura, la registrazione resta in memoria con tre uscite accanto, ma
  chiudere la scheda prima di sceglierne una la perde comunque. Non c'è modo di
  fare altrimenti: il posto durevole che avrebbe dovuto accoglierla è
  esattamente quello che ha detto di no.
- **L'audio si scarica passando dall'API.** `GET /api/recordings/:id/audio` legge
  da S3 e ristreamma: semplice, autenticato con lo stesso token di tutto il
  resto, e paga la banda due volte. Un URL prefirmato eviterebbe il doppio salto,
  ma sposterebbe l'autorizzazione dentro una firma con scadenza, e per ora non
  vale il cambio.
- **La scopa passa da sola, ma per default non porta via niente.** Il default è
  `elenca`: negli ambienti veri la passata avviene, ogni orfano finisce nel
  registro con la sua chiave e i suoi byte, e il bucket resta grande come prima.
  Recuperare lo spazio vuole ancora una mano — `SWEEP_MODE=cancella` nel
  pannello, o `npm run sweep -- --cancella` da un terminale — ed è voluto, perché
  quella mano è l'unica cosa che distingua «ho letto l'elenco» da «un processo
  ha deciso per me». Ma va detto per quello che è: il costo dello storage non
  scende finché qualcuno non lo chiede, e chi guarda solo la fattura non nota la
  differenza fra oggi e quando la scopa era spenta.
- **La scopa ha un bucket vero sotto, ma quel bucket è MinIO.** Adesso
  `docker-compose.yml` ha uno storage che parla S3, e con lui `S3StorageProvider`
  ha smesso di essere l'unico pezzo di produzione che nessun test eseguiva: la
  firma SigV4 scritta a mano viene calcolata contro un server che la verifica, il
  `continuationToken` è opaco e in base64 come sarà in produzione, e il
  segnalibro che la scopa rimanda indietro *dopo* aver cancellato le chiavi su cui
  si appoggia è provato invece che spiegato in un commento. Ma MinIO non è AWS, e
  non è R2 né B2 — sono proprio quei tre i posti in cui il provider girerà. Le
  differenze che restano fuori sono piccole e tutte nello stesso punto: come ogni
  servizio normalizza una chiave con caratteri strani, quanti oggetti mette
  davvero in una pagina, quale XML manda in un errore, e se ci sia una latenza
  fra un `put` e il `list` che dovrebbe vederlo — MinIO su un disco locale è
  immediato, un servizio distribuito no, e la regola 2 esiste apposta per quella
  finestra. Che la scopa non cancelli l'archivio di nessuno lo dice questo
  container; che non lo cancelli **su AWS** lo dirà la prima passata con
  `--cancella` spento contro un bucket vero.
- **La regola 2 della scopa resta provata solo in memoria.** «Abbastanza
  vecchio» ha i suoi casi in `storageSweep.test.ts` e `sweep.e2e.test.ts`, e tutti
  e due si appoggiano a `FakeStorageProvider.touch()` — invecchiare un oggetto è
  un potere che il finto ha e un bucket vero non dà a nessuno, perché la data la
  scrive il servizio. Contro MinIO il file S3 lavora quindi con una grazia
  negativa, cioè con la regola 2 disattivata: prova cosa succede *dopo*, non la
  soglia. Per provare la soglia contro un servizio vero servirebbe un test che
  aspetta, e un test che aspetta è un test che un giorno qualcuno toglie.
- **Il gesto che toglie tutte e due le cose sta in un posto solo.** È nella
  sezione «Da cosa nasce» del dettaglio, dentro il riquadro del vocale, ed è
  l'unico punto dell'app in cui la voce e la scheda che ne è nata sono sotto gli
  occhi insieme — quindi l'unico in cui la domanda «e la scheda?» si può porre a
  chi sa già quale scheda sia. L'elenco delle sospese ha un «Elimina» che toglie
  solo il vocale, e va bene così: quella lista mostra per costruzione ciò che non
  è ancora diventato una scheda. Ma se un giorno cambiasse filtro, quel pulsante
  tornerebbe a promettere più di quello che fa.
- **«Per sempre» è vero per l'applicazione, non per il disco.** Dal cestino la
  scheda sparisce davvero — i figli con lei per il `Cascade`, i vocali con la
  loro trascrizione, i byte dell'audio dal bucket — ma è una `DELETE`, non una
  cancellazione fisica: la riga resta nell'heap di Postgres finché non passa un
  `VACUUM`, resta nel WAL, e resta in qualunque copia di sicurezza fatta prima.
  E se lo storage non si lascia togliere l'oggetto — bucket irraggiungibile,
  credenziali scadute — chi ha premuto riceve comunque il suo `204`: quell'audio
  diventa un orfano, e l'unica cosa che può raccoglierlo è la scopa, che è un
  comando che qualcuno deve lanciare. La promessa che il pulsante fa a chi la
  legge è più forte di quella che il sistema mantiene, e la differenza si misura
  in giorni.
- **Svuotare un cestino grosso adesso finisce, ma non si vede finire.** Il tetto
  di cinquanta per richiesta e il ciclo dentro `ApiClient.emptyTrash()` hanno
  tolto il timeout: ogni `DELETE` dura al più quanto cinquanta schede, e chi ha
  premuto riceve un conto solo e completo. Restano due residui. Il primo è che
  fra la prima e l'ultima richiesta non c'è nessun avanzamento — il pulsante dice
  «Cancello…» e nient'altro, perché il ciclo sta sotto l'interfaccia e non ha modo
  di raccontarsi mentre gira; su duemila schede sono decine di richieste dietro
  una schermata che sembra ferma. Il secondo è che quel ciclo non riprende da
  solo: se la rete cade alla decima passata, le prime nove sono andate e le altre
  no, e chi guarda ritrova un cestino accorciato senza nessun messaggio che dica
  perché. Un'interruzione, insomma, adesso è più probabile di prima — sono tante
  richieste invece di una — e continua a costare esattamente quanto prima, cioè un
  altro tocco sul pulsante.
- **Il sospetto duplicato torna in coda, e la coda spende.** Cancellata la scheda
  a cui somigliava, quel vocale riparte da `BOZZA_AUDIO` con `nextAttemptAt`
  azzerato: alla passata successiva il worker rifà la trascrizione e
  l'estrazione, ripaga i token, e questa volta — non avendo più niente a cui
  somigliare — produce una scheda. Quasi sempre è ciò che si vuole, perché quel
  racconto nessuno ha mai deciso di buttarlo. Ma è l'unico punto
  dell'applicazione in cui cancellare qualcosa ne fa nascere un'altra, e non c'è
  nessuna schermata che lo dica prima.
- **L'opzione dà per scontato che i vocali siano uno.** `Procedure.recordings` è
  uno a molti, ma oggi `persistProcedure` crea sempre una scheda nuova, quindi
  due registrazioni non condividono mai un `procedureId` e il caso non si può
  presentare. Si presenterà il giorno in cui arriverà la risposta a
  `DUPLICATO_SOSPETTO` — «aggiorna quella esistente», che oggi nessuna rotta
  implementa — perché allora un secondo vocale punterà a una scheda già nata, e
  «il vocale e la scheda» premuto su uno dei due manderà in archivio una
  procedura che anche l'altro aveva prodotto, lasciandolo lì a puntare al
  cestino. Non c'è nessun controllo che lo impedisca, e nessuna schermata che
  avverta che i vocali erano due: chi scriverà quella rotta deve saperlo, ed è
  scritto qui perché non c'è un test che glielo dica.
- **La CI non ferma un deploy.** I test girano a ogni push, ma Railway e Netlify
  costruiscono ciò che sta su `master` appena ci arriva, senza chiedere niente a
  GitHub: un rosso è una notifica, non un cancello. Farlo diventare un cancello
  è un'impostazione delle due piattaforme, e sta da quella parte.
- **Del deploy si provano i nomi, non il comportamento — e per Railway nemmeno
  quelli.** `deploy.test.ts` garantisce che ogni script, percorso e rotta citati
  nei tre `.toml` esistano davvero da questa parte, e nessun test può dire che
  Netlify applichi quelle intestazioni a quelle risposte o che una CSP passi in
  un browser vero. Fin qui è il limite dichiarato. Quello che il primo deploy
  vero ha aggiunto è peggio: **i due `railway.toml` Railway non li legge
  affatto**, perché config-as-code è deprecata, e le impostazioni vere sono state
  digitate nel pannello. Quindi quei due file non sono più configurazione
  fraintendibile, sono una copia — e una copia che nessuno confronta con
  l'originale. Chi cambia `startCommand` qui vede il test verde e la produzione
  invariata, che è esattamente il modo di sbagliare da cui `deploy.test.ts` era
  nato per difendere. La via d'uscita è la Infrastructure as Code che Railway
  propone al suo posto (`.railway/railway.ts`, generabile con
  `railway config pull`): descriverebbe i servizi in TypeScript, dentro il
  typecheck, e `railway config plan` direbbe la differenza col vivo. Non è stata
  presa qui perché costa una dipendenza npm nuova (`railway`) e la riscrittura di
  `deploy.test.ts`, e perché il momento per farlo non è il giorno in cui si mette
  in piedi la produzione. È il debito più concreto di questo elenco.
- **Le due piattaforme chiedono cose che il repo non dice, e lo dicono male.**
  I due intoppi che hanno fermato il primo deploy avevano tutti e due un
  messaggio che parlava d'altro: `NODE_ENV=production` che fa saltare
  `@types/node` e produce un `TS2688` su un `tsconfig` che non è cambiato, e il
  worker che rifiuta di partire per un `CORS_ORIGINS` che non userà mai. Adesso stanno scritti nel
  README e nei due `.toml`, il che li rende ricordabili e non impossibili: non
  c'è nessun test che li provi, perché provarli vorrebbe dire costruire in un
  container con `NODE_ENV=production` — cioè avere una CI che ricostruisce
  l'ambiente di Railway, che è un progetto e non una riga.
- **I servizi girano dall'altra parte dell'oceano rispetto ai loro byte.** API e
  worker stanno in `us-west2`, il bucket dell'audio in `ams`: ogni upload e ogni
  riascolto attraversano l'Atlantico due volte. È successo in silenzio — la
  regione era stata chiesta come `europe-west4`, che Railway ha accettato senza
  errore e ignorato, perché l'identificatore giusto è `europe-west4-drams3a` — e
  si è visto solo rileggendo la configurazione generata. Con un database quasi
  vuoto spostare tutto costa poco; con un anno di registrazioni dentro costa una
  migrazione. Il difetto vero però non è la latenza, è che **una piattaforma ha
  accettato un valore che non sapeva applicare**, e l'unica difesa è rileggere
  ciò che si è impostato invece di fidarsi del fatto che la chiamata sia
  riuscita.

---

## Comandi

| | |
|---|---|
| `npm run build` | `tsc -b` su tutti i progetti |
| `npm run build:api` / `build:worker` | `prisma generate` + il sottoinsieme che serve — è ciò che gira su Railway |
| `npm run build:web` | shared + `vite build` — è ciò che gira su Netlify, senza Prisma |
| `npm run start:api` | `prisma migrate deploy` e poi l'API |
| `npm run start:worker` | il worker, senza migration |
| `npm run typecheck` | build + seed + test, senza emettere |
| `npm run dev` | shared in watch, api, worker e web insieme |
| `npm run dev:api` / `dev:web` / `dev:worker` | uno alla volta |
| `npm run db:migrate` | applica le migration e rigenera il client |
| `npm run db:migrate:create` | genera una migration **senza applicarla** |
| `npm run db:seed` | popola il database di sviluppo |
| `npm run db:reset` | ricrea il database da zero |
| `npm run db:studio` | Prisma Studio |
| `npm run sweep` | elenca gli oggetti che nessuna riga nomina più; `-- --cancella` per toglierli |
| `npm test` | unit + web, senza Docker |
| `npm run test:integration` | integration |
| `npm run preview --workspace @wikimylife/web` | la build vera, service worker compreso |
