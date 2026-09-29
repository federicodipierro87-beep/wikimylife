import { render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { BarraBassa } from "../../apps/web/src/App";
import { Icona, type NomeIcona } from "../../apps/web/src/Icona";
import { creaCapturaFinta, montaConCattura } from "./helpers/capturaFinta";

/**
 * La barra in basso e le icone, cioe' le due cose che il restyling ha
 * aggiunto e che non si vedono guardando.
 *
 * ## Perche' le icone vanno provate
 *
 * Un'icona che si vede c'e', e non serve un test per saperlo. Serve per la
 * parte che non si vede: che resti muta per chi usa un lettore di schermo. Se
 * perdesse `aria-hidden`, VoiceOver leggerebbe «immagine» davanti a ogni
 * pulsante dell'app, e nessun test che cerca i pulsanti per nome se ne
 * accorgerebbe — un SVG senza `<title>` non aggiunge niente al nome, aggiunge
 * solo un elemento in piu' da attraversare.
 *
 * ## Perche' la barra si monta da sola
 *
 * Come `NonSalvata`: dentro `App` servirebbero una sessione, un client e un
 * router. Qui serve solo la cattura, per l'indicatore della coda che la barra
 * si porta dietro, e l'hash, che e' dove il router legge la schermata aperta.
 */

const TUTTE: readonly NomeIcona[] = [
  "indietro",
  "avanti",
  "cerca",
  "account",
  "elenco",
  "microfono",
  "stop",
  "cestino",
];

beforeEach(() => {
  window.location.hash = "#/";
});

describe("Icona", () => {
  it.each(TUTTE)("«%s» e' nascosta ai lettori di schermo e fuori dal giro del Tab", (nome) => {
    const { container } = render(<Icona nome={nome} />);
    const svg = container.querySelector("svg");

    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
  });

  it.each(TUTTE)("«%s» disegna qualcosa, e non un riquadro vuoto", (nome) => {
    const { container } = render(<Icona nome={nome} />);

    // L'errore opposto: un'icona muta ma vuota passerebbe il caso sopra, e al
    // suo posto l'utente vedrebbe un buco dentro il pulsante.
    expect(container.querySelector("svg")?.childElementCount).toBeGreaterThan(0);
  });
});

describe("BarraBassa: dove si e'", () => {
  it("sull'elenco la voce Procedure e' la pagina corrente, e Cerca no", () => {
    window.location.hash = "#/";
    const { container } = montaConCattura(creaCapturaFinta(), <BarraBassa />);
    const barra = within(container);

    expect(barra.getByRole("button", { name: "Procedure" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(barra.getByRole("button", { name: "Cerca" }).hasAttribute("aria-current")).toBe(false);
  });

  it("sulla ricerca e' il contrario", () => {
    window.location.hash = "#/cerca";
    const { container } = montaConCattura(creaCapturaFinta(), <BarraBassa />);
    const barra = within(container);

    expect(barra.getByRole("button", { name: "Cerca" }).getAttribute("aria-current")).toBe("page");
    expect(barra.getByRole("button", { name: "Procedure" }).hasAttribute("aria-current")).toBe(
      false,
    );
  });

  // Il pulsante rosso in mezzo non e' una voce di navigazione: e' un gesto.
  // Anche sulla schermata di registrazione non deve dirsi «pagina corrente».
  it.each(["#/account", "#/registra"])(
    "su %s, che non e' una voce della barra, nessuna voce si dice corrente",
    (hash) => {
      window.location.hash = hash;
      const { container } = montaConCattura(creaCapturaFinta(), <BarraBassa />);

      expect(container.querySelectorAll("[aria-current]")).toHaveLength(0);
    },
  );

  it("il pulsante di registrazione ha un nome anche se mostra solo un disegno", () => {
    const { container } = montaConCattura(creaCapturaFinta(), <BarraBassa />);

    expect(within(container).getByRole("button", { name: "Registra" })).toBeTruthy();
  });
});
