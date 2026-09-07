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
GET    /api/search?q=                  ricerca ibrida (§7), paginata con offset
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

**Il corpo della `POST` non contiene testo.** Solo id. Accettare testo avrebbe
reso questa rotta un doppione della `PATCH` con un nome più rassicurante, cioè
l'unico modo di far passare per redazione una modifica qualunque.

**La scrittura passa dalla `PATCH`,** non dal repository. Scavalcarla sarebbe
stato più corto e avrebbe saltato il ricalcolo di `searchText`: una scheda
redatta resterebbe cercabile per il codice fiscale che le è stato tolto, e
nessun test se ne accorgerebbe, perché nessuno cerca un codice fiscale. Il test
di integrazione lo verifica sull'indice vero — cerca, redige, ricerca, e si
aspetta zero.

**Il flag non si toglie da solo.** Dopo la redazione `contieneDatiSensibili`
resta, e la schermata lo dice. Farlo sparire perché i rilevatori non trovano più
niente vorrebbe dire far dichiarare a quattro espressioni regolari che la scheda
è pulita, quando l'unica cosa che sanno è di non riconoscere più i formati che
conoscono: il nome dell'ex moglie di un cliente non ha un checksum. La
«revisione esplicita» che la §9 chiede resta un gesto di una persona, e passa
dalla `PATCH` come prima.

**Fuori dalla passata restano le trascrizioni e le note delle esecuzioni.** La
trascrizione è il verbale di ciò che l'utente ha detto: riscriverla farebbe
perdere la corrispondenza fra l'audio e il suo testo, che è l'unica cosa che
permette di capire da dove è uscita una scheda sbagliata (§3). Le note delle
esecuzioni sono il diario privato di chi ha eseguito la procedura, e non escono
dalla scheda quando la scheda esce. La §9 parla di ciò che si condivide, e ciò
che si condivide è la scheda.

