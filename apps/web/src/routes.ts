/**
 * Le rotte, senza il browser.
 *
 * Sta separato da `router.ts` perche' qui non si tocca `window`: leggere un
 * hash e scriverlo sono due funzioni pure, e come tali si provano in Node senza
 * simulare un DOM. Nel file accanto restano le tre righe che parlano davvero
 * con la barra degli indirizzi.
 *
 * Le rotte sono un'unione discriminata e non stringhe: sbagliare a scrivere
 * "scheda" diventa un errore di compilazione invece di una schermata bianca.
 */

export type Route =
  | { readonly name: "registra" }
  | { readonly name: "lista" }
  | { readonly name: "cerca" }
  | { readonly name: "scheda"; readonly id: string }
  | { readonly name: "revisione"; readonly id: string }
  | { readonly name: "redazione"; readonly id: string };

export const HOME: Route = { name: "lista" };

export function toHash(route: Route): string {
  switch (route.name) {
    case "registra":
      return "#/registra";
    case "lista":
      return "#/";
    case "cerca":
      return "#/cerca";
    case "scheda":
      return `#/scheda/${encodeURIComponent(route.id)}`;
    case "revisione":
      return `#/scheda/${encodeURIComponent(route.id)}/revisione`;
    case "redazione":
      return `#/scheda/${encodeURIComponent(route.id)}/redazione`;
  }
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [primo, secondo, terzo] = parts;

  if (primo === "registra") {
    return { name: "registra" };
  }
  if (primo === "cerca") {
    return { name: "cerca" };
  }
  if (primo === "scheda" && secondo !== undefined) {
    const id = decodeURIComponent(secondo);
    if (terzo === "revisione") {
      return { name: "revisione", id };
    }
    if (terzo === "redazione") {
      return { name: "redazione", id };
    }
    // Un terzo segmento che non si riconosce e' comunque una scheda: sbagliare
    // a scrivere `/redazoine` deve aprire la scheda, non riportare alla lista
    // perdendo anche l'id che era giusto.
    return { name: "scheda", id };
  }
  // Qualsiasi cosa non riconosciuta e' la home. Una schermata "404" dentro
  // un'app di sei pagine sarebbe piu' codice che valore.
  return HOME;
}
