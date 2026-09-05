import type { Coordinates } from "@wikimylife/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../api";
import { GeolocationAdapter } from "./GeolocationAdapter";
import { IndexedDbUploadQueue } from "./IndexedDbUploadQueue";
import { MediaRecorderAdapter } from "./MediaRecorderAdapter";
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
 */

export type CaptureState =
  | { readonly kind: "ferma" }
  | { readonly kind: "in-corso"; readonly elapsedMs: number }
  | { readonly kind: "salvataggio" };

export interface Capture {
  readonly state: CaptureState;
  /** Elementi ancora da caricare, esauriti compresi. */
  readonly inCoda: number;
  readonly online: boolean;
  /** `false` quando il browser non ha `MediaRecorder` o il microfono e' negato. */
  readonly supportata: boolean;
  start(): Promise<void>;
  /** Restituisce l'id locale accodato. Non aspetta il caricamento. */
  stop(): Promise<string>;
  cancel(): Promise<void>;
  /** Il pulsante «riprova» dell'indicatore. */
  riprova(): Promise<void>;
}

const CaptureContext = createContext<Capture | null>(null);

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

  const [state, setState] = useState<CaptureState>({ kind: "ferma" });
  const [inCoda, setInCoda] = useState(0);
  const [online, setOnline] = useState(() => navigator.onLine);

  const aggiornaConteggio = useCallback((): void => {
    queue.current
      .size()
      .then(setInCoda)
      .catch(() => {
        // IndexedDB negato (Firefox in navigazione privata): l'indicatore resta
        // a zero. E' un'imprecisione dell'interfaccia, non un motivo per
        // rompere la schermata.
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
      await queue.current.enqueue({
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
      });

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

  const value = useMemo<Capture>(
    () => ({
      state,
      inCoda,
      online,
      supportata: recorder.current.isSupported(),
      start,
      stop,
      cancel,
      riprova,
    }),
    [state, inCoda, online, start, stop, cancel, riprova],
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
