import {
  ApiError,
  AUTH_STORAGE_KEYS,
  CardStatus,
  ErrorCode,
  Outcome,
  RecordingStatus,
  createApiClient,
  type ApiClient,
} from "@wikimylife/shared";
import { buildExtractionContract, createInMemorySecureStorage } from "@wikimylife/shared/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeExtractionProvider } from "../../apps/api/src/providers/fake/index.js";
import { disconnectTestPrisma, resetDatabase } from "./helpers/db.js";
import { startTestServer, type TestServer } from "./helpers/server.js";

/**
 * Il ponte: l'`ApiClient` vero contro il server HTTP vero.
 *
 * ## Il buco che questo file chiude
 *
 * Fino a qui le due meta' dell'applicazione non si toccavano. I test di
 * `tests/web` premono i pulsanti davanti a un `ApiClient` finto; gli altri file
 * di questa cartella parlano HTTP vero con un `fetch` scritto a mano in
 * `helpers/server.ts`. Fra le due c'e' soltanto un tipo TypeScript, e un tipo
 * non attraversa la rete: un percorso sbagliato, un'intestazione dimenticata,
 * uno schema Zod che rifiuta cio' che il server manda davvero lasciano verdi
 * entrambe le suite.
 *
 * Il pezzo che nessuno eseguiva e' `packages/shared/src/api/client.ts` —
 * ottocento righe che compongono intestazioni, ruotano i token su 401, validano
 * le risposte e scrivono nel deposito sicuro. I suoi test unitari lo provano
 * davanti a un `fetchImpl` finto: provano la logica, non il contratto.
 *
 * ## Quello che ancora non si prova, e perche'
 *
 * Non c'e' nessuna schermata sopra: il ponte comincia dal client e finisce al
 * server, e sopra il client restano React e il browser. Chiuderlo del tutto
 * vorrebbe dire un browser pilotato, cioe' una terza infrastruttura di test; qui
 * la scelta e' stata di prendere la meta' che costa un file invece della meta'
 * che costa una dipendenza.
 *
 * E l'applicazione della CORS non e' provabile da qui: Node non manda `Origin`,
 * quindi il middleware non scatta mai. Cio' che si prova e' la compatibilita' —
 * che ogni intestazione che il client mette davvero sul filo sia fra quelle che
 * il server dichiara di consentire. Il blocco delle intestazioni spiega la
 * differenza.
 */

const PASSWORD = "password-di-prova-lunga";
const PASSWORD_NUOVA = "un-altra-password-lunghissima";
const ORIGINE = "http://localhost:5173";

let server: TestServer;
let llm: FakeExtractionProvider;

/**
 * I nomi dei metodi che almeno un caso di questo file ha attraversato.
 *
 * Vive a livello di modulo e nessuno lo svuota: l'ultimo blocco lo legge dopo
 * che tutti gli altri hanno finito, ed e' cio' su cui si regge la guardia. Lo
 * riempie la fabbrica del client e non i casi, perche' popolarlo a mano sarebbe
 * esattamente lo sbaglio che la guardia esiste per intercettare — chi aggiunge
 * un metodo e dimentica di provarlo dimenticherebbe anche di elencarlo qui.
 */
const attraversati = new Set<string>();

beforeAll(async () => {
  // `corsOrigins` e' l'unica opzione che si sposta dal default, e serve al solo
  // blocco delle intestazioni: senza un'origine ammessa il preflight
  // risponderebbe 403 e non direbbe niente su cosa il server consente.
  //
  // `redactionProvider` resta `nessuno` e `storage` resta `fake` di proposito:
  // la meta' deterministica della §9 gira comunque — le email le trova una
  // regex — e l'audio finto restituisce gli stessi byte che ha ricevuto. Un
  // provider acceso qui avrebbe messo di mezzo un finto in piu' fra il client e
  // il server, cioe' proprio la cosa che questo file esiste per togliere.
  server = await startTestServer({ corsOrigins: ORIGINE });

  const { extraction } = server.composition.providers;
  if (!(extraction instanceof FakeExtractionProvider)) {
    throw new Error("Il ponte richiede il provider di estrazione finto.");
  }
  llm = extraction;
});

afterAll(async () => {
  await server.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase();
  llm.reset();
});

// ---------------------------------------------------------------------------
// La fabbrica del client
// ---------------------------------------------------------------------------

