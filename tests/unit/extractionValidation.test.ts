import { CardStatus, Severity } from "@wikimylife/shared";
import { buildExtractionContract } from "@wikimylife/shared/testing";
import { describe, expect, it } from "vitest";
import {
  ExtractionRule,
  MAX_TITOLO_LENGTH,
  MIN_CONFIDENZA,
  normalizeSteps,
  validateExtraction,
  type ExtractionVerdict,
} from "../../apps/api/src/services/validation/extractionValidation.js";

/**
 * Validazione deterministica — §5.
 *
 * Ogni asserzione guarda la coppia `regola@percorso`, non il solo esito.
 * Un test che si accontenta di `outcome === "RIFIUTATA"` passa anche quando il
 * verdetto e' giusto per il motivo sbagliato, e siccome i casi si costruiscono
 * rompendo una cosa sola in un contratto valido, e' proprio quello che
 * succederebbe.
 *
 * La distinzione che questo file difende piu' di tutte e' fra RIFIUTATA e
 * ACCETTATA-con-issue: la prima porta a `ESTRAZIONE_FALLITA` e nessuna scheda,
 * la seconda a una scheda in `DA_RIVEDERE`. Confonderle significa buttare via
 * un'estrazione riuscita o mostrare all'utente schede che non doveva vedere.
 */

function rules(verdict: ExtractionVerdict): string[] {
  return verdict.issues.map((issue) => `${issue.rule}@${issue.path}`);
}

describe("validateExtraction — forma (§4.1)", () => {
  it("accetta un'estrazione completa e la marca COMPLETA senza rilievi", () => {
    const verdict = validateExtraction(buildExtractionContract());

    expect(verdict.outcome).toBe("ACCETTATA");
    expect(verdict.cardStatus).toBe(CardStatus.COMPLETA);
    expect(verdict.issues).toEqual([]);
  });

  it("rifiuta un JSON malformato: non un oggetto", () => {
    // Il caso che capita davvero quando un modello risponde in prosa.
    const verdict = validateExtraction("Certo! Ecco la procedura estratta:");

    expect(verdict.outcome).toBe("RIFIUTATA");
    expect(verdict.contract).toBeNull();
    expect(verdict.cardStatus).toBeNull();
    expect(rules(verdict)).toEqual([`${ExtractionRule.contrattoNonConforme}@`]);
  });

  it("rifiuta null e undefined", () => {
    expect(validateExtraction(null).outcome).toBe("RIFIUTATA");
    expect(validateExtraction(undefined).outcome).toBe("RIFIUTATA");
  });

  it("rifiuta una chiave mancante indicando quale", () => {
    const { esito: _omesso, ...senzaEsito } = buildExtractionContract();
    const verdict = validateExtraction(senzaEsito);

    expect(verdict.outcome).toBe("RIFIUTATA");
    expect(rules(verdict)).toEqual([`${ExtractionRule.contrattoNonConforme}@esito`]);
  });

  it("rifiuta un tipo sbagliato dentro un array indicando l'indice", () => {
    const verdict = validateExtraction(
      buildExtractionContract({
        passi: [
          { ordine: 1, azione: "primo", dettaglio: null, durataStimataMin: null },
          // `azione` numerica: il path deve arrivare fino a passi[1].azione.
          { ordine: 2, azione: 7, dettaglio: null, durataStimataMin: null },
        ] as never,
      }),
    );

    expect(verdict.outcome).toBe("RIFIUTATA");
    expect(rules(verdict)).toEqual([
      `${ExtractionRule.contrattoNonConforme}@passi[1].azione`,
    ]);
  });

  it("marca bloccanti tutti i problemi di forma", () => {
    // Nessuna scheda puo' nascere da un JSON non conforme: se anche uno solo
    // di questi issue non fosse bloccante, la pipeline proverebbe a salvare.
    const verdict = validateExtraction({ titolo: "solo il titolo" });

    expect(verdict.issues.length).toBeGreaterThan(0);
    expect(verdict.issues.every((i) => i.blocking)).toBe(true);
  });
});