Resta scoperto quello che il brief chiama «assistita dall'LLM per il resto»: i
nomi di persona, gli indirizzi di casa, tutto ciò che non ha un formato. Vedi
[Cosa non c'è ancora](#cosa-non-cè-ancora-e-si-sa).

---

## L'app

Sei schermate, un router a `hashchange` di trenta righe, nessuna libreria di
componenti e nessun framework CSS. Il bundle sta in **72 kB compressi**, foglio
di stile compreso.

```
apps/web/src/
  recording/   MediaRecorder, GPS, coda IndexedDB, svuotamento, disco pieno, contesto React
  screens/     login, registrazione, lista, ricerca, scheda, revisione, redazione
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
#   → proposte[], ognuna con campo, etichetta, valore, sostituzione e contesto

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
client API e i provider fake. Del client, il test che ha già ripagato il proprio
costo riguarda le due sole rotte con una query string: i parametri mandati si
confrontano con le chiavi dello schema, non con un URL scritto a mano. La query
si costruisce elencando i campi uno per uno, e `offset` era stato aggiunto al
contratto della ricerca e dimenticato lì — premere «Successive» ricaricava la
prima pagina, e niente falliva da nessuna parte. Della Fase 2: la validazione della §5 caso per caso
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
tutto è stato applicato. Della cancellazione di una registrazione: che riga e
oggetto spariscano entrambi, che una `IN_ELABORAZIONE` dia `409` e resti dov'è,
e i due casi in cui lo storage non collabora — l'oggetto già assente, che è un
successo perché tutti e tre i provider trattano così una `delete` a vuoto, e il
bucket irraggiungibile, che invece deve lasciare all'utente il suo `204` e la
chiave a chi tiene il bucket.

Le schermate non hanno test, e non c'è `jsdom` fra le dipendenze. È la ragione
per cui `format.ts`, `routes.ts`, `uploader.ts`, `salvataggio.ts` e `spazio.ts`
esistono come moduli separati e privi di DOM: lì sta tutto ciò che si può
sbagliare in silenzio, e
`tsconfig.tests.json` non carica nemmeno la libreria DOM, così un modulo che
nomina `window` non è importabile da un test e la separazione non può marcire.

Fra i test unitari c'è anche `deploy.test.ts`, che non prova codice ma i tre file
di configurazione del deploy. `netlify.toml` e i due `railway.toml` sono
eseguibili solo dalle piattaforme, quindi ogni nome che contengono è una promessa
verificata al primo deploy e non prima: uno script `npm run` che non esiste, un
`node apps/api/dist/index.js` che punta a un file che il `tsc` non produce più, un
`healthcheckPath` che nessuna rotta serve, un `publish` che non è la `outDir` di
Vite, un `for = "/sw.js"` per un file che è stato rinominato. Sono tutti errori
che vivono in un file solo e si scoprono su una macchina lontana. Il test li
riporta a casa: legge i tre `.toml` con un lettore scritto per l'occasione — una
dipendenza TOML per cinquanta righe che abbiamo scritto noi sarebbe stata
sproporzionata — e controlla che i nomi citati esistano da questa parte. Include,
come `guards.test.ts`, un blocco che prova la guardia stessa: senza, un lettore
rotto renderebbe vera ogni asserzione della forma «tutti gli elementi sono
validi».

**integration** applica le migration su `DATABASE_URL_TEST`, poi verifica lo
schema fisico contro il catalogo di Postgres, esegue il seed vero e ricontrolla
le invarianti, e prova autenticazione e ingestione end-to-end su HTTP reale —
l'app gira su una porta effimera e ci si parla con `fetch`, che è il motivo per
cui `supertest` non è fra le dipendenze.

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

Il CORS si prova lì e non con un finto oggetto request, pur non toccando il
database: le cose che si rompono sono cose dello stack — un preflight che
attraversa il parser JSON e muore su un corpo vuoto, un `OPTIONS` che finisce nel
gestore delle rotte inesistenti, un'intestazione impostata dopo che la risposta è
già partita. Nessuna si vede chiamando la funzione middleware a mano.

Vale lo stesso per `security.e2e.test.ts`: che `req.ip` esista davvero dietro
Express, che il `429` esca dall'error handler con il corpo del contratto invece
che come stack, che il middleware sia montato sulle rotte giuste e non su tutte,
e — il test che conta più degli altri — che un `X-Forwarded-For` inventato non
compri un budget nuovo. Ogni test riparte da un server nuovo, perché i conteggi
stanno in memoria di processo e `resetDatabase()` non li tocca.

`DATABASE_URL_TEST` non ha un valore di default, di proposito: i test fanno
`TRUNCATE`, e un default che puntasse al database di sviluppo lo svuoterebbe in
silenzio.

### La CI, e perché sono tre job

`.github/workflows/ci.yml` gira a ogni push su `master` e su ogni pull request.

| Job | Cosa fa | Cosa dimostra |
|---|---|---|
| `verifica` | `typecheck` + `npm test` | **senza nessun service container** |
| `integrazione` | `npm run test:integration` | Postgres con pgvector, migration versionate |
| `build` | `build:web`, `build:api`, `build:worker` | i tre comandi che girano in produzione |

Il primo non ha il database, e non è una svista: il repository promette che
`npm test` giri senza Docker, e una promessa che nessuno verifica scade da sola.
Con un job solo, il giorno in cui un test unitario aprisse una connessione
nessuno se ne accorgerebbe — il database ci sarebbe, e sarebbe verde.

Due dettagli del job di integrazione. Il database di test lo crea `initdb` con
`POSTGRES_DB`, perché in locale lo crea `docker/initdb` e lì non si può: i
service container partono **prima** del checkout, quindi quella cartella non
esiste ancora sul disco. E `DATABASE_URL` resta deliberatamente non definita —
il `globalSetup` rifiuta di partire se punta dove punta `DATABASE_URL_TEST`, e
in CI di database ce n'è uno solo: definirla sarebbe l'unico modo di sbagliare.
Le migration le applica il `globalSetup` con `migrate deploy` e non un passo del
workflow, così il percorso provato in CI è lo stesso di chi sviluppa e
`schema.test.ts` continua a verificare che le migration versionate bastino da
sole a costruire indice HNSW e colonna generata.

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

## Sicurezza in produzione

Tre cose che finché il dominio non è pubblico non si notano, e il giorno dopo
sono l'unica cosa che conta: contare i tentativi di accesso, dire al browser cosa
gli è permesso fare, e non ripetere all'infinito una chiamata a pagamento che
fallisce.

### Il limite dei tentativi

`POST /api/auth/signup`, `/login` e `/refresh` passano da
`apps/api/src/http/middleware/rateLimit.ts`: finestra fissa, in memoria del
processo, **dieci tentativi al minuto per IP e per rotta** di default
(`AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_SEC`). Oltre il limite è un `429`
con `error.code: "RATE_LIMITED"`, `Retry-After`, e le tre `RateLimit-*` — che ci
sono anche quando la richiesta passa, così un client attento rallenta da solo
invece di scoprire il muro sbattendoci.

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
  tentativi su indirizzi email diversi senza mai toccare il limite.
- **In memoria, non su Redis.** Redis sarebbe un quarto servizio, un'altra
  variabile e un altro modo di rompersi, per proteggere l'account di una persona.
  Il prezzo è scritto: con più repliche il limite effettivo è
  `AUTH_RATE_LIMIT_MAX × repliche`. Con una replica — che è la configurazione —
  è esatto.

`/logout` e `/me` non sono limitati. Il primo non regala niente a chi lo martella;
il secondo sta già dietro `requireAuth`, e limitarlo significherebbe rompere
l'app in mano a un utente legittimo che ricarica.

Le voci scadute si eliminano ogni 500 richieste, dentro la richiesta stessa: un
`setInterval` terrebbe vivo l'event loop e un processo che non muore su `SIGTERM`
viene ucciso dalla piattaforma dopo il timeout, ogni singolo deploy.

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
cambierebbe: un `400`, `413`, `415` o `422` da un fornitore — stati che parlano
del contenuto della richiesta e non del server che la riceve — e un oggetto che
lo storage non ha (404 da S3, `ENOENT` dal filesystem).

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
| `react-router` | `hashchange`, trenta righe per sei schermate |
| `@tanstack/react-query` | `useAsync`, venti righe: carica e ricarica |
| `vite-plugin-pwa` `workbox` | un service worker di sessanta righe |
| `tailwind` e simili | un foglio di stile di 2 kB compressi |
| `jsdom` `@testing-library` | la logica sta nei moduli puri, e quelli sono testati |

---

## Cosa non c'è ancora, e si sa

- **Il limite dei tentativi sta in memoria del processo.** Con una replica è
  esatto; con `n` repliche il limite effettivo è `AUTH_RATE_LIMIT_MAX × n`, e un
  riavvio azzera i conteggi. Un attacco lento e paziente resta possibile: questo
  ferma la forza bruta, non chi prova dieci password al minuto per un mese.
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
- **Delle cause di fallimento si riconoscono solo quelle dichiarate.** Un
  fornitore che rifiuta il contenuto con un `400`, `413`, `415` o `422` esce
  subito dalla coda; tutto il resto continua a comprare tre tentativi. Ma i
  guasti definitivi che non si annunciano con uno di quei quattro numeri esistono
  — un `500` che nasconde un audio illeggibile, un `200` con un corpo che non si
  interpreta — e per quelli l'ora e mezza si paga ancora. Allungare l'elenco
  richiede di misurare fallimenti veri, non di indovinarli: finché non ci sono,
  ogni aggiunta rischia di togliere i tentativi automatici a chi ne aveva
  bisogno.
- **Della §9 c'è la metà deterministica.** Il blocco alla pubblicazione e la
  passata su codici fiscali, IBAN, email e telefoni esistono; l'«assistita
  dall'LLM per il resto» no. Nomi di persona, indirizzi di casa, il numero di
  pratica che identifica qualcuno: tutto ciò che non ha un formato verificabile a
  macchina passa indenne, e chi rilegge la scheda deve accorgersene da solo. Il
  flag `contieneDatiSensibili` resta acceso anche dopo una passata proprio per
  questo — dice che l'estrazione ha visto qualcosa, e nessuna regex può
  smentirla.
- **Le schermate non hanno test automatici.** La logica che vale la pena
  verificare è stata spinta fuori dai componenti apposta, ma resta che nessuno
  controlla che il pulsante di registrazione sia collegato al microfono se non
  premendolo.
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
- **L'audio si toglie uno per uno, e nessuno raccoglie i resti.**
  `DELETE /api/recordings/:id` cancella la riga e poi l'oggetto, quindi la strada
  per far sparire una registrazione esiste. Ma fra le due operazioni c'è una
  finestra di qualche millisecondo, e la stessa finestra sta fra il `put` e la
  riga del caricamento: un processo che muoia lì in mezzo lascia nel bucket un
  file che nessuna riga nomina più. Quando la cancellazione fallisce per conto
  suo — bucket irraggiungibile, permesso mancante — l'utente riceve comunque il
  suo 204 e la chiave finisce in un `logger.error`, che è meglio di niente ma è
  un log, non un lavoro. Manca la scopa: nessun job confronta le chiavi del
  bucket con le righe della tabella, e nessuna lifecycle rule è configurata.
  Sono kilobyte, finché non sono gigabyte.
- **Cancellare una registrazione non cancella ciò che ne è derivato.** La scheda
  resta, con la sua trascrizione dentro i campi che l'estrazione ha riempito. È
  voluto e sta scritto sopra, ma vale la pena dirlo anche qui, perché chi preme
  «Elimina» su un vocale può ragionevolmente credere di aver cancellato tutto
  quello che quel vocale ha prodotto. Non esiste un gesto solo che faccia le due
  cose: per togliere anche la scheda bisogna archiviarla a parte, e archiviarla
  non la cancella.
- **La CI non ferma un deploy.** I test girano a ogni push, ma Railway e Netlify
  costruiscono ciò che sta su `master` appena ci arriva, senza chiedere niente a
  GitHub: un rosso è una notifica, non un cancello. Farlo diventare un cancello
  è un'impostazione delle due piattaforme, e sta da quella parte.
- **Del deploy si provano i nomi, non il comportamento.** `deploy.test.ts`
  garantisce che ogni script, percorso e rotta citati nei tre `.toml` esistano
  davvero da questa parte, ma nessun test può dire che Railway legga
  `watchPatterns` come crediamo, che Netlify applichi quelle intestazioni a
  quelle risposte, o che una CSP passi in un browser vero. Un file sintatticamente
  valido e semanticamente frainteso resta un errore che si scopre al primo deploy.

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
