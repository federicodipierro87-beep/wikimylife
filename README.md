# WikiMyLife

Trasforma note vocali in schede-procedura riutilizzabili: registri come hai fatto
una cosa, e la prossima volta la ritrovi scritta.

Siamo alla **Fase 5 — Deploy**: API e worker su Railway, la build statica su
Netlify, l'audio su object storage compatibile S3, e il CORS ristretto al solo
dominio del frontend. Sotto ci sono le fondamenta della Fase 1 (monorepo, schema
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

---

## Com'è fatto

```
apps/api        Express 5 + Prisma. Riceve l'audio e risponde subito.
apps/worker     Secondo processo: trascrive, estrae, valida, persiste.
apps/web        PWA Vite + React. Consuma packages/shared senza alias né polyfill.
packages/shared Codice isomorfo: contratti Zod, enum, interfacce, client API.
prisma/         Schema, migration, seed.
tests/          unit (senza Docker) e integration (con Postgres vero).
docs/           Le deviazioni dalla specifica, con le motivazioni.
netlify.toml    Netlify serve file e nient'altro: redirect SPA e header.
apps/*/railway.toml   Come si costruisce e come parte ciascun servizio.
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
GET  /api/recordings/:id       stato di avanzamento
POST /api/recordings/:id/retry riprocessa dalla trascrizione → 202
```

L'API non elabora niente: salva i byte, scrive la riga, risponde. Il resto lo fa
il worker, che gira su `npm run dev:worker`.

**L'audio si salva prima di ogni altra cosa.** Prima i byte sullo storage, poi la
riga nel database — nell'ordine inverso una registrazione potrebbe puntare a un
file che non esiste. Se la trascrizione o l'estrazione cadono, la riga torna in
`BOZZA_AUDIO` con l'errore registrato e il worker la riprende da solo al giro
successivo: l'audio non si perde mai.

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
POST   /api/procedures/:id/executions  registra un'esecuzione (§8)
GET    /api/search?q=                  ricerca ibrida (§7)
```

**Le liste nascondono il cestino, ma non lo cancellano.** `DELETE` porta la
scheda in `ARCHIVIATA` e risponde `200` con la scheda archiviata, non `204`: c'è
ancora tutto da vedere, e la si recupera con una `PATCH` sullo stato. La lista
esclude le archiviate finché non le si chiede esplicitamente con
`?status=ARCHIVIATA`.

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

---

## L'app

Cinque schermate, un router a `hashchange` di trenta righe, nessuna libreria di
componenti e nessun framework CSS. Il bundle sta in **71 kB compressi**, foglio
di stile compreso.

```
apps/web/src/
  recording/   MediaRecorder, GPS, coda IndexedDB, svuotamento, contesto React
  screens/     login, registrazione, lista, ricerca, scheda, revisione
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

curl.exe http://localhost:3000/api/auth/me
#   → 401 UNAUTHORIZED
```

L'ultima parte è il comportamento più importante della Fase 1. Quando un refresh
token già ruotato viene ripresentato, il server non può sapere chi sia il ladro:
se il token rubato arriva dopo la rotazione legittima ha una copia l'attaccante,
se arriva prima ce l'ha l'utente. In entrambi i casi la catena in circolazione è
compromessa, quindi si revoca l'intera famiglia e si costringe a rifare login.
Revocare solo il token riusato lascerebbe all'attaccante una catena valida per
trenta giorni.

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

La §8 e la §9, in quattro chiamate:

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
npm test               # unit — nessun Docker, nessuna rete
npm run test:integration   # integration — richiede docker compose up -d
npm run typecheck      # tsc su tutti i progetti, incluso seed e test
```

I due gruppi sono project Vitest separati e non filtrati per nome file, perché la
promessa deve essere verificabile: se `npm test` avesse bisogno di un container,
il primo contributo di chiunque comincerebbe con mezz'ora di setup.

**unit** copre il contratto Zod (casi negativi con verifica del *path* della
issue, non solo del fallimento), le guardie sull'isomorfismo, i token, il
servizio di autenticazione con un repository in memoria, l'error handler, il
client API e i provider fake. Della Fase 2: la validazione della §5 caso per caso
(JSON malformato, ordine non contiguo, confidenza bassa, importi negativi,
`NOTA_SEMPLICE`), il prompt confrontato carattere per carattere con la specifica,
e la pipeline con un repository in memoria — compreso il duplicato rilevato. Della
Fase 3: la composizione di `searchText()`, la fusione RRF come funzione pura (che
l'accordo batta l'eccellenza in un canale solo, l'ordinamento a parità, il
degrado con un canale vuoto), le regole §8 e §9 del servizio delle procedure, e
l'orchestrazione della ricerca — incluso il provider di embedding che cade e non
deve portarsi via la risposta. Della Fase 4: lo svuotamento della coda (ordine di
invio, `drain()` rientrante, un 401 che marca invece di riprovare all'infinito,
una rete assente che lascia tutto in coda), le regole di presentazione con un
*adesso* fisso — un test che legge l'orologio di sistema fallisce da solo a
mezzanotte — e il giro rotta ⇄ hash ⇄ rotta. Della Fase 5: la firma SigV4 contro
i vettori ufficiali di AWS, e le regole di `loadConfig` che in produzione
rifiutano lo storage effimero, il CORS vuoto e i provider fake.

Le schermate non hanno test, e non c'è `jsdom` fra le dipendenze. È la ragione
per cui `format.ts`, `routes.ts` e `uploader.ts` esistono come moduli separati e
privi di DOM: lì sta tutto ciò che si può sbagliare in silenzio, e
`tsconfig.tests.json` non carica nemmeno la libreria DOM, così un modulo che
nomina `window` non è importabile da un test e la separazione non può marcire.

**integration** applica le migration su `DATABASE_URL_TEST`, poi verifica lo
schema fisico contro il catalogo di Postgres, esegue il seed vero e ricontrolla
le invarianti, e prova autenticazione e ingestione end-to-end su HTTP reale —
l'app gira su una porta effimera e ci si parla con `fetch`, che è il motivo per
cui `supertest` non è fra le dipendenze.

L'end-to-end delle registrazioni carica un multipart vero e poi esegue
`ingestionService.processNext()` in-process, sulle **stesse istanze** che servono
le richieste HTTP: un secondo `compose()` per i test avrebbe programmato provider
fake che nessuna richiesta usa. Tre cose si possono verificare solo lì: che
`Response.formData()` regga un corpo multipart vero, che il `<=>` di pgvector
serva davvero la deduplicazione, e che `@@unique([procedureId, ordine])` non
esploda sui passi rinumerati.

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

Il CORS si prova lì e non con un finto oggetto request, pur non toccando il
database: le cose che si rompono sono cose dello stack — un preflight che
attraversa il parser JSON e muore su un corpo vuoto, un `OPTIONS` che finisce nel
gestore delle rotte inesistenti, un'intestazione impostata dopo che la risposta è
già partita. Nessuna si vede chiamando la funzione middleware a mano.

`DATABASE_URL_TEST` non ha un valore di default, di proposito: i test fanno
`TRUNCATE`, e un default che puntasse al database di sviluppo lo svuoterebbe in
silenzio.

---

## Deploy

Tre servizi su Railway e un sito statico su Netlify. Niente Docker scritto a
mano, niente Functions, niente CI: il repo contiene solo file di configurazione
dichiarativi e comandi npm, e ogni comando che gira in produzione si può
eseguire in locale identico.

| Dove | Cosa | Come parte |
|---|---|---|
| Railway | Postgres con `pgvector` | template ufficiale, estensione creata dalla prima migration |
| Railway | `apps/api` | `apps/api/railway.toml` → `npm run start:api` |
| Railway | `apps/worker` | `apps/worker/railway.toml` → `npm run start:worker` |
| Netlify | `apps/web` (statico) | `netlify.toml` → `npm run build:web` |

I due `railway.toml` si attivano da **Settings → Config-as-code** del rispettivo
servizio, indicando il percorso del file. Entrambi i servizi puntano allo stesso
repo e allo stesso `DATABASE_URL`, e hanno `watchPatterns` diversi: un push che
tocca solo `apps/web` non fa ripartire niente su Railway.

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
| `PORT` | | | | ✓ | **non impostarla su Railway**: la impone la piattaforma |
| `LOG_LEVEL` | ✓ | ✓ | | ✓ | `info` in produzione |
| `DATABASE_URL` | ✓ | ✓ | | ✓ | su Railway è il riferimento al servizio Postgres, non un URL copiato |
| `DATABASE_URL_TEST` | | | | ✓ | solo `npm run test:integration`. Nessun default: i test fanno `TRUNCATE` |
| `CORS_ORIGINS` | ✓ | | | ✓ | in produzione il dominio Netlify. In locale `http://localhost:5173` |
| `JWT_ACCESS_SECRET` | ✓ | ✓ | | ✓ | ≥ 32 caratteri. Lo stesso valore nei due servizi |
| `ACCESS_TOKEN_TTL_MIN` | ✓ | | | ✓ | default 15 |
| `REFRESH_TOKEN_TTL_DAYS` | ✓ | | | ✓ | default 30 |
| `SIGNUP_ENABLED` | ✓ | | | ✓ | **`false` dopo aver creato il primo utente** |
| `STORAGE_PROVIDER` | ✓ | ✓ | | ✓ | `s3` in produzione, ed è obbligatorio |
| `S3_BUCKET` | ✓ | ✓ | | | obbligatoria con `s3` |
| `S3_REGION` | ✓ | ✓ | | | obbligatoria con `s3`. Su R2: `auto` |
| `S3_ACCESS_KEY_ID` | ✓ | ✓ | | | obbligatoria con `s3` |
| `S3_SECRET_ACCESS_KEY` | ✓ | ✓ | | | obbligatoria con `s3` |
| `S3_ENDPOINT` | ✓ | ✓ | | | vuoto = AWS. R2: `https://<account>.r2.cloudflarestorage.com` |
| `S3_FORCE_PATH_STYLE` | ✓ | ✓ | | | `true` solo per MinIO e simili |
| `STORAGE_DIR` | | | | ✓ | solo con `STORAGE_PROVIDER=local` |
| `TRANSCRIPTION_PROVIDER` | ✓ | ✓ | | ✓ | `openai` in produzione |
| `EXTRACTION_PROVIDER` | ✓ | ✓ | | ✓ | `anthropic` in produzione |
| `EMBEDDING_PROVIDER` | ✓ | ✓ | | ✓ | `openai` in produzione |
| `OPENAI_API_KEY` | ✓ | ✓ | | ✓ | trascrizione ed embedding |
| `ANTHROPIC_API_KEY` | ✓ | ✓ | | ✓ | estrazione |
| `TRANSCRIPTION_MODEL` | ✓ | ✓ | | ✓ | default `whisper-1` |
| `EXTRACTION_MODEL` | ✓ | ✓ | | ✓ | il nome del modello non è la versione del prompt |
| `EMBEDDING_MODEL` | ✓ | ✓ | | ✓ | accoppiato a `vector(1536)`: cambiarlo richiede una migration |
| `EMBEDDING_DIMENSIONS` | ✓ | ✓ | | ✓ | 1536 |
| `SEED_USER_EMAIL` `SEED_USER_PASSWORD` | | | | ✓ | il seed non gira in produzione |
| `VITE_API_URL` | | | ✓ | ✓ | il dominio Railway dell'API |

Le API delle chiavi le vede solo Railway: **le `VITE_*` finiscono nel bundle in
chiaro**, quindi su Netlify va un URL e nient'altro. E vale al momento della
build, non dell'avvio: cambiare `VITE_API_URL` richiede un nuovo deploy.

Il worker riceve `CORS_ORIGINS`? No, e non serve: non espone HTTP. Riceve invece
tutte le variabili dei provider e dello storage, perché è lui a chiamare Whisper
e Claude e a scrivere l'audio — l'API lo storage lo tocca solo per rileggere il
file da servire.

### Il primo deploy, nell'ordine

1. **Postgres** su Railway. La prima migration fa `CREATE EXTENSION vector`:
   non serve abilitarla a mano, ma serve un'immagine che ce l'abbia (il template
   Postgres di Railway va bene).
2. **API**: nuovo servizio dallo stesso repo, config-as-code `apps/api/railway.toml`,
   variabili della colonna `R`. Al primo avvio applica tutte le migration. Poi si
   genera un dominio pubblico — quello è `VITE_API_URL`.
3. **Primo utente**: con `SIGNUP_ENABLED=true`, un `POST /api/auth/signup`, e
   subito dopo la variabile a `false` e redeploy. Il seed non è un'alternativa:
   popola dati di esempio, e in produzione non ci vanno.
4. **Worker**: terzo servizio, config-as-code `apps/worker/railway.toml`,
   variabili della colonna `W`.
5. **Netlify**: si collega il repo, `netlify.toml` è già lì, si imposta
   `VITE_API_URL` e si fa il deploy. Il dominio che ne esce va in `CORS_ORIGINS`
   sull'API — e l'API va riavviata, perché la lista si legge all'avvio.

Il punto 5 è circolare per costruzione: il frontend ha bisogno del dominio
dell'API e l'API ha bisogno del dominio del frontend. Si rompe deployando prima
l'API, che con un `CORS_ORIGINS` provvisorio parte lo stesso.

---

## Dipendenze

Oltre allo stack imposto (TypeScript, Express, Prisma, Zod, React, Vite, Vitest)
ce ne sono **due**, entrambe conseguenza dell'autenticazione:

- **`jose`** — JWT HS256. Zero dipendenze transitive, ESM nativo.
  `jsonwebtoken` è CJS e ne porta sei.
- **`@node-rs/argon2`** — argon2id con binari napi precompilati: niente
  `node-gyp` su Windows né toolchain sul server.

Non installate, e il perché:

| Pacchetto | Al suo posto |
|---|---|
| `dotenv` | `process.loadEnvFile()` di Node ≥ 20.12 |
| `supertest` | `listen(0)` + `fetch`, quindici righe |
| `pino` | un logger JSON su stdout di venti righe |
| `cors` | trenta righe: `origin: true` non dev'essere scrivibile per sbaglio |
| `@aws-sdk/client-s3` | SigV4 a mano, novanta righe, provate sui vettori AWS |
| `helmet` `rate-limit` | non ancora: si veda «cosa non c'è ancora» |
| `eslint` | il test di guardia copre le due regole che ci interessano |
| `uuid` `nanoid` | `crypto.randomUUID()` |
| `react-router` | `hashchange`, trenta righe per cinque schermate |
| `@tanstack/react-query` | `useAsync`, venti righe: carica e ricarica |
| `vite-plugin-pwa` `workbox` | un service worker di sessanta righe |
| `tailwind` e simili | un foglio di stile di 2 kB compressi |
| `jsdom` `@testing-library` | la logica sta nei moduli puri, e quelli sono testati |

---

## Cosa non c'è ancora, e si sa

- **Nessun rate limiting su `/api/auth/login`.** Con `SIGNUP_ENABLED=false` e un
  solo utente la superficie è una password, ma resta che nessuno conta i
  tentativi. È la prima cosa da aggiungere se il dominio diventa pubblico.
- **Nessun header di sicurezza.** Niente `helmet`, niente CSP: l'API risponde
  solo JSON e l'HTML lo serve Netlify, quindi il rischio è basso, ma «basso» non
  è «zero» e la CSP andrebbe scritta in `netlify.toml`.
- **Il refresh token vive 30 giorni, l'access token 15 minuti.** Un access token
  già emesso resta valido fino alla scadenza anche dopo la revoca della famiglia:
  invalidarlo richiederebbe una lettura del database a ogni richiesta, cioè
  esattamente il costo che quel token esiste per evitare. La finestra di 15
  minuti è il limite, ed è una scelta.
- **`vector(1536)` accoppia lo schema a `text-embedding-3-small`.** Passare a
  `-large` (3072 dimensioni) richiede una migration e il re-embedding di tutte le
  procedure.
- **Il duplicato si fonde a mano.** `POST /retry` scarta il suggerimento e
  riprocessa; "aggiorna quella esistente invece di crearne una nuova" si fa con
  una `PATCH` sulla scheda indicata da `duplicateOfId`, leggendo l'estrazione
  dalla registrazione. Non esiste una rotta che unisca le due in un colpo solo,
  ed è voluto: la fusione è una decisione, e va vista prima di essere scritta.
- **La ricerca non pagina.** `GET /api/search` ha un `limit` e nessun `offset`:
  RRF fonde due classifiche troncate, e la pagina due di una fusione di due
  finestre diverse non è la continuazione della pagina uno. Servirà una strategia
  a cursore, non un `OFFSET`.
- **Nessun limite al numero di retry.** `retryCount` si incrementa e basta: un
  audio irrecuperabile può essere riprocessato all'infinito, a spese di chi paga
  le chiamate ai modelli.
- **La redazione dei dati sensibili (§9) non c'è.** `contieneDatiSensibili` viene
  rilevato e salvato, ma non produce ancora nessun comportamento.
- **Le schermate non hanno test automatici.** La logica che vale la pena
  verificare è stata spinta fuori dai componenti apposta, ma resta che nessuno
  controlla che il pulsante di registrazione sia collegato al microfono se non
  premendolo.
- **La coda offline non ha un tetto.** Registrare per un pomeriggio senza rete
  riempie IndexedDB finché il browser non rifiuta la scrittura, e in quel caso
  l'errore si vede ma la registrazione è persa.
- **L'audio si scarica passando dall'API.** `GET /api/recordings/:id/audio` legge
  da S3 e ristreamma: semplice, autenticato con lo stesso token di tutto il
  resto, e paga la banda due volte. Un URL prefirmato eviterebbe il doppio salto,
  ma sposterebbe l'autorizzazione dentro una firma con scadenza, e per ora non
  vale il cambio.
- **Nessuna pulizia dell'object storage.** `DELETE` su una scheda archivia la
  riga; l'oggetto S3 resta. È voluto — l'audio è l'originale, la scheda è la
  derivata — ma non c'è nessun processo che tolga i file delle registrazioni
  cancellate davvero, e nessuna lifecycle rule configurata.
- **Nessuna CI.** Nessuno esegue `npm test` prima di un deploy: Railway e Netlify
  costruiscono qualunque cosa stia su `master`. Una build che compila e dei test
  rossi sono compatibili.
- **Il deploy non è provato da nessun test.** `netlify.toml` e i due
  `railway.toml` sono documentazione eseguibile solo dalle piattaforme: un refuso
  in `startCommand` si scopre al primo deploy, non prima.

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
| `npm test` | unit |
| `npm run test:integration` | integration |
| `npm run preview --workspace @wikimylife/web` | la build vera, service worker compreso |
