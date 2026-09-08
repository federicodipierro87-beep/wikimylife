import type { ApiClient } from "@wikimylife/shared";
import { createContext, useContext } from "react";

/**
 * Il client dell'API, passato invece che importato.
 *
 * Prima questo file costruiva un singleton e ogni schermata se lo prendeva con
 * `import { apiClient } from "../api"`. Funzionava, e aveva un difetto che si
 * vedeva solo provando a scrivere un test: non c'era nessun punto in cui
 * mettere qualcos'altro. Una schermata che importa la propria dipendenza non
 * puo' essere montata senza quella dipendenza, e l'unico modo di aggirarla e'
 * riscrivere il modulo da sotto con `vi.mock` — cioe' agganciare il finto a un
 * percorso di file invece che a un'interfaccia.
 *
 * Dall'altra parte del repository questa cosa e' decisa da sempre:
 * `apps/api/src/composition.ts` costruisce, `app.ts` riceve. Qui e' lo stesso,
 * con `main.tsx` al posto di `composition.ts`. La differenza non e' teorica:
 * l'oggetto che serve le richieste durante un test e' un oggetto scelto dal
 * test, e si sceglie come si sceglie un argomento di funzione.
 *
 * Un contesto e non una prop, per la stessa ragione per cui `session.tsx` e' un
 * contesto: il client serve a otto componenti a profondita' diverse, e passarlo
 * di padre in figlio avrebbe messo un parametro in mezzo a firme che non
 * c'entrano niente.
 *
 * Il valore predefinito e' `null` e `useApi` lancia. Un predefinito «vero»
 * sarebbe stato piu' comodo e avrebbe reso possibile la cosa peggiore: un test
 * che dimentica il provider e parla con `http://localhost:3000` senza dirlo,
 * passando o fallendo per motivi che non c'entrano con cio' che verifica.
 */

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: React.ReactNode;
}): React.JSX.Element {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (client === null) {
    throw new Error("useApi fuori da <ApiProvider>");
  }
  return client;
}
