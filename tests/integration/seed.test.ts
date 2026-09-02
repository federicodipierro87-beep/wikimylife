import { DEDUP_COSINE_THRESHOLD } from "@wikimylife/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_IDS } from "../../prisma/seed/config.js";
import { runNodeBin } from "./helpers/bin.js";
import { disconnectTestPrisma, resetDatabase, testDatabaseUrl, testPrisma } from "./helpers/db.js";

/**
 * Il seed, eseguito davvero, sul database di test.
 *
 * Si esegue il comando vero (`tsx prisma/seed.ts`) e non le funzioni importate:
 * cosi' il test copre anche il percorso di configurazione e il fatto che lo
 * script sia eseguibile, che e' meta' di cio' che puo' rompersi in un seed.
 *
 * Le tre invarianti della §5 — `costoTotaleCent`, `volteEseguita`,
 * `ultimaVerifica` — sono denormalizzazioni: nascono duplicando informazione che
 * vive gia' nelle tabelle figlie. Una denormalizzazione ha senso solo finche'
 * qualcuno la tiene allineata, e il seed e' il primo posto in cui puo'
 * disallinearsi. Qui si confrontano i campi con il conteggio effettivo delle
 * righe, non con i numeri attesi scritti a mano: un test che ricopiasse le
 * costanti del seed verificherebbe solo di saper leggere.
 */

const prisma = testPrisma();

function runSeed(): void {
  runNodeBin("tsx", "tsx", ["prisma/seed.ts"], {
    ...process.env,
    DATABASE_URL: testDatabaseUrl(),
  });
}

beforeAll(async () => {
  await resetDatabase();
  runSeed();
}, 120_000);

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("utente di prova", () => {
  it("esiste con la password hashata, mai in chiaro", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: SEED_IDS.user } });

    expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(user.passwordHash).not.toContain("wikimylife-demo-2026");
  });

  it("l'email e' normalizzata in minuscolo", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: SEED_IDS.user } });

    expect(user.email).toBe(user.email.toLowerCase());
  });
});

describe("invariante costoTotaleCent", () => {
  it("e' la somma dei Cost, non un numero scritto a mano", async () => {
    const procedures = await prisma.procedure.findMany({ include: { costs: true } });

    expect(procedures.length).toBeGreaterThan(0);
    for (const p of procedures) {
      const somma = p.costs.reduce((acc, c) => acc + c.importoCent, 0);
      expect(p.costoTotaleCent, `procedura ${p.id}`).toBe(somma);
    }
  });

  it("la procedura A somma 1600 + 380", async () => {
    const a = await prisma.procedure.findUniqueOrThrow({
      where: { id: SEED_IDS.procedureA },
      include: { costs: true },
    });

    expect(a.costs).toHaveLength(2);
    expect(a.costoTotaleCent).toBe(1980);
  });

  it("una procedura senza costi ha totale zero, non null", async () => {
    const b = await prisma.procedure.findUniqueOrThrow({
      where: { id: SEED_IDS.procedureB },
      include: { costs: true },
    });

    expect(b.costs).toHaveLength(0);
    expect(b.costoTotaleCent).toBe(0);
  });
});

describe("invariante volteEseguita", () => {
  it("coincide col numero di Execution", async () => {
    const procedures = await prisma.procedure.findMany({ include: { executions: true } });

    for (const p of procedures) {
      expect(p.volteEseguita, `procedura ${p.id}`).toBe(p.executions.length);
    }
  });

  it("conta anche le esecuzioni che non hanno funzionato", async () => {
    // La procedura B ha una sola Execution, con esito CAMBIATA: e' comunque un
    // tentativo, quindi `volteEseguita` vale 1. Se contasse solo i successi,
    // sarebbe la stessa informazione di `ultimaVerifica` scritta due volte.
    const b = await prisma.procedure.findUniqueOrThrow({
      where: { id: SEED_IDS.procedureB },
      include: { executions: true },
    });

    expect(b.executions).toHaveLength(1);
    expect(b.executions[0]?.esito).toBe("CAMBIATA");
    expect(b.volteEseguita).toBe(1);
  });
});

describe("invariante ultimaVerifica", () => {
  it("e' la piu' recente Execution con esito FUNZIONATO", async () => {
    const procedures = await prisma.procedure.findMany({ include: { executions: true } });

    for (const p of procedures) {
      const successi = p.executions
        .filter((e) => e.esito === "FUNZIONATO")
        .map((e) => e.eseguitaIl.getTime());
      const atteso = successi.length === 0 ? null : new Date(Math.max(...successi));

      expect(p.ultimaVerifica?.getTime() ?? null, `procedura ${p.id}`).toBe(
        atteso?.getTime() ?? null,
      );
    }
  });

  it("una sola esecuzione CAMBIATA lascia la procedura senza data di verifica", async () => {
    // E' la regola della §8 resa osservabile: una procedura eseguita ma
    // "cambiata" non e' verificata. Se `ultimaVerifica` si aggiornasse a ogni
    // Execution, la scheda B sembrerebbe fresca proprio nel momento in cui
    // qualcuno ha scoperto che non funziona piu'.
    const b = await prisma.procedure.findUniqueOrThrow({ where: { id: SEED_IDS.procedureB } });

    expect(b.ultimaVerifica).toBeNull();
    expect(b.status).toBe("DA_RIVEDERE");
  });
});

