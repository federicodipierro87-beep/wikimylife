# CLAUDE.md — memoria di lavoro

Questo file lo legge Claude Code all'avvio di ogni sessione. Serve a due cose:
sapere **come si lavora qui** e sapere **dove eravamo arrivati**. Non è
documentazione del prodotto — quella sta nel `README.md`, che è lungo e va letto
quando serve.

I tre file di riferimento, in ordine di autorità:

| file | cos'è | si modifica? |
|---|---|---|
| `wikimylife-schema.md` | la specifica del prodotto, con le sezioni numerate (§1 pipeline, §4 contratto, §5 validazione, §7 ricerca, §8 esecuzioni, §9 redazione) | **no**, è il contratto |
| `wikimylife-prompt-claude-code.md` | il brief originale: fasi, vincoli trasversali | **no**, è la consegna |
| `README.md` | come funziona ciò che esiste davvero, e cosa non esiste | **sì, sempre**, insieme al codice |

---

## Comandi

```bash
npm run typecheck        # quattro passaggi: tsc -b, prisma, tests, tests.web
npm test                 # progetti unit + web (jsdom)
npm run test:integration  # richiede: docker compose up -d
npm run dev              # shared, api, worker, web insieme
npm run db:seed
npm run sweep -- --cancella
```

Non c'è nessuno script di lint: il typecheck è tutto quello che c'è, e va
passato per intero prima di ogni commit.

`@wikimylife/shared` viene consumato da `dist`, non da `src`. Se tocchi
`packages/shared/src`, i test non vedono la modifica finché non gira
`tsc -b packages/shared` — `pretest` lo fa da solo, ma un `npx vitest` lanciato
a mano no.

I test d'integrazione parlano con un Postgres vero (container `wikimylife-db`).
Senza `docker compose up -d` falliscono tutti insieme, e non è un difetto.

---

## Convenzioni, quelle che è facile violare

**Niente accenti nel codice.** Non nei commenti, non nelle stringhe, non nel
testo JSX che legge l'utente. Si scrive `e'`, `piu'`, `perche'`, `gia'`,
`cosi'`, `pero'`; in JSX l'apostrofo è `&apos;`. Gli accenti stanno **solo** nel
Markdown. Fanno eccezione nove file più vecchi di questa regola, dove l'accento
è dentro un commento o dentro testo citato alla lettera dalla specifica
(`prompts/extraction.v1.ts`, `prompts/redaction.v1.ts` e i file di validazione e
ingestione): non vanno sistemati per il gusto di farlo, ma il codice nuovo la
regola la rispetta.

**I commenti spiegano il perché, non il cosa.** Sono in italiano, spesso lunghi,
e nei file importanti hanno sottosezioni `##`. Un commento che ridice la riga
sotto non serve; un commento che dice *quale alternativa è stata scartata e a
che prezzo* è la ragione per cui questo repo si può riprendere in mano.

**I nomi dei test sono frasi intere** che descrivono una proprietà, non
`should_return_null`. Esempio vero: `"zero dice che non c'era nessuno, e non
«fatto»"`.

**Ogni test prova il caso pericoloso e anche l'errore opposto.** Se si prova che
un pulsante è spento quando deve, si prova anche che è acceso quando deve.

**Mutation testing a mano su ogni test nuovo.** Si crea `muta.py` + `.muta.json`
nella radice, si fa girare, si riporta quante mutazioni cadono e quante
sopravvivono, e **si cancellano i due file prima del commit**. Una mutazione
viva è un test che non serve, e va detto invece di essere nascosto.

**I difetti noti del README si riscrivono, non si cancellano.** Nella sezione
`## Cosa non c'è ancora, e si sa` ogni voce è un debito dichiarato. Quando il
lavoro la rende falsa, va sostituita con il residuo vero — quasi sempre ce n'è
uno più piccolo — e non tolta dall'elenco.

**Prima di scrivere nel README che qualcosa non è provato, verificalo.** In
questa sessione ho scritto un difetto noto falso («nessun test d'integrazione
prova che `CAMBIATA` riporti la scheda in `DA_RIVEDERE`») e il test esisteva, in
`tests/integration/procedures.e2e.test.ts:713`. Un `grep` prima di affermare.

**I messaggi di commit sono in italiano**, con un titolo che dice l'effetto e un
corpo che spiega il ragionamento. Finiscono con
`Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`.

**Mai stime di tempo**, né nel codice né nelle risposte.

Dai vincoli del brief, i due che si dimenticano più spesso: nessuna regola di
dominio nel frontend, e `packages/shared` non importa mai API del browser.

---

## Dove siamo arrivati

Le cinque fasi del brief sono chiuse. Da lì in poi si è lavorato a giri di
rifinitura, ognuno nato da un elenco di difetti noti.

**Ultimo giro concluso — quattro attività, quattro commit separati:**

