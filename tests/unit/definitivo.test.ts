import { describe, expect, it } from "vitest";
import { ProviderHttpError } from "../../apps/api/src/providers/http.js";
import { S3StorageError } from "../../apps/api/src/providers/S3StorageProvider.js";
import {
  oggettoMancante,
  richiestaRifiutata,
  STATI_RIFIUTO,
} from "../../apps/api/src/services/ingestion/definitivo.js";

/**
 * Quali fallimenti vale la pena riprovare.
 *
 * I due errori si costruiscono con le classi vere e non con oggetti che le
 * somigliano: la classificazione guarda `name` e `status`, cioe' due proprieta'
 * che nessun compilatore lega alla classe. Un lookalike scritto a mano
 * continuerebbe a passare anche il giorno in cui qualcuno rinomina
 * `ProviderHttpError`, ed e' esattamente quel giorno che questo file esiste per
 * intercettare.
 *
 * Il verso che conta e' quello negativo. Chiamare «definitivo» un guasto
 * passeggero non spreca tentativi: li toglie, e per riaverli serve una persona
 * che apra l'app. Quindi ogni caso dubbio qui dentro deve risultare `false`.
 */

const RIFIUTO = 415;
const TRANSITORIO = 503;

function http(status: number): ProviderHttpError {
  return new ProviderHttpError({ provider: "fake", status, body: "" });
}

describe("richiestaRifiutata", () => {
  it("riconosce un rifiuto del contenuto", () => {
    expect(richiestaRifiutata(http(RIFIUTO))).toBe(true);
  });

  it("copre tutti gli stati dichiarati, e sono quelli", () => {
    // Il `Set` e' la policy: se qualcuno ci aggiunge un 401 il test lo dice,
    // invece di lasciare che una chiave scaduta fermi la coda per sempre.
    expect([...STATI_RIFIUTO].sort((a, b) => a - b)).toEqual([400, 413, 415, 422]);
    for (const status of STATI_RIFIUTO) {
      expect(richiestaRifiutata(http(status))).toBe(true);
    }
  });

  it("lascia transitorio tutto cio' che parla del server", () => {
    // 429 e 5xx sono la ragione per cui il backoff esiste.
    for (const status of [429, 500, 502, TRANSITORIO, 504]) {
      expect(richiestaRifiutata(http(status))).toBe(false);
    }
  });

  it("lascia transitorie le credenziali", () => {
    // Una chiave sbagliata fa fallire tutta la coda insieme. Fermarla
    // definitivamente vorrebbe dire un «riprova» a mano per ogni riga, dopo un
    // guasto che si ripara con una variabile d'ambiente: i novanta minuti di
    // tentativi sono anche la finestra per accorgersene.
    expect(richiestaRifiutata(http(401))).toBe(false);
    expect(richiestaRifiutata(http(403))).toBe(false);
  });

  it("lascia transitorio un 404 di un fornitore", () => {
    // Su un endpoint di OpenAI o Anthropic significa url o modello sbagliati,
    // cioe' ancora configurazione — al contrario del 404 dello storage.
    expect(richiestaRifiutata(http(404))).toBe(false);
  });

  it("non decide su un errore che non porta uno status", () => {
    // Timeout, DNS, connessione chiusa: nessuno di questi dice niente sul
    // contenuto della richiesta.
    expect(richiestaRifiutata(new Error("timeout"))).toBe(false);
    expect(richiestaRifiutata(null)).toBe(false);
    expect(richiestaRifiutata("415")).toBe(false);
    expect(richiestaRifiutata({ status: RIFIUTO })).toBe(false);
  });

  it("non si fa ingannare da uno status che non e' un numero", () => {
    const finto = new Error("boh");
    finto.name = "ProviderHttpError";
    expect(richiestaRifiutata(Object.assign(finto, { status: "415" }))).toBe(false);
  });

  it("vale anche per lo storage, con gli stessi stati", () => {
    expect(richiestaRifiutata(new S3StorageError("put", 400, ""))).toBe(true);
    expect(richiestaRifiutata(new S3StorageError("put", TRANSITORIO, ""))).toBe(false);
  });
});

describe("oggettoMancante", () => {
  it("riconosce il 404 dello storage", () => {
    expect(oggettoMancante(new S3StorageError("get", 404, "chiave assente"))).toBe(true);
  });

  it("riconosce ENOENT del filesystem", () => {
    const errno: NodeJS.ErrnoException = new Error("no such file");
    errno.code = "ENOENT";
    expect(oggettoMancante(errno)).toBe(true);
  });

  it("non confonde un permesso negato con un'assenza", () => {
    // Un `EACCES` si aggiusta cambiando i permessi, e allora il file c'e'
    // ancora: e' la definizione di transitorio.
    const errno: NodeJS.ErrnoException = new Error("permission denied");
    errno.code = "EACCES";
    expect(oggettoMancante(errno)).toBe(false);
    expect(oggettoMancante(new S3StorageError("get", 403, ""))).toBe(false);
  });

  it("non scambia un 404 di un fornitore per un oggetto mancante", () => {
    expect(oggettoMancante(http(404))).toBe(false);
  });

  it("regge cio' che non e' un errore", () => {
    expect(oggettoMancante(null)).toBe(false);
    expect(oggettoMancante("ENOENT")).toBe(false);
    expect(oggettoMancante(undefined)).toBe(false);
  });
});
