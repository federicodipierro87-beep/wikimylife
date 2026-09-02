# WikiMyLife

Trasforma note vocali in schede-procedura riutilizzabili: registri come hai fatto
una cosa, e la prossima volta la ritrovi scritta.

Questa è la **Fase 1 — Fondamenta**: monorepo, schema dati, pgvector, seed,
`packages/shared` e autenticazione JWT completa. Non c'è ancora nessuna
trascrizione né estrazione reale — i provider hanno implementazioni fake che
rispettano le stesse interfacce che useranno quelle vere.

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

Poi, in due terminali:

```powershell
npm run dev:api    # http://localhost:3000
npm run dev:web    # http://localhost:5173
```

> **PowerShell**: `curl` è un alias di `Invoke-WebRequest` e non si comporta come
> curl. Negli esempi qui sotto si usa `curl.exe`.
>
> Se la porta 5432 è già occupata da un Postgres locale, mappa `5433:5432` in
> `docker-compose.yml` e allinea `DATABASE_URL` e `DATABASE_URL_TEST`.

---

## Com'è fatto

```
apps/api        Express 5 + Prisma. L'unico processo che parla col database.
apps/worker     Scheletro. In Fase 2 farà trascrizione ed estrazione.
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
non 403: un 403 confermerebbe che quell'id esiste. È scritto qui perché in Fase 2
arrivano le rotte delle procedure ed è lì che si sbaglia.

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

L'ultima parte è il comportamento più importante della fase. Quando un refresh
token già ruotato viene ripresentato, il server non può sapere chi sia il ladro:
se il token rubato arriva dopo la rotazione legittima ha una copia l'attaccante,
se arriva prima ce l'ha l'utente. In entrambi i casi la catena in circolazione è
compromessa, quindi si revoca l'intera famiglia e si costringe a rifare login.
Revocare solo il token riusato lascerebbe all'attaccante una catena valida per
trenta giorni.

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
client API e i provider fake.

**integration** applica le migration su `DATABASE_URL_TEST`, poi verifica lo
schema fisico contro il catalogo di Postgres, esegue il seed vero e ricontrolla
le invarianti, e prova l'autenticazione end-to-end su HTTP reale — l'app gira su
una porta effimera e ci si parla con `fetch`, che è il motivo per cui `supertest`
non è fra le dipendenze.

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

---

## Comandi

| | |
|---|---|
| `npm run build` | `tsc -b` su tutti i progetti |
| `npm run typecheck` | build + seed + test, senza emettere |
| `npm run dev` | shared in watch, api e web insieme |
| `npm run dev:api` / `dev:web` / `dev:worker` | uno alla volta |
| `npm run db:migrate` | applica le migration e rigenera il client |
| `npm run db:migrate:create` | genera una migration **senza applicarla** |
| `npm run db:seed` | popola il database di sviluppo |
| `npm run db:reset` | ricrea il database da zero |
| `npm run db:studio` | Prisma Studio |
| `npm test` | unit |
| `npm run test:integration` | integration |
