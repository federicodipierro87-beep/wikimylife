# Deviazioni da `wikimylife-schema.md`

`wikimylife-schema.md` è la specifica autoritativa. Questo documento elenca **ogni** punto in cui
`prisma/schema.prisma` e `packages/shared` si discostano dalla sezione 6 (schema dati) e dalla
sezione 4.1 (contratto di estrazione), con la motivazione.

Ogni deviazione ha un marcatore `[Dn]` che compare come commento `///` accanto al campo o al modello
nello schema Prisma. Cercare `[D` nello schema restituisce l'elenco completo: se una riga di questo
documento non ha corrispondenza nello schema, o viceversa, una delle due è rimasta indietro.

**Regola per le fasi successive:** nessuna deviazione senza una voce qui. Una colonna aggiunta in
silenzio è una colonna che fra sei mesi nessuno saprà spiegare.

---

## Riepilogo

| | Deviazione | Tipo |
|---|---|---|
| [D1](#d1) | `CardStatus` += `ESTRAZIONE_FALLITA` | correzione di una omissione |
| [D2](#d2) | enum `RecordingStatus` + `Recording.status` | separazione di due cicli di vita |
| [D3](#d3) | `Recording.lastErrorCode/lastErrorMessage/lastErrorAt/retryCount` + `@@index([status])` | modellazione di un requisito già scritto |
| [D4](#d4) | `User.passwordHash` | conseguenza dell'auth in Fase 1 |
| [D5](#d5) | modello `RefreshToken` | conseguenza dell'auth in Fase 1 |
| [D6](#d6) | `Tag.user` (relazione inversa) | correzione di uno scalare orfano |
| [D7](#d7) | `Recording.mimeType/sizeBytes/deviceLocale/updatedAt` | requisiti del testo assenti dallo schema |
| [D8](#d8) | tre campi `nullable` in più nel contratto §4.1 | lettura del preambolo della §4 |

Tutto il resto è invariato: `Procedure` (incluso `status @default(BOZZA_AUDIO)`), `Step`,
`Prerequisite`, `Pitfall`, `Cost`, `Reference`, `Attachment`, `Execution`, `Tag`,
`TagOnProcedure`, `Scope`, `Visibility`, `PrereqType`, `Severity`, `RefType`, `Outcome`.

---

<a id="d1"></a>
## D1 — `ESTRAZIONE_FALLITA` in `CardStatus`

**Cosa.** Aggiunto un sesto valore all'enum `CardStatus`.

**Perché.** La §5 lo nomina esplicitamente — *«un solo retry, poi stato `ESTRAZIONE_FALLITA`»* — ma
l'enum della §6 ne elenca cinque e quello non c'è. È una omissione della specifica, non una scelta:
senza il valore, la frase della §5 non è implementabile.

---

<a id="d2"></a>
## D2 — `RecordingStatus` separato, e `Recording.status`

**Cosa.**

```prisma
enum RecordingStatus { BOZZA_AUDIO IN_ELABORAZIONE ESTRAZIONE_FALLITA ESTRATTO }

model Recording {
  status RecordingStatus @default(BOZZA_AUDIO)
}
```

Lo stato dell'elaborazione vive sul `Recording`. La `Procedure` conserva il proprio `CardStatus`, che
descrive il ciclo di vita della **scheda** (`DA_RIVEDERE → COMPLETA → ARCHIVIATA`).

**Perché.** La §6 ha un solo enum di stato e lo mette sulla `Procedure`. Ma la §1 dice che *«lo
stadio 1 non fallisce mai»*: l'audio viene sempre salvato, anche offline, anche se poi trascrizione o
estrazione falliscono. Con un solo enum sulla `Procedure`, registrare un fallimento richiede una
`Procedure` — che ha `titolo String` NOT NULL. Ma se l'estrazione è fallita il titolo *non esiste*,
perché è l'estrazione a produrlo.

Le due uscite possibili erano entrambe peggiori:

- rendere `titolo` nullable, cioè permettere schede senza titolo in tutta l'applicazione per
  rappresentare uno stato transitorio che l'utente non deve nemmeno vedere;
- inventare un titolo segnaposto (`"(estrazione fallita)"`), cioè scrivere spazzatura nella tabella
  che l'utente legge.

Separare i due cicli di vita risolve entrambe. In più il tipo diventa un vincolo reale: `card_status`
e `recording_status` sono due tipi Postgres distinti, quindi assegnare uno stato di elaborazione a
una scheda non è un bug da scoprire in produzione, è un errore di compilazione TypeScript **e** un
errore di tipo SQL.

Il diagramma della §8 si legge quindi su due tabelle:

```
Recording:  BOZZA_AUDIO → IN_ELABORAZIONE →┬→ ESTRATTO → crea Procedure
                  ↑                        └→ ESTRAZIONE_FALLITA
                  └──────── retry ──────────────────┘

Procedure:  DA_RIVEDERE → COMPLETA → ARCHIVIATA
                  ↑           │
                  └ Execution(CAMBIATA) ┘
```

I valori comuni ai due enum (`BOZZA_AUDIO`, `IN_ELABORAZIONE`, `ESTRAZIONE_FALLITA`) sono duplicati
di proposito: `CardStatus` li conserva perché la §6 li elenca e perché una scheda in Fase 2 potrà
nascere in `IN_ELABORAZIONE` durante un ri-arricchimento.

`prisma/seed/recordingC.ts` esiste solo per rendere questa deviazione verificabile: un `Recording`
con `procedureId: null` e `status: ESTRAZIONE_FALLITA`. Se qualcuno tornasse alla lettura letterale
della §6, quel seed non compilerebbe più.

---

<a id="d3"></a>
## D3 — Campi d'errore sul `Recording`, e indice su `status`

**Cosa.**

```prisma
lastErrorCode    String?
lastErrorMessage String?   @db.Text
lastErrorAt      DateTime?
retryCount       Int       @default(0)

@@index([status])
```

**Perché.** La §1 chiede che il fallimento sia *«registrato con l'errore»* e la §5 impone *«un solo
retry»*. Nessuna delle due cose è modellata nella §6. Senza `retryCount` la regola del retry singolo
non è applicabile in modo affidabile: contare i tentativi in memoria del worker significa perderli a
ogni riavvio, e il riavvio è esattamente il caso in cui i retry si moltiplicano.

`lastErrorMessage` è `@db.Text` e non `String` perché ci finiscono messaggi di provider, che sono
lunghi. Non contiene mai dati dell'utente: è testo diagnostico.

L'indice su `status` serve alla query di polling del worker (*«dammi i prossimi N
`BOZZA_AUDIO`»*), che è la query più frequente dell'intero sistema in Fase 2. Senza indice diventa
un sequential scan che cresce con lo storico.

---

<a id="d4"></a>
## D4 — `User.passwordHash`

**Cosa.** Una colonna in più su `User`.

**Perché.** La §6 definisce `User { id, email, locale, createdAt }` — un utente che non può
autenticarsi. Il piano di Fase 1 include l'autenticazione completa, quindi la credenziale deve stare
da qualche parte.

È la deviazione minima possibile: una colonna, nessuna tabella nuova, nessun campo di stato
(`emailVerified`, `lastLoginAt`, `failedAttempts`) che non serve ancora. Il valore è un hash
argon2id completo di parametri e salt — la stringa `$argon2id$v=19$m=19456,t=2,p=1$...` è
autodescrittiva, quindi cambiare i parametri in futuro non richiede una migration.

---

<a id="d5"></a>
## D5 — Modello `RefreshToken`

**Cosa.** Un modello nuovo, assente dalla §6.

```prisma
model RefreshToken {
  tokenHash    String  @unique
  familyId     String
  expiresAt    DateTime
  revokedAt    DateTime?
  replacedById String? @unique
}
```

**Perché.** Un refresh token deve essere **revocabile**, e un token revocabile deve esistere da
qualche parte sul server. Da questo discende tutto il resto:

- **Il refresh token non è un JWT.** È `randomBytes(32)` in base64url. Un JWT di refresh richiederebbe
  comunque una lettura del database per verificare la revoca — quindi aggiungerebbe solo la
  superficie della firma e il rischio di un `alg: none`, senza togliere nulla.
- **Si conserva `sha256(token)`, non il token.** Un dump del database non permette di impersonare
  nessuno. Non argon2: l'input ha già 256 bit di entropia, non è una password da proteggere da un
  attacco a dizionario, e argon2 su ogni refresh costerebbe ~50 ms per niente.
- **`familyId`** lega tutti i token discendenti da uno stesso login. Serve alla *reuse detection*: se
  arriva un token già ruotato, o è un bug del client o è un furto, e in entrambi i casi la risposta
  corretta è uccidere l'intera catena, non solo l'anello presentato.
- **`replacedById`** rende la catena ispezionabile: dato un token si risale alla rotazione che lo ha
  sostituito. `@unique` perché un token può sostituirne al più uno.

`onDelete: Cascade` verso `User` è l'unico cascade dello schema: le sessioni non hanno senso senza
l'utente, mentre le procedure sì (cancellare un utente non deve poter cancellare in silenzio anni di
schede — quella è una decisione di prodotto, non di schema).

---

<a id="d6"></a>
## D6 — `Tag.user`

**Cosa.** Aggiunta la relazione, non il campo:

```prisma
model Tag {
  userId String
  user   User   @relation(fields: [userId], references: [id])
}
```

**Perché.** La §6 dichiara `Tag.userId` come scalare senza `@relation` e senza lato inverso su
`User`. Prisma accetta uno scalare orfano, ma il risultato è una foreign key che il database non
conosce: nulla impedisce un `Tag` con un `userId` inesistente, e non esiste `user.tags`.

Dato che l'unicità è `@@unique([userId, nome])`, i tag sono per definizione per-utente. La relazione
esplicita è quindi l'intenzione già presente nella specifica, semplicemente non scritta.

---

<a id="d7"></a>
## D7 — `Recording.mimeType`, `sizeBytes`, `deviceLocale`, `updatedAt`

**Cosa.** Quattro colonne in più su `Recording`.

**Perché.** `mimeType` e `deviceLocale` non sono aggiunte: sono requisiti scritti nel testo della §2
fra i metadati di cattura, che la §6 non riporta.

- **`mimeType String`** (non nullable). Il contenitore audio dipende dalla piattaforma:
  `MediaRecorder` nel browser produce `audio/webm;codecs=opus`, un recorder iOS produce `audio/mp4`.
  Il provider di trascrizione ha bisogno di saperlo. Non nullable perché il client lo conosce sempre
  — è il `type` del `Blob` che ha appena prodotto — e un default lato server sarebbe una supposizione.
  Il seed contiene entrambi i casi proprio per non lasciare che qualcuno assuma `webm`.
- **`sizeBytes Int?`** — nullable, perché su un caricamento in streaming la dimensione si conosce
  solo alla fine. Serve alle quote e a diagnosticare i caricamenti troncati.
- **`deviceLocale String?`** — è la lingua attesa dallo STT. Passarla al provider evita che una nota
  in italiano venga trascritta come inglese storpiato, che è il modo più comune in cui la
  trascrizione automatica fallisce senza dare errore.
- **`updatedAt DateTime @updatedAt`** — il `Recording` è mutabile durante l'elaborazione (stato,
  trascrizione, estrazione, errori). `createdAt` da solo non permette di sapere quando un record si è
  piantato: un `IN_ELABORAZIONE` con `updatedAt` di due ore fa è un lavoro orfano, e questa è la
  query che in Fase 2 recupera i job persi.

---

<a id="d8"></a>
## D8 — Tre campi `nullable` in più nel contratto §4.1

**Cosa.** In `packages/shared/src/extraction/contract.schema.ts`:

| Campo | §4.1 | Zod |
|---|---|---|
| `passi[].durataStimataMin` | `1` (numero d'esempio) | `z.number().int().nullable()` |
| `durataTotaleStimataMin` | `0` (numero d'esempio) | `z.number().int().nullable()` |
| `ambitoSuggerito` | `"PERSONALE \| LAVORO \| CLIENTE"` | `z.enum(scopeValues).nullable()` |

**Perché.** Il preambolo della §4.1 è esplicito: *«Ogni campo non deducibile dal parlato vale `null`
— mai un'invenzione plausibile»*, e la regola 1 del prompt della §4.2 la ripete. Nel blocco JSON
questi tre campi sono scritti come valori d'esempio invece che come unioni con `null`, ma quella è la
notazione del blocco, non un'eccezione alla regola.

Il caso concreto è nel seed: nella procedura B il passo *«chiedere all'help desk di forzare la
risincronizzazione»* ha durata realmente ignota, dipende dalla coda dell'help desk. Le alternative a
`null` erano `0` (falso: non è istantaneo) o un numero inventato — cioè esattamente quello che la
regola 1 vieta.

Gli altri campi restano fedeli alla lettera: `luogo.confermatoDaGps` è `boolean` e non nullable
perché il GPS o ha confermato o no, `tag` è un array che può essere vuoto ma non assente,
`_meta.confidenzaGlobale` è sempre un numero.

### Nota di lettura: `.nullable()` e mai `.optional()`

Non è una deviazione, è la regola di traduzione applicata ovunque. Dove il contratto dice
`"string | null"`, lo schema Zod usa `.nullable()`: **la chiave deve esserci**. Così restano
distinguibili due situazioni molto diverse:

- valore `null` → il modello ha capito che il campo non è deducibile. Dato corretto.
- chiave assente → il modello si è dimenticato il campo. Difetto del prompt, da correggere.

Con `.optional()` i due casi collasserebbero in uno e il secondo diventerebbe invisibile.

### Nota di lettura: Zod valida solo la forma

`extractionContractSchema` verifica la **struttura**, non il **dominio**. Le regole della §5 —
ordine dei passi contiguo, titolo sotto gli 80 caratteri, importi non negativi, soglia di confidenza
— sono validazione di dominio e arrivano in Fase 2, in un modulo separato.

Non è pigrizia: confondere i due livelli renderebbe impossibile fare esattamente quello che la
specifica chiede, cioè **salvare in `DA_RIVEDERE` un JSON formalmente valido ma incompleto**. Se Zod
rifiutasse un'estrazione con i passi numerati `1, 2, 4`, quell'estrazione andrebbe persa invece di
finire davanti all'utente con un suggerimento gentile.

---

## Rimandato alla Fase 3: la ricerca full-text (§7)

La §7 chiede ricerca full-text in italiano oltre a quella semantica. **Non è implementata in Fase 1**,
ma il disegno è deciso ora perché condiziona il modo in cui la Fase 2 scriverà le procedure.

### Perché non basta un `tsvector` generato

La soluzione ovvia — una colonna generata sul modello `Procedure` — non funziona:

```sql
-- NON funziona
ALTER TABLE "Procedure" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('italian', coalesce(titolo,'') || ' ' || coalesce(trigger,''))) STORED;
```

Postgres richiede che l'espressione di una colonna generata sia `IMMUTABLE` e limitata alla **riga
corrente**. Ma le cose che si cercano davvero — *«quella cosa dove poi si scopriva che serviva la
marca da bollo»* — stanno nei **passi** e nelle **trappole**, cioè in `Step` e `Pitfall`, che sono
tabelle figlie. Una subquery in una colonna generata è vietata.

(In più `to_tsvector('italian', ...)` con la configurazione passata come letterale è `IMMUTABLE`, ma
la variante a un argomento non lo è, perché dipende da `default_text_search_config`. La
configurazione va sempre scritta esplicitamente.)

### Il disegno deciso

Una colonna `searchText` denormalizzata, **mantenuta dall'applicazione**, più un `tsvector` generato
sopra di essa:

```sql
ALTER TABLE "Procedure" ADD COLUMN "searchText" text NOT NULL DEFAULT '';

ALTER TABLE "Procedure" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('italian', "searchText")) STORED;

CREATE INDEX "Procedure_searchVector_idx" ON "Procedure" USING gin ("searchVector");
```

`searchText` viene ricomposto dall'applicazione ogni volta che la procedura o una delle sue righe
figlie cambia, con la stessa funzione unica in `packages/shared` — l'equivalente testuale di
`embeddingInput()`:

```
titolo
trigger
esito
azione + dettaglio di ogni passo
descrizione di ogni prerequisito
descrizione di ogni trappola
nomi dei tag
```

Il `tsvector` resta generato e non mantenuto a mano: così è impossibile che vada fuori sincrono
rispetto a `searchText`, e l'unico punto di verità applicativa è una funzione pura e testabile.

**Nota sulle procedure con `contieneDatiSensibili: true`:** entrano nell'indice normalmente. La
sensibilità limita la *condivisione* (§5), non la ricercabilità da parte del proprietario. La query
di ricerca filtra sempre per `userId`, come ogni altra query — vedi la regola di ownership nel README.

### Ranking

`ts_rank_cd` con pesi per sezione (`setweight`): titolo `A`, trigger `B`, passi `C`, il resto `D`.
Con `searchText` come singola stringa i pesi si perdono; se in Fase 3 serviranno davvero, `searchText`
diventerà quattro colonne (`searchTitle`, `searchTrigger`, `searchSteps`, `searchRest`) e il
`tsvector` generato le comporrà con `setweight`. La decisione si può prendere allora: non cambia
nulla di quello che la Fase 2 deve scrivere oggi.

---

## Nota operativa: l'indice HNSW è invisibile a Prisma

Non è una deviazione dallo schema ma è la conseguenza più pericolosa di averlo scelto, quindi sta
scritta anche qui oltre che nel README.

`Procedure.embedding` è `Unsupported("vector(1536)")`. L'indice
`Procedure_embedding_hnsw_idx` è creato da una migration scritta a mano e **il drift detection di
Prisma non lo vede**: una `prisma migrate dev` fatta senza pensarci può generare un `DROP INDEX`, e
il risultato non è un errore ma una ricerca semantica che diventa lentissima in silenzio.

Difese, in ordine:

1. **Sempre `prisma migrate dev --create-only`** (script `db:migrate:create`), poi leggere l'SQL
   generato e cancellare ogni `DROP INDEX` / `DROP EXTENSION` non voluto.
2. `tests/integration/schema.test.ts` verifica estensione, tipo della colonna e presenza dell'indice.
   È la rete che prende quello che sfugge alla regola 1.
