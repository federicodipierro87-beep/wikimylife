import { describe, expect, it } from "vitest";
import {
  estensioneDi,
  motivoDi,
  nomeFileDi,
  spazioEsaurito,
} from "../../apps/web/src/recording/salvataggio.js";

/**
 * Il caso in cui il browser rifiuta di scrivere l'audio.
 *
 * E' l'unico punto dell'app in cui un errore mal classificato costa una
 * registrazione: se «non c'e' spazio» passa per «IndexedDB e' rotto», l'utente
 * non vede il pulsante che gli farebbe salvare l'audio dopo aver liberato
 * memoria, e se il nome del file scaricato e' sbagliato l'audio esce dal
 * browser in un formato che il telefono non sa aprire.
 */

/** Come arriva davvero: `tx.error` e' una `DOMException`, non un `Error`. */
function domException(name: string): Error {
  const e = new Error("qualcosa e' andato storto");
  e.name = name;
  return e;
}

describe("spazioEsaurito", () => {
  it("riconosce il nome standard", () => {
    expect(spazioEsaurito(domException("QuotaExceededError"))).toBe(true);
  });

  it("riconosce anche i due nomi di Firefox", () => {
    // Gecko non usa il nome standard, e senza questi due l'utente su Firefox
    // vedrebbe «il browser non ha potuto salvare» quando invece basta liberare
    // spazio.
    expect(spazioEsaurito(domException("NS_ERROR_DOM_QUOTA_REACHED"))).toBe(true);
    expect(spazioEsaurito(domException("NS_ERROR_FILE_NO_DEVICE_SPACE"))).toBe(true);
  });

  it("non confonde un IndexedDB negato con un disco pieno", () => {
    // Firefox in navigazione privata: riprovare non cambia niente, e offrire
    // «riprova» sarebbe una bugia.
    expect(spazioEsaurito(domException("InvalidStateError"))).toBe(false);
    expect(spazioEsaurito(new Error("IndexedDB: apertura fallita"))).toBe(false);
  });

  it("regge cio' che non e' un errore", () => {
    // `throw "stringa"` e' legale in JavaScript, e una `catch` non puo'
    // assumere altro.
    expect(spazioEsaurito(null)).toBe(false);
    expect(spazioEsaurito(undefined)).toBe(false);
    expect(spazioEsaurito("QuotaExceededError")).toBe(false);
    expect(spazioEsaurito({ name: 42 })).toBe(false);
  });
});

describe("motivoDi", () => {
  it("dice che manca lo spazio quando manca lo spazio", () => {
    expect(motivoDi(domException("QuotaExceededError"))).toContain("spazio");
  });

  it("non promette spazio quando il problema e' un altro", () => {
    expect(motivoDi(new Error("boom"))).not.toContain("spazio");
  });

  it("non fa mai uscire il messaggio grezzo del browser", () => {
    // «A mutation operation was attempted on a database that did not allow
    // mutations» e' vero e non aiuta nessuno.
    const grezzo = "A mutation operation was attempted on a database";
    expect(motivoDi(new Error(grezzo))).not.toContain(grezzo);
  });
});

describe("estensioneDi", () => {
  it("ignora i parametri del tipo", () => {
    // E' cio' che `MediaRecorder.mimeType` restituisce davvero su Chrome.
    expect(estensioneDi("audio/webm;codecs=opus")).toBe("webm");
    expect(estensioneDi("audio/ogg; codecs=opus")).toBe("ogg");
  });

  it("dà a mp4 il nome che apre un lettore audio", () => {
    expect(estensioneDi("audio/mp4")).toBe("m4a");
    expect(estensioneDi("audio/mp4;codecs=mp4a.40.2")).toBe("m4a");
  });

  it("non finge di conoscere un tipo che non conosce", () => {
    // Chiamarlo `.webm` lo farebbe aprire e fallire: meglio un file che si
    // capisce di dover ispezionare.
    expect(estensioneDi("audio/flac")).toBe("bin");
    expect(estensioneDi("")).toBe("bin");
  });
});

describe("nomeFileDi", () => {
  it("mette data e ora nel nome", () => {
    // Ora locale: e' quella che l'utente ha guardato mentre registrava, e il
    // file finisce accanto a tutto il resto dei suoi Download.
    const quando = new Date(2026, 2, 1, 10, 15);
    expect(nomeFileDi(quando.toISOString(), "audio/webm;codecs=opus")).toBe(
      "wikimylife-20260301-1015.webm",
    );
  });

  it("riempie di zeri i mesi e le ore a una cifra", () => {
    const quando = new Date(2026, 0, 5, 9, 7);
    expect(nomeFileDi(quando.toISOString(), "audio/mp4")).toBe("wikimylife-20260105-0907.m4a");
  });

  it("produce comunque un nome se la data non si legge", () => {
    // Un nome sbagliato e' un fastidio; un'eccezione qui dentro sarebbe l'audio
    // che non esce dal browser.
    expect(nomeFileDi("non una data", "audio/webm")).toBe("wikimylife-senza-data.webm");
  });
});
