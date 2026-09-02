# WikiMyLife

Trasforma note vocali in schede-procedura riutilizzabili: registri come hai fatto
una cosa, e la prossima volta la ritrovi scritta.

Siamo alla **Fase 2 — Pipeline di ingestione**: si carica un vocale e ne esce una
scheda. Sopra le fondamenta della Fase 1 (monorepo, schema dati, pgvector, seed,
`packages/shared`, autenticazione JWT) ci sono ora l'upload multipart, il worker,
la validazione deterministica della §5 e la deduplicazione per similarità coseno.

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
apps/web        Vite + React. Consuma packages/shared senza alias né polyfill.
packages/shared Codice isomorfo: contratti Zod, enum, interfacce, client API.
prisma/         Schema, migration, seed.
tests/          unit (senza Docker) e integration (con Postgres vero).
docs/           Le deviazioni dalla specifica, con le motivazioni.
```

`packages/shared` si importa come `@wikimylife/shared` grazie ai workspace npm:
nessun path alias, nessun `tsconfig-paths`. La build è `tsc -b` con project
references.

### Tre regole che vale la pena conoscere prima di scrivere codice

**1. `packages/shared` deve restare isomorfo.** Ci gira sopra sia il browser sia
Node, e in Fase 4 anche React Native. Non può contenere `window`, `document`,
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

## pgvector — la regola permanente sulle migration

`Procedure.embedding` è una colonna `vector(1536)`, che Prisma dichiara
`Unsupported`. Ne discende una cosa da sapere prima di toccare lo schema:

> **L'indice HNSW è invisibile alla drift detection di Prisma.** Ogni migration
> va generata con `--create-only`, l'SQL va letto, e ogni `DROP INDEX` o
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

### Schema e pgvector

```powershell
docker compose exec db psql -U wikimylife -d wikimylife -c "\dx"
#   → vector

docker compose exec db psql -U wikimylife -d wikimylife -c "\d+ \""Procedure\"""
#   → embedding | vector(1536)

docker compose exec db psql -U wikimylife -d wikimylife -c "SELECT indexname FROM pg_indexes WHERE tablename='Procedure';"
#   → Procedure_embedding_hnsw_idx
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
e la pipeline con un repository in memoria — compreso il duplicato rilevato.

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

`DATABASE_URL_TEST` non ha un valore di default, di proposito: i test fanno
`TRUNCATE`, e un default che puntasse al database di sviluppo lo svuoterebbe in
silenzio.

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
| `cors` `helmet` `rate-limit` | Fasi 4-5, quando servono davvero |
| `eslint` | il test di guardia copre le due regole che ci interessano |
| `uuid` `nanoid` | `node:crypto` |

---

## Cosa non c'è ancora, e si sa

- **Nessun rate limiting su `/api/auth/login`.** Accettabile in locale, da
  chiudere in Fase 5.
- **Il refresh token vive 30 giorni, l'access token 15 minuti.** Un access token
  già emesso resta valido fino alla scadenza anche dopo la revoca della famiglia:
  invalidarlo richiederebbe una lettura del database a ogni richiesta, cioè
  esattamente il costo che quel token esiste per evitare. La finestra di 15
  minuti è il limite, ed è una scelta.
- **`vector(1536)` accoppia lo schema a `text-embedding-3-small`.** Passare a
  `-large` (3072 dimensioni) richiede una migration e il re-embedding di tutte le
  procedure.
- **Il full-text non c'è.** Il `tsvector` deve coprire anche passi e trappole, che
  stanno in tabelle figlie: serve una colonna `searchText` mantenuta
  dall'applicazione. Il design SQL definitivo è già scritto in
  `docs/deviazioni-schema.md`, si applica in Fase 3.
- **Il suggerimento di duplicato si può solo scartare.** `POST /retry` cancella il
  suggerimento e riprocessa, ma "aggiorna quella esistente invece di crearne una
  nuova" richiede la rotta di modifica delle procedure, che è Fase 3.
- **Le schede non si leggono ancora via API.** `GET /api/recordings/:id` dice come
  è andata e dà il `procedureId`; per vedere la scheda serve Prisma Studio. Le
  rotte delle procedure sono Fase 3.
- **Nessun limite al numero di retry.** `retryCount` si incrementa e basta: un
  audio irrecuperabile può essere riprocessato all'infinito, a spese di chi paga
  le chiamate ai modelli.
- **La redazione dei dati sensibili (§9) non c'è.** `contieneDatiSensibili` viene
  rilevato e salvato, ma non produce ancora nessun comportamento.

---

## Comandi

| | |
|---|---|
| `npm run build` | `tsc -b` su tutti i progetti |
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
