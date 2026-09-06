import {
  PrereqType,
  RefType,
  Severity,
  Visibility,
  redactionReportSchema,
} from "@wikimylife/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../../apps/api/src/providers/fake/index.js";
import {
  createProceduresService,
  type ProceduresService,
} from "../../apps/api/src/services/procedures.service.js";
import { campiRedigibili } from "../../apps/api/src/services/redaction/proposals.js";
import { FixedClock } from "../support/FixedClock.js";
import { InMemoryProcedureRepository } from "../support/InMemoryProcedureRepository.js";

/**
 * La passata di redazione della §9, dal lato del servizio.
 *
 * `redaction.test.ts` prova che i rilevatori riconoscano un IBAN. Qui si prova
 * cio' che i rilevatori non possono sapere: quali pezzi di una scheda si
 * guardano, che una conferma valga per il testo che l'utente ha guardato e non
 * per un altro, e che dopo la redazione la scheda non resti cercabile per il
 * dato che le e' stato tolto.
 *
 * Il codice fiscale usato ovunque e' `MRTMTT25D09F205Z`, l'esempio pubblico
 * dell'Agenzia delle Entrate: ha il carattere di controllo giusto, quindi passa
 * il checksum, e non e' di nessuno.
 */

const USER = "user-1";
const NOW = new Date("2026-06-01T12:00:00.000Z");

const CF = "MRTMTT25D09F205Z";
const IBAN = "IT60 X054 2811 1010 0000 0123 456";

interface Harness {
  readonly repo: InMemoryProcedureRepository;
  readonly service: ProceduresService;
}

function harness(): Harness {
  const repo = new InMemoryProcedureRepository();
  return {
    repo,
    service: createProceduresService({
      repo,
      embeddings: new FakeEmbeddingProvider({ model: "fake", dimensions: 1536 }),
      clock: new FixedClock(NOW),
    }),
  };
}

let h: Harness;

beforeEach(() => {
  h = harness();
});

/** Gli id delle proposte, che e' l'unica cosa che la POST accetta. */
async function conferme(id: string): Promise<string[]> {
  const report = await h.service.proposeRedaction(USER, id);
  return report.proposte.map((p) => p.id);
}

describe("campiRedigibili — cosa si guarda e cosa no", () => {
  it("guarda i campi liberi della scheda, in ordine di lettura", () => {
    const row = h.repo.seed({
      userId: USER,
      titolo: "Titolo",
      trigger: "Quando",
      esito: "Cosa",
      luogoNome: "Ufficio",
      steps: [{ id: "s1", ordine: 1, azione: "Azione", dettaglio: "Dettaglio", durataStimataMin: null }],
      refs: [{ id: "r1", tipo: RefType.TELEFONO, valore: "02 1234 5678" }],
    });

    expect(campiRedigibili(row).map((c) => c.campo)).toEqual([
      "titolo",
      "trigger",
      "esito",
      "luogoNome",
      "steps.0.azione",
      "steps.0.dettaglio",
      "refs.0.valore",
    ]);
  });

  it("salta i campi vuoti invece di proporre un campo senza testo", () => {
    const row = h.repo.seed({ userId: USER, titolo: "Solo il titolo", trigger: "", esito: null });

    expect(campiRedigibili(row).map((c) => c.campo)).toEqual(["titolo"]);
  });

  it("non guarda le trascrizioni delle registrazioni", () => {
    // La trascrizione e' il verbale di cio' che l'utente ha detto, non un campo
    // della scheda: riscriverla farebbe perdere la corrispondenza fra l'audio e
    // il suo testo, che e' l'unico modo di capire da dove e' uscita una scheda
    // sbagliata. La §9 parla di cio' che si condivide, e cio' che si condivide
    // e' la scheda.
    const row = h.repo.seed({
      userId: USER,
      titolo: "Titolo pulito",
      recordings: [
        { id: "rec-1", recordedAt: NOW, durationMs: 1000, transcript: `Il mio codice e' ${CF}` },
      ],
    });

    expect(campiRedigibili(row).map((c) => c.campo)).toEqual(["titolo"]);
  });
});