interface RichiestaVista {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

interface ClienteVero {
  readonly client: ApiClient;
  readonly storage: ReturnType<typeof createInMemorySecureStorage>;
  /** Cio' che e' passato sul filo, nell'ordine in cui e' partito. */
  readonly richieste: RichiestaVista[];
  /** Quante volte il client ha detto «la sessione e' morta». */
  readonly scaduta: number;
}

/**
 * Un client vero, con un registratore sempre acceso in mezzo.
 *
 * Il `fetchImpl` non sostituisce niente: chiama `fetch` e basta. Serve a
 * guardare, e a guardare **sempre** — raccogliere le intestazioni solo nel
 * blocco che le verifica vorrebbe dire provarle su una richiesta sola invece che
 * su tutte quelle che il file fa partire.
 *
 * `iniziale` precarica il deposito: e' cosi' che si costruisce «un secondo
 * dispositivo», cioe' un client che ha il refresh token di qualcun altro e non
 * ha nessun access token in memoria.
 */
function creaCliente(iniziale?: Readonly<Record<string, string>>): ClienteVero {
  const storage = createInMemorySecureStorage(iniziale);
  const richieste: RichiestaVista[] = [];
  const conteggio = { scaduta: 0 };

  const nudo = createApiClient({
    baseUrl: server.url,
    storage,
    onSessionExpired: () => {
      conteggio.scaduta += 1;
    },
    fetchImpl: (input, init) => {
      richieste.push({
        url: input,
        method: init?.method ?? "GET",
        // Una copia: `init.headers` e' l'oggetto che il client ha costruito, e
        // conservarlo per riferimento significherebbe leggere piu' tardi cio'
        // che nel frattempo potrebbe essere stato cambiato.
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      });
      return fetch(input, init);
    },
  });

  return {
    client: traccia(nudo),
    storage,
    richieste,
    get scaduta(): number {
      return conteggio.scaduta;
    },
  };
}

/** Avvolge ogni metodo per segnarne il nome. Vedi `attraversati`. */
function traccia(client: ApiClient): ApiClient {
  const avvolto: Record<string, unknown> = {};
  for (const [nome, valore] of Object.entries(client)) {
    const metodo = valore as (...args: readonly unknown[]) => unknown;
    avvolto[nome] = (...args: readonly unknown[]): unknown => {
      attraversati.add(nome);
      return metodo(...args);
    };
  }
  return avvolto as unknown as ApiClient;
}

let contatore = 0;

function emailNuova(): string {
  contatore += 1;
  return `ponte-${String(contatore)}@wikimylife.test`;
}

/** Un client gia' iscritto, che e' il punto di partenza di quasi ogni caso. */
async function iscritto(): Promise<ClienteVero> {
  const cliente = creaCliente();
  await cliente.client.signup({ email: emailNuova(), password: PASSWORD });
  return cliente;
}

/** Il codice di un `ApiError`, con un messaggio utile se non lo e'. */
function codiceDi(errore: unknown): string {
  if (!(errore instanceof ApiError)) {
    throw new Error(`Atteso un ApiError, ottenuto ${String(errore)}`);
  }
  return errore.code;
}

/**
 * Il codice con cui una chiamata ha rifiutato — e un fallimento se non rifiuta.
 *
 * Scritto a mano invece di `rejects.toSatisfy(...)` perche' un predicato dentro
 * una matcher, quando fallisce, dice soltanto che ha restituito falso: non dice
 * quale codice e' arrivato al posto di quello atteso, che e' l'unica cosa che
 * serve sapere. Cosi' il confronto e' un `toBe` fra due stringhe, e il
 * messaggio le stampa entrambe.
 *
 * Il `throw` finale conta quanto il resto: una chiamata che riesce dove il caso
 * si aspettava un rifiuto e' esattamente il difetto che si sta cercando, e
 * senza quella riga passerebbe inosservata.
 */
async function codiceDelRifiuto(promessa: Promise<unknown>): Promise<string> {
  try {
    await promessa;
  } catch (errore) {
    return codiceDi(errore);
  }
  throw new Error("La chiamata doveva fallire, e invece e' riuscita.");
}

/** Quante richieste sono partite verso un percorso. */
function quante(cliente: ClienteVero, percorso: string): number {
  return cliente.richieste.filter((r) => r.url.includes(percorso)).length;
}

/** L'audio finto: byte estremi compresi, per accorgersi di chi li fa passare per testo. */
const BYTE_AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff, 0x7f, 0x80]);

function audioFinto(): Blob {
  return new Blob([BYTE_AUDIO], { type: "audio/webm" });
}

const METADATI = {
  recordedAt: "2026-03-01T09:30:00.000Z",
  durationMs: 42_000,
  mimeType: "audio/webm",
  capturedOffline: false,
  deviceLocale: "it-IT",
};

// ---------------------------------------------------------------------------
// 1. La sessione
// ---------------------------------------------------------------------------

