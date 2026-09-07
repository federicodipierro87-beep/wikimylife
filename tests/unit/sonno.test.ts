import { describe, expect, it } from "vitest";
import { creaSonno } from "../../apps/worker/src/sonno.js";

/**
 * Il sonno del worker, e la sveglia che lo interrompe.
 *
 * Non ci sono timer finti: quello che questi test devono provare e' proprio il
 * comportamento del timer vero, e in particolare che il processo resti vivo
 * mentre dorme. Le attese sono percio' di pochi millisecondi.
 */

/** Quanto tempo e' passato davvero, non quanto ne era stato chiesto. */
async function cronometra(azione: () => Promise<void>): Promise<number> {
  const inizio = Date.now();
  await azione();
  return Date.now() - inizio;
}

describe("creaSonno", () => {
  it("aspetta, se nessuno lo sveglia", async () => {
    const sonno = creaSonno();
    const trascorso = await cronometra(() => sonno.dormi(50));
    // Con margine verso il basso: i timer di Node scattano puntuali o tardi,
    // mai in anticipo, ma il conto del tempo di sistema puo' arrotondare.
    expect(trascorso).toBeGreaterThanOrEqual(45);
  });

  it("si sveglia subito se glielo si chiede", async () => {
    // La proprieta' che serve al SIGTERM: chi arresta il worker mentre dorme
    // non deve pagare l'intervallo di polling per intero.
    const sonno = creaSonno();
    const trascorso = await cronometra(async () => {
      const dorme = sonno.dormi(10_000);
      sonno.svegliati();
      await dorme;
    });
    expect(trascorso).toBeLessThan(1_000);
  });

  it("tiene vivo il ciclo degli eventi mentre dorme", async () => {
    // Il difetto da cui nasce questo file: con un timer `unref` Node esce da
    // solo durante il primo sonno, perche' mentre il worker aspetta non c'e'
    // nient'altro che lo trattenga. Qui lo si prova al contrario, guardando che
    // l'handle esista e non sia stato staccato dal conteggio.
    const sonno = creaSonno();
    const dorme = sonno.dormi(50);
    const timer = process
      .getActiveResourcesInfo()
      .filter((risorsa) => risorsa === "Timeout");
    expect(timer.length).toBeGreaterThan(0);
    sonno.svegliati();
    await dorme;
  });

  it("svegliare chi non dorme non fa niente", async () => {
    // Il caso di un secondo SIGTERM, o di un arresto chiesto mentre il worker
    // sta elaborando: deve essere un'operazione muta, non un errore.
    const sonno = creaSonno();
    expect(() => sonno.svegliati()).not.toThrow();
    await sonno.dormi(1);
    expect(() => sonno.svegliati()).not.toThrow();
  });

  it("la sveglia di uno non tocca il sonno di un altro", async () => {
    // La ragione per cui e' un oggetto e non due funzioni di modulo: due worker
    // nello stesso processo di test condividerebbero il timer, e il primo che
    // si arresta sveglierebbe l'altro.
    const primo = creaSonno();
    const secondo = creaSonno();

    let secondoSvegliato = false;
    const dormeIlSecondo = secondo.dormi(60).then(() => {
      secondoSvegliato = true;
    });
    const dormeIlPrimo = primo.dormi(10_000);

    primo.svegliati();
    await dormeIlPrimo;
    expect(secondoSvegliato).toBe(false);

    await dormeIlSecondo;
    expect(secondoSvegliato).toBe(true);
  });

  it("la sveglia di ieri non accorcia il sonno di oggi", async () => {
    // Se allo scadere del timer la sveglia non venisse rilasciata, questo
    // `svegliati()` resterebbe appeso al sonno finito e il successivo `dormi`
    // partirebbe da un oggetto gia' consumato. Nel worker si tradurrebbe in un
    // giro di polling ogni pochi millisecondi dopo il primo arresto mancato.
    const sonno = creaSonno();
    await sonno.dormi(1);
    sonno.svegliati();
    const trascorso = await cronometra(() => sonno.dormi(40));
    expect(trascorso).toBeGreaterThanOrEqual(35);
  });
});
