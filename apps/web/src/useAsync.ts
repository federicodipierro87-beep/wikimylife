import { useCallback, useEffect, useRef, useState } from "react";
import { messaggioDi } from "./session";

/**
 * Caricare qualcosa dall'API, con i tre stati che servono e nessuno di piu'.
 *
 * Non e' React Query: qui non c'e' cache condivisa, non c'e' invalidazione fra
 * schermate e non serve — le schermate sono sei e si aprono una alla volta.
 * Sono poche righe contro una dipendenza, e restano poche finche' non esiste un
 * caso che le richieda diverse. Il primo e' stato il polling: `aggiorna`.
 *
 * Il flag `vivo` non e' scaramanzia: senza, tornare indietro mentre una
 * richiesta e' in volo produce un `setState` su un componente smontato, e in
 * `StrictMode` succede a ogni montaggio.
 */

export type Async<T> =
  | { readonly kind: "attesa" }
  | { readonly kind: "pronto"; readonly dato: T }
  | { readonly kind: "errore"; readonly messaggio: string };

export interface AsyncResult<T> {
  readonly stato: Async<T>;
  /**
   * Rilegge passando da `attesa`, per esempio dopo un PATCH.
   *
   * Il passaggio da `attesa` e' una promessa, non un effetto collaterale: le
   * schermate che mostrano un «Carico…» in `attesa` smontano cio' che c'era
   * sotto, e a quello smontaggio si appoggiano. Il dettaglio dopo una modifica,
   * la redazione dopo un 409: e' lo smontaggio ad azzerare i loro stati locali,
   * nati dal dato vecchio. Tenere il dato durante una `ricarica` li lascerebbe
   * in piedi a parlare di una versione che non esiste piu'.
   */
  ricarica(): void;
  /**
   * Rilegge senza togliere niente da sotto gli occhi: finche' il dato nuovo non
   * arriva resta il vecchio, e se il giro fallisce il vecchio resta e basta.
   *
   * E' per i giri che nessuno ha chiesto — il polling — dove chi guarda non
   * ha fatto niente e non deve veder sparire niente. `ricarica` li' smontava
   * ogni cinque secondi i riquadri dei vocali in lavorazione, e con loro la
   * domanda «Elimina davvero» che qualcuno stava leggendo. E un errore non
   * diventa `errore`, perche' un buco di rete fra due giri non dice che il
   * dato e' sbagliato: dice che non se ne ha uno piu' nuovo.
   *
   * Vale solo per lo stesso giro: se nel frattempo sono cambiate le
   * dipendenze, il dato vecchio risponde a un'altra domanda e si passa da
   * `attesa` come sempre.
   */
  aggiorna(): void;
}

interface Giro {
  readonly n: number;
  readonly silenzioso: boolean;
}

export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncResult<T> {
  const [stato, setStato] = useState<Async<T>>({ kind: "attesa" });
  const [giro, setGiro] = useState<Giro>({ n: 0, silenzioso: false });

  // `fn` cambia identita' a ogni render: le dipendenze vere sono quelle
  // dichiarate da chi chiama, che sa cosa rende diversa una richiesta.
  const esegui = useCallback(fn, deps);

  // Quale richiesta ha prodotto il dato che si vede. Un `aggiorna` chiesto
  // prima di un cambio di dipendenze arriva all'effetto insieme a quel cambio,
  // e senza questo confronto terrebbe in pagina la risposta a un'altra domanda.
  const ultimaRichiesta = useRef(esegui);

  useEffect(() => {
    let vivo = true;
    const silenzioso = giro.silenzioso && ultimaRichiesta.current === esegui;
    ultimaRichiesta.current = esegui;
    if (!silenzioso) {
      setStato({ kind: "attesa" });
    }

    esegui()
      .then((dato) => {
        if (vivo) {
          setStato({ kind: "pronto", dato });
        }
      })
      .catch((error: unknown) => {
        if (vivo) {
          // Si tiene solo un `pronto`: tenere un'`attesa` vorrebbe dire un
          // «Carico…» senza fine. Il `silenzioso &&` e' ridondante — fuori da
          // un giro silenzioso lo stato e' gia' stato messo in `attesa` qui
          // sopra, quindi non e' mai `pronto` — e una mutazione che lo toglie
          // sopravvive, dichiarata: resta perche' dice a chi legge di quale
          // giro si parla, non perche' cambi qualcosa.
          setStato((prima) =>
            silenzioso && prima.kind === "pronto"
              ? prima
              : { kind: "errore", messaggio: messaggioDi(error) },
          );
        }
      });

    return () => {
      vivo = false;
    };
  }, [esegui, giro]);

  const ricarica = useCallback((): void => {
    setGiro((g) => ({ n: g.n + 1, silenzioso: false }));
  }, []);

  const aggiorna = useCallback((): void => {
    setGiro((g) => ({ n: g.n + 1, silenzioso: true }));
  }, []);

  return { stato, ricarica, aggiorna };
}