describe("ordine dei passi", () => {
  it("e' contiguo e parte da 1 in ogni procedura", async () => {
    // La §5 chiede passi contigui. Il rendering della scheda e la
    // riorganizzazione dei passi in Fase 3 lo daranno per scontato: un buco
    // nella numerazione diventerebbe un passo che sparisce dall'interfaccia.
    const procedures = await prisma.procedure.findMany({
      include: { steps: { orderBy: { ordine: "asc" } } },
    });

    for (const p of procedures) {
      const ordini = p.steps.map((s) => s.ordine);
      expect(ordini, `procedura ${p.id}`).toEqual(
        Array.from({ length: p.steps.length }, (_, i) => i + 1),
      );
    }
  });

  it("la procedura A ha cinque passi", async () => {
    const steps = await prisma.step.count({ where: { procedureId: SEED_IDS.procedureA } });
    expect(steps).toBe(5);
  });
});

describe("embedding", () => {
  it("e' popolato per entrambe le procedure con 1536 dimensioni", async () => {
    const rows = await prisma.$queryRaw<{ id: string; dims: number }[]>`
      SELECT id, vector_dims(embedding) AS dims
      FROM "Procedure"
      WHERE embedding IS NOT NULL
      ORDER BY id
    `;

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.dims === 1536)).toBe(true);
  });

  it("i vettori sono unitari", async () => {
    // `<#>` e' il prodotto interno negato: su vettori normalizzati vale -1.
    const rows = await prisma.$queryRaw<{ ip: number }[]>`
      SELECT (embedding <#> embedding) AS ip FROM "Procedure" WHERE embedding IS NOT NULL
    `;

    for (const row of rows) {
      expect(row.ip).toBeCloseTo(-1, 5);
    }
  });

  it("A e B non si somigliano abbastanza da sembrare duplicati", async () => {
    // La soglia di dedup e' 0.85. Se il casellario giudiziale e la VPN
    // aziendale la superassero, il seed dimostrerebbe che la Fase 2 nascera'
    // suggerendo di fondere due procedure che non c'entrano niente.
    const rows = await prisma.$queryRaw<{ similarity: number }[]>`
      SELECT 1 - (a.embedding <=> b.embedding) AS similarity
      FROM "Procedure" a, "Procedure" b
      WHERE a.id = ${SEED_IDS.procedureA} AND b.id = ${SEED_IDS.procedureB}
    `;

    const similarity = rows[0]?.similarity ?? 1;
    expect(similarity).toBeLessThan(DEDUP_COSINE_THRESHOLD);
    expect(Math.abs(similarity)).toBeLessThan(0.2);
  });

  it("una procedura e' identica a se stessa", async () => {
    const rows = await prisma.$queryRaw<{ similarity: number }[]>`
      SELECT 1 - (embedding <=> embedding) AS similarity
      FROM "Procedure" WHERE id = ${SEED_IDS.procedureA}
    `;

    expect(rows[0]?.similarity).toBeCloseTo(1, 5);
  });
});

describe("registrazioni", () => {
  it("quella della procedura A e' ESTRATTO e collegata", async () => {
    const rec = await prisma.recording.findUniqueOrThrow({
      where: { id: SEED_IDS.recordingA },
    });

    expect(rec.status).toBe("ESTRATTO");
    expect(rec.procedureId).toBe(SEED_IDS.procedureA);
    expect(rec.retryCount).toBe(0);
    expect(rec.mimeType).toBeTruthy();
  });

  it("esiste una registrazione orfana in ESTRAZIONE_FALLITA [D2]", async () => {
    // Dieci righe che provano la decisione 2: il ciclo di vita
    // dell'elaborazione sta sulla registrazione, quindi un audio puo' esistere
    // senza scheda. Nel modello originale, dove lo stato stava sulla Procedure,
    // questa riga avrebbe richiesto una Procedure con `titolo` inventato.
    const rec = await prisma.recording.findUniqueOrThrow({
      where: { id: SEED_IDS.recordingOrphan },
    });

    expect(rec.status).toBe("ESTRAZIONE_FALLITA");
    expect(rec.procedureId).toBeNull();
    expect(rec.retryCount).toBe(1);
    expect(rec.lastErrorCode).toBeTruthy();
  });

  it("nessuna Procedure e' nata dall'estrazione fallita", async () => {
    const count = await prisma.procedure.count();
    expect(count).toBe(2);
  });
});

describe("idempotenza", () => {
  it("una seconda esecuzione lascia lo stesso numero di righe", async () => {
    const before = await counts();

    runSeed();

    expect(await counts()).toEqual(before);
  }, 120_000);

  it("e non duplica i tag", async () => {
    // I tag sono l'unico dato del seed condiviso fra procedure diverse: senza
    // `upsert` su `(userId, nome)` la seconda esecuzione ne creerebbe una copia,
    // e nell'interfaccia comparirebbero due "burocrazia" identici.
    const tags = await prisma.tag.findMany({ select: { nome: true } });
    const nomi = tags.map((t) => t.nome);

    expect(new Set(nomi).size).toBe(nomi.length);
  });
});

async function counts(): Promise<Record<string, number>> {
  const [user, procedure, recording, step, execution, cost, tag, tagOnProcedure] =
    await Promise.all([
      prisma.user.count(),
      prisma.procedure.count(),
      prisma.recording.count(),
      prisma.step.count(),
      prisma.execution.count(),
      prisma.cost.count(),
      prisma.tag.count(),
      prisma.tagOnProcedure.count(),
    ]);

  return { user, procedure, recording, step, execution, cost, tag, tagOnProcedure };
}
