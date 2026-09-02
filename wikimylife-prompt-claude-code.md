# Prompt per Claude Code — WikiMyLife

> **Come usarlo:** crea una cartella vuota `wikimylife/`, copiaci dentro il file
> `wikimylife-schema.md`, apri la cartella in VS Code, lancia Claude Code e incolla
> tutto il testo qui sotto (dalla riga `---` in poi).

---

## Contesto

Sto costruendo **WikiMyLife**, un'app che trasforma note vocali in schede-procedura riutilizzabili. L'utente registra un vocale subito dopo aver portato a termine qualcosa (una pratica burocratica, un'operazione di lavoro, una riparazione domestica), e l'app lo trasforma in una scheda strutturata e ricercabile che potrà rileggere anche fra due anni.

Nella root del progetto trovi il file **`wikimylife-schema.md`**: contiene lo schema dati completo, il contratto JSON di estrazione, il prompt per l'LLM e le regole di validazione. **Leggilo per intero prima di scrivere qualsiasi cosa.** È la specifica autoritativa: se qualcosa in questo prompt sembra contraddirlo, fermati e chiedimi quale delle due vale.

Sono uno sviluppatore, quindi puoi essere tecnico e diretto. Non spiegarmi cosa fa Prisma.

## Architettura

```
   PWA (Netlify)              App nativa (in futuro)
   React + Vite               React Native / Expo
        │                              │
        └──────────────┬───────────────┘
                       │  HTTPS  ·  JWT Bearer  ·  JSON
                       ▼
        ┌──────────────────────────────────┐
        │  API — Railway                   │
        │  ┌────────────────────────────┐  │
        │  │ rotte HTTP (Express, Zod)  │  │  sottile: valida e delega
        │  ├────────────────────────────┤  │
        │  │ servizi di dominio         │  │  zero dipendenze da HTTP
        │  ├────────────────────────────┤  │
        │  │ provider (interfacce)      │  │  Transcription · Extraction · Storage
        │  └────────────────────────────┘  │
        └───────┬─────────────────┬────────┘
                │                 │
        ┌───────▼──────┐   ┌──────▼────────────┐
        │ Worker job   │   │ API esterne       │
        │ (Railway,    │   │ Whisper · Anthropic│
        │  2° servizio)│   └───────────────────┘
        └───────┬──────┘
                │
   ┌────────────▼──────────┐   ┌────────────────────┐
   │ Postgres + pgvector   │   │ Storage audio      │
   │ (Railway)             │   │ fs locale → S3     │
   └───────────────────────┘   └────────────────────┘
```

**Il backend è headless e ignora chi lo chiama.** Nessuna logica applicativa deve mai finire nel frontend o in una function di Netlify: Netlify ospita solo asset statici e le regole di redirect. Ogni comportamento del prodotto vive nell'API su Railway, così il giorno in cui affianco un'app nativa questa parla con lo stesso backend senza che io debba riscrivere niente.

**Tre strati nell'API, con dipendenze a senso unico.** Le rotte conoscono i servizi, i servizi conoscono i provider, e nessuno guarda all'indietro. Un servizio di dominio non deve sapere che esiste Express: niente `req` o `res` che scendono sotto lo strato delle rotte.

**Il worker è un secondo servizio Railway** che gira dallo stesso repo e condivide il database. Non è un thread dentro l'API: l'elaborazione di un vocale può durare decine di secondi e non deve competere con le richieste degli utenti.

### Predisposizione all'app nativa

Non costruiamo l'app nativa adesso, ma ogni scelta di oggi deve tenerla possibile senza rifacimenti. Concretamente:

- **Autenticazione con JWT nell'header `Authorization`**, mai cookie di sessione. I cookie funzionano male fuori dal browser. Access token a vita breve più refresh token, e il refresh token va conservato dal client dietro un'interfaccia `SecureStorageAdapter` (in web: `localStorage`; in nativo: keychain).
- **`packages/shared` deve restare isomorfo**: tipi, enum, schemi Zod e client API tipizzato, costruito solo su `fetch`. Nessun riferimento a `window`, `document` o ad API del browser. Deve poter essere importato tal quale da React Native.
- **Le capacità del dispositivo stanno dietro adapter**, definiti come interfacce in `packages/shared` e implementati in `apps/web`: `RecorderAdapter` (MediaRecorder), `LocationAdapter` (Geolocation), `UploadQueueAdapter` (IndexedDB), `SecureStorageAdapter`. La logica di cattura e accodamento è scritta contro le interfacce, non contro le API del browser.
- **Nessuna logica di prodotto nei componenti React.** Regole di stato, sequenza di upload, gestione della coda offline stanno in funzioni pure o hook che dipendono solo dagli adapter, così sono riutilizzabili con una interfaccia diversa.
- **Formato audio comune**: usa un contenitore che sia producibile sia da MediaRecorder sia da un recorder nativo, e definisci lato server la conversione se necessario. Il client dichiara il mime type, il server non lo dà per scontato.
- **Genera uno spec OpenAPI dall'API.** Serve a produrre il client tipizzato ora e a generarne uno per l'app nativa domani senza reverse engineering.
- **Upload dell'audio pensato per arrivare a URL prefirmato.** Anche se in fase 2 l'audio passa dall'API in multipart, isola quel passaggio dietro il `StorageProvider` così da poterlo spostare senza toccare i client.

## Stack

- **Monorepo** con workspace npm: `apps/api`, `apps/worker`, `apps/web`, `packages/shared`
- **Backend:** Node.js + TypeScript + Express, Prisma, PostgreSQL 16 con estensione `pgvector`
- **Frontend:** React + TypeScript + Vite, configurato come PWA (serve l'accesso al microfono e l'installazione su telefono)
- **STT:** Whisper via API OpenAI, dietro un'interfaccia `TranscriptionProvider` così da poterlo sostituire
- **Estrazione:** Anthropic API con tool use / structured output, dietro un'interfaccia `ExtractionProvider`
- **Sviluppo locale:** `docker-compose` per Postgres con pgvector, storage audio su filesystem locale dietro un'interfaccia `StorageProvider` (in produzione diventerà object storage)
- **Test:** Vitest
- **Deploy:** Railway per API, worker e Postgres; Netlify per la PWA. È una scelta già presa, non da rivalutare. Configurala solo in fase 5, ma tienine conto da subito: niente function serverless, niente dipendenze da filesystem effimero, configurazione interamente da variabili d'ambiente

Le tre interfacce `Provider` sono un requisito, non un suggerimento: voglio poter cambiare fornitore di STT o di LLM senza toccare la logica applicativa, e poter testare tutto con implementazioni finte.

## Modalità di lavoro

Lavoriamo **una fase alla volta**. Alla fine di ogni fase: fermati, mostrami cosa hai creato in sintesi, dimmi come lo verifico e aspetta il mio via libera prima di passare alla successiva. Non anticipare fasi successive.

All'inizio di ogni fase, se ci sono decisioni ambigue, fammi al massimo due domande. Se non ce ne sono, procedi senza chiedere.

---

## Fase 1 — Fondamenta

- Struttura del monorepo con i workspace
- `docker-compose.yml` con Postgres 16 + pgvector, volume persistente
- `schema.prisma` che riproduce **esattamente** i modelli descritti in `wikimylife-schema.md`, sezione 6. Non aggiungere campi che non sono nella specifica e non rinominare nulla. Se un campo ti sembra mancante, segnalamelo invece di aggiungerlo.
- Prima migration applicata, più la migration separata che abilita `CREATE EXTENSION vector`
- Script di seed con un utente di prova e due procedure di esempio complete (una personale, una di lavoro)
- `packages/shared`: tipi TypeScript ed enum condivisi fra api e web, derivati dal contratto JSON della sezione 4.1, più uno schema Zod che lo valida
- `.env.example` con tutte le variabili necessarie. Nessun segreto nel repo, mai
- README con i comandi per partire da zero

## Fase 2 — Pipeline di ingestione

Il cuore del prodotto. Implementa i cinque stadi della sezione 1 della specifica.

Endpoint:

```
POST /api/recordings           multipart: audio + metadati di cattura
                               → salva audio, crea Procedure in BOZZA_AUDIO,
                                 accoda il job, risponde 202 con l'id
GET  /api/recordings/:id       stato di avanzamento dell'elaborazione
POST /api/recordings/:id/retry riprocessa dalla trascrizione
```

Il job asincrono esegue in ordine: trascrizione → estrazione → validazione → persistenza, aggiornando `CardStatus` a ogni passaggio. Per la coda usa una soluzione semplice (una tabella job con polling va benissimo): non introdurre Redis in questa fase.

Requisiti non negoziabili:

1. **L'audio si salva prima di ogni altra cosa.** Se STT o estrazione falliscono, la scheda resta in `BOZZA_AUDIO` con l'errore registrato e resta riprocessabile. Nessun dato dell'utente va mai perso per un fallimento di rete o di API.
2. La trascrizione grezza si conserva sempre, anche quando l'estrazione riesce.
3. `rawExtraction` contiene l'output integrale dell'LLM, non solo i campi usati.
4. Il prompt di estrazione va preso **alla lettera** dalla sezione 4.2 della specifica, tenuto in un file dedicato e versionato (`prompts/extraction.v1.ts`), con il nome versione salvato in `extractionModel`.
5. La validazione della sezione 5 è codice deterministico, non un secondo giro di LLM. Include la deduplicazione per similarità coseno: se supera 0.85 con una procedura esistente dello stesso utente, **non creare un duplicato** — restituisci un suggerimento di aggiornamento e lascia decidere all'utente.
6. Temperatura bassa sull'estrazione, un solo retry se il JSON non è conforme, poi stato `ESTRAZIONE_FALLITA`.

Scrivi test veri per lo stadio di validazione, usando provider finti: JSON malformato, passi con ordine non contiguo, confidenza bassa, importi negativi, rilevamento duplicato, trascrizione che non è una procedura (`NOTA_SEMPLICE`).

## Fase 3 — API di lettura e ricerca

```
GET    /api/procedures                lista, filtri per scope, status, tag
GET    /api/procedures/:id            scheda completa con relazioni
PATCH  /api/procedures/:id            modifica manuale dei campi
DELETE /api/procedures/:id            soft delete → ARCHIVIATA
POST   /api/procedures/:id/executions registra un'esecuzione (sezione 8)
GET    /api/search?q=                 ricerca ibrida
```

La ricerca implementa la sezione 7: full-text con configurazione italiana **più** ricerca semantica pgvector sull'embedding di `titolo + trigger + tag`, risultati fusi e ordinati per rilevanza, poi freschezza (`ultimaVerifica`), poi `volteEseguita`. Ogni risultato espone un flag di obsolescenza se `ultimaVerifica` è più vecchia di un anno.

Registrare un'esecuzione con esito `CAMBIATA` riporta la scheda in `DA_RIVEDERE`, come da diagramma di stato.

## Fase 4 — PWA

Mobile-first, poche schermate, nessuna libreria di componenti pesante.

- **Registrazione:** un solo grande pulsante. `MediaRecorder`, cattura GPS e timestamp in parallelo all'audio, upload in background con indicatore di stato non bloccante. L'utente deve poter chiudere l'app subito dopo aver premuto stop.
- **Lista:** schede ordinate per ultimo aggiornamento, badge visibile per `DA_RIVEDERE` e per le schede obsolete.
- **Dettaglio:** ordine di lettura obbligato — prerequisiti, poi trappole, poi passi. Le trappole `BLOCCANTE` sono evidenziate. In fondo, sempre accessibile, la trascrizione grezza e il player audio originale.
- **Conferma:** su una scheda aperta, tre pulsanti grandi — ha funzionato / è cambiata / non ha funzionato. Un tocco, niente form.
- **Revisione:** quando l'estrazione ha lasciato `campiIncerti`, mostra le `domandeSuggerite` come suggerimenti opzionali, mai come blocco. La scheda si salva sempre incompleta.

Funzionamento offline: se manca la rete, la registrazione si accoda in IndexedDB e parte da sola al ritorno della connessione.

## Fase 5 — Deploy

**Railway**, tre servizi collegati:

- Postgres con estensione `pgvector` abilitata dalla prima migration
- `apps/api`, avvio con migration Prisma automatiche prima dello start, health check su `/health`
- `apps/worker`, processo separato che condivide la stessa `DATABASE_URL`

**Netlify** ospita solo la build statica di `apps/web`: redirect SPA verso `index.html`, header per il service worker, variabile `VITE_API_URL` che punta al dominio Railway. Nessuna Netlify Function, nessuna logica lato hosting.

Altre cose da chiudere qui: CORS ristretto al dominio Netlify e a nient'altro, storage audio spostato su object storage tramite il `StorageProvider` (il filesystem di Railway è effimero, l'audio locale non sopravvive a un redeploy), tutte le variabili d'ambiente documentate nel README con l'indicazione di dove vanno impostate.

