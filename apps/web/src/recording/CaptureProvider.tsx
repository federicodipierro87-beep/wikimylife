import type { Coordinates, QueuedRecording } from "@wikimylife/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../api";
import { GeolocationAdapter } from "./GeolocationAdapter";
import { IndexedDbUploadQueue } from "./IndexedDbUploadQueue";
import { MediaRecorderAdapter } from "./MediaRecorderAdapter";
import { motivoDi, nomeFileDi, spazioEsaurito } from "./salvataggio";
import { valutaSpazio, type Spazio } from "./spazio";
import { createUploader, type Uploader } from "./uploader";

/**
 * La cattura, dal pulsante alla coda.
 *
 * ## La promessa della §2
 *
 * «L'utente deve poter chiudere l'app subito dopo aver premuto stop». Qui
 * significa una cosa precisa: `stop()` scrive su IndexedDB e finisce. Il
 * caricamento parte dopo, senza che nessuno lo aspetti, e se la scheda muore
 * nel frattempo riparte al prossimo avvio. Non c'e' nessun punto in cui l'audio
 * esiste solo in memoria.
 *
 * ## Il GPS non fa aspettare nessuno
 *
 * La posizione si chiede all'inizio, in parallelo alla registrazione, e allo
 * stop si legge quello che nel frattempo e' arrivato — senza `await`. Non e'
 * una sfumatura: `getCurrentPosition` ha otto secondi di timeout e il reverse
 * geocoding ne ha altri quattro, quindi attenderli allo stop significherebbe
 * tenere l'audio in memoria fino a dodici secondi dopo che l'utente ha finito
 * di parlare. Il luogo e' un extra; l'audio e' il dato.
 *
 * ## Gli adattatori sono istanze, non moduli
 *
 * `useRef` e non variabili di modulo: due montaggi in `StrictMode` non devono
 * condividere un `MediaRecorder` a meta' registrazione, e un giorno un test
 * potra' iniettarne altri senza toccare l'ordine degli import.
 *
 * ## Il tetto alla coda e' il rifiuto di registrare
 *
 * IndexedDB non e' infinito e non dice quanto manca: la quota per origine la
 * decide il browser, la stringe quando il dispositivo si riempie, e l'unico
 * segnale che si riceve e' una scrittura rifiutata. Fino a poco fa quel rifiuto
 * arrivava dopo lo stop, quando l'unica copia dell'audio era la variabile
 * locale di `stop()`: l'utente vedeva un errore e la registrazione spariva con
 * la funzione.
 *
 * Adesso l'audio rifiutato resta in memoria e diventa `nonSalvata`, con tre
 * uscite — riprovare dopo aver liberato spazio, scaricare il file, buttarlo — e
 * finche' e' li' `start()` rifiuta di registrare ancora. E' un tetto scomodo di
 * proposito: un tetto che cancella le registrazioni vecchie per fare posto alle
 * nuove sarebbe la stessa perdita di dati di prima, decisa da noi invece che
 * dal browser. La memoria non e' un posto sicuro — chiudere la scheda perde
 * tutto — ed e' esattamente il motivo per cui l'avviso e' vistoso e lo
 * scaricamento sta li' accanto.
 *
 * Quella difesa pero' scatta a danno avvenuto: quando l'utente lo scopre ha
 * gia' parlato per dieci minuti. `stimaSpazio()` chiede al browser quanto
 * manca e permette di dirlo prima — ma solo di dirlo. La stima e' arrotondata
 * apposta per non diventare un'impronta digitale, e un divieto costruito sopra
 * un numero cosi' impedirebbe di registrare a chi lo spazio ce l'ha. Fra
 * un'attesa sbagliata e una registrazione mai fatta, la seconda e' la perdita
 * peggiore.
 */

export type CaptureState =
  | { readonly kind: "ferma" }
  | { readonly kind: "in-corso"; readonly elapsedMs: number }
  | { readonly kind: "salvataggio" };

/**
 * Un audio che esiste solo in memoria perche' il browser ha rifiutato di
 * scriverlo. Non contiene i byte: quelli restano in un ref, e metterli nello
 * stato di React significherebbe copiarli a ogni render.
 */
export interface RegistrazioneNonSalvata {
  /** ISO 8601, orologio del dispositivo. */
  readonly recordedAt: string;
  readonly durationMs: number;
  /** Cosa e' successo, in una riga leggibile. */
  readonly motivo: string;
  /** `true` se e' mancato lo spazio: liberarne puo' far riuscire un secondo tentativo. */
  readonly spazio: boolean;
}

