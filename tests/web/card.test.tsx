import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { creaClienteFinto } from "./helpers/clienteFinto";
import { unaVoce } from "./helpers/dati";
import { montaConApi } from "./helpers/render";
import { ProcedureCard } from "../../apps/web/src/screens/ProcedureCard";

/**
 * La riga che compare in elenco e in ricerca.
 *
 * E' il componente piu' piccolo con un test proprio, e la ragione e' che compare
 * due volte: `ListScreen` e `SearchScreen` montano la stessa riga, quindi ogni
 * suo difetto e' un difetto in due schermate, ed entrambe hanno gia' i loro casi
 * che guardano *quante* righe ci sono e non cosa c'e' dentro.
 *
 * Non si riprova qui cosa scrivono `badgesOf`, `formatDurata`, `formatCosto` e
 * `formatQuando`: sono funzioni pure e hanno il loro file in
 * `tests/unit/format.test.ts`. Si prova cio' che una funzione pura non puo'
 * dimostrare — che sia questa riga a chiamarle, e che decida bene cosa mostrare
 * e cosa no.
 *
 * ## Il caso che conta
 *
 * La riga porta a una scheda, e l'id che mette nell'hash e' l'unico modo che
 * l'utente ha di arrivarci. Sbagliarlo — mandare l'indice invece dell'id,
 * dimenticare la codifica — produce una riga che si preme, una pagina che si
 * apre, e la scheda sbagliata o un errore: nessuna delle due cose assomiglia a
 * un difetto di questa quindicina di righe.
 */

const NIENTE = creaClienteFinto();

beforeEach(() => {
  window.location.hash = "#/";
});

describe("ProcedureCard: dove porta", () => {
  it("apre la scheda di quella riga, e non di un'altra", async () => {
    montaConApi(NIENTE, <ProcedureCard p={unaVoce({ id: "proc-42" })} />);

    await userEvent.setup().click(screen.getByRole("button"));

    expect(window.location.hash).toBe("#/scheda/proc-42");
  });

  it("un id con caratteri da codificare arriva intero", async () => {
    // Gli id li fa il server e oggi sono cuid, ma l'hash e' un posto dove uno
    // slash o uno spazio cambiano la rotta invece del parametro: la codifica
    // qui e' l'unica cosa che separa «scheda a/b» da «scheda a, sezione b».
    montaConApi(NIENTE, <ProcedureCard p={unaVoce({ id: "a b/c" })} />);

    await userEvent.setup().click(screen.getByRole("button"));

    expect(window.location.hash).toBe(`#/scheda/${encodeURIComponent("a b/c")}`);
  });

  it("e' un pulsante, quindi ci si arriva anche senza toccare lo schermo", () => {
    montaConApi(NIENTE, <ProcedureCard p={unaVoce()} />);

    // Un `<div onClick>` sarebbe identico a vedersi e irraggiungibile da
    // tastiera e da lettore di schermo, senza che niente lo segnali.
    expect(screen.getByRole("button")).toBeTruthy();
  });
});

describe("ProcedureCard: i bollini", () => {
  it("una scheda senza niente da segnalare non porta un contenitore vuoto", () => {
    const { container } = montaConApi(NIENTE, <ProcedureCard p={unaVoce()} />);

    // Il contenitore e non i bollini: `.riga__badge` ha una spaziatura sua, e
    // vuoto lascerebbe un buco in mezzo a ogni riga dell'elenco senza che
    // nessuno colleghi quel buco a questa condizione.
    expect(container.querySelector(".riga__badge")).toBeNull();
  });

  it("e quando c'e' qualcosa da segnalare lo segnala, col suo tipo addosso", () => {
    const { container } = montaConApi(
      NIENTE,
      <ProcedureCard p={unaVoce({ status: "DA_RIVEDERE", obsoleta: true })} />,
    );

    const contenitore = container.querySelector(".riga__badge");
    expect(contenitore).not.toBeNull();
    // La classe e non solo il testo: il colore e' cio' che distingue «da
    // rivedere» da «da verificare» a colpo d'occhio in una lista lunga, e una
    // classe sbagliata li rende due etichette grigie identiche.
    expect(container.querySelector(".badge--revisione")?.textContent).toBe("Da rivedere");
    expect(container.querySelector(".badge--obsoleta")?.textContent).toBe("Da verificare");
  });
});

