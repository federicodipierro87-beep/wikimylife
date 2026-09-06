import { useCallback, useEffect, useState } from "react";
import { messaggioDi } from "./session";

/**
 * Caricare qualcosa dall'API, con i tre stati che servono e nessuno di piu'.
 *
 * Non e' React Query: qui non c'e' cache condivisa, non c'e' invalidazione fra
 * schermate e non serve — le schermate sono sei e si aprono una alla volta.
 * Sono venti righe contro una dipendenza, e restano venti righe finche' non
 * esiste un caso che le richieda diverse.
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
  /** Rilegge, per esempio dopo un PATCH. */
  ricarica(): void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncResult<T> {
  const [stato, setStato] = useState<Async<T>>({ kind: "attesa" });
  const [giro, setGiro] = useState(0);

  // `fn` cambia identita' a ogni render: le dipendenze vere sono quelle
  // dichiarate da chi chiama, che sa cosa rende diversa una richiesta.
  const esegui = useCallback(fn, deps);

  useEffect(() => {
    let vivo = true;
    setStato({ kind: "attesa" });

    esegui()
      .then((dato) => {
        if (vivo) {
          setStato({ kind: "pronto", dato });
        }
      })
      .catch((error: unknown) => {
        if (vivo) {
          setStato({ kind: "errore", messaggio: messaggioDi(error) });
        }
      });

    return () => {
      vivo = false;
    };
  }, [esegui, giro]);

  const ricarica = useCallback((): void => {
    setGiro((n) => n + 1);
  }, []);

  return { stato, ricarica };
}
