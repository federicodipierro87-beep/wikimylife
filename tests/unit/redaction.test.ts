import {
  SensitiveKind,
  applyRedactions,
  codiceFiscaleValido,
  detectSensitive,
  ibanValido,
} from "@wikimylife/shared";
import { describe, expect, it } from "vitest";

/**
 * I rilevatori della §9.
 *
 * Meta' di questo file prova che i dati personali vengono trovati, e non e' la
 * meta' interessante: una regex qualunque supera quei test. L'altra meta' prova
 * che il testo normale di una scheda NON viene toccato, ed e' quella che decide
 * se la funzione e' usabile.
 *
 * Il motivo e' che i due errori non si pagano uguale. Un dato non trovato lo
 * vede l'utente, che la §9 obbliga a confermare le sostituzioni una per una; un
 * falso positivo gli propone di cancellare un pezzo di scheda scritto bene, e
 * se lo conferma senza guardare quel pezzo non torna. Per questo qui sotto ci
 * sono piu' casi negativi che positivi: sono quelli che possono fare danni.
 */

function tipi(testo: string): readonly string[] {
  return detectSensitive(testo).map((m) => m.kind);
}

function valori(testo: string): readonly string[] {
  return detectSensitive(testo).map((m) => m.value);
}

// ---------------------------------------------------------------------------
// Codice fiscale
// ---------------------------------------------------------------------------

describe("codiceFiscaleValido", () => {
  it("accetta i codici di esempio che girano da sempre", () => {
    // Non calcolati da questo file: sono i due esempi validi che compaiono
    // ovunque, ed e' l'unico modo di provare che la tabella ministeriale sia
    // stata trascritta giusta invece che coerente con se stessa.
    expect(codiceFiscaleValido("MRTMTT25D09F205Z")).toBe(true);
    expect(codiceFiscaleValido("RSSMRA85T10A562S")).toBe(true);
  });

  it("rifiuta lo stesso codice con l'ultima lettera cambiata", () => {
    // E' cio' che dimostra che la cifra di controllo viene calcolata davvero:
    // senza, basterebbe `length === 16` per far passare il test di sopra.
    expect(codiceFiscaleValido("MRTMTT25D09F205A")).toBe(false);
  });

  it("rifiuta un codice della forma giusta ma inventato", () => {
    expect(codiceFiscaleValido("ABCDEF12A34B567C")).toBe(false);
  });

  it("rifiuta una lunghezza diversa da sedici", () => {
    expect(codiceFiscaleValido("MRTMTT25D09F205")).toBe(false);
    expect(codiceFiscaleValido("MRTMTT25D09F205ZZ")).toBe(false);
  });

  it("accetta un codice con omocodia", () => {
    // `MRTMTT25D09F20RU` e' l'omocodico del codice di sopra: la cifra piu' a
    // destra, il 5 di F205, e' diventata la R di `LMNPQRSTUV`. Nel calcolo
    // quella R vale per se stessa e non per il 5 che rappresenta — sbagliarlo
    // fa fallire solo gli omocodici, che sono rari abbastanza da non
    // accorgersene mai.
    expect(codiceFiscaleValido("MRTMTT25D09F20RU")).toBe(true);
  });
});