describe("validateExtraction — titolo", () => {
  it("rifiuta un titolo assente: la scheda non sarebbe ritrovabile", () => {
    const verdict = validateExtraction(buildExtractionContract({ titolo: null }));

    expect(verdict.outcome).toBe("RIFIUTATA");
    expect(rules(verdict)).toEqual([`${ExtractionRule.titoloMancante}@titolo`]);
  });

  it("rifiuta un titolo fatto di soli spazi", () => {
    const verdict = validateExtraction(buildExtractionContract({ titolo: "   \n\t " }));

    expect(verdict.outcome).toBe("RIFIUTATA");
    expect(rules(verdict)).toEqual([`${ExtractionRule.titoloMancante}@titolo`]);
  });

  it("accetta un titolo lungo segnalandolo, e non lo tronca", () => {
    // Non bloccante: il titolo lungo e' recuperabile dall'utente, un titolo
    // tagliato a meta' no.
    const titolo = "R".repeat(MAX_TITOLO_LENGTH);
    const verdict = validateExtraction(buildExtractionContract({ titolo }));

    expect(verdict.outcome).toBe("ACCETTATA");
    expect(verdict.cardStatus).toBe(CardStatus.DA_RIVEDERE);
    expect(rules(verdict)).toEqual([`${ExtractionRule.titoloTroppoLungo}@titolo`]);
    expect(verdict.contract?.titolo).toHaveLength(MAX_TITOLO_LENGTH);
  });

  it("non segnala un titolo appena sotto il limite", () => {
    const verdict = validateExtraction(
      buildExtractionContract({ titolo: "R".repeat(MAX_TITOLO_LENGTH - 1) }),
    );

    expect(verdict.issues).toEqual([]);
  });
});

describe("validateExtraction — passi", () => {
  it("segnala un ordine non contiguo senza rifiutare l'estrazione", () => {
    const verdict = validateExtraction(
      buildExtractionContract({
        passi: [
          { ordine: 1, azione: "uno", dettaglio: null, durataStimataMin: null },
          { ordine: 2, azione: "due", dettaglio: null, durataStimataMin: null },
          { ordine: 4, azione: "quattro", dettaglio: null, durataStimataMin: null },
        ],
      }),
    );

    expect(verdict.outcome).toBe("ACCETTATA");
    expect(verdict.cardStatus).toBe(CardStatus.DA_RIVEDERE);
    expect(rules(verdict)).toEqual([`${ExtractionRule.passiOrdineNonContiguo}@passi`]);
    expect(verdict.issues[0]?.message).toContain("1, 2, 4");
  });

  it("segnala anche due passi con lo stesso ordine", () => {
    // `@@unique([procedureId, ordine])` li rifiuterebbe a livello di database:
    // qui devono essere visti prima, per poterli rinumerare.
    const verdict = validateExtraction(
      buildExtractionContract({
        passi: [
          { ordine: 1, azione: "uno", dettaglio: null, durataStimataMin: null },
          { ordine: 1, azione: "uno bis", dettaglio: null, durataStimataMin: null },
        ],
      }),
    );

    expect(rules(verdict)).toEqual([`${ExtractionRule.passiOrdineNonContiguo}@passi`]);
  });

  it("segnala l'assenza di passi mandando la scheda in revisione", () => {
    // §5 nomina questo caso esplicitamente: passi vuoti -> DA_RIVEDERE.
    const verdict = validateExtraction(buildExtractionContract({ passi: [] }));

    expect(verdict.outcome).toBe("ACCETTATA");
    expect(verdict.cardStatus).toBe(CardStatus.DA_RIVEDERE);
    expect(rules(verdict)).toEqual([`${ExtractionRule.passiVuoti}@passi`]);
  });
});

describe("validateExtraction — costi", () => {
  it("segnala un importo negativo con l'indice esatto", () => {
    const verdict = validateExtraction(
      buildExtractionContract({
        costi: [
          { descrizione: "Marca da bollo", importoCent: 1600, valuta: "EUR" },
          { descrizione: "Rimborso", importoCent: -380, valuta: "EUR" },
        ],
      }),
    );

    expect(verdict.outcome).toBe("ACCETTATA");
    expect(verdict.cardStatus).toBe(CardStatus.DA_RIVEDERE);
    expect(rules(verdict)).toEqual([
      `${ExtractionRule.costoImportoNegativo}@costi[1].importoCent`,
    ]);
  });

  it("segnala una valuta che non e' un codice ISO 4217", () => {
    // Il caso reale: il modello scrive la parola invece del codice.
    const verdict = validateExtraction(
      buildExtractionContract({
        costi: [{ descrizione: "Bollo", importoCent: 1600, valuta: "euro" }],
      }),
    );

    expect(rules(verdict)).toEqual([`${ExtractionRule.costoValutaNonIso}@costi[0].valuta`]);
  });

  it("accetta un costo a zero: gratuito e' un'informazione", () => {
    const verdict = validateExtraction(
      buildExtractionContract({
        costi: [{ descrizione: "Rilascio", importoCent: 0, valuta: "EUR" }],
      }),
    );

    expect(verdict.issues).toEqual([]);
  });

  it("segnala entrambi i problemi dello stesso costo", () => {
    const verdict = validateExtraction(
      buildExtractionContract({
        costi: [{ descrizione: "Sconto", importoCent: -100, valuta: "EU" }],
      }),
    );

    expect(rules(verdict)).toEqual([
      `${ExtractionRule.costoImportoNegativo}@costi[0].importoCent`,
      `${ExtractionRule.costoValutaNonIso}@costi[0].valuta`,
    ]);
  });
});