| | | commit |
|---|---|---|
| 1 | test d'integrazione della scopa contro un Postgres vero | `2499602` |
| 2 | svuotare il cestino: `DELETE` vero, figli, vocali e byte | `8323a97` |
| 3 | «scollega tutti i dispositivi» senza cambiare password | `605c34f` |
| 4 | i test della schermata di dettaglio | `797d1d1` |

Stato all'ultimo commit: typecheck verde sui quattro passaggi, **921 test**
unit + web su 44 file, **305** d'integrazione su 11 file, albero pulito.

Il quarto ha portato `tests/web/detail.test.tsx` da 8 a 26 casi, sui quattro
punti in cui quella schermata decide qualcosa invece di stampare un campo: la
voce che si butta, i tre esiti della §8, le porte verso redazione e revisione, i
riferimenti che escono con `rel="noreferrer noopener"`. Ventitré mutazioni,
ventitré cadute.

---

## Il giro appena chiuso, quattro su quattro

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

> **Da fare a mano, una volta sola:** aggiungere al proprio `.env` le cinque
> righe `S3_ENDPOINT_TEST`, `S3_BUCKET_TEST`, `S3_REGION_TEST`,
> `S3_ACCESS_KEY_ID_TEST`, `S3_SECRET_ACCESS_KEY_TEST`, copiandole da
> `.env.example`. Senza, i due file nuovi non partono. `.env` non è leggibile
> dagli strumenti, quindi non ho potuto farlo io.

### 2 — fatto

`9fb2126`, «svuotare il cestino in un gesto solo, e sapere quante ne sono
andate». Il codice di produzione era già scritto e compilava dal giro prima;
questa sessione ha aggiunto i **sessantatré casi** che mancavano, sui quattro
project: il servizio, il client, la schermata, e la rotta contro Postgres.

Stato all'ultimo commit: typecheck verde sui quattro passaggi, **943 test**
unit + web su 44 file, **332** d'integrazione su 13 file, albero pulito.

Le tre decisioni che il diff non racconta — una scheda per volta invece di una
`deleteMany`, `ASSENTE` e `NON_ARCHIVIATA` contate come `saltate`, il pulsante
montato fuori dal ramo dell'elenco — adesso stanno nel README, in «Leggere,
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

Stato all'ultimo commit: typecheck verde sui quattro passaggi, **959 test**
unit + web su 44 file, **338** d'integrazione su 13 file, albero pulito.

Le due decisioni prese con l'utente prima di scrivere, e che il diff non
racconta: **solo l'elenco**, niente «chiudi questa sessione» per riga; e la
**data di nascita** (`MIN(issuedAt)` su tutta la famiglia) e non l'`issuedAt`
della riga viva, che sarebbe «ultimo accesso» sotto un altro nome. Entrambe
stanno nel README, insieme alla ragione delle due interrogazioni nell'adattatore
invece di una. Qui non si ripetono.

Due cose emerse strada facendo, che vale la pena ricordare:

- Il nome `session` era già occupato: `authSessionSchema` è la sessione di
  login (utente + token). Il contratto nuovo si chiama `openSession*`, e la
  porta restituisce `OpenSessionRecord`.
- Il piano diceva di mettere i casi della rotta in `tests/unit/routes.test.ts`.
  Quel file prova il router **a hash del web**, non le rotte Express — che
  nessun test unitario tocca. I casi della rotta sono finiti
  nell'integrazione, quelli di percorso e verbo in `apiClient.test.ts`.

Ventiquattro mutazioni, ventiquattro cadute. **Una cosa da ricordare sul
metodo**, per il prossimo `muta.py`: una mutazione è sopravvissuta al primo giro
perché *equivalente*, non perché il test fosse debole. Lo `userId` è scritto in
tutte e due le interrogazioni — quella che trova le famiglie vive e quella che
ne calcola la nascita — e toglierlo da una sola non cambia il risultato. La cura
non è aggiungere un caso: è che una mutazione possa toccare **più punti insieme**,
perché il difetto vero è dimenticare lo scope in tutti e due i posti. Vale ogni
volta che la stessa precauzione è scritta due volte.

### 4 — fatto

La domanda aperta è stata chiusa dall'utente: **niente Playwright**. Il ponte è
l'`ApiClient` vero contro il server HTTP vero, in Node, senza schermata sopra —
ampiezza «il giro intero più una guardia», e il CORS provato come dichiarazione e
non come applicazione.

Un file solo, `tests/integration/client.e2e.test.ts`, **29 casi** in sei
blocchi: la sessione, la rotazione dopo un 401, il giro completo della scheda,
le risposte senza corpo e il cestino, le intestazioni sul filo, la guardia.
Niente altro toccato: né il client né il server.

Stato all'ultimo commit: typecheck verde sui quattro passaggi, **959 test**
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
del terzo:

