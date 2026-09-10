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

## Il giro in corso, a metà

Quattro attività scelte dall'elenco dei difetti noti, una per commit.

| | | stato |
|---|---|---|
| 1 | MinIO sotto la scopa: uno storage vero nei test d'integrazione | fatto, `8d5f608` |
| 2 | svuotare il cestino in un gesto solo | fatto, `9fb2126` |
| 3 | l'elenco delle sessioni aperte, con la sola data di nascita | da fare |
| 4 | il ponte fra la schermata e il server | da fare |

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

### 4 — c'è una domanda aperta

Prima di cominciare il quarto va chiesto all'utente se vuole un browser pilotato
(Playwright, una dipendenza pesante) o un ponte più leggero: l'`ApiClient` vero
contro il server HTTP vero, senza schermata.

---

## Cosa resta scoperto

L'elenco intero è la sezione `## Cosa non c'è ancora, e si sa` del README, ed è
la prima cosa da leggere per decidere cosa fare dopo. I tre più grossi:

- **Fra la schermata e il server non passa mai un byte.** I test web premono i
  pulsanti davanti a un `ApiClient` finto, quelli d'integrazione parlano HTTP
  vero senza schermata sopra, e le due metà si toccano solo attraverso un tipo
  TypeScript. Un `fetch` che non allega l'header o una CORS che rifiuta lasciano
  verdi entrambe le suite.
- **Del dettaglio restano circa cinquecento righe senza casi** — campi stampati,
  sommario, trascrizione, player. È una scelta dichiarata (se spariscono si vede
  aprendo la pagina), non una dimenticanza.
- **La scopa ha un bucket vero sotto, ma quel bucket è MinIO.** Le differenze
  che restano fuori sono quelle fra MinIO e S3 vero: i 503 sotto carico, la
  coerenza eventuale, i limiti di richieste al secondo.

E la più grande di tutte, che nessun test coprirà mai: che il pulsante di
registrazione sia davvero collegato al microfono lo dice solo premerlo su un
telefono vero.