describe("il ponte: la sessione", () => {
  it("l'iscrizione mette il refresh token nel deposito e l'access token in memoria", async () => {
    const cliente = creaCliente();
    const email = emailNuova();

    const sessione = await cliente.client.signup({ email, password: PASSWORD });

    expect(sessione.user.email).toBe(email);
    // I due token stanno in due posti diversi apposta: quello lungo dove
    // sopravvive alla chiusura dell'app, quello corto dove non sopravvive. Se il
    // client scrivesse anche l'access token nel deposito, un telefono rubato
    // porterebbe con se' anche la chiave breve.
    expect(cliente.storage.snapshot()).toEqual({
      [AUTH_STORAGE_KEYS.refreshToken]: sessione.tokens.refreshToken,
    });
    expect(cliente.client.getAccessToken()).toBe(sessione.tokens.accessToken);
  });

  it("le credenziali giuste aprono una sessione anche da un client che non si e' mai iscritto", async () => {
    const primo = creaCliente();
    const email = emailNuova();
    await primo.client.signup({ email, password: PASSWORD });

    const secondo = creaCliente();
    const sessione = await secondo.client.login({ email, password: PASSWORD });

    expect(sessione.user.email).toBe(email);
    expect(secondo.client.getAccessToken()).not.toBeNull();
  });

  it("un deposito precaricato ritrova l'utente senza passare dalla password", async () => {
    const primo = await iscritto();
    const refreshToken = primo.storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken];
    expect(refreshToken).toBeDefined();

    // E' il giro che fa l'applicazione a ogni apertura: il refresh token c'e',
    // l'access token no, e da quel solo token si deve tornare a essere qualcuno.
    const secondo = creaCliente({ [AUTH_STORAGE_KEYS.refreshToken]: refreshToken ?? "" });
    const utente = await secondo.client.restoreSession();

    expect(utente).not.toBeNull();
    expect(utente?.id).toBe((await primo.client.me()).id);
    expect(secondo.client.getAccessToken()).not.toBeNull();
  });

  it("un deposito vuoto non produce nessuna sessione, e non chiede niente al server", async () => {
    const cliente = creaCliente();

    expect(await cliente.client.restoreSession()).toBeNull();
    // Il caso opposto di quello sopra, e la seconda asserzione conta quanto la
    // prima: un client che chiedesse comunque si prenderebbe un 401 a ogni
    // apertura dell'app da parte di chi non ha mai fatto login.
    expect(cliente.richieste).toHaveLength(0);
  });

  it("l'uscita svuota il deposito e la memoria, e non solo la memoria", async () => {
    const cliente = await iscritto();

    await cliente.client.logout();

    // `logout()` inghiotte gli errori del server e svuota comunque: che non
    // abbia lanciato non dimostra niente. Cio' che si guarda e' che il deposito
    // sia vuoto — un refresh token rimasto li' e' una sessione che la prossima
    // apertura dell'app ripescherebbe senza che nessuno l'abbia chiesto.
    expect(cliente.storage.snapshot()).toEqual({});
    expect(cliente.client.getAccessToken()).toBeNull();
  });

  it("dopo l'uscita il refresh token non vale piu' nemmeno per chi se lo era copiato", async () => {
    const cliente = await iscritto();
    const refreshToken = cliente.storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken];

    await cliente.client.logout();

    const ladro = creaCliente({ [AUTH_STORAGE_KEYS.refreshToken]: refreshToken ?? "" });
    expect(await ladro.client.restoreSession()).toBeNull();
  });

  it("lo stato di salute si legge senza nessuna sessione", async () => {
    const cliente = creaCliente();

    const salute = await cliente.client.health();

    expect(salute.status).toBe("ok");
    // L'unica rotta del client che non manda `Authorization` neanche avendolo.
    expect(cliente.richieste[0]?.headers["Authorization"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. La rotazione a 401
// ---------------------------------------------------------------------------

describe("il ponte: la rotazione dopo un 401", () => {
  it("una richiesta senza access token ruota, ritenta e riesce", async () => {
    const primo = await iscritto();
    const refreshToken = primo.storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken];

    // Il 401 non si aspetta: il minimo di `ACCESS_TOKEN_TTL_MIN` e' un minuto, e
    // un test che dorme un minuto e' un test che qualcuno toglie. Si provoca,
    // costruendo lo stato esatto in cui l'app si trova dopo un riavvio del
    // browser — refresh token nel deposito, memoria vuota — e chiamando una
    // rotta autenticata senza passare da `restoreSession`.
    const secondo = creaCliente({ [AUTH_STORAGE_KEYS.refreshToken]: refreshToken ?? "" });
    const utente = await secondo.client.me();

    expect(utente.id).toBeDefined();
    // Tre richieste e non una: il `me` che si prende il 401, la rotazione, il
    // `me` ripetuto. Senza il ritenta ci sarebbe un errore al posto dell'utente.
    expect(quante(secondo, "/api/auth/me")).toBe(2);
    expect(quante(secondo, "/api/auth/refresh")).toBe(1);
    // E il token nel deposito e' cambiato: la rotazione e' una sostituzione, non
    // un rinnovo. Un refresh token riusato e' il segnale di furto su cui si
    // regge la reuse detection, quindi lasciare quello vecchio la spegnerebbe.
    expect(secondo.storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken]).not.toBe(refreshToken);
    expect(secondo.scaduta).toBe(0);
  });

  it("la rotazione si puo' anche chiedere, e allora il token vecchio diventa un furto", async () => {
    const cliente = await iscritto();
    const vecchio = cliente.storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken];

    // `refresh()` e' l'unico metodo pubblico che il giro automatico non
    // attraversa: il 401 fa girare la stessa funzione interna, ma passando da
    // un'altra porta. Chiamarlo a mano e' cio' che fa l'app quando vuole
    // rinnovare prima della scadenza invece di aspettare il rifiuto.
    const sessione = await cliente.client.refresh();

    expect(sessione.tokens.refreshToken).not.toBe(vecchio);
    expect(cliente.storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken]).toBe(
      sessione.tokens.refreshToken,
    );

    // E il vecchio non e' scaduto: e' bruciato. Un secondo client che provasse a
    // usarlo non e' un ritardatario, e' qualcuno che ha una copia — la reuse
    // detection e' tutta qui, e senza questa meta' «ruota» vorrebbe dire solo
    // «ne aggiunge un altro».
    const copia = creaCliente({ [AUTH_STORAGE_KEYS.refreshToken]: vecchio ?? "" });
    expect(await codiceDelRifiuto(copia.client.refresh())).toBe(ErrorCode.TOKEN_REUSED);
  });

  it("una password sbagliata al login e' un 401 che non fa ruotare niente", async () => {
    const email = emailNuova();
    const primo = creaCliente();
    await primo.client.signup({ email, password: PASSWORD });

    const secondo = creaCliente();
    await expect(secondo.client.login({ email, password: "non-e-questa-la-password" })).rejects.toThrow(
      ApiError,
    );

    // E' il ramo opposto, quello che si dimentica: non tutti i 401 parlano della
    // sessione. Qui il 401 parla del corpo, e una rotazione sarebbe una
    // richiesta in piu' fatta con un deposito che e' vuoto per definizione.
    expect(quante(secondo, "/api/auth/refresh")).toBe(0);
    expect(secondo.scaduta).toBe(0);
  });

  it("una password attuale sbagliata non butta fuori da una sessione viva", async () => {
    const cliente = await iscritto();

    expect(
      await codiceDelRifiuto(
        cliente.client.changePassword({
          currentPassword: "questa-non-e-quella-attuale",
          newPassword: PASSWORD_NUOVA,
        }),
      ),
    ).toBe(ErrorCode.INVALID_CREDENTIALS);

    // Il caso pericoloso di tutto il blocco. `/api/auth/password` e' una rotta
    // autenticata che accetta a sua volta una password: il suo 401 significa
    // «hai digitato male», e il token con cui e' partita la richiesta e' vivo.
    // Trattarlo come gli altri 401 farebbe ruotare per niente e poi, al secondo
    // rifiuto identico, svuoterebbe la sessione — cioe' butterebbe fuori
    // dall'account proprio chi stava cercando di proteggerlo.
    expect(quante(cliente, "/api/auth/refresh")).toBe(0);
    expect(cliente.scaduta).toBe(0);
    expect(cliente.client.getAccessToken()).not.toBeNull();
    await expect(cliente.client.me()).resolves.toBeDefined();
  });

  it("la password si cambia davvero, e il client resta dentro con i token nuovi", async () => {
    const email = emailNuova();
    const cliente = creaCliente();
    await cliente.client.signup({ email, password: PASSWORD });
    const vecchio = cliente.storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken];

    const sessione = await cliente.client.changePassword({
      currentPassword: PASSWORD,
      newPassword: PASSWORD_NUOVA,
    });

    // Il cambio password revoca tutte le famiglie e ne apre una nuova: se il
    // client non conservasse i token che la risposta gli da', chi ha appena
    // cambiato password si troverebbe scollegato dal proprio gesto.
    expect(cliente.storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken]).toBe(
      sessione.tokens.refreshToken,
    );
    expect(cliente.storage.snapshot()[AUTH_STORAGE_KEYS.refreshToken]).not.toBe(vecchio);
    await expect(cliente.client.me()).resolves.toBeDefined();
  });

  it("quando anche la rotazione fallisce, la sessione muore una volta sola", async () => {
    const cliente = creaCliente({ [AUTH_STORAGE_KEYS.refreshToken]: "questo-token-non-esiste" });

    await expect(cliente.client.listProcedures()).rejects.toThrow(ApiError);

    // Uno e non due. Il client passa da due punti in cui potrebbe dichiarare la
    // sessione morta — il fallimento della rotazione e il 401 non recuperabile —
    // e chiamarli entrambi manderebbe l'app due volte sulla schermata di
    // ingresso, che e' il modo in cui un redirect diventa un ciclo.
    expect(cliente.scaduta).toBe(1);
    expect(cliente.storage.snapshot()).toEqual({});
    expect(cliente.client.getAccessToken()).toBeNull();
  });

  it("scollegare gli altri dispositivi uccide la famiglia dell'altro e non la propria", async () => {
    const email = emailNuova();
    const primo = creaCliente();
    await primo.client.signup({ email, password: PASSWORD });

    const secondo = creaCliente();
    await secondo.client.login({ email, password: PASSWORD });

    const elenco = await secondo.client.listSessions();
    expect(elenco.sessions).toHaveLength(2);
    expect(elenco.sessions.filter((s) => s.current)).toHaveLength(1);

    const esito = await secondo.client.revokeOtherSessions({ currentPassword: PASSWORD });

    expect(esito.revoked).toBe(1);
    // Chi ha chiesto resta dentro — e' il senso del gesto — e chi e' stato
    // scollegato trova un 401 che nemmeno la rotazione salva, perche' anche il
    // suo refresh token e' morto insieme alla famiglia.
    await expect(secondo.client.me()).resolves.toBeDefined();
    await expect(primo.client.me()).rejects.toThrow(ApiError);
    expect(primo.scaduta).toBe(1);
    expect((await secondo.client.listSessions()).sessions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Il giro completo di una scheda
// ---------------------------------------------------------------------------

describe("il ponte: dalla voce alla scheda e ritorno", () => {
  /**
   * Un caso solo, lungo, e non dodici corti.
   *
   * Ogni passo dipende dallo stato che il precedente ha lasciato sul server:
   * `retry` vuole una registrazione ancora in `BOZZA_AUDIO`, l'audio si scarica
   * finche' i byte sono nel bucket, l'esecuzione si registra finche' la scheda
   * non e' archiviata, la redazione si applica finche' nessuno ha toccato il
   * testo. Spezzarlo vorrebbe dire ricostruire quello stato con chiamate
   * diverse da quelle che si stanno provando — cioe' provare il ponte
   * costruendo il ponte con qualcos'altro.
   *
   * L'ordine non e' una preferenza: ogni riga della sequenza ha un vincolo, e i
   * commenti dicono quale.
   */
  it("attraversa tutte le rotte della scheda nell'unico ordine che il server accetta", async () => {
    llm.enqueue(
      buildExtractionContract({
        titolo: "Rinnovare il passaporto elettronico",
        trigger: "Il passaporto scade fra due mesi e devo viaggiare",
        esito: "Passaporto ritirato in questura, conferma a sportello.passaporti@example.com",
      }),
    );

    const cliente = await iscritto();
    const { client } = cliente;

    // Un `Blob` vero dentro una `FormData` vera: e' il solo punto dell'app in
    // cui il client non manda JSON, e il solo in cui il `Content-Type` non lo
    // scrive lui.
    const caricata = await client.createRecording({
      audio: audioFinto(),
      metadata: METADATI,
      filename: "voce.webm",
    });
    expect(caricata.status).toBe(RecordingStatus.BOZZA_AUDIO);
    expect(caricata.sizeBytes).toBe(BYTE_AUDIO.byteLength);

    // `retry` mentre e' ancora in `BOZZA_AUDIO`: su una `ESTRATTO` il server
    // risponde 404, perche' rimetterla in coda creerebbe una seconda scheda
    // identica. Dopo l'ingestione questa riga sarebbe stata irraggiungibile.
    const riprovata = await client.retryRecording(caricata.id);
    expect(riprovata.status).toBe(RecordingStatus.BOZZA_AUDIO);
    expect(riprovata.retryCount).toBe(1);

    const sospese = await client.listPendingRecordings();
    expect(sospese.items.map((r) => r.id)).toEqual([caricata.id]);

    const riletta = await client.getRecording(caricata.id);
    expect(riletta.id).toBe(caricata.id);
    expect(riletta.procedureId).toBeNull();

    // I byte, e prima della cancellazione definitiva: quella svuota il bucket.
    // E' anche l'unica risposta non-JSON di tutto il client, quindi l'unica che
    // passa dal ramo che non chiama `response.json()`.
    const audio = await client.getRecordingAudio(caricata.id);
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(BYTE_AUDIO);

    // L'ingestione in-process, sulle stesse istanze che servono le richieste
    // HTTP: e' il modo in cui gli altri file di questa cartella evitano di
    // avviare il worker e aspettare un giro di polling.
    const esito = await server.composition.ingestionService.processNext();
    expect(esito?.kind).toBe("ESTRATTO");

    const elenco = await client.listProcedures();
    expect(elenco.total).toBe(1);
    const idScheda = elenco.items[0]?.id ?? "";
    expect(idScheda).not.toBe("");

    const scheda = await client.getProcedure(idScheda);
    expect(scheda.titolo).toBe("Rinnovare il passaporto elettronico");
    expect(scheda.steps).toHaveLength(2);

    const aggiornata = await client.updateProcedure(idScheda, { status: CardStatus.COMPLETA });
    expect(aggiornata.status).toBe(CardStatus.COMPLETA);

    // Prima di archiviare: su una `ARCHIVIATA` questa chiamata e' un 409, e ha
    // ragione — una procedura nel cestino non la sta eseguendo nessuno.
    const eseguita = await client.recordExecution(idScheda, {
      esito: Outcome.FUNZIONATO,
      nota: "Fatto allo sportello, quarantacinque minuti",
    });
    // Due e non uno: una scheda nasce con `volteEseguita @default(1)`, perche'
    // la §6 conta come prima esecuzione il fatto stesso di averla raccontata —
    // nessuno detta una procedura che non ha mai fatto. Questa e' la seconda.
    expect(eseguita.volteEseguita).toBe(2);

    // Una parola del titolo, che e' certa di stare in `searchText`: il canale
    // semantico qui tace, perche' il provider finto produce vettori quasi
    // ortogonali, quindi a rispondere e' il full-text italiano.
    const trovate = await client.search({ q: "passaporto" });
    expect(trovate.items.map((h) => h.id)).toContain(idScheda);

    const proposte = await client.proposeRedaction(idScheda);
    // `NON_CONFIGURATA` e non `ESEGUITA`: il provider assistito e' spento, e il
    // caso lo asserisce invece di accenderlo. La meta' che non ha bisogno di
    // nessuno — la regex delle email — deve funzionare comunque.
    expect(proposte.assistenza).toBe("NON_CONFIGURATA");
    const email = proposte.proposte.find((p) => p.kind === "EMAIL");
    expect(email).toBeDefined();
    expect(email?.campo).toBe("esito");
    expect(email?.valore).toBe("sportello.passaporti@example.com");

    // Nessuna `updateProcedure` fra la proposta e l'applicazione: gli id sono
    // derivati dagli offset nel testo, e un testo cambiato nel frattempo li
    // renderebbe irreperibili — che e' un 409, ed e' la garanzia della §9.
    const redatta = await client.applyRedaction(idScheda, [email?.id ?? ""]);
    expect(redatta.esito).toBe("Passaporto ritirato in questura, conferma a [email]");

    const archiviata = await client.archiveProcedure(idScheda);
    expect(archiviata.status).toBe(CardStatus.ARCHIVIATA);

    // Solo su una `ARCHIVIATA`: e' l'unica difesa che il server ha contro una
    // cancellazione definitiva partita per sbaglio.
    await client.deleteProcedureForever(idScheda);
    expect(await codiceDelRifiuto(client.getProcedure(idScheda))).toBe(ErrorCode.NOT_FOUND);

    // E per finire, che il giro sia stato fatto davvero da questo client e non
    // da qualcosa che gli somigliava: ogni richiesta e' passata di qui.
    expect(cliente.richieste.length).toBeGreaterThan(15);
    expect(cliente.scaduta).toBe(0);
  });

  it("registrare un'esecuzione su una scheda archiviata e' un 409, e non un silenzio", async () => {
    llm.enqueue(buildExtractionContract({ titolo: "Disdire l'abbonamento della palestra" }));
    const { client } = await iscritto();

    await client.createRecording({ audio: audioFinto(), metadata: METADATI });
    const esito = await server.composition.ingestionService.processNext();
    const idScheda = esito?.kind === "ESTRATTO" ? esito.procedureId : "";
    await client.archiveProcedure(idScheda);

    // Il caso opposto del passo 8 del giro sopra. Senza, «prima di archiviare»
    // resterebbe un commento invece di un vincolo, e riordinare la sequenza
    // sembrerebbe innocuo.
    expect(
      await codiceDelRifiuto(
        client.recordExecution(idScheda, { esito: Outcome.FUNZIONATO, nota: null }),
      ),
    ).toBe(ErrorCode.CONFLICT);
  });

  it("rimettere in coda una registrazione gia' diventata scheda e' un 404", async () => {
    llm.enqueue(buildExtractionContract({ titolo: "Attivare lo SPID al comune" }));
    const { client } = await iscritto();

    const caricata = await client.createRecording({ audio: audioFinto(), metadata: METADATI });
    await server.composition.ingestionService.processNext();

    // L'altro vincolo d'ordine del giro lungo, provato dal verso in cui fa male:
    // se questa rispondesse 200, ogni `retry` premuto due volte produrrebbe una
    // scheda in piu'.
    expect(await codiceDelRifiuto(client.retryRecording(caricata.id))).toBe(ErrorCode.NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// 4. Il cestino e le registrazioni
// ---------------------------------------------------------------------------

describe("il ponte: le risposte senza corpo e il cestino", () => {
  it("cancellare una registrazione e' un 204 che il client non prova a leggere come JSON", async () => {
    const { client } = await iscritto();
    const caricata = await client.createRecording({ audio: audioFinto(), metadata: METADATI });

    // `deleteRecording` non passa da `send()`: un 204 non ha corpo, e
    // `response.json()` su una risposta vuota lancia. Quel ramo del client
    // esiste per questo e fino a qui non lo eseguiva nessuno contro un server
    // vero — davanti a un finto il corpo vuoto lo decide il test.
    await expect(client.deleteRecording(caricata.id)).resolves.toBeUndefined();

    expect((await client.listPendingRecordings()).items).toHaveLength(0);
    expect(await codiceDelRifiuto(client.getRecording(caricata.id))).toBe(ErrorCode.NOT_FOUND);
  });

  it("cancellare la voce e anche la scheda archivia la scheda, e cancellarla da sola no", async () => {
    llm.enqueue(buildExtractionContract({ titolo: "Prenotare la visita dal medico di base" }));
    const { client } = await iscritto();

    const caricata = await client.createRecording({ audio: audioFinto(), metadata: METADATI });
    const esito = await server.composition.ingestionService.processNext();
    const idScheda = esito?.kind === "ESTRATTO" ? esito.procedureId : "";

    // Le due chiamate sono quasi identiche e fanno due cose molto diverse, e la
    // differenza e' un parametro di query che nel finto non si vede: il finto
    // riceve un booleano, il server riceve `?ancheLaScheda=1`. Qui si guarda
    // l'effetto, che e' l'unica cosa che dimostri che il parametro e' arrivato.
    await client.deleteRecording(caricata.id, { ancheLaScheda: true });

    expect((await client.getProcedure(idScheda)).status).toBe(CardStatus.ARCHIVIATA);
  });

  it("una scheda si ripesca dal cestino e torna a essere da rivedere", async () => {
    llm.enqueue(buildExtractionContract({ titolo: "Cambiare il medico di famiglia" }));
    const { client } = await iscritto();

    await client.createRecording({ audio: audioFinto(), metadata: METADATI });
    const esito = await server.composition.ingestionService.processNext();
    const idScheda = esito?.kind === "ESTRATTO" ? esito.procedureId : "";
    await client.archiveProcedure(idScheda);

    const ripescata = await client.updateProcedure(idScheda, { status: CardStatus.DA_RIVEDERE });

    // `DA_RIVEDERE` e non `COMPLETA`: lo stato che la scheda aveva prima non e'
    // scritto da nessuna parte, e «completa» e' la sola delle due bugie che non
    // si nota. La schermata del cestino manda questo, e questo deve arrivare.
    expect(ripescata.status).toBe(CardStatus.DA_RIVEDERE);
    expect((await client.listProcedures({ status: CardStatus.ARCHIVIATA })).total).toBe(0);
  });

  it("svuotare il cestino dice quante ne sono andate, e non tocca le schede vive", async () => {
    llm.enqueue(buildExtractionContract({ titolo: "Disdire la fibra e riportare il modem" }));
    llm.enqueue(
      buildExtractionContract({
        // Davvero diversa, e non «Seconda scheda»: il provider di embedding
        // finto e' una funzione pura del testo, quindi due estrazioni identiche
        // producono lo stesso vettore e la seconda finisce in
        // `DUPLICATO_SOSPETTO` invece di diventare una scheda.
        titolo: "Iscrivere il bambino alla mensa scolastica",
        trigger: "Le iscrizioni aprono a maggio e chiudono in fretta",
      }),
    );
    const { client } = await iscritto();

    await client.createRecording({ audio: audioFinto(), metadata: METADATI });
    const prima = await server.composition.ingestionService.processNext();
    await client.createRecording({ audio: audioFinto(), metadata: METADATI });
    const seconda = await server.composition.ingestionService.processNext();
    expect(prima?.kind).toBe("ESTRATTO");
    expect(seconda?.kind).toBe("ESTRATTO");

    const daButtare = prima?.kind === "ESTRATTO" ? prima.procedureId : "";
    const daTenere = seconda?.kind === "ESTRATTO" ? seconda.procedureId : "";
    await client.archiveProcedure(daButtare);

    const conto = await client.emptyTrash();

    // La rotta esiste da due attivita' e il client vero non l'aveva mai
    // chiamata: i due parametri di query li scrive lui, e sbagliarne uno e' un
    // 400 che nessuna schermata potrebbe correggere.
    expect(conto).toEqual({ cancellate: 1, saltate: 0 });
    expect(await codiceDelRifiuto(client.getProcedure(daButtare))).toBe(ErrorCode.NOT_FOUND);
    // E l'altra e' ancora li'. La meta' che conta davvero: uno svuotamento che
    // prendesse tutte le schede invece delle sole archiviate passerebbe la riga
    // sopra e cancellerebbe l'archivio di chi ha premuto il pulsante.
    expect((await client.getProcedure(daTenere)).id).toBe(daTenere);
  });

  it("un cestino vuoto risponde due zeri, e non un errore", async () => {
    const { client } = await iscritto();

    expect(await client.emptyTrash()).toEqual({ cancellate: 0, saltate: 0 });
  });

  it("cancellare per sempre una scheda viva e' un 409, e la lascia dov'e'", async () => {
    llm.enqueue(buildExtractionContract({ titolo: "Ritirare la tessera sanitaria nuova" }));
    const { client } = await iscritto();

    await client.createRecording({ audio: audioFinto(), metadata: METADATI });
    const esito = await server.composition.ingestionService.processNext();
    const idScheda = esito?.kind === "ESTRATTO" ? esito.procedureId : "";

    // L'altro ramo senza corpo del client. Qui la risposta un corpo ce l'ha —
    // e' un errore — e il client lo deve leggere lo stesso: e' la prova che
    // «non chiamare `json()`» vale sul successo e non sul fallimento.
    expect(await codiceDelRifiuto(client.deleteProcedureForever(idScheda))).toBe(
      ErrorCode.CONFLICT,
    );
    expect((await client.getProcedure(idScheda)).id).toBe(idScheda);
  });
});

// ---------------------------------------------------------------------------
// 5. Le intestazioni che il client mette sul filo
// ---------------------------------------------------------------------------

/**
 * Le intestazioni che un browser lascia passare senza preflight.
 *
 * `content-type` **non** e' nell'elenco, e non e' una dimenticanza: e'
 * safelisted solo con tre valori, e `application/json` non e' fra quelli. Il
 * client manda proprio quello, quindi deve essere il server a dichiararlo.
 */
const SAFELISTED = new Set(["accept", "accept-language", "content-language"]);

describe("il ponte: le intestazioni e la CORS", () => {
  /**
   * Il preflight si fa a mano, e non con il client.
   *
   * E' l'unico modo di farsi dire dal server cosa consente: il client non manda
   * mai `OPTIONS` — lo manda il browser, da solo, prima della richiesta vera — e
   * chiedere a `apps/api/src/http/middleware/cors.ts` la sua costante
   * significherebbe confrontare il codice con se' stesso.
   */
  async function intestazioniConsentite(): Promise<Set<string>> {
    const pre = await fetch(`${server.url}/api/procedures`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGINE,
        "access-control-request-method": "GET",
      },
    });
    expect(pre.status).toBe(204);

    return new Set(
      (pre.headers.get("access-control-allow-headers") ?? "")
        .split(",")
        // La costante del server oggi non ha spazi. Il `trim` serve il giorno
        // in cui qualcuno ce li mettesse per leggibilita': senza, l'insieme
        // conterrebbe " content-type" e questo caso fallirebbe accusando il
        // client di un difetto che non ha.
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0),
    );
  }

  it("ogni intestazione che il client manda e' safelisted o dichiarata dal server", async () => {
    const consentite = await intestazioniConsentite();

    // Un giro largo apposta: JSON con corpo, JSON senza corpo, multipart, e una
    // risposta binaria. Sono i quattro modi in cui `execute` compone le
    // intestazioni, e provarne uno solo proverebbe un ramo su quattro.
    const cliente = await iscritto();
    llm.enqueue(buildExtractionContract({ titolo: "Chiedere il duplicato della patente" }));
    const caricata = await cliente.client.createRecording({
      audio: audioFinto(),
      metadata: METADATI,
    });
    await cliente.client.getRecordingAudio(caricata.id);
    await cliente.client.listProcedures();
    await server.composition.ingestionService.processNext();
    const idScheda = (await cliente.client.listProcedures()).items[0]?.id ?? "";
    await cliente.client.updateProcedure(idScheda, { titolo: "Duplicato della patente" });
    await cliente.client.archiveProcedure(idScheda);

    expect(cliente.richieste.length).toBeGreaterThan(5);

    const fuorilegge: string[] = [];
    for (const richiesta of cliente.richieste) {
      for (const nome of Object.keys(richiesta.headers)) {
        const minuscolo = nome.toLowerCase();
        if (!SAFELISTED.has(minuscolo) && !consentite.has(minuscolo)) {
          fuorilegge.push(`${richiesta.method} ${richiesta.url}: ${nome}`);
        }
      }
    }

    // Una sola asserzione per tutte le richieste del giro, e l'elenco dentro il
    // messaggio: cosi' il giorno in cui il client comincera' a mandare
    // `X-Qualcosa` il fallimento dice quale rotta e quale intestazione, invece
    // di dire che un booleano era falso.
    expect(fuorilegge).toEqual([]);
  });

  it("il server non dichiara consentita un'intestazione che nessuno gli ha chiesto", async () => {
    const consentite = await intestazioniConsentite();

    // Senza questo caso, l'asserzione sopra passerebbe anche contro un insieme
    // che contiene tutto — per esempio se il server rispondesse `*`, o se il
    // parsing raccogliesse una riga intera invece dei singoli nomi.
    expect(consentite.has("x-finto")).toBe(false);
    expect(consentite.has("authorization")).toBe(true);
    expect(consentite.has("content-type")).toBe(true);
  });

  it("il caricamento dell'audio non porta nessun Content-Type scritto a mano", async () => {
    const cliente = await iscritto();

    await cliente.client.createRecording({ audio: audioFinto(), metadata: METADATI });

    const upload = cliente.richieste.find((r) => r.url.endsWith("/api/recordings"));
    expect(upload).toBeDefined();
    // Il boundary lo conosce solo il runtime che ha costruito la `FormData`.
    // Un `Content-Type` scritto dal client sovrascriverebbe quello giusto e
    // produrrebbe un multipart che nessun parser sa leggere — cioe' un 400 su
    // ogni registrazione, che e' il gesto principale dell'applicazione.
    expect(upload?.headers["Content-Type"]).toBeUndefined();
    expect(upload?.headers["Authorization"]).toMatch(/^Bearer /);
  });

  it("una richiesta con corpo JSON il Content-Type ce l'ha", async () => {
    const cliente = await iscritto();
    llm.enqueue(buildExtractionContract({ titolo: "Rinnovare il permesso di sosta" }));
    await cliente.client.createRecording({ audio: audioFinto(), metadata: METADATI });
    await server.composition.ingestionService.processNext();
    const idScheda = (await cliente.client.listProcedures()).items[0]?.id ?? "";

    await cliente.client.updateProcedure(idScheda, { titolo: "Permesso di sosta" });

    // Il verso opposto del caso sopra: se il client smettesse di metterlo, Express
    // non interpreterebbe il corpo e ogni `PATCH` diventerebbe un 400.
    const patch = cliente.richieste.find((r) => r.method === "PATCH");
    expect(patch?.headers["Content-Type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// 6. Guardia: nessun metodo senza ponte
// ---------------------------------------------------------------------------

describe("il ponte: guardia", () => {
  /**
   * L'elenco vero dei metodi, letto dall'oggetto e non scritto qui.
   *
   * Funziona perche' `createApiClient` restituisce un oggetto letterale e non
   * un'istanza di classe: le chiavi ci sono tutte, e un metodo aggiunto domani
   * compare qui da solo. Con una classe sarebbero state sul prototipo e
   * `Object.keys` avrebbe risposto `[]`, cioe' una guardia sempre verde.
   */
  function tuttiIMetodi(): string[] {
    return Object.keys(
      createApiClient({
        baseUrl: server.url,
        storage: createInMemorySecureStorage(),
      }),
    );
  }

  /** Sincrono, non fa HTTP: non c'e' nessun ponte da attraversare. */
  const ESENTI = new Set(["getAccessToken"]);

  it("ogni metodo del client e' stato chiamato almeno una volta contro il server vero", () => {
    const scoperti = tuttiIMetodi().filter(
      (nome) => !ESENTI.has(nome) && !attraversati.has(nome),
    );

    // Nominare i metodi invece di contarli: il fallimento deve dire cosa manca,
    // perche' chi lo legge e' quasi sempre chi ha appena aggiunto il metodo e
    // non sa ancora che questo file esiste.
    expect(scoperti).toEqual([]);
  });

  it("la guardia sta guardando qualcosa", () => {
    // Senza questo caso, un `Object.keys` che tornasse vuoto — per un refactoring
    // del client da oggetto letterale a classe, che e' una riscrittura
    // plausibile — renderebbe la guardia sopra verde per sempre, e nessuno se ne
    // accorgerebbe perche' i test verdi non si rileggono.
    expect(tuttiIMetodi()).toHaveLength(27);
    expect(attraversati.size).toBeGreaterThan(0);
  });
});
