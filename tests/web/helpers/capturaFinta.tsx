import { render as renderRTL, type RenderResult } from "@testing-library/react";
import {
  CaptureContext,
  type Capture,
} from "../../../apps/web/src/recording/CaptureProvider";

/**
 * La cattura vista dalla schermata, e nient'altro.
 *
 * `CaptureProvider` costruisce da se' un `MediaRecorder`, un GPS e un
 * IndexedDB. In `jsdom` nessuno dei tre esiste per davvero, e montarlo vorrebbe
 * dire tre finti di hardware per provare che un pulsante cambia etichetta. Qui
 * si salta direttamente a cio' che la schermata legge: sette campi e sette
 * metodi.
 *
 * I valori predefiniti sono lo stato tranquillo — ferma, online, supportata,
 * niente in coda, niente da salvare, spazio a posto — perche' ogni caso deve
 * dichiarare solo la cosa che sta provando. `spazio` parte da `ok` e non da
 * `ignoto`, che e' il vero valore iniziale del provider, proprio perche'
 * `ignoto` e' uno dei casi da provare: se fosse anche il predefinito, il caso
 * che verifica «non lo so non diventa pieno» non si distinguerebbe da un caso
 * che non ha dichiarato niente.
 *
 * I metodi non insegnati lanciano col proprio nome, come `creaClienteFinto`.
 * Una differenza va detta: `premi()` dentro `RecordScreen` ha un `try/catch`,
 * quindi un `start`/`stop` non insegnato non fa esplodere il test — finisce
 * nell'avviso rosso della schermata. Per questo il messaggio dice di chi e' la
 * colpa: leggerlo dentro un `expect` fallito e' immediato, dedurlo da un
 * «avviso presente quando non doveva» no.
 */

function nonPrevista(nome: string): never {
  throw new Error(
    `Il test non ha previsto Capture.${nome}(): o la schermata chiama la cosa sbagliata, o il finto va completato.`,
  );
}

export function creaCapturaFinta(parti: Partial<Capture> = {}): Capture {
  const base: Capture = {
    state: { kind: "ferma" },
    inCoda: 0,
    online: true,
    supportata: true,
    nonSalvata: null,
    spazio: { kind: "ok" },
    start: () => nonPrevista("start"),
    stop: () => nonPrevista("stop"),
    cancel: () => nonPrevista("cancel"),
    riprova: () => nonPrevista("riprova"),
    riscrivi: () => nonPrevista("riscrivi"),
    scarica: () => nonPrevista("scarica"),
    scarta: () => nonPrevista("scarta"),
  };

  return { ...base, ...parti };
}

/**
 * Come `montaConApi`, e per la stessa ragione: il provider passa da `wrapper`,
 * cosi' un `rerender` non lo perde per strada.
 */
export function montaConCattura(capture: Capture, ui: React.ReactElement): RenderResult {
  return renderRTL(ui, {
    wrapper: ({ children }) => (
      <CaptureContext.Provider value={capture}>{children}</CaptureContext.Provider>
    ),
  });
}
