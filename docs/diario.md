# Diario di lavoro

La cronaca dei giri di rifinitura: cosa è stato fatto, in quale commit, e
soprattutto **perché è stato fatto così** invece che nell'altro modo.

Questo file **non** viene caricato all'avvio di una sessione, e non va richiamato
da `CLAUDE.md` con un `@import` — un import lo rimetterebbe nel contesto di ogni
avvio, che è il problema che questo file esiste per risolvere. Si apre quando
serve: quando si tocca qualcosa e si vuole sapere se ci si è già scottati lì.

Le lezioni di metodo che valgono **oltre** il giro in cui sono nate non stanno
qui: sono state distillate nella sezione «Lezioni di metodo» di `CLAUDE.md`, che
si legge sempre. Qui resta il racconto, con i numeri e i nomi dei file.

I giri sono in **ordine cronologico, dal più vecchio al più recente**. Prima si
chiamavano «l'ultimo», «il penultimo», «quello appena chiuso»: nomi che
invecchiano da soli e che infatti erano diventati falsi — la sezione intitolata
«ultimo giro concluso» era la più vecchia delle tre. Un giro si nomina per i suoi
commit, non per la sua distanza da oggi.

| | giro | commit | unit + web | integrazione |
|---|---|---|---|---|
| 1 | scopa, cestino, dispositivi, dettaglio | `2499602` → `797d1d1` | 921 su 44 file | 305 su 11 file |
| 2 | MinIO, cestino in un gesto, sessioni, ponte | `8d5f608` → `024ea02` | 959 su 44 file | 367 su 14 file |
| 3 | le tre schermate scoperte, cestino grosso, una sessione | `36a6f8c` → `b904141` | 1050 su 47 file | 380 su 14 file |
| — | il primo deploy vero | `f847ebb` | invariati | invariati |
| — | i due difetti trovati dalla produzione | `5e2a772`, `9c5c587` | 1064 su 47 file | 381 su 14 file |
| 4 | i tag duplicati, l'elenco che si accorge, le categorie, il microfono | `2c184ba` → `HEAD` | 1145 su 49 file | 392 su 14 file |

---

## I difetti noti falsi, tutti quanti

`CLAUDE.md` vieta di scrivere «non è provato che X» senza un `grep` prima. La
regola esiste perché è stata violata sei volte, e l'elenco sta qui perché una
regola con sotto i suoi cadaveri si dimentica meno.

| | scritto | perché era falso | trovato da |
|---|---|---|---|
| 1 | «nessun test d'integrazione prova che `CAMBIATA` riporti la scheda in `DA_RIVEDERE`» | il test esisteva, `tests/integration/procedures.e2e.test.ts:713` | una rilettura |
| 2 | «il single-flight della rotazione non è provato sotto concorrenza» | `tests/unit/apiClient.test.ts:292` lo prova, davanti a un `fetch` finto | una rilettura |
| 3 | «di schermate ne sono provate sette» | erano nove: mancavano all'elenco `account.test.tsx` e `trash.test.tsx` | una rilettura |
| 4 | «`ReviewScreen`, dove si decide cosa fare di un duplicato sospetto» | `DUPLICATO_SOSPETTO` non compare in `ReviewScreen`: è un'etichetta di stato in `format.ts:213` | la scrittura dei test |
| 5 | «il worker non ha bisogno di `CORS_ORIGINS`: non espone HTTP» | `loadConfig` è condiviso e non sa chi lo chiama | il processo che non partiva |
| 6 | «la scopa rimette in coda le righe ferme da troppo tempo, ma la lancia un umano» | due affermazioni, tutte e due false: la scopa gira da sola nel ciclo del worker (`sweepSchedule.ts`), e guarda i file del bucket, non le righe | un `grep` fatto dopo aver scritto la frase |

Tre cose che questo elenco dice e le singole voci no. La quarta è stata scritta
**dentro il commit che correggeva la seconda e la terza**, tre righe sotto la
regola — e veniva dal riassunto di un agente di ricerca, preso per buono senza
verificarlo. La quinta non l'ha trovata nessuna rilettura: l'ha trovata la
produzione, rifiutandosi di avviarsi. La sesta è l'unica scritta in un difetto
noto *nuovo*, cioè nel posto dove si dichiarano i debiti: sbagliarla lì significa
descrivere una riparazione che non esiste, e mandare il prossimo a cercarla.

---

## Giro 1 — scopa, cestino, dispositivi, dettaglio

Quattro attività scelte dall'elenco dei difetti noti, quattro commit separati.

| | | commit |
|---|---|---|
| 1 | test d'integrazione della scopa contro un Postgres vero | `2499602` |
| 2 | svuotare il cestino: `DELETE` vero, figli, vocali e byte | `8323a97` |
| 3 | «scollega tutti i dispositivi» senza cambiare password | `605c34f` |
| 4 | i test della schermata di dettaglio | `797d1d1` |

Stato alla fine del giro: typecheck verde sui quattro passaggi, **921 test**
unit + web su 44 file, **305** d'integrazione su 11 file, albero pulito.

Il quarto ha portato `tests/web/detail.test.tsx` da 8 a 26 casi, sui quattro
punti in cui quella schermata decide qualcosa invece di stampare un campo: la
voce che si butta, i tre esiti della §8, le porte verso redazione e revisione, i
riferimenti che escono con `rel="noreferrer noopener"`. Ventitré mutazioni,
ventitré cadute.

---

## Giro 2 — MinIO, cestino in un gesto, sessioni, ponte

Quattro attività scelte dall'elenco dei difetti noti, una per commit.

| | | stato |
|---|---|---|
| 1 | MinIO sotto la scopa: uno storage vero nei test d'integrazione | fatto, `8d5f608` |
| 2 | svuotare il cestino in un gesto solo | fatto, `9fb2126` |
| 3 | l'elenco delle sessioni aperte, con la sola data di nascita | fatto, `c9184c0` |
| 4 | il ponte fra il client vero e il server vero | fatto, `024ea02` |

### 1 — fatto

`8d5f608`, «un bucket vero sotto il provider che nessun test eseguiva». MinIO in
`docker-compose.yml`, `tests/integration/helpers/storage.ts`, e due file nuovi:
`storage.s3.e2e.test.ts` (14 casi) e `sweep.s3.e2e.test.ts` (4). Da **305 su 11
file** a **323 su 13**. Ventidue mutazioni, tutte cadute.

Una di quelle mutazioni ha lasciato un segno: con `delete` ridotta a un no-op,
`svuotaIlBucket` girava per sempre, e la mutazione moriva dopo trentaquattro
minuti invece di quaranta secondi. Adesso quel ciclo ha un tetto di venti scorse.

Le cinque righe `S3_*_TEST` da aggiungere a mano al proprio `.env` sono nate qui.
Sono ancora da fare, e stanno in `CLAUDE.md` insieme al giro d'aiuto.

### 2 — fatto

`9fb2126`, «svuotare il cestino in un gesto solo, e sapere quante ne sono
andate». Il codice di produzione era già scritto e compilava dal giro prima;
questa sessione ha aggiunto i **sessantatré casi** che mancavano, sui quattro
project: il servizio, il client, la schermata, e la rotta contro Postgres.

Stato a questo commit: typecheck verde sui quattro passaggi, **943 test**
unit + web su 44 file, **332** d'integrazione su 13 file, albero pulito.

Le tre decisioni che il diff non racconta — una scheda per volta invece di una
`deleteMany`, `ASSENTE` e `NON_ARCHIVIATA` contate come `saltate`, il pulsante
montato fuori dal ramo dell'elenco — stanno nel README, in «Leggere,
modificare, cercare» e nella sezione della schermata. Qui non si ripetono.

Trenta mutazioni, ventinove cadute al primo giro. **La sopravvissuta va
ricordata**, perché è il tipo di buco che si rifà da solo: tolto il
`return null` anticipato di `SvuotaIlCestino`, il riquadro restava nel DOM
vuoto, e siccome `.svuota` ha un `border-top` disegnava una riga che separava
«Il cestino e' vuoto.» da niente. Nessun caso lo vedeva, perché tutti cercavano
il *pulsante* — che ha una sua condizione e spariva lo stesso. Il caso nuovo
guarda il contenitore (`container.querySelector(".svuota")`), come già fa
`pending.test.tsx`, e quella mutazione cade.

### 3 — fatto

`c9184c0`, «vedere quali dispositivi sono collegati, e da quando».
`GET /api/auth/sessions` e l'elenco dentro la sezione «Scollega gli altri
dispositivi», non in una sezione sua. Ventidue casi nuovi su quattro project:
sei nel servizio, tre nel client, sette nella schermata, sei — poi sette, con
l'ordine — contro Postgres.

Stato a questo commit: typecheck verde sui quattro passaggi, **959 test**
unit + web su 44 file, **338** d'integrazione su 13 file, albero pulito.

