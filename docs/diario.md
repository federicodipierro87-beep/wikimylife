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

---

## I difetti noti falsi, tutti quanti

`CLAUDE.md` vieta di scrivere «non è provato che X» senza un `grep` prima. La
regola esiste perché è stata violata cinque volte, e l'elenco sta qui perché una
regola con sotto i suoi cadaveri si dimentica meno.

| | scritto | perché era falso | trovato da |
|---|---|---|---|
| 1 | «nessun test d'integrazione prova che `CAMBIATA` riporti la scheda in `DA_RIVEDERE`» | il test esisteva, `tests/integration/procedures.e2e.test.ts:713` | una rilettura |
| 2 | «il single-flight della rotazione non è provato sotto concorrenza» | `tests/unit/apiClient.test.ts:292` lo prova, davanti a un `fetch` finto | una rilettura |
| 3 | «di schermate ne sono provate sette» | erano nove: mancavano all'elenco `account.test.tsx` e `trash.test.tsx` | una rilettura |
| 4 | «`ReviewScreen`, dove si decide cosa fare di un duplicato sospetto» | `DUPLICATO_SOSPETTO` non compare in `ReviewScreen`: è un'etichetta di stato in `format.ts:213` | la scrittura dei test |
| 5 | «il worker non ha bisogno di `CORS_ORIGINS`: non espone HTTP» | `loadConfig` è condiviso e non sa chi lo chiama | il processo che non partiva |

Due cose che questo elenco dice e le singole voci no. La quarta è stata scritta
**dentro il commit che correggeva la seconda e la terza**, tre righe sotto la
regola — e veniva dal riassunto di un agente di ricerca, preso per buono senza
verificarlo. La quinta non l'ha trovata nessuna rilettura: l'ha trovata la
produzione, rifiutandosi di avviarsi.

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

Tre commit su quattro di un piano che ne prevedeva cinque; il quinto — il
microfono su iOS — resta fermo, perché comincia con una misura da fare su un
iPhone vero e quella la fa l'utente.

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

Da **1064** test unit + web su 47 file a **1110** su 48, e da **381**
d'integrazione a **392**. Ventinove mutazioni sul solo commit delle categorie:
26 cadute, due controlli vivi come devono, una equivalente dichiarata.
