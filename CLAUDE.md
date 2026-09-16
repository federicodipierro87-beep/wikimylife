# CLAUDE.md — memoria di lavoro

Questo file lo legge Claude Code all'avvio di ogni sessione. Serve a due cose:
sapere **come si lavora qui** e sapere **dove eravamo arrivati**. Non è
documentazione del prodotto — quella sta nel `README.md`, che è lungo e va letto
quando serve.

Siccome viene caricato ogni volta, **deve restare corto**: sopra i 40.000
caratteri Claude Code avvisa che occupa troppo contesto. Ci sta ciò che serve
*sempre*; la cronaca di ciò che è stato fatto sta altrove.

I file di riferimento, in ordine di autorità:

| file | cos'è | si modifica? |
|---|---|---|
| `wikimylife-schema.md` | la specifica del prodotto, con le sezioni numerate (§1 pipeline, §4 contratto, §5 validazione, §7 ricerca, §8 esecuzioni, §9 redazione) | **no**, è il contratto |
| `wikimylife-prompt-claude-code.md` | il brief originale: fasi, vincoli trasversali | **no**, è la consegna |
| `README.md` | come funziona ciò che esiste davvero, e cosa non esiste | **sì, sempre**, insieme al codice |
| `docs/diario.md` | la cronaca dei giri: quale commit, quali numeri, quale alternativa scartata | **sì**, in coda, a fine giro |

`docs/diario.md` si apre a mano quando si tocca qualcosa e si vuole sapere se ci
si è già scottati lì. **Non va richiamato con un `@import`**: un import lo
rimetterebbe nel contesto di ogni avvio, che è il problema per cui è stato
scorporato.

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

**Prima di scrivere che qualcosa non è provato, verificalo.** Ogni frase della
forma «non è provato che X» va preceduta da un `grep`, sempre, anche quando sono
sicuro, e **anche quando la fonte è un altro strumento**: il riassunto di un
agente di ricerca ha la stessa autorità di un ricordo, cioè nessuna. È già
successo **cinque volte** di scrivere un difetto noto falso — una di queste
*dentro il commit che ne correggeva altri due*, tre righe sotto questa regola — e
l'ultima non l'ha trovata un `grep` ma un processo che si rifiutava di partire.
I cinque sono elencati uno per uno in `docs/diario.md`.

**I messaggi di commit sono in italiano**, con un titolo che dice l'effetto e un
corpo che spiega il ragionamento. Finiscono con
`Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`.

**Mai stime di tempo**, né nel codice né nelle risposte.

Dai vincoli del brief, i due che si dimenticano più spesso: nessuna regola di
dominio nel frontend, e `packages/shared` non importa mai API del browser.

---

## Lezioni di metodo

Regole nate da un errore concreto, che valgono oltre il giro in cui sono nate.
Il caso da cui viene ciascuna sta in `docs/diario.md`.

### Sulle mutazioni

- **Una mutazione di controllo in ogni `.muta.json`**, che cambia *solo un
  commento* e quindi **deve sopravvivere**. Senza, «dodici cadute su dodici» è
  indistinguibile da «dodici volte lo stesso guasto del runner» — è già successo,
  con un `UnicodeDecodeError` che faceva fallire il comando sempre.