Le due decisioni prese con l'utente prima di scrivere, e che il diff non
racconta: **solo l'elenco**, niente «chiudi questa sessione» per riga; e la
**data di nascita** (`MIN(issuedAt)` su tutta la famiglia) e non l'`issuedAt`
della riga viva, che sarebbe «ultimo accesso» sotto un altro nome. Entrambe
stanno nel README, insieme alla ragione delle due interrogazioni nell'adattatore
invece di una. Qui non si ripetono.

La prima delle due è stata **ribaltata** nel giro dopo, dall'utente: vedi
«Giro 3 — attività 4».

Due cose emerse strada facendo, che vale la pena ricordare:

- Il nome `session` era già occupato: `authSessionSchema` è la sessione di
  login (utente + token). Il contratto nuovo si chiama `openSession*`, e la
  porta restituisce `OpenSessionRecord`.
- Il piano diceva di mettere i casi della rotta in `tests/unit/routes.test.ts`.
  Quel file prova il router **a hash del web**, non le rotte Express — che
  nessun test unitario tocca. I casi della rotta sono finiti
  nell'integrazione, quelli di percorso e verbo in `apiClient.test.ts`.

Ventiquattro mutazioni, ventiquattro cadute. Una è sopravvissuta al primo giro
perché *equivalente*, non perché il test fosse debole: lo `userId` è scritto in
tutte e due le interrogazioni — quella che trova le famiglie vive e quella che
ne calcola la nascita — e toglierlo da una sola non cambia il risultato. È da qui
che nasce la regola sulle mutazioni a più punti, ora in `CLAUDE.md`.

### 4 — fatto

La domanda aperta è stata chiusa dall'utente: **niente Playwright**. Il ponte è
l'`ApiClient` vero contro il server HTTP vero, in Node, senza schermata sopra —
ampiezza «il giro intero più una guardia», e il CORS provato come dichiarazione e
non come applicazione.

Un file solo, `tests/integration/client.e2e.test.ts`, **29 casi** in sei
blocchi: la sessione, la rotazione dopo un 401, il giro completo della scheda,
le risposte senza corpo e il cestino, le intestazioni sul filo, la guardia.
Niente altro toccato: né il client né il server.

Stato a questo commit: typecheck verde sui quattro passaggi, **959 test**
unit + web su 44 file (invariati, com'era giusto), **367** d'integrazione su 14
file, albero pulito.

Le decisioni che il diff non racconta stanno nel README, nella sezione dei test.
Qui restano le quattro cose che costano tempo se non si sanno:

- **Il 401 non si aspetta, si provoca.** `ACCESS_TOKEN_TTL_MIN` ha un minimo di
  un minuto (`apps/api/src/config/env.ts`), e un test che dorme un minuto è un
  test che qualcuno toglie. Si costruisce invece un secondo client con il refresh
  token dell'altro nel deposito e la memoria vuota: è lo stato esatto dopo un
  riavvio del browser.
- **`refresh()` non lo attraversa la rotazione automatica.** Il giro sul 401
  chiama la funzione interna `rotate()`, non il metodo pubblico. Senza un caso
  che lo chiami a mano, la guardia del blocco 6 lo segnala come scoperto — ed è
  stato il primo fallimento vero del file.
- **Una scheda nasce con `volteEseguita: 1`**, non zero: la §6 conta come prima
  esecuzione il fatto stesso di averla raccontata. Dopo una `recordExecution` il
  numero è due.
- **`restoreProcedure` non esiste.** Ripescare dal cestino è
  `updateProcedure(id, { status: "DA_RIVEDERE" })`, e il servizio non lo blocca
  su una `ARCHIVIATA`.

Venti mutazioni, venti cadute. Due valgono come metodo, e continuano il discorso
dell'attività 3:

- `sbagliatoIlCorpo` è letto in due punti di `execute` (il ramo che ruota e
  quello che svuota la sessione). Le mutazioni sono **tre**: una che spegne la
  variabile e quindi tocca entrambi i punti insieme, e una per punto. Sono tutte
  e tre cadute, quindi i due rami sono davvero pinzati separatamente — è la
  verifica che l'attività 3 suggeriva di fare.
- La guardia «senza token conservato non si chiede niente al server» ha avuto
  bisogno di una mutazione a **due sostituzioni**: il `return null` di
  `restoreSession` e il `throw` di `rotate()` proteggono la stessa cosa, e
  toglierne uno solo è una mutazione equivalente — l'altro fermerebbe comunque la
  richiesta prima che parta.

---

## Giro 3 — le tre schermate scoperte, cestino grosso, una sessione

Quattro attività scelte dai difetti noti, più una correzione che veniva prima di
tutto. Una per commit, come sempre.

Stato alla fine del giro: typecheck verde sui quattro passaggi, **1050 test** unit
+ web su 47 file, **380** d'integrazione su 14 file, albero pulito.

| | | stato |
|---|---|---|
| 0 | due difetti noti sbagliati, riscritti | fatto, `36a6f8c` |
| 1 | `RecordScreen`: il gesto principale dell'app, senza nessun caso | fatto, `dd84304` |
| 2 | `ReviewScreen` e `ProcedureCard`, le altre due scoperte | fatto, `a14d9c9` |
| 3 | svuotare un cestino grosso senza incontrare il timeout di un proxy | fatto, `7faaece` |
| 4 | chiudere **una** sessione sola | fatto, `b904141` |

### 0 — le due correzioni

Scritte nel giro prima, sbagliate tutte e due, trovate rileggendo prima di
proporre il giro nuovo:

- Il residuo del ponte diceva che «il single-flight della rotazione non è provato
  sotto concorrenza». **Falso**: `tests/unit/apiClient.test.ts:292`, «due
  richieste parallele condividono una sola rotazione», mette due `me()` in un
  `Promise.all`, li fa fallire entrambi con `401` e conta una sola chiamata a
  `refresh`. Il residuo vero è più piccolo: non è provato **contro un server
  vero**, cioè contro uno che la rilevazione del riuso ce l'ha davvero.
- «Di schermate ne sono provate sette». Sono **nove** su dodici: l'elenco non
  citava `account.test.tsx` (30 casi) né `trash.test.tsx` (20), aggiunti nei due
  giri prima. Le tre senza nessun caso sono `RecordScreen`, `ReviewScreen` e
  `ProcedureCard` — ed è da lì che nascono le attività 1 e 2.

### 1 — fatto

`tests/web/record.test.tsx`, **ventuno casi** su `RecordScreen` e `NonSalvata`.
Da **959 su 44 file** a **980 su 45**. Ventitré mutazioni, ventitré cadute.

Il caso che vale da solo l'intero file: `premi()` fa `await capture.stop()` e
**poi** `navigate({ name: "lista" })`, e quell'ordine è tutta la garanzia che
un salvataggio fallito non mandi via l'utente dalla schermata dove c'è scritto
come recuperare l'audio. Il caso non guarda un messaggio: guarda che dopo un
`stop()` fallito `window.location.hash` sia rimasto dov'era.

**Due esportazioni fatte per i test, e dichiarate come tali.** `CaptureContext`
(prima privato) e `NonSalvata` (prima interno a `App`). L'alternativa era montare
`CaptureProvider`, che costruisce da sé un `MediaRecorder`, un GPS e un
IndexedDB: tre finti di hardware per provare che un pulsante cambia etichetta. Il
commento sopra ciascuna esportazione dice perché esiste, così nessuno la scambia
per una porta aperta.

Le altre due lezioni del file — verificare `navigate()` sull'hash, e
`within(container)` con due montaggi — sono in `CLAUDE.md`.

### 2 — fatto, e c'era un terzo difetto noto falso

`tests/web/review.test.tsx` (**venti casi**) e `tests/web/card.test.tsx`
(**nove**). Da **980 su 45 file** a **1009 su 47**. Ventinove mutazioni,
ventinove cadute, zero saltate.

**La cosa da ricordare prima di tutte.** Nel commit `36a6f8c` — cioè nel commit
che correggeva due difetti noti falsi — ne ho scritto un terzo: «`ReviewScreen`,
dove si decide cosa fare di un duplicato sospetto, e l'unico punto dell'app in
cui cancellare una cosa ne crea un'altra». **Falso.** `ReviewScreen` è la
revisione di una scheda `DA_RIVEDERE`: domande suggerite, titolo, un passo
facoltativo in coda. `DUPLICATO_SOSPETTO` compare in tutto `apps/web/src` una
volta sola, in `format.ts:213`, come etichetta di uno stato di registrazione.
La frase veniva dal riassunto di un agente di ricerca e non l'ho verificata —
tre righe sotto la regola che dice di verificare. Corretta in README e qui.

Sul contenuto: undici dei venti casi della revisione non guardano la pagina,
guardano l'oggetto che finisce in `updateProcedure`. È lì che stanno le
decisioni, e la più pericolosa è che `steps` sia una **sostituzione**: mandare
il solo passo nuovo cancella tutti quelli che c'erano, e la schermata dice
«salvato». Le ragioni per esteso stanno nel README, qui non si ripetono.

Le due lezioni sul metodo — `expect(null).not.toHaveProperty` e le mutazioni a
più sostituzioni — sono in `CLAUDE.md`.

### 3 — fatto

Il tetto e il ciclo. `EMPTY_TRASH_BATCH_SIZE = 50` nel contratto,
`listArchivedIds(userId, take)` che porta il `take` fino alla `findMany`,
`rimaste` nella risposta, e il ciclo dentro `ApiClient.emptyTrash()`. Quattordici
casi nuovi su quattro project: quattro nel servizio, sette nel client, tre nella
schermata, più due contro Postgres. Da **1009 su 47 file** a **1023 su 47**, e da
**367** d'integrazione a **369**, sempre su 14 file.

Le due decisioni prese con l'utente prima di scrivere:

- **Il ciclo sta dentro `ApiClient.emptyTrash()`**, non nella schermata. Il
  metodo resta senza argomenti e restituisce i totali sommati, quindi
  `TrashScreen` cambia quasi niente — che è ciò che vuole il vincolo «nessuna
  regola di dominio nel frontend». Prezzo dichiarato: mentre gira non c'è
  avanzamento, e sta fra i difetti noti.
- **Cinquanta per richiesta**, e deliberatamente **non** legato a
  `PROCEDURE_PAGE_SIZE` (che è venti): lì il numero è quanto ci sta su uno
  schermo, qui è quanto ci sta dentro un timeout. Due ragioni diverse non
  condividono una costante.

Le altre — `rimaste` da un `COUNT` fresco invece che da `ids.length - cancellate`,
il tetto non esposto come parametro di query, le due uscite del ciclo — stanno nel
README. Qui non si ripetono.

Ventitré mutazioni, ventidue cadute. **Le due che sono sopravvissute al primo
giro vanno ricordate, perché sono due cose diverse chiamate con lo stesso nome.**

- `EMPTY_TRASH_BATCH_SIZE` portato da 50 a 1000 non faceva cadere niente: si
  poteva rimettere il difetto che l'attività esiste per togliere. Sopravviveva
  perché i casi usano la costante **simbolicamente** (`EMPTY_TRASH_BATCH_SIZE + 7`
  schede, `cancellate` pari alla costante) — e va bene così, altrimenti cambiarla
  vorrebbe dire riscrivere i test. Ma un test scritto così si muove insieme al
  valore e non lo difende. La cura non è un `toBe(50)` tautologico: è una guardia
  sull'**intervallo**, fra dieci e cento, con scritto accanto perché esistono i due
  estremi.
- L'`orderBy: { updatedAt: "asc" }` di `listArchivedIds` girato in `"desc"`
  sopravvive ancora, ed è **equivalente**: per lo svuotamento a più passate serve
  solo che un ordine ci sia. Qui la cura è stata correggere il **commento**, che
  diceva più di quanto fosse vero.

### 4 — fatto, e una decisione che si ribalta

`b904141`, «chiudere una sessione sola, e non tutte le altre insieme».

Un giro fa, sull'elenco delle sessioni, si era deciso **solo l'elenco, niente
«chiudi questa sessione» per riga**. Qui si è fatto il contrario, e la scelta è
stata dell'utente. Il vincolo rimasto dal ragionamento di allora ha governato
tutto il resto: l'id di sessione non deve esistere nel contratto **prima** del
gesto che lo consuma — un id che gira in ogni risposta senza che nessuno lo usi è
solo un id che prima o poi finisce in un log. Quindi l'`id` in
`openSessionSchema`, `POST /api/auth/sessions/revoke-one` e il pulsante per riga
sono atterrati insieme, in un commit solo, su quattro project.

Quarantuno casi nuovi: undici nel servizio, cinque nel client, undici nella
schermata, nove contro Postgres in `auth.e2e.test.ts`, uno in
`security.e2e.test.ts`, uno nel ponte. Da **1023 su 47 file** a **1050 su 47**, e
da **369** d'integrazione a **380**, sempre su 14 file.

Le decisioni prese con l'utente e quelle tecniche stanno tutte nel README — la
schermata dell'account e la sezione della rotta. Qui restano le cinque cose che
costano tempo se non si sanno.

- **L'id sta nel corpo e non nel percorso, e la ragione è il limite dei
  tentativi.** `rateLimit.ts` costruisce la chiave con `req.path`, che è il
  percorso **concreto** e non lo schema della rotta: con l'id nel percorso ogni
  id aprirebbe un secchiello nuovo, e una rotta che accetta una password
  diventerebbe un oracolo senza limite. È il motivo per cui `POST
  /sessions/:id/revoke` e `DELETE /sessions/:id` sono state scartate tutte e
  due, ed è provato da un caso in `security.e2e.test.ts` che manda quattro
  `sessionId` diversi e pretende il `429` al quarto.
- **Revocare il proprio token dà `TOKEN_REUSED`, non `UNAUTHORIZED`.** Un caso
  del servizio è stato scritto aspettandosi il secondo e ha trovato il primo. Non
  è un difetto: la riga revocata **resta** nel database perché è lei a far
  scattare la rilevazione del riuso, e presentare un token revocato è
  indistinguibile da un furto — deliberatamente. L'aspettativa è stata corretta,
  non il codice.
- **Per uccidere `key={indice}` non basta guardare cosa c'è scritto sulla riga:**
  con tre date diverse una riga *riciclata* mostra il testo giusto lo stesso.
  Quello che cambia è l'identità del nodo, e si legge con
  `premuto.isConnected === false` dopo che l'elenco si è ricaricato. Il `focus`
  sembrava la strada e non lo è: jsdom lo perde da solo quando il nodo esce dal
  documento, quindi l'asserzione passerebbe con tutte e due le chiavi.
- **Il piano diceva `tests/unit/contract.test.ts` per i casi degli schemi nuovi.
  Sbagliato**: quel file è tutto su `extractionContractSchema` (§4.1) e non ha
  niente a che vedere con il contratto HTTP. I casi di rigidità della richiesta
  sono finiti nell'integrazione (dove un corpo malformato attraversa `parseBody`
  davvero) e quello dello schema di risposta in `apiClient.test.ts`.
