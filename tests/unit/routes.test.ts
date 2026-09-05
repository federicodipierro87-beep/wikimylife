import { describe, expect, it } from "vitest";
import { HOME, parseHash, toHash, type Route } from "../../apps/web/src/routes.js";

/**
 * Le rotte della PWA.
 *
 * Sono trenta righe di codice, ma sono anche il punto in cui un id con un
 * carattere strano dentro produce una schermata bianca invece di una scheda.
 * Il giro completo — rotta, hash, rotta — e' l'unica prova che conta.
 */

const ROTTE: readonly Route[] = [
  { name: "lista" },
  { name: "registra" },
  { name: "cerca" },
  { name: "scheda", id: "cku123" },
  { name: "revisione", id: "cku123" },
];

describe("toHash / parseHash", () => {
  it.each(ROTTE)("va e torna: $name", (route) => {
    expect(parseHash(toHash(route))).toEqual(route);
  });

  it("sopravvive a un id che ha bisogno di essere codificato", () => {
    // Gli id sono cuid e non hanno caratteri strani, oggi. Domani potrebbero.
    const route: Route = { name: "scheda", id: "a/b c#d" };

    expect(parseHash(toHash(route))).toEqual(route);
  });

  it("un hash sconosciuto porta a casa invece che in una schermata bianca", () => {
    expect(parseHash("#/qualcosa-che-non-esiste")).toEqual(HOME);
  });

  it("l'hash vuoto e' la home", () => {
    expect(parseHash("")).toEqual(HOME);
    expect(parseHash("#")).toEqual(HOME);
    expect(parseHash("#/")).toEqual(HOME);
  });

  it("una scheda senza id non e' una scheda", () => {
    // Senza questo, `#/scheda` aprirebbe il dettaglio di `undefined` e
    // chiederebbe al server una risorsa che non puo' esistere.
    expect(parseHash("#/scheda")).toEqual(HOME);
  });

  it("tollera lo slash finale", () => {
    expect(parseHash("#/cerca/")).toEqual({ name: "cerca" });
  });
});