describe("ProcedureCard: cosa dice della scheda", () => {
  it("il trigger c'e' solo quando c'e'", () => {
    const senza = montaConApi(NIENTE, <ProcedureCard p={unaVoce({ trigger: null })} />);
    expect(senza.container.querySelector(".riga__trigger")).toBeNull();

    const con = montaConApi(
      NIENTE,
      <ProcedureCard p={unaVoce({ trigger: "Mi hanno chiesto il certificato" })} />,
    );
    expect(con.container.querySelector(".riga__trigger")?.textContent).toBe(
      "Mi hanno chiesto il certificato",
    );
  });

  it("la riga di mezzo salta cio' che manca invece di scrivere dei vuoti", () => {
    const { container } = montaConApi(
      NIENTE,
      <ProcedureCard
        p={unaVoce({
          numeroPassi: 3,
          durataStimataMin: null,
          costoTotaleCent: null,
          luogoNome: null,
        })}
      />,
    );

    // Un `join` fatto senza il filtro produce "3 passi ·  ·  · · 2 mesi fa",
    // che e' una riga che sembra rotta su ogni scheda a cui manca qualcosa —
    // cioe' sulla maggioranza.
    const meta = container.querySelector(".riga__meta")?.textContent ?? "";
    expect(meta.startsWith("3 passi · ")).toBe(true);
    expect(meta).not.toContain("·  ·");
  });

  it("zero passi non si scrive: «0 passi» direbbe vuota una scheda che non lo e'", () => {
    const { container } = montaConApi(NIENTE, <ProcedureCard p={unaVoce({ numeroPassi: 0 })} />);

    expect(container.querySelector(".riga__meta")?.textContent).not.toContain("passi");
  });

  it("le categorie si vedono, tutte e nel loro ordine", () => {
    const { container } = montaConApi(
      NIENTE,
      <ProcedureCard p={unaVoce({ tag: ["casa", "burocrazia"] })} />,
    );

    const categorie = container.querySelectorAll(".riga__categorie .chip");
    expect([...categorie].map((c) => c.textContent)).toEqual(["casa", "burocrazia"]);
  });

  it("una scheda senza categorie non porta un contenitore vuoto", () => {
    const { container } = montaConApi(NIENTE, <ProcedureCard p={unaVoce({ tag: [] })} />);

    // Come per i bollini: `.riga__categorie` ha una spaziatura sua, e le schede
    // senza categorie sono la maggioranza — un buco su quasi tutte le righe
    // dell'elenco che nessuno collegherebbe a questa condizione.
    expect(container.querySelector(".riga__categorie")).toBeNull();
  });

  it("le categorie non sono premibili, perche' la riga intera e' gia' un pulsante", () => {
    const { container } = montaConApi(
      NIENTE,
      <ProcedureCard p={unaVoce({ tag: ["casa", "burocrazia"] })} />,
    );

    // Un `<button>` dentro un `<button>` e' HTML non valido, e ogni browser
    // inventa il suo comportamento: quello piu' probabile e' che premere la
    // categoria non apra piu' la scheda. Si contano i pulsanti di tutta la
    // riga, non si cercano quelli dentro le categorie: e' l'unico modo perche'
    // il caso cada anche se le chip venissero disegnate altrove nella riga.
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("«Dati sensibili» compare solo su chi ce li ha", () => {
    const con = montaConApi(
      NIENTE,
      <ProcedureCard p={unaVoce({ contieneDatiSensibili: true })} />,
    );
    expect(within(con.container).getByText("Dati sensibili")).toBeTruthy();

    const senza = montaConApi(
      NIENTE,
      <ProcedureCard p={unaVoce({ contieneDatiSensibili: false })} />,
    );
    // Il verso che conta di piu' e' questo: un avviso di dati sensibili su ogni
    // riga smette di volere dire qualcosa entro il secondo giorno.
    expect(within(senza.container).queryByText("Dati sensibili")).toBeNull();
  });
});