- `sbagliatoIlCorpo` è letto in due punti di `execute` (il ramo che ruota e
  quello che svuota la sessione). Le mutazioni sono **tre**: una che spegne la
  variabile e quindi tocca entrambi i punti insieme, e una per punto. Sono tutte
  e tre cadute, quindi i due rami sono davvero pinzati separatamente — è la
  verifica che il terzo giro suggeriva di fare.
- La guardia «senza token conservato non si chiede niente al server» ha avuto
  bisogno di una mutazione a **due sostituzioni**: il `return null` di
  `restoreSession` e il `throw` di `rotate()` proteggono la stessa cosa, e
  toglierne uno solo è una mutazione equivalente — l'altro fermerebbe comunque la
  richiesta prima che parta.

---

## Il giro nuovo, appena cominciato

Quattro attività scelte dai difetti noti, più una correzione che viene prima di
tutto. Una per commit, come sempre.

| | | stato |
|---|---|---|
| 0 | due difetti noti sbagliati, riscritti | in corso |
| 1 | `RecordScreen`: il gesto principale dell'app, senza nessun caso | da fare |
| 2 | `ReviewScreen` e `ProcedureCard`, le altre due scoperte | da fare |
| 3 | svuotare un cestino grosso senza incontrare il timeout di un proxy | da fare |
| 4 | chiudere **una** sessione sola | da fare |

### 0 — le due correzioni

Scritte nel giro scorso, sbagliate tutte e due, trovate rileggendo prima di
proporre il giro nuovo:

- Il residuo del ponte diceva che «il single-flight della rotazione non è provato
  sotto concorrenza». **Falso**: `tests/unit/apiClient.test.ts:292`, «due
  richieste parallele condividono una sola rotazione», mette due `me()` in un
  `Promise.all`, li fa fallire entrambi con `401` e conta una sola chiamata a
  `refresh`. Il residuo vero è più piccolo: non è provato **contro un server
  vero**, cioè contro uno che la rilevazione del riuso ce l'ha davvero.
- «Di schermate ne sono provate sette». Sono **nove** su dodici: l'elenco non
  citava `account.test.tsx` (30 casi) né `trash.test.tsx` (20), aggiunti nei due
  giri scorsi. Le tre senza nessun caso sono `RecordScreen`, `ReviewScreen` e
  `ProcedureCard` — ed è da lì che nascono le attività 1 e 2.

È la seconda volta che scrivo un difetto noto falso, e la regola che lo vieta è
già scritta qui sopra. Il modo per non farlo una terza volta non è ricordarsela:
è che ogni frase della forma «non è provato che X» sia preceduta da un `grep`,
sempre, anche quando sono sicuro.

### 4 — una decisione che si ribalta, e va detto

Un giro fa, sull'elenco delle sessioni, si è deciso **solo l'elenco, niente
«chiudi questa sessione» per riga**. Adesso si fa il contrario, e la scelta è
dell'utente. Il vincolo che resta dal ragionamento di allora: l'id di sessione
non deve esistere nel contratto **prima** del gesto che lo consuma — un id che
gira in ogni risposta senza che nessuno lo usi è solo un id che prima o poi
finisce in un log. Quindi l'id, la rotta che revoca e il pulsante atterrano
**insieme**, in un commit solo, su quattro project.

---

## Cosa resta scoperto

L'elenco intero è la sezione `## Cosa non c'è ancora, e si sa` del README, ed è
la prima cosa da leggere per decidere cosa fare dopo. I tre più grossi:

- **Il ponte arriva al client vero, e si ferma sotto la schermata.** Adesso
  l'`ApiClient` vero parla con il server vero, ma sopra di lui React, gli hook e
  la coda offline restano davanti a un finto, e il service worker non lo esegue
  nessuno. Restano fuori anche: il rifiuto di un'origine estranea (da Node non
  parte un `Origin`, quindi si prova la dichiarazione e non l'applicazione), la
  metà assistita della §9, la metà semantica della ricerca, il single-flight
  della rotazione **contro un server vero** (davanti a un `fetch` finto è
  provato: `apiClient.test.ts`, «due richieste parallele condividono una sola
  rotazione»), e i byte dell'audio, che vengono da un `Blob` e non da
  `MediaRecorder`.
- **Tre schermate su dodici non hanno nessun caso**: `RecordScreen` — il gesto
  principale dell'app — `ReviewScreen` e `ProcedureCard`. E del dettaglio
  restano circa cinquecento righe senza casi — campi stampati, sommario,
  trascrizione, player: quella è una scelta dichiarata (se spariscono si vede
  aprendo la pagina), le tre schermate no.
- **La scopa ha un bucket vero sotto, ma quel bucket è MinIO.** Le differenze
  che restano fuori sono quelle fra MinIO e S3 vero: i 503 sotto carico, la
  coerenza eventuale, i limiti di richieste al secondo.

E la più grande di tutte, che nessun test coprirà mai: che il pulsante di
registrazione sia davvero collegato al microfono lo dice solo premerlo su un
telefono vero.
