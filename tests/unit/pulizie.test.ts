import { describe, expect, it } from "vitest";
import { PULIZIA_IP_OGNI_MS, creaPuliziaPeriodica } from "../../apps/worker/src/pulizie.js";

/**
 * La pulizia a tempo degli indirizzi IP, fuori dal ciclo del worker.
 *
 * Due cose possono sbagliarsi senza che niente lo dica: che non passi mai (e
 * gli indirizzi restano per settimane, contro quanto dice la pagina della
 * privacy), o che passi a ogni giro (e un database irraggiungibile diventa un
 * tentativo ogni cinque secondi). Ogni caso ha il suo opposto.
 */

const OGNI = 10_000;

function attrezzo(lavoro: () => Promise<void> = () => Promise.resolve()) {
  let ora = 0;
  let passate = 0;
  const errori: unknown[] = [];
  const pulizia = creaPuliziaPeriodica({
    ogniMs: OGNI,
    adesso: () => ora,
    lavoro: async () => {
      passate += 1;
      await lavoro();
    },
    onErrore: (error) => {
      errori.push(error);
    },
  });
  return {
    pulizia,
    passate: () => passate,
    errori,
    avanza: (ms: number) => {
      ora += ms;
    },
    vaiA: (ms: number) => {
      ora = ms;
    },
  };
}

describe("la pulizia periodica del worker", () => {
  it("passa subito, al primo giro dopo l'avvio", async () => {
    // Un deploy non deve spostare la prossima pulizia di un intervallo intero.
    const a = attrezzo();

    await a.pulizia.forse();

    expect(a.passate()).toBe(1);
  });

  it("non ripassa prima che sia trascorso l'intervallo", async () => {
    const a = attrezzo();
    await a.pulizia.forse();

    a.avanza(OGNI - 1);
    await a.pulizia.forse();

    expect(a.passate()).toBe(1);
  });

  it("ripassa appena l'intervallo e' trascorso", async () => {
    const a = attrezzo();
    await a.pulizia.forse();

    a.avanza(OGNI);
    await a.pulizia.forse();

    expect(a.passate()).toBe(2);
  });

  it("un fallimento finisce nel registro e non lancia", async () => {
    const guasto = new Error("database irraggiungibile");
    const a = attrezzo(() => Promise.reject(guasto));

    await expect(a.pulizia.forse()).resolves.toBeUndefined();

    expect(a.errori).toEqual([guasto]);
  });

  it("e dopo un fallimento aspetta l'intervallo come dopo un successo", async () => {
    const a = attrezzo(() => Promise.reject(new Error("giu'")));
    await a.pulizia.forse();

    a.avanza(5_000);
    await a.pulizia.forse();

    expect(a.passate()).toBe(1);
  });

  it("l'intervallo si conta dalla fine della passata, non dall'inizio", async () => {
    // Una passata lenta che finisce a ridosso della successiva non deve
    // ripartire subito.
    let attrezzoLento: ReturnType<typeof attrezzo> | undefined;
    attrezzoLento = attrezzo(async () => {
      attrezzoLento?.avanza(3_000);
    });
    await attrezzoLento.pulizia.forse();

    attrezzoLento.vaiA(OGNI + 1_000);
    await attrezzoLento.pulizia.forse();

    expect(attrezzoLento.passate()).toBe(1);
  });

  it("l'intervallo vero sta fra la finestra dei tentativi e un quarto d'ora", () => {
    // Sotto il minuto della finestra si cancellerebbe quasi sempre niente; sopra
    // il quarto d'ora «alla pulizia successiva» non e' piu' un tempo che si dice.
    expect(PULIZIA_IP_OGNI_MS).toBeGreaterThanOrEqual(60_000);
    expect(PULIZIA_IP_OGNI_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});
