import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAsync } from "../../apps/web/src/useAsync";

/**
 * I due modi di rileggere, e la differenza che conta fra loro.
 *
 * `ricarica` passa da `attesa`, e ci sono schermate che si appoggiano a quel
 * passaggio per smontare cio' che stava sotto. `aggiorna` no, ed e' fatto per
 * il polling. Ogni caso qui ha il suo gemello dall'altra parte: provare solo
 * che `aggiorna` tiene il dato non direbbe niente se anche `ricarica`
 * cominciasse a tenerlo.
 */

/** Una promessa che si risolve quando lo decide il test. */
function rinviata<T>(): {
  promessa: Promise<T>;
  risolvi: (valore: T) => void;
  rifiuta: (errore: unknown) => void;
} {
  let risolvi: (valore: T) => void = () => {};
  let rifiuta: (errore: unknown) => void = () => {};
  const promessa = new Promise<T>((ok, ko) => {
    risolvi = ok;
    rifiuta = ko;
  });
  return { promessa, risolvi, rifiuta };
}

/** Un `fn` che a ogni chiamata restituisce la prossima promessa della fila. */
function aFila<T>(): {
  fn: () => Promise<T>;
  chiamate: () => number;
  ultima: () => ReturnType<typeof rinviata<T>>;
} {
  const fila: ReturnType<typeof rinviata<T>>[] = [];
  return {
    fn: () => {
      const r = rinviata<T>();
      fila.push(r);
      return r.promessa;
    },
    chiamate: () => fila.length,
    ultima: () => {
      const r = fila[fila.length - 1];
      if (r === undefined) {
        throw new Error("nessuna chiamata ancora");
      }
      return r;
    },
  };
}

async function montatoCon(valore: string) {
  const fila = aFila<string>();
  const hook = renderHook(() => useAsync(fila.fn, []));
  await act(async () => {
    fila.ultima().risolvi(valore);
  });
  expect(hook.result.current.stato).toEqual({ kind: "pronto", dato: valore });
  return { fila, hook };
}

describe("useAsync: rileggere", () => {
  it("aggiorna tiene il dato vecchio finche' non arriva il nuovo", async () => {
    const { fila, hook } = await montatoCon("vecchio");

    act(() => {
      hook.result.current.aggiorna();
    });
    await waitFor(() => {
      expect(fila.chiamate()).toBe(2);
    });
    expect(hook.result.current.stato).toEqual({ kind: "pronto", dato: "vecchio" });

    await act(async () => {
      fila.ultima().risolvi("nuovo");
    });
    expect(hook.result.current.stato).toEqual({ kind: "pronto", dato: "nuovo" });
  });

  it("ricarica invece passa da attesa, e chi ci si appoggia per smontare lo trova", async () => {
    const { fila, hook } = await montatoCon("vecchio");

    act(() => {
      hook.result.current.ricarica();
    });
    await waitFor(() => {
      expect(fila.chiamate()).toBe(2);
    });
    expect(hook.result.current.stato).toEqual({ kind: "attesa" });
  });

  it("un aggiorna che fallisce lascia il dato che c'era", async () => {
    // Un buco di rete fra due giri di polling non dice che il dato e' sbagliato.
    const { fila, hook } = await montatoCon("vecchio");

    act(() => {
      hook.result.current.aggiorna();
    });
    await act(async () => {
      fila.ultima().rifiuta(new Error("rete giu'"));
    });
    expect(hook.result.current.stato).toEqual({ kind: "pronto", dato: "vecchio" });
  });

  it("un aggiorna che fallisce prima di qualunque dato diventa un errore, non un'attesa infinita", async () => {
    // Non c'e' niente da tenere: tenere «cio' che c'era» vorrebbe dire tenere
    // l'`attesa`, cioe' un «Carico…» che non finisce mai.
    const fila = aFila<string>();
    const hook = renderHook(() => useAsync(fila.fn, []));

    act(() => {
      hook.result.current.aggiorna();
    });
    await waitFor(() => {
      expect(fila.chiamate()).toBe(2);
    });
    await act(async () => {
      fila.ultima().rifiuta(new Error("rete giu'"));
    });

    expect(hook.result.current.stato.kind).toBe("errore");
  });

  it("un ricarica che fallisce diventa un errore", async () => {
    const { fila, hook } = await montatoCon("vecchio");

    act(() => {
      hook.result.current.ricarica();
    });
    await act(async () => {
      fila.ultima().rifiuta(new Error("rete giu'"));
    });
    expect(hook.result.current.stato.kind).toBe("errore");
  });

  it("cambiate le dipendenze, aggiorna non tiene la risposta a un'altra domanda", async () => {
    // Un `aggiorna` del polling e un cambio di filtro possono arrivare
    // all'effetto nello stesso giro: tenere il dato vorrebbe dire mostrare la
    // pagina di prima sotto il filtro nuovo.
    // Una freccia nuova a ogni render, come nelle schermate: `useCallback`
    // restituisce la funzione che riceve, e passandogli sempre `fila.fn` le
    // dipendenze cambierebbero senza che la richiesta cambi identita'.
    const fila = aFila<string>();
    const hook = renderHook(({ chiave }) => useAsync(() => fila.fn(), [chiave]), {
      initialProps: { chiave: "a" },
    });
    await act(async () => {
      fila.ultima().risolvi("risposta ad a");
    });

    act(() => {
      hook.result.current.aggiorna();
      hook.rerender({ chiave: "b" });
    });

    expect(hook.result.current.stato).toEqual({ kind: "attesa" });
  });

  it("e passato il cambio, aggiorna torna a tenere il dato", async () => {
    // Se la richiesta di riferimento restasse quella del primo montaggio, dopo
    // il primo cambio di filtro ogni `aggiorna` diventerebbe una `ricarica`, e
    // il polling tornerebbe a smontare tutto senza che niente lo dica.
    const fila = aFila<string>();
    const hook = renderHook(({ chiave }) => useAsync(() => fila.fn(), [chiave]), {
      initialProps: { chiave: "a" },
    });
    await act(async () => {
      fila.ultima().risolvi("risposta ad a");
    });
    hook.rerender({ chiave: "b" });
    await act(async () => {
      fila.ultima().risolvi("risposta a b");
    });

    act(() => {
      hook.result.current.aggiorna();
    });

    expect(hook.result.current.stato).toEqual({ kind: "pronto", dato: "risposta a b" });
  });
});