describe("proposeRedaction", () => {
  it("propone e non tocca niente", async () => {
    const row = h.repo.seed({ userId: USER, titolo: `Pratica di ${CF}` });

    const report = await h.service.proposeRedaction(USER, row.id);

    expect(redactionReportSchema.parse(report)).toEqual(report);
    expect(report.proposte).toHaveLength(1);
    expect(report.proposte[0]?.valore).toBe(CF);
    expect(h.repo.snapshot(row.id).titolo).toBe(`Pratica di ${CF}`);
    expect(h.repo.lastUpdate).toBeNull();
  });

  it("dice in quale campo, con l'etichetta che l'interfaccia puo' mostrare", async () => {
    const row = h.repo.seed({
      userId: USER,
      steps: [
        { id: "s1", ordine: 1, azione: "Presentarsi allo sportello", dettaglio: null, durataStimataMin: null },
        { id: "s2", ordine: 2, azione: `Dettare il codice ${CF}`, dettaglio: null, durataStimataMin: null },
      ],
    });

    const [proposta] = (await h.service.proposeRedaction(USER, row.id)).proposte;

    expect(proposta?.campo).toBe("steps.1.azione");
    expect(proposta?.etichetta).toBe("Passo 2 — azione");
  });

  it("include il contesto con il dato ancora dentro", async () => {
    // Confermare guardando solo il dato estratto dal suo contesto significa
    // confermare alla cieca: e' nel contesto che si vede se quel numero era un
    // cellulare o un centralino.
    const row = h.repo.seed({
      userId: USER,
      esito: `Ricevi la ricevuta all'indirizzo mario.rossi@example.com entro tre giorni`,
    });

    const [proposta] = (await h.service.proposeRedaction(USER, row.id)).proposte;

    expect(proposta?.contesto).toContain("mario.rossi@example.com");
    expect(proposta?.contesto).toContain("entro tre giorni");
  });

  it("propone anche i riferimenti di tipo TELEFONO", async () => {
    // Un `TELEFONO` che contiene un numero di telefono non e' un errore, e'
    // cio' che quel campo e'. Proporlo lo stesso e' giusto: il centralino di un
    // ufficio si condivide, il cellulare della persona che ci lavora no, e la
    // differenza non la puo' vedere una regex.
    const row = h.repo.seed({
      userId: USER,
      refs: [{ id: "r1", tipo: RefType.TELEFONO, valore: "+39 333 1234567" }],
    });

    const report = await h.service.proposeRedaction(USER, row.id);

    expect(report.proposte.map((p) => p.campo)).toEqual(["refs.0.valore"]);
  });

  it("propone su qualsiasi scheda, anche senza il flag", async () => {
    // Il flag dice cosa ha pensato l'estrazione, non cosa c'e' nel testo: una
    // scheda scritta a mano non passa dall'estrazione e non ha mai il flag.
    const row = h.repo.seed({ userId: USER, titolo: `Pratica ${CF}`, contieneDatiSensibili: false });

    const report = await h.service.proposeRedaction(USER, row.id);

    expect(report.contieneDatiSensibili).toBe(false);
    expect(report.proposte).toHaveLength(1);
  });

  it("torna una lista vuota su una scheda pulita", async () => {
    const row = h.repo.seed({ userId: USER, titolo: "Rinnovare il passaporto" });

    expect((await h.service.proposeRedaction(USER, row.id)).proposte).toEqual([]);
  });

  it("non esiste per chi non e' il proprietario", async () => {
    const row = h.repo.seed({ userId: USER, titolo: `Pratica ${CF}` });

    await expect(h.service.proposeRedaction("user-2", row.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("applyRedaction — solo cio' che e' stato confermato", () => {
  it("sostituisce il dato confermato e lascia stare gli altri", async () => {
    const row = h.repo.seed({
      userId: USER,
      titolo: `Pratica di ${CF}`,
      esito: "Scrivere a mario.rossi@example.com",
    });

    const report = await h.service.proposeRedaction(USER, row.id);
    const soloEmail = report.proposte.filter((p) => p.kind === "EMAIL").map((p) => p.id);

    const scheda = await h.service.applyRedaction(USER, row.id, { conferme: soloEmail });

    expect(scheda.esito).toBe("Scrivere a [email]");
    expect(scheda.titolo).toBe(`Pratica di ${CF}`);
  });

  it("redige piu' campi in una volta sola", async () => {
    const row = h.repo.seed({
      userId: USER,
      titolo: `Pratica di ${CF}`,
      trigger: `Serve quando l'IBAN e' ${IBAN}`,
      prereqs: [
        {
          id: "p1",
          descrizione: "Chiamare il 333 1234567",
          tipo: PrereqType.ALTRO,
          obbligatorio: true,
        },
      ],
    });

    const scheda = await h.service.applyRedaction(USER, row.id, {
      conferme: await conferme(row.id),
    });

    expect(scheda.titolo).toBe("Pratica di [codice fiscale]");
    expect(scheda.trigger).toBe("Serve quando l'IBAN e' [IBAN]");
    expect(scheda.prereqs[0]?.descrizione).toBe("Chiamare il [telefono]");
  });

  it("manda gli array figli interi, non solo gli elementi toccati", async () => {
    // La PATCH sostituisce gli array per intero: mandare solo il passo redatto
    // cancellerebbe gli altri. E' il dettaglio che non si vede finche' la
    // scheda non ha piu' di un passo.
    const row = h.repo.seed({
      userId: USER,
      steps: [
        { id: "s1", ordine: 1, azione: "Prendere appuntamento", dettaglio: null, durataStimataMin: 10 },
        { id: "s2", ordine: 2, azione: `Dettare ${CF}`, dettaglio: null, durataStimataMin: null },
        { id: "s3", ordine: 3, azione: "Ritirare la ricevuta", dettaglio: null, durataStimataMin: null },
      ],
    });

    const scheda = await h.service.applyRedaction(USER, row.id, {
      conferme: await conferme(row.id),
    });

    expect(scheda.steps.map((s) => s.azione)).toEqual([
      "Prendere appuntamento",
      "Dettare [codice fiscale]",
      "Ritirare la ricevuta",
    ]);
    expect(scheda.steps[0]?.durataStimataMin).toBe(10);
  });

  it("non lascia la scheda cercabile per il dato che le e' stato tolto", async () => {
    // La ragione per cui la redazione passa dalla PATCH invece di scrivere
    // dritta sul repository: `searchText` si ricalcola, e una scheda redatta
    // smette davvero di essere raggiungibile con quel codice fiscale.
    const row = h.repo.seed({ userId: USER, titolo: `Pratica di ${CF}` });

    await h.service.applyRedaction(USER, row.id, { conferme: await conferme(row.id) });

    expect(h.repo.lastUpdate?.searchText).not.toContain(CF);
    expect(h.repo.lastUpdate?.searchText).toContain("Pratica");
  });

  it("rifiuta una conferma che non corrisponde piu' a niente", async () => {
    const row = h.repo.seed({ userId: USER, titolo: `Pratica di ${CF}` });
    const validi = await conferme(row.id);

    await expect(
      h.service.applyRedaction(USER, row.id, { conferme: [...validi, "titolo:999:IBAN"] }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("non applica nemmeno le conferme buone quando una non si ritrova", async () => {
    // Tutto o niente: se il testo e' cambiato, gli offset delle altre conferme
    // valgono per una versione della scheda che non esiste piu'.
    const row = h.repo.seed({ userId: USER, titolo: `Pratica di ${CF}` });
    const validi = await conferme(row.id);

    await expect(
      h.service.applyRedaction(USER, row.id, { conferme: [...validi, "esito:0:EMAIL"] }),
    ).rejects.toThrow();

    expect(h.repo.snapshot(row.id).titolo).toBe(`Pratica di ${CF}`);
    expect(h.repo.lastUpdate).toBeNull();
  });

  it("fallisce se la scheda e' cambiata fra la proposta e la conferma", async () => {
    // Il caso vero dietro il test precedente: due schede aperte, una modifica
    // in mezzo, e gli offset che non tornano piu'.
    const row = h.repo.seed({ userId: USER, titolo: `Pratica di ${CF}` });
    const validi = await conferme(row.id);

    await h.service.update(USER, row.id, { titolo: `Nuova pratica di ${CF}` });

    await expect(h.service.applyRedaction(USER, row.id, { conferme: validi })).rejects.toMatchObject(
      { status: 409 },
    );
  });

  it("applicata due volte, la seconda fallisce invece di non fare niente", async () => {
    const row = h.repo.seed({ userId: USER, titolo: `Pratica di ${CF}` });
    const validi = await conferme(row.id);

    await h.service.applyRedaction(USER, row.id, { conferme: validi });

    await expect(h.service.applyRedaction(USER, row.id, { conferme: validi })).rejects.toMatchObject(
      { status: 409 },
    );
  });

  it("non tocca il flag: toglierlo resta una decisione di una persona", async () => {
    // La §9 chiede «una revisione esplicita». Togliere il flag perche' i
    // rilevatori non trovano piu' niente vorrebbe dire far dichiarare alle
    // regex che la scheda e' pulita, quando l'unica cosa che sanno e' che non
    // riconoscono piu' i quattro formati che conoscono. Il nome dell'ex moglie
    // di un cliente non ha un checksum.
    const row = h.repo.seed({
      userId: USER,
      titolo: `Pratica di ${CF}`,
      contieneDatiSensibili: true,
    });

    const scheda = await h.service.applyRedaction(USER, row.id, {
      conferme: await conferme(row.id),
    });

    expect(scheda.contieneDatiSensibili).toBe(true);
    await expect(
      h.service.update(USER, row.id, { visibility: Visibility.PUBBLICA }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("dopo la redazione non resta niente da proporre", async () => {
    const row = h.repo.seed({
      userId: USER,
      titolo: `Pratica di ${CF}`,
      pitfalls: [
        { id: "t1", descrizione: "Non scrivere a mario@example.com", gravita: Severity.NOTA },
      ],
    });

    await h.service.applyRedaction(USER, row.id, { conferme: await conferme(row.id) });

    expect((await h.service.proposeRedaction(USER, row.id)).proposte).toEqual([]);
  });

  it("non esiste per chi non e' il proprietario", async () => {
    const row = h.repo.seed({ userId: USER, titolo: `Pratica di ${CF}` });

    await expect(
      h.service.applyRedaction("user-2", row.id, { conferme: ["titolo:11:CODICE_FISCALE"] }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