describe("validateExtraction — _meta", () => {
  const base = buildExtractionContract();

  it("segnala una confidenza sotto la soglia della §5", () => {
    const verdict = validateExtraction(
      buildExtractionContract({
        _meta: { ...base._meta, confidenzaGlobale: MIN_CONFIDENZA - 0.01 },
      }),
    );

    expect(verdict.outcome).toBe("ACCETTATA");
    expect(verdict.cardStatus).toBe(CardStatus.DA_RIVEDERE);
    expect(rules(verdict)).toEqual([
      `${ExtractionRule.confidenzaBassa}@_meta.confidenzaGlobale`,
    ]);
  });

  it("non segnala una confidenza esattamente alla soglia", () => {
    // §5 dice "< 0.5", non "<= 0.5": il confine sta scritto qui.
    const verdict = validateExtraction(
      buildExtractionContract({
        _meta: { ...base._meta, confidenzaGlobale: MIN_CONFIDENZA },
      }),
    );

    expect(verdict.issues).toEqual([]);
  });

  it("distingue una confidenza fuori scala da una confidenza bassa", () => {
    // 1.4 non e' "poca fiducia": e' un modello che ha risposto fuori contratto.
    // Segnalarlo come confidenzaBassa nasconderebbe un difetto del prompt.
    const verdict = validateExtraction(
      buildExtractionContract({ _meta: { ...base._meta, confidenzaGlobale: 1.4 } }),
    );

    expect(rules(verdict)).toEqual([
      `${ExtractionRule.confidenzaFuoriScala}@_meta.confidenzaGlobale`,
    ]);
  });

  it("tratta una confidenza negativa come fuori scala", () => {
    const verdict = validateExtraction(
      buildExtractionContract({ _meta: { ...base._meta, confidenzaGlobale: -0.2 } }),
    );

    expect(rules(verdict)).toEqual([
      `${ExtractionRule.confidenzaFuoriScala}@_meta.confidenzaGlobale`,
    ]);
  });

  it("salva una NOTA_SEMPLICE in DA_RIVEDERE invece di rifiutarla", () => {
    // Regola 10 del prompt: titolo e trigger, il resto vuoto. Il risultato e'
    // una scheda quasi vuota, che e' esattamente cio' che DA_RIVEDERE
    // rappresenta. Rifiutarla perderebbe l'unica cosa non riproducibile.
    const verdict = validateExtraction(
      buildExtractionContract({
        titolo: "Ricordarsi di richiamare l'ufficio",
        trigger: "Non rispondevano",
        passi: [],
        prerequisiti: [],
        trappole: [],
        costi: [],
        _meta: { ...base._meta, tipoRilevato: "NOTA_SEMPLICE" },
      }),
    );

    expect(verdict.outcome).toBe("ACCETTATA");
    expect(verdict.cardStatus).toBe(CardStatus.DA_RIVEDERE);
    expect(rules(verdict)).toEqual([
      `${ExtractionRule.passiVuoti}@passi`,
      `${ExtractionRule.tipoNonProcedura}@_meta.tipoRilevato`,
    ]);
  });
});