- **Il `<Dispositivi>` è stato spostato *dentro* il `<form>`.** Il piano
  giustificava `type="button"` con «premerlo dentro il `<form>` farebbe partire
  scollega gli altri», ma l'elenco era renderizzato fuori — quindi la
  precauzione non proteggeva niente e la mutazione sarebbe stata equivalente.
  Spostarlo dentro rende la precauzione vera e la mutazione reale: adesso
  `type="submit"` fa cadere un caso.

Trentatré mutazioni, trentatré cadute, zero sopravvissute. Cinque sono state
scritte **doppie** perché il filtro a tre parti è scritto due volte — Prisma e
doppio in memoria — e toglierne una copia sola lascia in piedi l'altra suite.
Una mutazione è stata saltata al primo giro per l'indentazione della stringa `da`
(otto spazi invece di dieci, dentro un blocco multiriga): rifatta da sola con
`python muta.py 22`, caduta.

---

## Fuori dai giri: il primo deploy vero

Non è un'attività dell'elenco dei difetti, è una richiesta dell'utente arrivata
dopo il quarto commit del giro 3: «possiamo iniziare a vedere qualcosa su railway
e netlify?». Il codice era fermo su `master` da trentotto commit non spinti.

Cosa gira e dove sta in `CLAUDE.md`, perché è lo stato attuale e non cronaca.

Le correzioni al repo che ne sono uscite stanno nel README, nei tre file di
deploy e nel commento di `deploy.test.ts`. Nessuno dei guasti incontrati *durante
il deploy* era nel codice — erano tutti in ciò che il repo **diceva** di sé, e
infatti quel commit è un `docs:` senza `feat:` davanti. Il codice ha ceduto dopo,
alla prima registrazione vera, e ha una sezione sua qui sotto. Qui restano le
cose da sapere prima di toccare di nuovo la produzione:

- **Config-as-code di Railway è deprecata.** I due `apps/*/railway.toml` non li
  legge più nessuno: le impostazioni sono state digitate nel pannello, e i file
  sono rimasti come documentazione delle *ragioni*. Il che li rende una copia
  senza un originale con cui confrontarsi — è il difetto noto più concreto che
  questo deploy ha lasciato, e la via d'uscita è `.railway/railway.ts` con
  `railway config plan`. Non presa qui: costa una dipendenza npm nuova e la
  riscrittura di `deploy.test.ts`, e non si fa il giorno in cui si mette in piedi
  la produzione.
