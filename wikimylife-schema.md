# WikiMyLife — Schema dati e pipeline vocale

Specifica tecnica v0.1. Copre il percorso completo da "premo registra" a "scheda procedura salvata e ricercabile".

---

## 1. La pipeline in cinque stadi

```
[1] CATTURA          audio + metadati di contesto raccolti dal dispositivo
      ↓
[2] TRASCRIZIONE     speech-to-text, output grezzo conservato per sempre
      ↓
[3] ESTRAZIONE       LLM con output strutturato → JSON conforme al contratto
      ↓
[4] VALIDAZIONE      controlli deterministici + marcatura campi incerti
      ↓
[5] PERSISTENZA      scrittura su DB, indicizzazione per la ricerca
```

Principio non negoziabile: **lo stadio [1] non fallisce mai**. L'audio si salva su disco locale prima di qualsiasi chiamata di rete. Se la trascrizione o l'estrazione falliscono, la scheda esiste comunque in stato `BOZZA_AUDIO` e viene riprocessata dopo. L'utente che registra mentre esce da un ufficio non deve mai perdere quello che ha detto perché non c'era campo.

---

## 2. Stadio 1 — Cattura e metadati automatici

Questi metadati non vengono dedotti dall'IA: li raccoglie il dispositivo al momento della registrazione. Sono più affidabili di qualsiasi estrazione e vanno catturati sempre.

| Metadato | Fonte | A cosa serve |
|---|---|---|
| `recordedAt` | orologio device | popola `ultimaVerifica`, ordina la timeline |
| `latitude` / `longitude` | GPS (se autorizzato) | suggerisce il luogo: "Ufficio Postale di via Roma" |
| `placeLabel` | reverse geocoding | riempie il campo luogo senza che l'utente lo dica |
| `durationMs` | recorder | euristica: sotto i 10s probabilmente non è una procedura |
| `deviceLocale` | OS | lingua attesa per lo STT |
| `capturedOffline` | stato rete | segna le schede da riprocessare |

Il GPS è la vincita nascosta di tutto il progetto: risolve il campo più noioso da dettare e permette in futuro di dire "cosa avevo registrato quando ero in Comune".

---

## 3. Stadio 2 — Trascrizione

Requisiti:

- italiano parlato informale, con esitazioni e riprese ("cioè no aspetta, prima devi...")
- punteggiatura automatica, perché il testo grezzo va mostrato all'utente
- niente diarizzazione: c'è un solo parlante
- vocabolario personalizzato / prompt di contesto con termini che lo STT generico sbaglia sistematicamente: SPID, CIE, casellario, marca da bollo, PEC, F24, ASL, staff augmentation, deploy, VPN, ticket

Opzioni realistiche:

| Soluzione | Pro | Contro |
|---|---|---|
| STT on-device (iOS `SFSpeechRecognizer`, Android `SpeechRecognizer`) | gratis, offline, privacy | qualità inferiore su termini tecnici |
| Whisper via API | ottimo su italiano, supporta prompt di vocabolario | costo per minuto, richiede rete |
| Deepgram / AssemblyAI | veloci, streaming | qualità italiana da verificare sul tuo caso |

Strategia consigliata: on-device come fallback immediato per dare feedback istantaneo, API di qualità come passata definitiva quando c'è connessione. Il campo `transcriptSource` traccia quale delle due ha prodotto il testo finale.

**La trascrizione grezza non si cancella mai.** È la fonte di verità quando l'estrazione sbaglia, ed è ciò che permette all'utente di fidarsi.

---

## 4. Stadio 3 — Estrazione strutturata

### 4.1 Contratto di output

L'LLM deve restituire esclusivamente questo JSON. Ogni campo non deducibile dal parlato vale `null` — mai un'invenzione plausibile.

```json
{
  "titolo": "string | null",
  "trigger": "string | null",
  "esito": "string | null",
  "validitaEsito": "string | null",

  "prerequisiti": [
    {
      "descrizione": "string",
      "tipo": "DOCUMENTO | CREDENZIALE | DENARO | TEMPO | PERSONA | STRUMENTO | ALTRO",
      "obbligatorio": true
    }
  ],

  "passi": [
    {
      "ordine": 1,
      "azione": "string",
      "dettaglio": "string | null",
      "durataStimataMin": 0
    }
  ],

  "trappole": [
    {
      "descrizione": "string",
      "gravita": "BLOCCANTE | FASTIDIO | NOTA"
    }
  ],

  "costi": [
    { "descrizione": "string", "importoCent": 0, "valuta": "EUR" }
  ],

  "durataTotaleStimataMin": 0,

  "luogo": {
    "nome": "string | null",
    "dettaglio": "string | null",
    "confermatoDaGps": false
  },

  "riferimenti": [
    { "tipo": "PERSONA | URL | TELEFONO | UFFICIO | SISTEMA", "valore": "string" }
  ],

  "tag": ["string"],
  "ambitoSuggerito": "PERSONALE | LAVORO | CLIENTE",

  "_meta": {
    "confidenzaGlobale": 0.0,
    "campiIncerti": ["costi"],
    "domandeSuggerite": ["Quanto hai pagato in tutto?"],
    "contieneDatiSensibili": false,
    "tipoRilevato": "PROCEDURA | NOTA_SEMPLICE | NON_CLASSIFICABILE"
  }
}
```