describe("detectSensitive — codice fiscale", () => {
  it("lo trova dentro una frase", () => {
    expect(tipi("Serve il CF MRTMTT25D09F205Z allo sportello")).toEqual([
      SensitiveKind.CODICE_FISCALE,
    ]);
  });

  it("non trova niente se la cifra di controllo non torna", () => {
    // Sedici caratteri della forma giusta ma non un codice fiscale: senza il
    // controllo, questo verrebbe cancellato dalla scheda.
    expect(detectSensitive("Il modulo ABCDEF12A34B567C va compilato")).toEqual([]);
  });

  it("non lo trova attaccato ad altre lettere", () => {
    expect(detectSensitive("XMRTMTT25D09F205Z")).toEqual([]);
    expect(detectSensitive("MRTMTT25D09F205ZX")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// IBAN
// ---------------------------------------------------------------------------

describe("ibanValido", () => {
  it("accetta un IBAN italiano", () => {
    expect(ibanValido("IT60X0542811101000000123456")).toBe(true);
  });

  it("accetta lo stesso IBAN scritto con gli spazi", () => {
    // E' come lo si copia da un estratto conto, quindi e' come arrivera'.
    expect(ibanValido("IT60 X054 2811 1010 0000 0123 456")).toBe(true);
  });

  it("rifiuta un IBAN con una cifra cambiata", () => {
    expect(ibanValido("IT60X0542811101000000123457")).toBe(false);
  });

  it("accetta un IBAN di un altro paese", () => {
    expect(ibanValido("DE89370400440532013000")).toBe(true);
    expect(ibanValido("GB33BUKB20201555555555")).toBe(true);
  });

  it("regge un IBAN lungo senza perdere precisione", () => {
    // Trentaquattro caratteri diventano un numero da quaranta cifre. Calcolato
    // in un `number` il resto sarebbe sbagliato, e lo sarebbe in silenzio: il
    // test esiste perche' con i soli IBAN italiani non si vedrebbe.
    expect(ibanValido("MT84MALT011000012345MTLCAST001S")).toBe(true);
  });

  it("rifiuta qualcosa di troppo corto per essere un IBAN", () => {
    expect(ibanValido("IT60X05428")).toBe(false);
  });
});

describe("detectSensitive — IBAN", () => {
  it("lo trova con gli spazi dentro", () => {
    expect(valori("Bonifico su IT60 X054 2811 1010 0000 0123 456 entro il 30")).toEqual([
      "IT60 X054 2811 1010 0000 0123 456",
    ]);
  });

  it("non trova un IBAN dove non c'e'", () => {
    expect(detectSensitive("La pratica IT60X0542811101000000123999 non esiste")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

describe("detectSensitive — email", () => {
  it("la trova", () => {
    expect(valori("Scrivere a mario.rossi@comune.milano.it")).toEqual([
      "mario.rossi@comune.milano.it",
    ]);
  });

  it("non prende la punteggiatura finale della frase", () => {
    expect(valori("Scrivi a info@example.com.")).toEqual(["info@example.com"]);
  });

  it("non considera email una chiocciola qualunque", () => {
    expect(detectSensitive("Ci vediamo @casa")).toEqual([]);
    expect(detectSensitive("Il tasso e' 5@2")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Telefono, cioe' la parte pericolosa
// ---------------------------------------------------------------------------

describe("detectSensitive — telefono", () => {
  it("trova un cellulare italiano", () => {
    expect(tipi("Chiama il 3281234567")).toEqual([SensitiveKind.TELEFONO]);
  });

  it("trova un cellulare scritto con gli spazi", () => {
    expect(valori("Chiama il 328 123 4567 domani")).toEqual(["328 123 4567"]);
  });

  it("trova un fisso", () => {
    expect(tipi("Ufficio: 0612345678")).toEqual([SensitiveKind.TELEFONO]);
  });

  it("trova un numero internazionale", () => {
    expect(tipi("Chiama +39 328 1234567")).toEqual([SensitiveKind.TELEFONO]);
  });

  it("non scambia un importo per un telefono", () => {
    expect(detectSensitive("Il bollo costa 16 euro")).toEqual([]);
    expect(detectSensitive("Servono 1600 euro in tutto")).toEqual([]);
  });

  it("non scambia una durata per un telefono", () => {
    expect(detectSensitive("Ci vogliono 30 minuti, forse 45")).toEqual([]);
  });

  it("non scambia un anno o una data per un telefono", () => {
    expect(detectSensitive("Scadenza 31/12/2026, rinnovo dal 2019")).toEqual([]);
  });

  it("non scambia un numero di protocollo lungo per un telefono", () => {
    // Tredici cifre di seguito non sono un telefono italiano, e cancellare un
    // numero di pratica da una scheda la rende inservibile.
    expect(detectSensitive("Protocollo 3281234567890123")).toEqual([]);
  });

  it("non prende sette cifre nude", () => {
    // Potrebbero essere un fisso senza prefisso, e potrebbero essere qualunque
    // altra cosa. La §9 non vale il prezzo di indovinare.
    expect(detectSensitive("Codice pratica 1234567")).toEqual([]);
  });

  it("non prende un numero attaccato a delle lettere", () => {
    expect(detectSensitive("Modello AB3281234567")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sovrapposizioni
// ---------------------------------------------------------------------------

describe("detectSensitive — sovrapposizioni", () => {
  it("un IBAN non diventa anche un telefono", () => {
    // Dentro le cifre di un IBAN il rilevatore dei telefoni trova volentieri
    // qualcosa: chi ha il criterio piu' forte deve vincere.
    expect(tipi("IT60X0542811101000000123456")).toEqual([SensitiveKind.IBAN]);
  });

  it("trova piu' dati nella stessa frase, in ordine", () => {
    const trovati = detectSensitive(
      "CF MRTMTT25D09F205Z, tel 3281234567, mail mario@example.com",
    );

    expect(trovati.map((m) => m.kind)).toEqual([
      SensitiveKind.CODICE_FISCALE,
      SensitiveKind.TELEFONO,
      SensitiveKind.EMAIL,
    ]);
  });

  it("non restituisce due tratti che si accavallano", () => {
    const trovati = detectSensitive("IT60 X054 2811 1010 0000 0123 456 e poi 3281234567");

    for (let i = 1; i < trovati.length; i += 1) {
      const precedente = trovati[i - 1];
      const corrente = trovati[i];
      if (precedente === undefined || corrente === undefined) {
        throw new Error("indice fuori posto");
      }
      expect(corrente.start).toBeGreaterThanOrEqual(precedente.end);
    }
  });

  it("gli indici individuano davvero il testo trovato", () => {
    const testo = "Il CF e' MRTMTT25D09F205Z, punto.";
    const trovato = detectSensitive(testo)[0];
    if (trovato === undefined) {
      throw new Error("atteso un codice fiscale");
    }

    expect(testo.slice(trovato.start, trovato.end)).toBe(trovato.value);
  });
});

// ---------------------------------------------------------------------------
// Testo normale
// ---------------------------------------------------------------------------

describe("detectSensitive — cio' che deve restare intatto", () => {
  it("non tocca un passo di procedura scritto normalmente", () => {
    const passo =
      "Vai allo sportello 3 del Comune con la marca da bollo da 16 euro e il documento; " +
      "l'attesa e' di circa 40 minuti, il modulo e' il C2 versione 2019.";

    expect(detectSensitive(passo)).toEqual([]);
  });

  it("non tocca un testo vuoto", () => {
    expect(detectSensitive("")).toEqual([]);
  });

  // I numeri che compaiono davvero dentro una procedura burocratica italiana.
  // Ognuno di questi e' un modo diverso di sembrare un telefono senza esserlo,
  // ed e' la lista che ha deciso quanto stretto dovesse essere il rilevatore.
  it.each([
    "Presentati allo sportello 12 entro le 10:30 del 15/03/2026",
    "Il costo e' 16,00 euro di marca da bollo piu' 3,50 di diritti",
    "Documento 12345678 rilasciato dal Comune di Milano nel 2019",
    "La pratica e' la 2024/000123/AB",
    "Partita IVA 12345678903 della ditta",
    "CAP 20121, via Roma 15, scala B interno 7",
    "Ordine 4051234567890 su Amazon",
  ])("non trova niente in %j", (frase) => {
    expect(detectSensitive(frase)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sostituzione
// ---------------------------------------------------------------------------

describe("applyRedactions", () => {
  it("sostituisce un dato solo", () => {
    const testo = "Chiama il 3281234567 di mattina";

    expect(applyRedactions(testo, detectSensitive(testo))).toBe(
      "Chiama il [telefono] di mattina",
    );
  });

  it("sostituisce piu' dati senza sfasare gli indici", () => {
    // Il segnaposto e' piu' corto del dato, quindi andando da sinistra a destra
    // la seconda sostituzione cadrebbe qualche carattere prima del punto
    // giusto. Con un dato solo il baco non si vede.
    const testo = "CF MRTMTT25D09F205Z, tel 3281234567, mail mario@example.com";

    expect(applyRedactions(testo, detectSensitive(testo))).toBe(
      "CF [codice fiscale], tel [telefono], mail [email]",
    );
  });

  it("sostituisce solo cio' che gli si passa", () => {
    // E' il cuore del «una per una» della §9: l'utente ne conferma due su tre,
    // e la terza deve restare dov'e'.
    const testo = "CF MRTMTT25D09F205Z, tel 3281234567";
    const trovati = detectSensitive(testo);
    const soloIlTelefono = trovati.filter((m) => m.kind === SensitiveKind.TELEFONO);

    expect(applyRedactions(testo, soloIlTelefono)).toBe("CF MRTMTT25D09F205Z, tel [telefono]");
  });

  it("senza niente da sostituire restituisce il testo com'e'", () => {
    expect(applyRedactions("Niente da fare qui", [])).toBe("Niente da fare qui");
  });
});