---

## Vincoli trasversali

- **Niente `any`.** TypeScript in strict mode ovunque.
- Validazione degli input con Zod al confine dell'API, sempre.
- Errori strutturati con codice e messaggio, mai stringhe libere lanciate a caso.
- Ogni scrittura passa dal controllo di proprietà: un utente tocca solo le proprie risorse. Anche in fase di sviluppo con un utente finto.
- Le procedure con `scope = CLIENTE` non possono diventare `PUBBLICA`: bloccalo a livello di logica applicativa, non solo nell'interfaccia.
- Commit atomici e con messaggi chiari, uno per unità di lavoro sensata.
- Non aggiungere dipendenze non necessarie. Se ne serve una nuova, dimmi perché prima di installarla.
- **Nessuna logica di prodotto fuori dall'API.** Se ti accorgi di star mettendo una regola di dominio nel frontend, fermati e spostala.
- **`packages/shared` non importa mai API del browser.** Se una funzionalità ne ha bisogno, definisci l'interfaccia in shared e implementala in `apps/web`.
- Prima di introdurre qualcosa di specifico di Railway o Netlify che non sia una variabile d'ambiente, chiedimelo: il vincolo di portabilità vale anche verso l'hosting.

## Come iniziamo

Leggi `wikimylife-schema.md`, poi dimmi in una decina di righe come hai capito il progetto e quali punti della specifica ti sembrano ambigui o rischiosi. **Non scrivere ancora codice.** Partiamo dalla fase 1 solo dopo che ci siamo allineati.