Il blocco `_meta` è la parte che rende il sistema onesto. `campiIncerti` alimenta i suggerimenti gentili post-salvataggio, `contieneDatiSensibili` blocca la condivisione pubblica, `tipoRilevato` distingue una vera procedura da un pensiero buttato lì — e una nota semplice va salvata come tale, senza forzarla dentro una struttura che non le appartiene.

### 4.2 Prompt di estrazione

```
Sei un estrattore di procedure. Ricevi la trascrizione di una nota vocale in cui
una persona racconta, subito dopo averla vissuta, come ha portato a termine
qualcosa: una pratica burocratica, un'operazione di lavoro, una riparazione
domestica.

Il tuo compito è convertirla nel JSON del contratto fornito. Non parli con
l'utente, non spieghi, non aggiungi testo prima o dopo il JSON.

REGOLE

1. Non inventare nulla. Se un'informazione non è nel parlato, il campo vale null
   o resta un array vuoto. È molto meglio un campo vuoto che un dettaglio
   verosimile ma falso: l'utente rileggerà questa scheda tra due anni fidandosi.

2. Non arricchire con conoscenza tua. Se la persona dice "sono andato all'ufficio
   postale" non aggiungere orari, requisiti o costi che sai da altre fonti.
   Questa scheda vale proprio perché contiene solo l'esperienza reale.

3. Riordina, non riassumere. Il parlato è disordinato: la persona torna indietro,
   si corregge, aggiunge un pezzo alla fine. Ricostruisci l'ordine cronologico
   reale dei passi. Se si autocorregge ("no scusa, prima la marca da bollo"),
   vince l'ultima versione.

4. Il titolo è verbo all'infinito più oggetto, come lo cercherebbe l'utente tra
   due anni. "Richiedere il casellario giudiziale", non "Ufficio postale" né
   "La mia esperienza al casellario".

5. Il trigger è la situazione che fa nascere il bisogno, non la procedura stessa.
   Se non è esplicito, deducilo solo quando è ovvio, altrimenti null.

6. Le trappole sono la parte di maggior valore. Cerca frasi come "attenzione che",
   "l'errore che ho fatto", "non te lo dicono", "la prossima volta". Marcale
   BLOCCANTE se hanno impedito o rimandato il risultato.

7. Distingui prerequisiti da passi. Il prerequisito è ciò che devi avere PRIMA di
   iniziare; il passo è un'azione da compiere.

8. Importi in centesimi interi: 16 euro → 1600.

9. Metti contieneDatiSensibili a true se compaiono password, codici fiscali,
   numeri di documento, dati di salute, nomi di clienti o dettagli interni di
   un'azienda.

10. Se il testo non descrive una procedura ripetibile, imposta tipoRilevato a
    NOTA_SEMPLICE, compila solo titolo e trigger e lascia il resto vuoto.

11. Mantieni la lingua e le parole dell'utente. Non tradurre e non alzare il
    registro: se dice "sportello", scrivi "sportello", non "front office".

CONTESTO DISPONIBILE
Data e ora della registrazione: {recordedAt}
Luogo rilevato via GPS: {placeLabel}
Ambiti già usati dall'utente: {existingScopes}
Tag già esistenti dell'utente: {existingTags}

Usa i tag esistenti quando calzano, invece di crearne di nuovi quasi identici.
Il luogo GPS va usato solo per riempire luogo.nome se l'utente non lo nomina;
in quel caso metti confermatoDaGps a true.

TRASCRIZIONE
{transcript}
```

Da implementare con structured output / tool use, non con parsing di testo libero. Temperatura bassa (0–0.2): qui non serve creatività.

---

## 5. Stadio 4 — Validazione deterministica

Prima di salvare, controlli in codice — non affidati all'LLM per verificare sé stesso:

- JSON conforme allo schema, altrimenti un solo retry poi stato `ESTRAZIONE_FALLITA`
- `passi[].ordine` contiguo a partire da 1
- importi non negativi, valuta ISO valida
- titolo non vuoto e più corto di 80 caratteri
- se `confidenzaGlobale < 0.5` oppure `passi` è vuoto → stato `DA_RIVEDERE`
- deduplicazione: se esiste già una procedura dello stesso utente con titolo molto simile (similarità coseno sugli embedding > 0.85), proponi **aggiorna quella esistente** invece di crearne una nuova

Quest'ultimo punto conta più di quanto sembri. La seconda volta che rifai una pratica, non vuoi una scheda duplicata: vuoi la stessa scheda aggiornata, con una nuova riga nel registro esecuzioni.

---

## 6. Schema di persistenza (Prisma / PostgreSQL)

```prisma
enum Scope        { PERSONALE LAVORO CLIENTE }
enum Visibility   { PRIVATA CONDIVISA_TEAM PUBBLICA }
enum CardStatus   { BOZZA_AUDIO IN_ELABORAZIONE DA_RIVEDERE COMPLETA ARCHIVIATA }
enum PrereqType   { DOCUMENTO CREDENZIALE DENARO TEMPO PERSONA STRUMENTO ALTRO }
enum Severity     { BLOCCANTE FASTIDIO NOTA }
enum RefType      { PERSONA URL TELEFONO UFFICIO SISTEMA }
enum Outcome      { FUNZIONATO CAMBIATA FALLITA }

model User {
  id          String      @id @default(cuid())
  email       String      @unique
  locale      String      @default("it-IT")
  procedures  Procedure[]
  recordings  Recording[]
  createdAt   DateTime    @default(now())
}

model Recording {
  id              String    @id @default(cuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id])

  audioUrl        String
  durationMs      Int
  recordedAt      DateTime
  capturedOffline Boolean   @default(false)

  latitude        Float?
  longitude       Float?
  placeLabel      String?

  transcript      String?   @db.Text
  transcriptSource String?          // "on-device" | "whisper" | ...
  transcribedAt   DateTime?

  rawExtraction   Json?             // output LLM integrale, per debug e riprocessing
  extractionModel String?
  extractedAt     DateTime?

  procedureId     String?
  procedure       Procedure? @relation(fields: [procedureId], references: [id])

  @@index([userId, recordedAt])
}

model Procedure {
  id            String        @id @default(cuid())
  userId        String
  user          User          @relation(fields: [userId], references: [id])

  titolo        String
  trigger       String?
  esito         String?
  validitaEsito String?                       // "6 mesi", "fino a fine anno"

  durataStimataMin Int?
  costoTotaleCent  Int?                       // denormalizzato per la lista

  luogoNome       String?
  luogoDettaglio  String?
  latitude        Float?
  longitude       Float?

  scope         Scope         @default(PERSONALE)
  clientLabel   String?                       // valorizzato solo se scope = CLIENTE
  visibility    Visibility    @default(PRIVATA)
  status        CardStatus    @default(BOZZA_AUDIO)

  ultimaVerifica DateTime?                    // quando ha funzionato l'ultima volta
  volteEseguita  Int          @default(1)
  contieneDatiSensibili Boolean @default(false)

  forkedFromId  String?                       // copia personale di una scheda pubblica
  forkedFrom    Procedure?    @relation("Fork", fields: [forkedFromId], references: [id])
  forks         Procedure[]   @relation("Fork")

  embedding     Unsupported("vector(1536)")?  // pgvector, su titolo + trigger

  steps         Step[]
  prereqs       Prerequisite[]
  pitfalls      Pitfall[]
  costs         Cost[]
  refs          Reference[]
  attachments   Attachment[]
  executions    Execution[]
  recordings    Recording[]
  tags          TagOnProcedure[]

  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt

  @@index([userId, status])
  @@index([userId, updatedAt])
}

model Step {
  id           String    @id @default(cuid())
  procedureId  String
  procedure    Procedure @relation(fields: [procedureId], references: [id], onDelete: Cascade)
  ordine       Int
  azione       String
  dettaglio    String?
  durataStimataMin Int?
  @@unique([procedureId, ordine])
}

model Prerequisite {
  id           String     @id @default(cuid())
  procedureId  String
  procedure    Procedure  @relation(fields: [procedureId], references: [id], onDelete: Cascade)
  descrizione  String
  tipo         PrereqType @default(ALTRO)
  obbligatorio Boolean    @default(true)
}

model Pitfall {
  id           String    @id @default(cuid())
  procedureId  String
  procedure    Procedure @relation(fields: [procedureId], references: [id], onDelete: Cascade)
  descrizione  String
  gravita      Severity  @default(NOTA)
}

model Cost {
  id           String    @id @default(cuid())
  procedureId  String
  procedure    Procedure @relation(fields: [procedureId], references: [id], onDelete: Cascade)
  descrizione  String
  importoCent  Int
  valuta       String    @default("EUR")
}

model Reference {
  id           String    @id @default(cuid())
  procedureId  String
  procedure    Procedure @relation(fields: [procedureId], references: [id], onDelete: Cascade)
  tipo         RefType
  valore       String
}

model Attachment {
  id           String    @id @default(cuid())
  procedureId  String
  procedure    Procedure @relation(fields: [procedureId], references: [id], onDelete: Cascade)
  url          String
  mimeType     String
  didascalia   String?
}

model Execution {
  id           String    @id @default(cuid())
  procedureId  String
  procedure    Procedure @relation(fields: [procedureId], references: [id], onDelete: Cascade)
  eseguitaIl   DateTime  @default(now())
  esito        Outcome
  nota         String?                       // "adesso il pagamento è solo su pagoPA"
}

model Tag {
  id           String            @id @default(cuid())
  userId       String
  nome         String
  procedures   TagOnProcedure[]
  @@unique([userId, nome])
}

model TagOnProcedure {
  procedureId  String
  tagId        String
  procedure    Procedure @relation(fields: [procedureId], references: [id], onDelete: Cascade)
  tag          Tag       @relation(fields: [tagId], references: [id], onDelete: Cascade)
  @@id([procedureId, tagId])
}
```