export interface Capture {
  readonly state: CaptureState;
  /** Elementi ancora da caricare, esauriti compresi. */
  readonly inCoda: number;
  readonly online: boolean;
  /** `false` quando il browser non ha `MediaRecorder` o il microfono e' negato. */
  readonly supportata: boolean;
  /** L'audio che non e' riuscito ad arrivare su disco, se ce n'e' uno. */
  readonly nonSalvata: RegistrazioneNonSalvata | null;
  /** Quanto spazio dice di avere il browser. Avvisa, non impedisce. */
  readonly spazio: Spazio;
  start(): Promise<void>;
  /** Restituisce l'id locale accodato. Non aspetta il caricamento. */
  stop(): Promise<string>;
  cancel(): Promise<void>;
  /** Il pulsante «riprova» dell'indicatore. */
  riprova(): Promise<void>;
  /** Riprova a scrivere in coda l'audio non salvato. Non lancia: aggiorna il motivo. */
  riscrivi(): Promise<void>;
  /** Porta l'audio non salvato fuori dal browser, nella cartella Download. */
  scarica(): void;
  /** Rinuncia all'audio non salvato. E' una decisione dell'utente, non dell'app. */
  scarta(): void;
}

const CaptureContext = createContext<Capture | null>(null);

/**
 * Quanto spazio dice di avere il browser, o `null` se non lo dice.
 *
 * `navigator.storage` manca su Safari vecchi e in ogni contesto non sicuro, e
 * `estimate()` puo' lanciare o restituire campi assenti: tre modi diversi di
 * dire «non lo so», che per chi chiama sono lo stesso caso.
 */
async function stimaSpazio(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator.storage?.estimate !== "function") {
    return null;
  }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return typeof usage === "number" && typeof quota === "number" ? { usage, quota } : null;
  } catch {
    return null;
  }
}

/** Un id locale che esiste prima del server: e' il nome del file nella coda. */
function nuovoId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
}