- **Una precauzione scritta due volte va mutata in tre modi**: tutti e due i
  punti insieme, e poi **uno per volta**. La congiunta da sola non basta (cade
  anche se un solo punto è pinzato, e fa da copertura all'altro); le singole da
  sole neanche (una può essere equivalente). Vale per i filtri ripetuti fra Prisma
  e doppio in memoria, per lo `userId` scritto in due interrogazioni, per i
  messaggi costruiti in due rami gemelli.
- **`.muta.json` accetta una lista di sostituzioni per mutazione**, con un
  conteggio atteso per ciascuna. Serve per le mutazioni che altrimenti non
  compilerebbero (`<button>` → `<div>` vuole anche il tag di chiusura) e per
  quelle ripetute in più punti dello stesso file.
- **Saltata non è caduta.** Se `muta.py` dice che una sostituzione non ha trovato
  il testo (quasi sempre: indentazione diversa dentro un blocco multiriga), va
  corretta e rifatta da sola con `python muta.py <indice>`, non contata fra le
  cadute.
- **Una mutazione equivalente si dichiara, non si copre.** Se sopravvive perché
  non descrive nessun difetto reale, non si aggiunge un caso: si scrive perché, e
  se il commento del codice prometteva più di quanto è vero, si corregge il
  commento.
- **Una costante che è un compromesso si difende con un intervallo**, non con un
  `toBe` tautologico. I casi che la usano simbolicamente (`COSTANTE + 7`) si
  muovono insieme a lei e non la proteggono: serve una guardia che dica fra quali
  estremi ha senso, e perché esistono i due estremi.

### Sui test che sembrano verdi e non provano niente

- **`expect(null).not.toHaveProperty(...)` passa.** Asserire l'*assenza* di un
  campo dentro un valore raccolto da una callback vuole un `not.toBeNull()`
  prima, o il caso resta verde anche se il server non è mai stato chiamato.
- **Per l'identità di un nodo del DOM si guarda `isConnected`**, non il testo e
  non il `focus`. Una riga riciclata da React mostra il contenuto giusto lo
  stesso, e jsdom perde il focus da solo quando il nodo esce dal documento.
- **Due montaggi nello stesso caso vogliono `within(container)`.** `screen` cerca
  in tutto il documento: un'asserzione di assenza fatta dopo il secondo montaggio
  trova l'elemento del primo e passa al contrario.
- **Si guarda il contenitore, non solo il pulsante.** Un riquadro che resta nel
  DOM vuoto disegna bordi e separatori; i casi che cercano il pulsante non lo
  vedono, perché il pulsante ha una sua condizione. Si usa
  `container.querySelector(".classe")`.
- **`navigate()` si verifica leggendo `window.location.hash`**, non sostituendo
  il modulo del router: un finto dice che è stata chiamata una funzione, l'hash
  dice dove si è finiti. Serve un `beforeEach` che lo riporti al punto di
  partenza, o l'hash lasciato dal caso prima fa passare per «non ha navigato» un
  caso che ha navigato.
- **Un 401 non si aspetta, si provoca.** `ACCESS_TOKEN_TTL_MIN` ha un minimo di
  un minuto, e un test che dorme un minuto è un test che qualcuno toglie. Si
  costruisce un secondo client con il refresh token del primo nel deposito e la
  memoria vuota: è lo stato esatto dopo un riavvio del browser.

### Dove NON vanno i test

Tre piani di lavoro hanno già sbagliato indirizzo. I nomi ingannano:

- `tests/unit/contract.test.ts` è il contratto **dell'estrazione**
  (`extractionContractSchema`, §4.1), non il contratto HTTP.
- `tests/unit/routes.test.ts` è il router **a hash del web**, non le rotte
  Express — che nessun test unitario tocca.
- Le rotte Express si provano **nell'integrazione**, dove un corpo malformato
  attraversa `parseBody` davvero. Percorso e verbo si provano in
  `apiClient.test.ts`.

### Su ciò che si scrive e su ciò da cui si dipende

- **Prima di scrivere una stringa nuova destinata all'utente, `grep`ala.** Nei
  messaggi le parole sono interfacce: riusare con un terzo significato una frase
  che due test cercano come marcatore non rompe niente e non fa protestare
  nessuno — rende solo inutile il marcatore.
- **Non si lega mai una decisione alla prosa di un terzo.** Non i messaggi di Zod
  (senza `errorMap` sono inglese di libreria), non il corpo di errore di un
  fornitore. Il giorno che lo riscrivono, nessun test cade.
- **La tassonomia degli errori altrui non si deduce: si osserva.** 1050 test
  verdi non hanno visto che un fornitore risponde `400` a un problema di
  credenziali, e la prima registrazione vera l'ha trovato in un minuto.

### Sulle piattaforme

- **Rileggere ciò che si è impostato.** Una piattaforma può accettare un valore e
  ignorarlo senza errore: `railway config pull`, `curl -I`, il pannello riletto.
  Che la chiamata sia riuscita non dice che il valore sia applicato.
- **Un deploy automatico che non si è mai visto scattare non si sa se esiste.**
  La configurazione sembrava a posto e nessun push faceva partire niente. L'unico
  modo di saperlo è spingere qualcosa e guardare i cruscotti.
- **`grep -c` su un bundle minificato mente**: è una riga sola da centinaia di kB,
  e ha risposto `0` su un file che conteneva `VITE_API_URL`. Il confronto giusto è
  binario, byte a byte, contro il file costruito in locale.

---

## Dove siamo arrivati

Le cinque fasi del brief sono chiuse. Da lì in poi si è lavorato a giri di
rifinitura, ognuno nato da un elenco di difetti noti; poi è arrivato il primo
deploy vero, e con lui i primi due difetti trovati dalla produzione invece che
dai test. Il racconto di tutto questo è in `docs/diario.md`.

**Stato all'ultimo commit** (`cfe5351`): typecheck verde sui quattro passaggi,
**1064 test** unit + web su 47 file, **381** d'integrazione su 14 file, albero
pulito.

### Cosa gira, e dove

| | |
|---|---|
| repo | `github.com/federicodipierro87-beep/wikimylife`, `master` |
| Railway | progetto `wikimylife`, tre servizi: `Postgres`, `api`, `worker` |
| API | `https://api-production-15b2f.up.railway.app` |
| storage | un bucket nativo Railway, endpoint `t3.storageapi.dev`, virtual-host |
| Netlify | `https://wikimylife.netlify.app`, collegato a `master`, deploy continuo |

Nessun segreto sta in git e nessuno sta qui: chiavi, `JWT_ACCESS_SECRET` e
credenziali S3 vivono solo nei pannelli delle due piattaforme. `SIGNUP_ENABLED`
è `false`, verificato riprovando la `signup` e ottenendo `403 SIGNUP_DISABLED` —
non fidandosi del pannello.

### Cosa resta da fare a mano, e l'utente lo sa

- **Ruotare le due chiavi API**, perché sono passate dalla chat.
- **Le cinque righe `S3_*_TEST` nel proprio `.env`**, copiate da `.env.example`:
  `S3_ENDPOINT_TEST`, `S3_BUCKET_TEST`, `S3_REGION_TEST`, `S3_ACCESS_KEY_ID_TEST`,
  `S3_SECRET_ACCESS_KEY_TEST`. `.env` non è leggibile dagli strumenti, quindi non
  posso farlo io. Senza, **nessuno** dei quattordici file d'integrazione parte: il
  `globalSetup` prepara il bucket *prima* di raccogliere i file e muore con
  `BucketDiTestAssente`. Il giro d'aiuto, finché le righe mancano, è passarle
  sull'invocazione — `dotenv` non sovrascrive ciò che è già in `process.env`:

  ```bash
  S3_ENDPOINT_TEST="http://127.0.0.1:9100" S3_BUCKET_TEST=wikimylife-test \
  S3_REGION_TEST=us-east-1 S3_ACCESS_KEY_ID_TEST=wikimylife \
  S3_SECRET_ACCESS_KEY_TEST=wikimylife-segreto npm run test:integration
  ```

### Tre test che traballano sotto carico, e non è colpa di chi li vede rossi

`list.test.tsx` («cambiare ambito riporta alla prima pagina») e
`account.test.tsx` («manda la password attuale e la nuova») vanno in timeout su
una `findBy*` quando la macchina è occupata; `guards.test.ts` cammina l'albero del
repo con il timeout di 5s di default e dentro `npm test` intero ogni tanto lo
sfora. Nessuno dei tre è stato introdotto dal lavoro recente. **Chi vede rosso lì
rifaccia girare il file da solo** prima di cercare la causa altrove — ma non
prima di aver escluso di averli rotti davvero, il che vuol dire rifare girare la
suite **con** le modifiche e vederla verde due volte, non solo sull'albero pulito.

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
- **Ogni schermata ha dei casi, nessuna è provata per intero.** Il debito non è
  più «quali mancano» ma «quanto di ognuna è coperto»: del dettaglio restano
  circa cinquecento righe senza casi — campi stampati, sommario, trascrizione,
  player — e dell'elenco e della ricerca si prova cosa chiedono al server, non
  che le schede compaiano. È una scelta dichiarata (quella roba, se sparisce, si
  vede aprendo la pagina), ma «provata» e «funziona» restano due parole diverse.
- **La scopa ha un bucket vero sotto, ma quel bucket è MinIO.** Le differenze
  che restano fuori sono quelle fra MinIO e S3 vero: i 503 sotto carico, la
  coerenza eventuale, i limiti di richieste al secondo.

E la più grande di tutte, che nessun test coprirà mai: che il pulsante di
registrazione sia davvero collegato al microfono lo dice solo premerlo su un
telefono vero. **Da adesso si può**: il sito è pubblico e la pipeline è
collegata a modelli veri, quindi la cosa più utile che si possa fare al prossimo
giro non è un test — è registrare un vocale da un telefono e guardare dove si
ferma. Nessuno l'ha ancora fatto, e finché non succede «funziona» resta una
parola sostenuta solo da finti.