- **`NODE_ENV=production` rompe la build, e il messaggio parla d'altro.** `npm
  ci` salta le devDependencies, fra cui `@types/node` che
  `apps/api/tsconfig.json` pretende; ma `typescript` e `prisma` restano perché
  transitivi di produzione, quindi `tsc` parte e muore a metà con un `TS2688`. Il
  rimedio è `NPM_CONFIG_INCLUDE=dev` sui due servizi. Spostare `@types/node`
  fra le `dependencies` sarebbe stato peggio: farebbe mentire l'elenco di ciò che
  va in produzione.
- **Il worker ha bisogno di `CORS_ORIGINS` pur non usandola.** `loadConfig` è
  condiviso e non sa chi lo chiama. Il README diceva il contrario — «No, e non
  serve: non espone HTTP» — ed è il quarto difetto noto falso di questa serie,
  trovato dal processo che si rifiutava di partire invece che da un `grep`.
- **Una piattaforma può accettare un valore e ignorarlo.** `region:
  "europe-west4"` è stata accettata senza errore e non applicata: l'id giusto è
  `europe-west4-drams3a`, e i servizi sono finiti in `us-west2` mentre il bucket
  sta ad Amsterdam. Si è visto solo rileggendo la configurazione con
  `railway config pull`.
- **Un header dichiarato non è un header servito.** `netlify.toml` dice
  esplicitamente «niente preload» sull'HSTS, e Netlify aggiunge `; preload` di
  suo. Il valore identico mandato dall'API su Railway arriva intatto. Verificato
  con `curl -I` su tutti e due prima di scriverlo.
- **Su Railway il repo e il trigger sono due cose diverse**, e per un po' qui ce
  n'è stata una sola. I due servizi avevano `source.repo` impostato — la
  dashboard mostrava il repo giusto, `railway redeploy --from-source` costruiva
  da `master` — ma `repoTriggers` era vuoto, quindi **nessun push faceva partire
  niente**. Se ne è accorto solo il push del commit delle correzioni: Netlify ha
  ripubblicato da sola, Railway è rimasta ferma al commit prima. Sistemato con
  `deploymentTriggerCreate` su entrambi i servizi, `master`.
- **Netlify CLI si blocca su un prompt interattivo nei monorepo.**
  `sites:create` e `deploy` dalla radice si fermano ad aspettare una risposta che
  non arriva mai. Le due vie d'uscita: `netlify api <metodo>` per le operazioni, e
  lanciare il deploy da `apps/web` con `--dir apps/web/dist` (il `base = "."` fa
  comunque risolvere i percorsi dalla radice).

Le tre lezioni che valgono oltre questo deploy — rileggere ciò che si è
impostato, un trigger mai visto scattare, `grep -c` su un bundle minificato —
sono in `CLAUDE.md`.

E una cosa scoperta verificando queste modifiche, che non c'entra col deploy:
**due test web falliscono sotto carico e passano da soli.** Con la macchina
occupata, `list.test.tsx` («cambiare ambito riporta alla prima pagina») e
`account.test.tsx` («manda la password attuale e la nuova») sono andati in
timeout su una `findBy*`; la stessa suite, due volte di fila a macchina scarica,
ha fatto **1050 su 1050** in meno di un minuto contro i due minuti e mezzo del
giro fallito. Il primo sospetto è stato di averli rotti io, ed è stato escluso
rifacendo girare la suite sull'albero pulito — dove però passava, il che da solo
non bastava: è servito rifarla girare **con** le modifiche e vederla verde due
volte.

---

## Il primo difetto trovato dalla produzione, e non dai test

`5e2a772`, «un 400 non dice di cosa parla, e non puo' essere definitivo».

La prima registrazione vera è finita in `ESTRAZIONE_FALLITA` con questo, incollato
dall'utente:

```
anthropic: HTTP 400 — {"error":{"message":"This API key is not scoped to a
workspace, so this request must include the anthropic-workspace-id header"}}
L'estrazione e' stata rifiutata per com'e' fatta questa trascrizione:
rimandarla identica darebbe lo stesso esito.
```

**Due guasti, e il secondo è peggiore del primo.** Il primo è una chiave legata
all'organizzazione invece che a un workspace: si ripara dal pannello di Anthropic
e non è codice. Il secondo è che l'app ha dato la colpa alla trascrizione
dell'utente per una nostra configurazione sbagliata, e le ha tolto i tentativi
automatici: `retryCount` era `1` su `3`, verificato interrogando il Postgres di
produzione.

La causa sta in `STATI_RIFIUTO` di `services/ingestion/definitivo.ts`, che
conteneva `400`. Quel file dichiara in testa che ciò che si aggiusta con una
variabile d'ambiente resta transitorio, «novanta minuti sono anche la finestra
entro cui chi ha sbagliato la chiave può correggerla» — e poi il caso di
configurazione per eccellenza gli è passato sotto travestito da 400. **Il
commento diceva l'intenzione giusta e la riga sotto la tradiva**, e nessuno dei
tredici casi del file se n'era accorto perché tutti provavano il 401 e il 403.

La correzione è togliere il `400`, non distinguerlo. `413`, `415` e `422` parlano
*per definizione* dell'entità spedita; `400` è il generico delle richieste
malformate, e una richiesta comprende le intestazioni e le credenziali oltre al
corpo: è ambiguo per costruzione. Distinguere cercando marcatori nel messaggio
era la strada sbagliata due volte — il corpo arriva lì dentro solo perché
`ProviderHttpError` lo concatena troncato a 500 caratteri, e legare la
classificazione alla prosa inglese di un fornitore vuol dire che il giorno in cui
la riscrive nessun test cade. Il prezzo di toglierlo (un rifiuto di contenuto
annunciato con un 400 ora paga i novanta minuti) è dichiarato nel README e nel
file.

Una riga di produzione cambiata, sei casi nuovi, da **1050 su 47 file** a
**1056**. Ventidue mutazioni, ventidue cadute — ma solo al secondo giro, e le due
sopravvissute valgono più del conteggio:

- **La guardia sul nome non era provata.** Tolto `!NOMI_CON_STATUS.has(nome)`,
  niente cadeva: i casi negativi usavano oggetti *senza* nome, che la prima metà
  della condizione ferma lo stesso. Il caso che mancava è un `AppError` — che ha
  anche lui uno `status` — con dentro un 422: un errore nostro che senza quella
  guardia verrebbe scambiato per un rifiuto del fornitore. Test debole, non
  mutazione equivalente.
- **Una mutazione doppia può morire su metà di sé e nascondere l'altra.** Il
  messaggio «stesso esito» è costruito in due punti gemelli, trascrizione ed
  estrazione. La mutazione che li accendeva *tutti e due insieme* cadeva, quindi
  sembrava tutto pinzato; quella sul solo stadio della trascrizione sopravviveva,
  perché l'unico caso che guardava il messaggio passava dall'estrazione.

E la lezione grossa, che non è sul codice: **1050 test verdi non hanno visto un
difetto che la prima registrazione vera ha trovato in un minuto.** Non perché i
test fossero scritti male — provavano esattamente ciò che credevano — ma perché
nessuno aveva mai visto un fornitore rispondere 400 a un problema di credenziali.
La tassonomia degli errori altrui non si deduce: si osserva.

### Il secondo, che il primo ha scoperto

`9c5c587`, «il messaggio di un rifiuto dice quale regola ha bloccato».

Rimessa in coda la registrazione con la chiave nuova, il `400` era sparito e la
pipeline è arrivata in fondo. È emerso il difetto successivo, che non è nella
logica ma in ciò che l'utente legge:

```
status         ESTRAZIONE_FALLITA
lastErrorCode  contratto.non_conforme
msg            Estrazione non conforme al contratto dopo 2 tentativi.
trascrizione   "Sottotitoli creati dalla comunita' Amara.org"
```

Quella trascrizione è l'allucinazione classica di Whisper sul **silenzio** — i
sottotitoli di Amara stanno nel suo addestramento. Il modello ha risposto bene
(`NON_CLASSIFICABILE`, confidenza 0, tutto `null`) e la validazione ha bloccato
bene, su `titolo.mancante`, che è l'unica regola bloccante di `domainIssues`.
Niente di rotto: **solo il messaggio non diceva niente.**

E non era una mancanza, era uno spreco: **il motivo era già calcolato, nella riga
sopra.** `lastIssues` veniva raccolto, passato a `StageFailure`, e buttato via da
chi costruiva la stringa. Quella stringa non resta nei log — attraversa
`recordingErrorSchema.message`, `RecordingState.lastError`, `format.ts:231` — e
finisce stampata sotto l'avviso.

Due decisioni, e la seconda è quella da ricordare:

- **Solo le regole bloccanti.** Una non bloccante, per definizione, non è il
  motivo per cui ci si è fermati. Prezzo dichiarato: si legge il sintomo
  (`titolo.mancante`) e non la causa (`meta.tipo_non_procedura`). È il residuo
  nuovo nei difetti noti — le `issues` sono già nel contratto e **nessuna
  schermata le mostra**, `grep` fatto: zero occorrenze in tutto `apps/web/src`.
- **I messaggi di Zod non si citano.** Senza `errorMap` — e non ce n'è uno —
  sono prosa inglese di libreria. Citarli avrebbe appeso ciò che legge l'utente
  al testo di un terzo: **lo stesso errore che la correzione del `400` aveva
  appena rifiutato di fare**, a due giorni di distanza e in un punto diverso del
  codice. Che nessun test asserisse un messaggio Zod — `extractionValidation.test.ts`
  guarda sempre e solo `rule@path` — era la prova che la linea era già stata
  tracciata da qualcuno, e mai scritta.

Una riga di produzione e una funzione nuova, nove casi, da **1056 su 47 file** a
**1064**, e da **380** d'integrazione a **381**.

Sul metodo, il caso concreto dietro due regole che ora stanno in `CLAUDE.md`:

- **Una collisione di frase evitata per un soffio.** La coda del messaggio nuovo
  diceva «con lo stesso esito», ma quella frase è il marcatore che due casi
  esistenti cercano per dire «rimandarla identica non serve». Riusarla con un
  terzo significato l'avrebbe resa inutile come indizio, senza rompere nulla e
  senza che nessun test protestasse. Cambiata in «e non è cambiato niente».
- **Una mutazione di controllo, che deve sopravvivere.** Il primo giro ha dato
  dodici cadute su dodici mentre il runner stampava `UnicodeDecodeError`, e
  dodici su dodici è esattamente ciò che si vedrebbe se il comando fallisse
  *sempre* per un motivo suo.

---

## Giro 4 — i tag duplicati, l'elenco che si accorge, le categorie

Cinque commit di un piano che ne prevedeva cinque, ma l'ultimo è **mezzo**: il
microfono su iOS cominciava con una misura da fare su un iPhone vero, l'utente
l'ha fatta a metà, e quella metà basta per due delle cinque leve e non per le
altre.

### `2c184ba` — i tag duplicati fanno morire il salvataggio

Difetto **dedotto leggendo, non osservato**: `TagOnProcedure` ha
`@@id([procedureId, tagId])`, l'`upsert` per nome risolve due nomi uguali nello
stesso `tag.id`, e il `createMany` successivo viola la chiave composta. P2002,
cioè 500 in faccia a chi ha premuto salva; e sulla pipeline, un vocale che resta
`BOZZA_AUDIO` per sempre perché il modello ha proposto `["casa", "casa"]`.
Nessuno dei tre punti in cui si poteva deduplicare lo faceva.

I due casi d'integrazione sono stati scritti **prima** della correzione e hanno
risposto 500 e `persistenza.fallita`. Se fossero passati subito, la diagnosi era
sbagliata e andava detto.

Una funzione sola, `tagUnici`, chiamata da tutte e due le vie di scrittura. Non
un `.transform` di zod: `extractionContractSchema` è il contratto §4 e deve dire
alla lettera cosa ha risposto il modello. Il vincolo del database non si rilassa —
è lui che ha trovato il difetto.

### `399d9a8` — l'elenco si ricarica quando un vocale diventa scheda

`listPending` filtra `status: { not: ESTRATTO }`, quindi l'istante in cui nasce
una scheda è l'istante in cui un id lascia la lista dei sospesi. Da lì in giù non
succedeva niente: il polling si spegneva perché non c'era più nulla in movimento,
e `ListScreen` aveva chiesto la sua pagina una volta sola al montaggio. Il vocale
spariva e la scheda non compariva — proprio mentre si stava guardando.

Le decisioni, e i loro prezzi:

- **L'evento è «un id se n'è andato», non «è passato del tempo».** Far ripollare
  l'elenco da sé sarebbe una richiesta paginata ogni cinque secondi per tutta la
  sessione. Prezzo: se la scheda nascesse con `PendingRecordings` non montata —
  oggi non succede mai — nessuno ricaricherebbe.
- **Confronto di id, non di lunghezza.** Uno che esce e uno che entra nello stesso
  giro lascia la lunghezza invariata, e la scheda nuova resterebbe invisibile:
  cioè esattamente il difetto da togliere.
- **Prop obbligatoria.** `onSparita?` avrebbe tenuto compilanti i sette montaggi
  esistenti, ma una prop facoltativa è una porta aperta. Prezzo: sette righe di
  test toccate.

Un difetto **trovato progettando**, scritto nei difetti noti e non corretto qui:
`ricarica()` di `useAsync` riporta lo stato ad `attesa`, e la sezione dei sospesi
restituisce `null` quando non è `pronto` — quindi si smonta e rimonta a ogni tick
di cinque secondi, e la conferma di «Elimina» su un vocale sospeso sparisce da
sola. La cura sta in `useAsync`, che lo montano dodici schermate: non si infila di
straforo in un commit che parla d'altro.

### Le categorie: `GET /api/tags` e l'indice in dashboard

La tensione dichiarata prima del codice: una scheda porta fino a trenta tag,
quindi non appartiene a *una* categoria; e le sezioni giuste si disegnerebbero
solo avendo davanti tutte le schede, mentre ne arrivano venti per volta. Quindi
**non un raggruppamento: un indice.** Le chip filtrano la lista già paginata dal
server, e il numero dice quanto c'è dietro.

Scartate: raggruppare nel client (mentirebbe su ciò che non è caricato, e sarebbe
una regola di dominio nel frontend); una colonna `categoriaPrincipale` (una
migrazione, un concetto che la §4 non produce, e la domanda «chi la sceglie» su
ogni scheda già esistente).

Le decisioni che è servito difendere:

- **Lo stesso `whereFor` per il conteggio e per la lista.** Se una chip dicesse
  «7» e ne aprisse 6, l'utente non si fiderebbe più di nessuno dei due numeri.
  Riusando la stessa funzione il disaccordo diventa impossibile per costruzione,
  e il cestino resta fuori da solo. La mutazione che separa i due `WHERE` cade
  **solo** sul caso d'integrazione che li confronta.
- **`groupBy` sui legami, non `tag.findMany` con `_count`.** Due ragioni
  indipendenti, e la seconda è emersa leggendo il codice e non dal piano: i `Tag`
  orfani si tengono apposta (vocabolario del prompt §4.2) e finirebbero sul filo
  con uno zero; e `_count` conta tutte le associazioni, cestino compreso.
- **Router suo a `/api/tags`.** `procedures.routes.ts` dichiara
  `router.get("/:id")`: `GET /api/procedures/tags` funzionerebbe solo se
  dichiarata prima, cioè si reggerebbe sull'ordine delle righe di un file.
- **Niente `status` nella query.** Lezione di `revoke-one`: un parametro che gira
  nel contratto prima del gesto che lo consuma è un parametro che qualcuno
  interpreterà male.
- **Cambiare ambito lascia andare la categoria.** Non era nel piano. La fila si
  ricarica sul nuovo ambito, quindi una categoria che lì non esiste sparisce dalla
  riga — ma il filtro resterebbe applicato: lista vuota, nessuna chip accesa,
  niente da premere per capire perché. Prezzo: si perde «Casa» anche quando in
  Lavoro «Casa» c'è.

Il doppio in memoria **riscrive i tre filtri invece di chiamare `this.list`**,
apposta: delegando, il caso che confronta il conteggio con ciò che la chip apre
sarebbe stato vero per costruzione anche in memoria, cioè non avrebbe pinzato
niente.

### Le categorie sulla scheda, e il riquadro che le scrive

Il commit precedente ha costruito l'indice; questo mette le categorie **dove si
leggono** (la riga della dashboard) e **dove si scrivono** (una sezione nel
dettaglio). Le decisioni, e i loro prezzi:

- **Sulla `ProcedureCard` le chip sono `<span>`, mai `<button>`.** La scheda *è*
  un `<button type="button" className="riga">`, e un pulsante dentro un pulsante
  è HTML non valido che non fa protestare nessuno: React lo disegna, jsdom lo
  accetta, il browser vero riorganizza i nodi per conto suo. Renderle premibili
  vorrebbe dire smontare la scheda-bottone e rifare la navigazione con un
  `<div>`, perdendo tastiera e ruolo — cioè esattamente ciò che il commento di
  quel file dice di aver guadagnato. Prezzo: dalla lista non si filtra toccando
  la categoria sulla scheda. Il caso che difende la decisione **conta i
  `<button>` nella riga**, non guarda le chip: cercare «le chip non sono
  `<button>`» si aggirerebbe riscrivendole come `<a>`.
- **Si scrive dal dettaglio e non dalla revisione.** `ReviewScreen` esiste solo
  per le `DA_RIVEDERE`, e il suo `salva()` ha già la trappola documentata della
  sostituzione totale di `steps`: aggiungerci un secondo campo a sostituzione
  totale raddoppierebbe quella superficie. Prezzo: un passo in più per
  categorizzare una scheda appena nata.
- **Il riquadro manda sempre la lista intera**, perché
  `updateProcedureBodySchema.tag` è una sostituzione. Mandare la sola categoria
  nuova cancellerebbe le altre e la schermata direbbe «salvato» — e *sembrerebbe
  giusto*, perché dopo il `onCambiata()` a schermo c'è ciò che il server ha
  risposto. È il difetto già pagato su `steps`, e per questo i casi leggono il
  corpo inviato invece dello schermo.
- **Un `<datalist>`, non una tendina.** La tendina impedirebbe di inventare una
  categoria nuova, che è il gesto che dà senso a tutto; il campo libero da solo
  genera «Casa» e «casa». Prezzo: su Safari iOS il supporto è più povero, ed è
  da verificare sul telefono insieme al commit del microfono.
- **Un booleano solo per il pulsante e per l'Invio.** `puoAggiungere` muove
  `disabled` e la guardia dell'`onKeyDown`. Se la condizione fosse riscritta a
  mano dentro la tastiera, l'Invio diventerebbe una porta di servizio verso un
  `400` e il pulsante spento accanto non lo direbbe: c'è una mutazione apposta, e
  cade.

**Una deviazione dal piano, dichiarata.** Il piano diceva «niente shared» per
questo commit e allo stesso tempo che il tetto di trenta dovesse venire dal
contratto: le due cose insieme non stanno in piedi, perché per spegnere il
pulsante *prima* della richiesta la schermata il numero lo deve leggere da
qualche parte. Quindi `PROCEDURE_TAG_MAX` e `PROCEDURE_TAG_NAME_MAX` sono
diventati due costanti esportate, e lo schema le usa invece dei letterali.
Ricopiare `30` nel client sarebbe stata una regola di dominio nel frontend —
uno dei due vincoli trasversali del brief.

**E la guardia che il piano non prevedeva.** Un `grep` prima delle mutazioni ha
mostrato che *niente* pinzava quel numero: tutti i casi nuovi lo usano
simbolicamente, quindi si muovono insieme a lui, e `30 → 3` sarebbe sopravvissuto
ovunque. È la regola di `CLAUDE.md` sulle costanti che sono un compromesso:
servono un intervallo e il motivo dei due estremi. Aggiunti quattro casi in
`tagUnici.test.ts` — fra dieci e cinquanta per il numero di categorie, fra venti
e duecento per la lunghezza di un nome, più la proprietà che vale più del numero:
che la schermata e il contratto contino **lo stesso**. Le quattro mutazioni
(`30→3`, `30→100`, `60→5`, `60→1000`) adesso cadono tutte.

### Il microfono: la misura ha risposto, e la risposta era «non è tuo»

Il quinto commit cominciava con cinque passi da fare su un iPhone. L'utente ne ha
fatti tre, e hanno detto questo: alla prima registrazione compaiono i due
cartelli; a una seconda nella stessa scheda non compare niente; dopo un logout e
un nuovo login **ricompaiono tutti e due**.

La terza riga sembrava un difetto nostro — il logout smonta `CaptureProvider`, il
login ne costruisce uno nuovo, adattatori nuovi. Il primo controllo è stato un
`grep` per `location.reload`: non esiste, in tutto `apps/web/src`. Quindi non è
un caricamento di pagina, è solo React. Ma la prova che chiude il discorso è la
**posizione**: il nostro codice non tocca in nessun punto il permesso di
geolocalizzazione, eppure anche quello viene richiesto di nuovo. Se si dimentica
una cosa che non abbiamo mai toccato, la causa è fuori dal nostro codice per
costruzione. La geolocalizzazione ha fatto da controllo, esattamente come la
mutazione che cambia un commento.

Delle cinque leve del piano se ne sono implementate due, quelle che erano
giustificate anche prima della misura, e si è scritto perché le altre no.

**(a) L'inversione dell'ordine.** `start()` faceva partire il `void (async …)()`
del GPS **prima** dell'`await recorder.current.start()`: il primo cartello
riguardava la posizione, nell'attimo in cui si è premuto il tasto rosso per
parlare. Invertito. Sicuro, perché `getUserMedia` resta dentro l'attivazione
utente dello stesso click. E c'è un secondo effetto voluto: se il microfono è
negato, `start()` esce prima e la posizione non viene chiesta affatto.

**(b) La memoria di un rifiuto della posizione — ma non dove diceva il piano.**
Il piano diceva `localStorage` con `try`/`catch`. La misura ha cambiato l'analisi:
se i permessi non sopravvivono al caricamento della pagina, un ricordo scritto su
disco vivrebbe **più a lungo della cosa che rispecchia** — il browser tornerebbe a
chiedere e noi avremmo smesso di domandare, cioè posizione spenta per sempre su
quel dispositivo e nessun posto da cui riaccenderla. Un campo dell'istanza ha
esattamente la vita giusta: nasce e muore col provider, e non serve nessun gesto
per dimenticarlo. Meno codice, nessuna porta a senso unico, nessuna interfaccia
da inventare. Si ricorda **solo** `PERMISSION_DENIED`: un timeout e una posizione
non determinabile sono guasti di adesso, e contarli come «no» spegnerebbe il GPS
per il resto della sessione a chi ha registrato una volta in cantina.

**(c) e (d) no, e il motivo è lo stesso.** Il pulsante «Prepara il microfono» e
il riquadro su `navigator.standalone` dipendono dai due passi che mancano —
installare dalla Home, e l'impostazione per sito. Un riquadro che spiega come si
fa una cosa che non si è visto funzionare è peggio di nessun riquadro. **(e)**
resta no per il motivo già scritto nel piano: dentro un caricamento di pagina il
permesso è già concesso, quindi tenere vivo un `MediaStream` non evita nessun
cartello e accende l'indicatore arancione in permanenza. Si pagherebbe un
sospetto per non ottenere niente.

**Il primo test che monta `CaptureProvider`.** Non ce n'erano, e il motivo era
buono: costruisce da sé un `MediaRecorder`, un GPS e un IndexedDB. Ma l'ordine dei
due permessi vive **solo** lì dentro, e nessun finto della schermata può vederlo.
Due scelte hanno fatto la differenza. I marcatori li scrivono `getUserMedia` e
`geolocation.getCurrentPosition`, cioè i globali veri del browser e non i nostri
adattatori — così il caso prova che il telefono riceve le due domande in
quell'ordine, non che `start()` chiama due nostri metodi. E l'ordine si prova con
un array, non con due spie: due `toHaveBeenCalled` passano in qualunque ordine,
cioè passano anche contro il difetto che il file esiste per impedire.

Due inciampi, tutti e due di ambiente. Il piano metteva i casi della
geolocalizzazione in `tests/unit/geolocation.test.ts`: `tsconfig.tests.json` ha
`lib: ["ES2023"]` senza DOM, quindi `navigator.geolocation` non compila — e il
progetto `web` raccoglie solo `.test.tsx`. E montare il provider in `jsdom`
produce una promessa rifiutata che nessuno raccoglie, perché `indexedDB` non
esiste e lo svuotamento della coda parte al montaggio: l'unico finto di modulo del
file serve a questo, ed è dichiarato in cima.

Dieci mutazioni, **nove cadute e il controllo vivo**. La decisiva è quella che
rimette il GPS davanti al microfono, che è il difetto trovato sull'iPhone
riscritto come mutazione.

### Sul metodo, due cose che questo giro ha insegnato

**La mutazione di controllo serve per ogni comando, non per ogni file.** Il primo
giro di mutazioni ha dato 26 cadute su 27 con l'unico controllo vivo, e sembrava
un risultato pulito. Il controllo però girava il comando *unit*; aggiungendone uno
sul comando d'integrazione, quello è **caduto** — e la causa era che il prefisso
`VAR="x" comando` passato a `subprocess(shell=True)` su Windows finisce in
`cmd.exe`, dove non è sintassi valida. Il comando non partiva affatto: sette
mutazioni «cadute» non avevano mai fatto girare un test. È la stessa lezione
dell'`UnicodeDecodeError`, ripetuta in un punto in cui sembrava già imparata.
Il runner adesso distingue «fallito» da «fallito senza che nessun test sia
girato».

**Una precauzione scritta due volte, e la terza mutazione che dà ragione alla
regola.** `userId` compare in tutte e due le interrogazioni di `listTags`.
Mutandola nei tre modi previsti: toglierla dal `groupBy` cade, toglierla da tutti
e due cade, toglierla dalla sola lettura dei nomi **sopravvive**. Ed è
equivalente: gli id arrivano da righe già filtrate per proprietario, e un `Tag`
appartiene a un utente solo. Non si è aggiunto un caso per coprirla — non c'è
nessun difetto da descrivere. Si è corretto il commento, che dicendo «nessun
`WHERE` senza proprietario» lasciava credere che tutti e due stessero difendendo
qualcosa.

Da **1064** test unit + web su 47 file a **1145** su 49, e da **381**
d'integrazione a **392**. Ventinove mutazioni sul commit dell'indice delle
categorie — 26 cadute, due controlli vivi come devono, una equivalente
dichiarata — ventotto su quello della scheda e del riquadro (**26 cadute e due
vive, che sono esattamente i due controlli**) e dieci su quello del microfono:
nove cadute e il controllo vivo. Nessuna saltata e nessun guasto del runner in
nessuno dei tre giri.

---

## Giro 5 — verso un'app vera: le guardie, e cancellare il proprio conto

Il giro nasce da una domanda pratica: che iOS chieda il permesso del microfono
una volta sola. Su Safari non è ottenibile; dentro un guscio Capacitor sì, perché
`WebViewDelegationHandler.swift` implementa `requestMediaCapturePermissionFor`
con un `decisionHandler(.grant)` senza condizioni, e allora l'unico cartello che
resta è quello di sistema, che il telefono ricorda perché è legato all'app
installata e non alla scheda del browser. **Questa frase è una lettura di
sorgente su GitHub, cioè ha l'autorità di un ricordo**: diventa vera quando la si
misura su un iPhone, che è la fase 3 del piano e costa 99 $ l'anno.

Le fasi sono sei. Questo giro chiude le prime due porzioni della fase 0, che è
tutto ciò che va fatto *prima* di generare qualunque cartella nativa.

### 0a — le guardie, prima e non dopo

`guards.test.ts` cammina l'albero del repo. `apps/mobile/ios` e
`apps/mobile/android` conterranno migliaia di file generati — Pods, Gradle,
`.pbxproj` — e la guardia li leggerebbe tutti. `IGNORED_DIRS` si è allargata con
`ios`, `android`, `Pods`, `build`, `.gradle`, e `BROWSER_GLOBALS` con `Capacitor`,
che è un globale del browser a tutti gli effetti e che `packages/shared` non deve
poter toccare.

Allargare `IGNORED_DIRS` allarga un punto cieco, ed è scritto nei difetti noti:
quelle cartelle non le controllerà più nessuna guardia. Il caso opposto è nel
file — una cartella *nostra* con un nome simile viene camminata lo stesso —
perché senza, `IGNORED_DIRS = tutto` passerebbe.

### 0b — cancellare il proprio conto

Non esisteva: `grep` per `deleteUser|deleteAccount|cancella.*account` dava zero.
La linea guida Apple **5.1.1(v)** dice che un'app da cui si crea un account deve
permettere di cancellarlo dentro l'app, e senza il rifiuto alla revisione è
certo.

**La cascata non c'era.** `Recording.user`, `Procedure.user` e `Tag.user` non
avevano `onDelete: Cascade` — solo `RefreshToken` ce l'aveva — quindi
`user.delete()` sarebbe morto su un vincolo di chiave esterna al primo utente con
un vocale. La migrazione `20260922100000_delete_account_cascade` li allinea, e in
`schema.test.ts` c'è una guardia che interroga `pg_constraint` con
`confrelid = '"User"'::regclass` e pretende **esattamente quattro** chiavi
esterne, tutte `CASCADE`. Scritta così e non elencando i nomi a mano perché una
tabella nuova con uno `userId` che nessuno collega alla cascata deve far cadere
quel caso.

Quella guardia, alla prima stesura, era sbagliata. La premessa era «nessuna FK
fuori da `%_userId_fkey` deve essere `CASCADE`», ed è falsa: `Step_procedureId_fkey`
e altre otto cascano legittimamente da `Procedure`. Il caso è rosso al primo giro,
e la verità l'ha detta un `psql` diretto, non il ragionamento.

**`POST /delete-account` e non `DELETE /me`**, che era ciò che il piano
prevedeva. Il motivo è già scritto nel repo per `/sessions/revoke`: il gesto
vuole la password nel corpo, e un corpo su una `DELETE` è consentito dallo
standard e trattato male da metà del mondo che sta in mezzo. La deviazione è
dichiarata qui e una mutazione la rimette in `DELETE /api/auth/me`, così la
scelta resta onesta.

**La risposta porta tre numeri** — vocali, schede, sessioni — e non un `204`:
sono l'unico momento in cui quell'archivio si può ancora contare. **Un vocale in
`IN_ELABORAZIONE` ferma tutto con un 409**, ed è la decisione scomoda: la
5.1.1(v) vuole un gesto che funziona, e qui esiste un istante in cui risponde
«riprova». L'alternativa era cancellare sotto un worker che ci sta scrivendo.

Il residuo vero, trovato verificando invece di supporre, è peggiore
dell'istante: un vocale che in `IN_ELABORAZIONE` **ci resta** — worker ucciso a
metà — non lo recupera nessuno. `claimNext` pesca solo fra le `BOZZA_AUDIO`,
`requeue` rifiuta esplicitamente l'`IN_ELABORAZIONE`, la `DELETE` della
registrazione pure. Era già un difetto prima di questa rotta; quello che la
rotta aggiunge è che adesso quel vicolo cieco si porta dietro anche l'uscita.
La prima stesura del difetto noto diceva che «la scopa rimette in coda le righe
ferme, ma la lancia un umano»: **due affermazioni, tutte e due false**. La scopa
gira da sola nel ciclo del worker e guarda i file del bucket, non le righe. È il
sesto difetto noto falso scritto in questo repo, e di nuovo l'ha trovato un
`grep` fatto *dopo* aver scritto la frase invece che prima.

### Un'etichetta riusata, che nessun test avrebbe protetto

Il campo nuovo si chiamava «La tua password». Sette casi web rossi con
`Found multiple elements`: quella frase appartiene già, sessanta righe più su
nello stesso file, al modulo che scollega gli altri dispositivi. Adesso dice
«Password, per cancellare il conto». È esattamente la regola «prima di scrivere
una stringa nuova destinata all'utente, `grep`ala», violata tre righe dopo averla
riletta.

E nel correggerla, un secondo inciampo evitato per un pelo: una sostituzione
cieca di quella stringa nel file di test toccava **30 occorrenze**, 19 delle
quali appartenevano ai casi preesistenti della revoca. Se ne è accorto il numero
stampato, non un test.

### Il difetto dello strumento che si è travestito da esito

Il giro completo delle mutazioni ha dato il controllo `[0]` **caduto**, su un
commit dove tutto era verde. La causa: `@wikimylife/shared` si consuma da `dist`,
e i comandi che mutano `packages/shared/src` lo compilano lì dentro. `muta.py`
ripristina il sorgente, ma `dist` resta mutato — quindi ogni comando successivo,
compresi quelli del giro **dopo**, girava contro la rotta `DELETE` lasciata dalla
mutazione 20. Adesso ogni comando del `.muta.json` comincia con
`npx tsc -b packages/shared`.

È la terza volta che un difetto del runner si traveste da esito. Le prime due
facevano passare dei guasti per cadute; questa faceva cadute vere su codice non
mutato. Le tre hanno in comune una cosa sola: **senza la mutazione di controllo
non se ne sarebbe accorto nessuno**.

### La precauzione doppia, ancora, e ancora con lo stesso esito

Nel conteggio delle sessioni della ricevuta convivono `revokedAt: null` e
`distinct: ["familyId"]`. Mutate nei tre modi previsti dalla regola: insieme
cadono; togliere il filtro cade — ma solo dopo aver aggiunto un caso con un
dispositivo *già scollegato*, perché con un dispositivo solo il `distinct`
copriva la mancanza; togliere il `distinct` **sopravvive**, ed è equivalente. La
rotazione revoca la riga di partenza nella stessa transazione in cui crea quella
nuova, quindi di ogni famiglia viva esiste una riga sola.

Non si è aggiunto nessun caso per coprirla. Si è corretto il commento, che
diceva che il `distinct` serviva a non contare le antenate revocate — cosa che fa
già il filtro — e adesso dichiara la ridondanza e perché resta.

### I numeri

Da **1148** test unit + web su 49 file a **1169**, e da **392** d'integrazione su
14 file a **405**. Trenta mutazioni: **25 cadute, quattro controlli vivi come
devono, una equivalente dichiarata**, zero guasti e zero saltate al giro finale.

---

## Giro 6 — la 0c: la pagina della privacy, e le icone che si generano

### Le icone: un rasterizzatore scritto qui, invece di una dipendenza

Nel repo non c'era un solo PNG, e Apple vuole un 1024×1024 **senza canale alfa**.
Nessuno strumento del repo sapeva trasformare un SVG in PNG. Le strade pronte
erano `sharp` o `@resvg/resvg-js`, cioè un binario nativo per piattaforma dentro
`npm ci` — su Windows, in CI e su Netlify — per disegnare quattro forme; o un
browser senza testa. Scartate tutte e due: `scripts/icone.ts` descrive il
microfono una volta sola, calcola la distanza da un rettangolo arrotondato, da un
semicerchio e da un segmento con sedici campioni per pixel, e scrive il PNG con
`node:zlib`, che sa già comprimere e fare il CRC. Il prezzo è dichiarato nel
file: sa disegnare solo queste forme.

Lo stesso script scrive anche `icona.svg`, che prima era scritto a mano: i
numeri sono stati riportati senza ritocchi, e il `diff` dell'SVG rigenerato tocca
solo il commento. Adesso i tre file non possono divergere, e
`tests/unit/icone.test.ts` lo pinza confrontando i **pixel** e non i byte — i
byte dipendono dalla versione di zlib che arriva con Node.

Un controllo esterno che il test non poteva dare: PIL, un decodificatore che non
abbiamo scritto noi, legge i due PNG come `RGB` e trova i colori giusti nei punti
giusti.

**Una svista trovata strada facendo:** `index.html` puntava `apple-touch-icon` a
`icona.svg`. Per quanto se ne sa Safari non accetta un SVG lì. È un ricordo e
non una misura, ed è scritto così nel README.

### La pagina: tre frasi false fermate prima di uscire

Ogni frase su cosa esce e verso chi è stata cercata nel codice prima di restare
nella pagina, e tre non hanno retto:

- La ricognizione del giro prima diceva che agli embedding va «il titolo». In
  `ingestion.service.ts` vanno **titolo, trigger e tag**.
- Mancava un destinatario: **Nominatim di OpenStreetMap**, che riceve le
  coordinate direttamente dal browser (`GeolocationAdapter.ts`).
- La prima stesura diceva che il microfono è acceso «mentre tieni premuto il
  pulsante». La registrazione si avvia e si ferma con due tocchi.

E una scoperta che ha cambiato la pagina e aggiunto un difetto noto: gli
**indirizzi IP stanno nel database**, in `RateLimitBucket`, e la pulizia parte
ogni cinquecento richieste per processo. Avrei scritto «solo in memoria».

### La guardia dei terzi, e i due falsi positivi che ha trovato su se stessa

`tests/unit/privacy.test.ts` cerca gli URL `https://` che aprono un letterale nei
sorgenti, e pretende che ogni host abbia un nome e che quel nome compaia nella
pagina. Al primo giro è caduta due volte, tutte e due per ragioni giuste: aveva
preso un `https://x.netlify.app/` fra due backtick in un JSDoc di `env.ts`, e il
controllo della CSP aveva trovato la parola `<style>` nel **commento** della
pagina che spiega perché non c'è uno `<style>`. Adesso salta le righe di commento
dei sorgenti e i commenti HTML della pagina.

### Le mutazioni

Venticinque, su tre comandi, con un controllo per ciascuno: al primo giro **21
cadute, tre controlli vivi, una sopravvissuta**. La sopravvissuta toglieva
Nominatim dalla tabella della pagina, e restava verde perché «Nominatim»
compariva ancora nel commento HTML in testa al file. Non era una mutazione
equivalente: era il test che leggeva il sorgente invece di ciò che vede chi apre
la pagina. Adesso i nomi si cercano in `VISIBILE`, la pagina senza commenti, e la
mutazione cade. Al giro finale: **22 cadute, tre controlli vivi, zero saltate,
zero guasti**.

Una seconda debolezza l'ha trovata la lettura, prima delle mutazioni: il caso
«non ha il canale alfa» confrontava con `PNG_RGB` **importato dallo script**, cioè
con il valore che doveva controllare. Adesso il numero 2 è scritto nel test, e
c'è un caso che guarda anche il PNG appena uscito dallo script — i file in git
dicono solo com'era lo script l'ultima volta che qualcuno l'ha lanciato.

### Due inciampi dello strumento

- `prettier` lanciato senza configurazione riformatta a 80 colonne, e il repo non
  ne ha una: ha spezzato un `it(..., 30_000)` mescolando il commento con gli
  argomenti. Il codice del repo sta intorno alle 100 colonne e non è formattato
  in modo uniforme.
- Un `\r` dentro un heredoc passato a Python è arrivato nel file come un ritorno
  a capo vero, spezzando una regex a metà. Le correzioni con barre rovesciate
  vanno fatte con uno script scritto su file, non attraverso la shell.

### I numeri

Da **1169** test unit + web su 49 file a **1202** su 51, verdi due volte di
seguito con le modifiche. Nessun cambiamento all'API, quindi l'integrazione non
è stata rilanciata: resta a **405** su 14 file dall'ultimo giro.

---

## Giro 7 — la fase 1: il guscio Android, senza Android su questa macchina

### Dove si costruisce

Qui c'è Java 8 e nessun SDK Android; Capacitor 8.5.2 vuole Java 21. La scelta,
dell'utente: l'APK lo costruisce GitHub Actions, in un job `android` accanto ai
tre che c'erano, e lo lascia come artefatto. È anche lo schema che servirà per
iOS nella fase 2. Il prezzo è che **l'APK non è mai stato costruito** nel momento
in cui questo giro si chiude: la prima volta che Gradle vedrà il progetto sarà la
run dopo il push.

### Il manifest, letto dal codice di Capacitor

Prima di scrivere i permessi è stato letto `BridgeWebChromeClient.java`. Due cose
che una lista a memoria avrebbe sbagliato: per il microfono Capacitor chiede
`RECORD_AUDIO` **e** `MODIFY_AUDIO_SETTINGS`, e concede la pagina solo se li ha
tutti e due; per la posizione chiede la precisa e l'approssimativa insieme, e
senza la precisa nel manifest nega tutto sotto Android 12. `mobile.test.ts` legge
quel file Java in `node_modules` invece di una lista nostra, così un
aggiornamento di Capacitor che chiede un permesso in più cade in un test.

L'origine della WebView, `https://localhost`, è stata letta in `CapConfig.java`,
e `CORS_ORIGINS` letto dal pannello con la CLI di Railway filtrando la sola
variabile, senza stampare le altre, che contengono le chiavi. Vale solo
`https://wikimylife.netlify.app`: senza toccare il pannello l'app non fa login.

### Le icone Android dallo stesso script, e un conto che ha evitato un ritocco

Capacitor genera le icone e undici splash con il suo logo. `@capacitor/assets`
li rifarebbe da una sorgente, ma porta `sharp`, cioè il binario nativo scartato
nel giro prima. `scripts/icone.ts` adesso scrive 28 PNG. Il primo piano delle
icone adattive poteva volere un disegno ridotto; il conto dice di no: il punto
più lontano del microfono (la base dell'asta, arrotondata) sta a 148 unità dal
centro su 512, il 28,9%, e la zona che ogni launcher mostra arriva al 30,6%.

Undici splash fino a 1920×1280 avrebbero portato il test a decine di secondi. Il
rasterizzatore adesso salta i pixel fuori dal riquadro del microfono, che sono
fondo per costruzione: i PNG web rigenerati sono rimasti **identici al byte**, e
i 176 casi delle icone girano in meno di tre secondi.

### Il service worker, spento nell'app

La condizione di registrazione è uscita da `main.tsx`, che nessun test monta, ed
è entrata in `serviceWorker.ts` con sette casi. Una finestra finta e non quella
di jsdom: jsdom non ha `navigator.serviceWorker`, e il suo `load` è già scattato
quando il caso parte.

### Le mutazioni

Ventiquattro su tre comandi, con un controllo ciascuno: **21 cadute, 3 controlli
vivi, nessuna sopravvissuta, nessuna saltata**. Una precisazione su una di
esse: togliere il `.catch` della registrazione lascia verdi i sette casi, e la
corsa fallisce lo stesso perché Vitest vede il rifiuto non gestito. Il runner la
conta come caduta dichiarandolo; la prende la corsa, non un caso.

### I numeri

Da **1202** test unit + web su 51 file a **1377** su 53 (quasi tutti i nuovi sono
i casi per file delle icone Android). Integrazione non rilanciata: l'API non è
cambiata.

---

## Giro 8 — la fase 2: iOS in CI, e la prima run del guscio Android

### Android, misurato dalla CI

Il push di `050f30b` e `5134135` ha fatto girare per la prima volta il job
`android`: verde al primo colpo, compreso `windowSplashScreenBackground`, l'unica
riga che non aveva mai visto un compilatore. L'artefatto è un APK di circa 4 MB.
Lo stato si è letto dall'API pubblica di GitHub, perché `gh` qui non è
autenticato; i log invece vogliono un token, e quindi restano chiusi.

Due fatti che la run ha portato con sé:

- Il job `integrazione` fallisce sul passo «il bucket dei test», **già dalla run
  di `0fc6215`**, cioè prima di questo lavoro. Il perché sta nel log.
- La modifica di `CORS_ORIGINS` su Railway è stata **negata dal classificatore
  dei permessi**, perché tocca una risorsa di produzione condivisa. Non la si è
  aggirata: è passata all'utente, con il comando pronto.

L'utente ha anche ricordato che non lavora in `localhost` ma su Railway e
Netlify. Vero, e non cambia l'origine da ammettere: `https://localhost` è il nome
con cui la WebView di Capacitor serve i file **dentro il telefono**, non un
server di sviluppo.

### iOS

`@capacitor/ios` 8.5.2, e un progetto che usa Swift Package Manager: niente
CocoaPods sul runner. Le due frasi dei permessi in `Info.plist` sono state
scritte prima di tutto il resto, perché la loro assenza non è un permesso negato
ma un'app chiusa. Le icone e i tre splash quadrati da 2732 vengono dallo stesso
script; il lato del disegno negli splash (630) è ricavato da come
`scaleAspectFill` ritaglia un quadrato su un iPhone in verticale, per avere lo
stesso ingombro dello splash Android.

Il job `ios` compila per `generic/platform=iOS` con `CODE_SIGNING_ALLOWED=NO`: è
la compilazione che servirà a TestFlight, meno la firma.

### Un altro `| tail` che nasconde un codice d'uscita

`npm run typecheck | tail -1 && npm test` ha eseguito i test comunque: il codice
d'uscita della pipeline è quello di `tail`. Il typecheck era verde — rifatto
leggendo `$?` — ma la riga non lo provava.

### Le mutazioni

Undici: **9 cadute, 2 controlli vivi**, nessuna saltata.

### I numeri

**1409** test unit + web su 53 file.