### Note sulle scelte

**`Execution` è una tabella a sé, non un campo.** Ogni volta che l'utente riapre una scheda e conferma "ha funzionato ancora", nasce una riga. Da qui derivi la freschezza della procedura, la frequenza reale d'uso e — quando arriverà la community — la credibilità di una scheda condivisa. È anche il tuo dato di prodotto più prezioso per capire se l'app serve davvero.

**`rawExtraction` conserva l'output integrale dell'LLM.** Quando cambierai modello o prompt potrai riprocessare tutto lo storico dalle trascrizioni senza chiedere niente agli utenti.

**`scope` è separato da `visibility`.** Il primo dice a quale sfera della vita appartiene la scheda, il secondo chi può vederla. Tenerli distinti evita l'errore classico di rendere pubblico per sbaglio un runbook di un cliente.

**`forkedFromId`** prepara il modello community giusto: prendi la procedura pubblica, la copi nel tuo spazio e ci aggiungi le tue eccezioni locali. La copia è tua e non cambia più sotto i piedi.

---

## 7. Ricerca

Due indici che lavorano insieme, perché le due domande sono diverse:

- **Full-text** (`tsvector` italiano) su titolo, trigger, passi, trappole — per quando ricordi una parola precisa
- **Semantico** (pgvector, embedding su `titolo + trigger + tag`) — per quando ricordi solo la situazione: "come si faceva quella cosa del certificato per il cliente"

Il campo `trigger` è la chiave di volta della ricerca semantica: la gente non cerca il nome della procedura, cerca il momento in cui si è ritrovata. Vale la pena includerlo nell'embedding con peso pieno.

Ordinamento dei risultati: rilevanza, poi freschezza (`ultimaVerifica`), poi frequenza (`volteEseguita`). Una scheda non verificata da tre anni va mostrata con un avviso visibile, non nascosta.

---

## 8. Stati e riprocessing

```
BOZZA_AUDIO ──► IN_ELABORAZIONE ──► DA_RIVEDERE ──► COMPLETA ──► ARCHIVIATA
      ▲                 │                                  │
      └── retry ────────┘                                  └──► DA_RIVEDERE
                                                  (dopo Execution con esito CAMBIATA)
```

Una scheda torna in revisione da sola quando l'utente registra un'esecuzione con esito `CAMBIATA`. È il meccanismo che tiene viva la wiki senza chiedere manutenzione volontaria a nessuno.

---

## 9. Prima di condividere: redazione

Nessuna scheda con `contieneDatiSensibili = true` può passare a `PUBBLICA` senza una revisione esplicita. Prima della pubblicazione serve una passata di redazione — deterministica dove possibile (regex per codici fiscali, IBAN, email, telefoni), assistita dall'LLM per il resto — che proponga le sostituzioni e le faccia confermare una per una all'utente.

Per l'ambito `CLIENTE` la scelta più sicura è disabilitare del tutto la condivisione pubblica a livello di codice, non solo di interfaccia.