export function CaptureProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const recorder = useRef(new MediaRecorderAdapter());
  const location = useRef(new GeolocationAdapter());
  const queue = useRef(new IndexedDbUploadQueue());
  /**
   * Quello che il GPS ha fatto in tempo a dire. Si scrive quando arriva, si
   * legge allo stop senza attendere: se non c'e' ancora, non c'e'.
   */
  const luogo = useRef<{ coords: Coordinates | null; label: string | null }>({
    coords: null,
    label: null,
  });
  /**
   * L'audio che il disco ha rifiutato. E' un ref e non uno stato perche' sono
   * megabyte: React non deve confrontarli, e nessun render deve dipendere da
   * loro. Cio' che l'interfaccia deve sapere sta in `nonSalvata`.
   */
  const inSospeso = useRef<Omit<QueuedRecording, "attempts" | "lastError"> | null>(null);

  const [state, setState] = useState<CaptureState>({ kind: "ferma" });
  const [inCoda, setInCoda] = useState(0);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [nonSalvata, setNonSalvata] = useState<RegistrazioneNonSalvata | null>(null);
  const [spazio, setSpazio] = useState<Spazio>({ kind: "ignoto" });

  const aggiornaConteggio = useCallback((): void => {
    queue.current
      .size()
      .then(setInCoda)
      .catch(() => {
        // IndexedDB negato (Firefox in navigazione privata): l'indicatore resta
        // a zero. E' un'imprecisione dell'interfaccia, non un motivo per
        // rompere la schermata.
      });

    // Attaccato al conteggio e non a un intervallo: lo spazio libero cambia
    // quando la coda cambia, cioe' quando si registra e quando si carica.
    // Chiederlo ogni pochi secondi costerebbe senza dire niente di nuovo.
    void stimaSpazio().then((s) => {
      setSpazio(valutaSpazio(s));
    });
  }, []);

  const uploader = useRef<Uploader>(
    createUploader({
      queue: queue.current,
      client: apiClient,
      isOnline: () => navigator.onLine,
      onChange: aggiornaConteggio,
    }),
  );

  // Un giro all'avvio: e' cio' che raccoglie l'audio registrato ieri in un
  // ascensore e mai caricato.
  useEffect(() => {
    aggiornaConteggio();
    void uploader.current.drain();
  }, [aggiornaConteggio]);

  useEffect(() => {
    const suOnline = (): void => {
      setOnline(true);
      void uploader.current.drain();
    };
    const suOffline = (): void => {
      setOnline(false);
    };
    window.addEventListener("online", suOnline);
    window.addEventListener("offline", suOffline);
    return () => {
      window.removeEventListener("online", suOnline);
      window.removeEventListener("offline", suOffline);
    };
  }, []);

  // Il contatore. Un intervallo e non `requestAnimationFrame`: la cifra dei
  // secondi cambia una volta al secondo, e sessanta ridisegni per mostrarne uno
  // sono cinquantanove sprechi di batteria mentre il microfono e' acceso.
  useEffect(() => {
    if (state.kind !== "in-corso") {
      return;
    }
    const timer = setInterval(() => {
      setState({ kind: "in-corso", elapsedMs: recorder.current.elapsedMs() });
    }, 250);
    return () => {
      clearInterval(timer);
    };
  }, [state.kind]);

  const start = useCallback(async (): Promise<void> => {
    // Registrare sopra un audio che non si e' potuto salvare significa quasi
    // certamente non poter salvare nemmeno questo, e intanto tenere due file in
    // memoria invece di uno. Meglio fermarsi qui, dove c'e' ancora qualcosa da
    // salvare, che due schermate piu' avanti quando non c'e' piu'.
    if (inSospeso.current !== null) {
      throw new Error(
        "C'e' una registrazione non salvata: scaricala o scartala prima di registrarne un'altra.",
      );
    }

    // Il GPS parte adesso e deposita il risultato nel ref quando arriva.
    // Nessuno lo aspetta, ne' qui ne' allo stop.
    luogo.current = { coords: null, label: null };
    void (async (): Promise<void> => {
      const coords = await location.current.getCurrentPosition();
      if (coords === null) {
        return;
      }
      luogo.current = { coords, label: null };
      luogo.current = { coords, label: await location.current.reverseGeocode(coords) };
    })();

    await recorder.current.start();
    setState({ kind: "in-corso", elapsedMs: 0 });
  }, []);

  const stop = useCallback(async (): Promise<string> => {
    setState({ kind: "salvataggio" });
    try {
      const chunk = await recorder.current.stop();
      const { coords, label } = luogo.current;

      const id = nuovoId();
      const item = {
        id,
        audio: chunk.data,
        mimeType: chunk.mimeType,
        durationMs: chunk.durationMs,
        recordedAt: new Date().toISOString(),
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
        placeLabel: label,
        deviceLocale: navigator.language,
        // Il dispositivo e' l'unico che lo sa: al server la richiesta appare
        // online comunque, perche' e' arrivata.
        capturedOffline: !navigator.onLine,
      };

      try {
        await queue.current.enqueue(item);
      } catch (error: unknown) {
        // Trattenere `item` e' tutto cio' che separa «l'audio non e' su disco»
        // da «l'audio non esiste piu'»: uscire di qui senza farlo lo lascerebbe
        // al garbage collector.
        inSospeso.current = item;
        setNonSalvata({
          recordedAt: item.recordedAt,
          durationMs: item.durationMs,
          motivo: motivoDi(error),
          spazio: spazioEsaurito(error),
        });
        // Rilanciato con il messaggio leggibile: chi ha premuto stop lo vede
        // subito dov'e', senza aspettare di guardare l'avviso in basso.
        throw new Error(motivoDi(error));
      }

      // Da qui in poi l'audio e' salvo e l'app si puo' chiudere. Tutto cio' che
      // segue e' senza `await` di proposito.
      aggiornaConteggio();
      void uploader.current.drain();

      return id;
    } finally {
      setState({ kind: "ferma" });
    }
  }, [aggiornaConteggio]);

  const cancel = useCallback(async (): Promise<void> => {
    await recorder.current.cancel();
    setState({ kind: "ferma" });
  }, []);

  const riprova = useCallback(async (): Promise<void> => {
    await uploader.current.drain();
    aggiornaConteggio();
  }, [aggiornaConteggio]);

  const riscrivi = useCallback(async (): Promise<void> => {
    const item = inSospeso.current;
    if (item === null) {
      return;
    }
    try {
      await queue.current.enqueue(item);
    } catch (error: unknown) {
      // Non rilancia: il pulsante che chiama questa e' dentro l'avviso, e
      // l'avviso e' gia' il posto dove il fallimento si legge. L'audio resta
      // dov'era.
      setNonSalvata((corrente) =>
        corrente === null
          ? null
          : { ...corrente, motivo: motivoDi(error), spazio: spazioEsaurito(error) },
      );
      return;
    }
    inSospeso.current = null;
    setNonSalvata(null);
    aggiornaConteggio();
    void uploader.current.drain();
  }, [aggiornaConteggio]);

  const scarica = useCallback((): void => {
    const item = inSospeso.current;
    if (item === null) {
      return;
    }
    const url = URL.createObjectURL(new Blob([new Uint8Array(item.audio)], { type: item.mimeType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = nomeFileDi(item.recordedAt, item.mimeType);
    link.click();
    // Revocare subito annulla lo scaricamento su piu' di un browser: l'URL
    // serve finche' il download non e' partito davvero, e un minuto e' molto
    // piu' di quanto occorra a un file locale.
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60_000);
  }, []);

  const scarta = useCallback((): void => {
    inSospeso.current = null;
    setNonSalvata(null);
  }, []);

  const value = useMemo<Capture>(
    () => ({
      state,
      inCoda,
      online,
      supportata: recorder.current.isSupported(),
      nonSalvata,
      spazio,
      start,
      stop,
      cancel,
      riprova,
      riscrivi,
      scarica,
      scarta,
    }),
    [
      state,
      inCoda,
      online,
      nonSalvata,
      spazio,
      start,
      stop,
      cancel,
      riprova,
      riscrivi,
      scarica,
      scarta,
    ],
  );

  return <CaptureContext.Provider value={value}>{children}</CaptureContext.Provider>;
}

export function useCapture(): Capture {
  const capture = useContext(CaptureContext);
  if (capture === null) {
    throw new Error("useCapture fuori da <CaptureProvider>");
  }
  return capture;
}