describe("validateExtraction — accumulo", () => {
  it("riporta tutti i problemi insieme, non si ferma al primo", () => {
    // Chi rivede la scheda deve vedere la lista intera in una volta: una
    // validazione che si arresta al primo errore costringerebbe a scoprirli
    // uno alla volta, riprocessando ogni volta.
    const base = buildExtractionContract();
    const verdict = validateExtraction(
      buildExtractionContract({
        titolo: "T".repeat(120),
        passi: [
          { ordine: 2, azione: "secondo", dettaglio: null, durataStimataMin: null },
          { ordine: 3, azione: "terzo", dettaglio: null, durataStimataMin: null },
        ],
        costi: [{ descrizione: "Anticipo", importoCent: -1, valuta: "eur" }],
        _meta: { ...base._meta, confidenzaGlobale: 0.2, tipoRilevato: "NOTA_SEMPLICE" },
      }),
    );

    expect(verdict.outcome).toBe("ACCETTATA");
    expect(verdict.cardStatus).toBe(CardStatus.DA_RIVEDERE);
    expect(rules(verdict)).toEqual([
      `${ExtractionRule.titoloTroppoLungo}@titolo`,
      `${ExtractionRule.passiOrdineNonContiguo}@passi`,
      `${ExtractionRule.costoImportoNegativo}@costi[0].importoCent`,
      `${ExtractionRule.costoValutaNonIso}@costi[0].valuta`,
      `${ExtractionRule.confidenzaBassa}@_meta.confidenzaGlobale`,
      `${ExtractionRule.tipoNonProcedura}@_meta.tipoRilevato`,
    ]);
  });

  it("un problema bloccante annulla il verdetto anche in mezzo ad altri", () => {
    const verdict = validateExtraction(
      buildExtractionContract({
        titolo: "",
        passi: [],
        costi: [{ descrizione: "X", importoCent: -1, valuta: "EUR" }],
      }),
    );

    expect(verdict.outcome).toBe("RIFIUTATA");
    expect(verdict.contract).toBeNull();
    // Gli issue non bloccanti restano visibili: servono a capire cos'altro
    // c'era che non andava, senza dover riprocessare.
    expect(rules(verdict)).toContain(`${ExtractionRule.passiVuoti}@passi`);
  });
});

describe("normalizeSteps", () => {
  it("rinumera da 1 conservando l'ordine relativo", () => {
    const passi = normalizeSteps([
      { ordine: 3, azione: "terzo", dettaglio: null, durataStimataMin: null },
      { ordine: 1, azione: "primo", dettaglio: null, durataStimataMin: null },
      { ordine: 7, azione: "ultimo", dettaglio: null, durataStimataMin: null },
    ]);

    expect(passi.map((p) => [p.ordine, p.azione])).toEqual([
      [1, "primo"],
      [2, "terzo"],
      [3, "ultimo"],
    ]);
  });

  it("e' stabile fra passi con lo stesso ordine", () => {
    // Due passi numerati 1 devono restare nell'ordine in cui il modello li ha
    // scritti: e' l'unica informazione di sequenza rimasta.
    const passi = normalizeSteps([
      { ordine: 1, azione: "prima cosa", dettaglio: null, durataStimataMin: null },
      { ordine: 1, azione: "seconda cosa", dettaglio: null, durataStimataMin: null },
      { ordine: 2, azione: "terza cosa", dettaglio: null, durataStimataMin: null },
    ]);

    expect(passi.map((p) => p.azione)).toEqual(["prima cosa", "seconda cosa", "terza cosa"]);
    expect(passi.map((p) => p.ordine)).toEqual([1, 2, 3]);
  });

  it("conserva ogni altro campo del passo", () => {
    const passi = normalizeSteps([
      { ordine: 9, azione: "unico", dettaglio: "con dettaglio", durataStimataMin: 15 },
    ]);

    expect(passi).toEqual([
      { ordine: 1, azione: "unico", dettaglio: "con dettaglio", durataStimataMin: 15 },
    ]);
  });

  it("non modifica l'array ricevuto", () => {
    const originali = [
      { ordine: 5, azione: "uno", dettaglio: null, durataStimataMin: null },
    ];
    normalizeSteps(originali);

    expect(originali[0]?.ordine).toBe(5);
  });

  it("rende contiguo cio' che non lo era, senza altri rilievi", () => {
    // La prova che rinumerare basta: dopo normalizeSteps la stessa estrazione
    // che aveva un issue di contiguita' non ne ha piu'.
    const rotto = buildExtractionContract({
      passi: [
        { ordine: 1, azione: "uno", dettaglio: null, durataStimataMin: null },
        { ordine: 4, azione: "quattro", dettaglio: null, durataStimataMin: null },
      ],
    });

    expect(validateExtraction(rotto).issues).toHaveLength(1);
    expect(
      validateExtraction({ ...rotto, passi: normalizeSteps(rotto.passi) }).issues,
    ).toEqual([]);
  });
});

describe("gravita delle trappole", () => {
  it("una trappola BLOCCANTE non blocca la creazione della scheda", () => {
    // Distinzione che vale la pena fissare: `Severity.BLOCCANTE` descrive il
    // mondo (quel passaggio ha fermato l'utente), `issue.blocking` descrive la
    // pipeline. Sono due cose diverse con lo stesso nome.
    const verdict = validateExtraction(
      buildExtractionContract({
        trappole: [{ descrizione: "Lo sportello chiude alle 12", gravita: Severity.BLOCCANTE }],
      }),
    );

    expect(verdict.outcome).toBe("ACCETTATA");
    expect(verdict.cardStatus).toBe(CardStatus.COMPLETA);
  });
});
