import type { RecorderAdapter, RecordingChunk } from "@wikimylife/shared";

/**
 * `RecorderAdapter` su `MediaRecorder`.
 *
 * ## Il mimeType non si sceglie, si chiede
 *
 * Chrome produce `audio/webm;codecs=opus`, Safari `audio/mp4`. Passare un tipo
 * non supportato a `MediaRecorder` lancia, e passarne uno supportato non
 * garantisce che sia quello usato davvero. Quindi si prova la lista in ordine
 * di preferenza, si lascia decidere il browser se nessuno passa, e alla fine si
 * legge `recorder.mimeType` — che e' l'unica fonte attendibile, e viaggia fino
 * al server dentro i metadati della §2.
 *
 * ## Il microfono si spegne sempre
 *
 * Le tracce di `getUserMedia` tengono acceso l'indicatore rosso del sistema
 * finche' non si chiama `stop()` su ognuna. Dimenticarlo dopo una registrazione
 * significa lasciare a un'app di appunti l'aria di stare a origliare.
 */

/** In ordine di preferenza: opus e' piccolo, aac e' l'unico su iOS. */
const CANDIDATE_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

function preferredType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  return CANDIDATE_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
}

interface Session {
  readonly recorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly chunks: Blob[];
  readonly startedAt: number;
}

export class MediaRecorderAdapter implements RecorderAdapter {
  #session: Session | null = null;

  isSupported(): boolean {
    return (
      typeof MediaRecorder !== "undefined" &&
      typeof navigator !== "undefined" &&
      navigator.mediaDevices !== undefined
    );
  }

  async requestPermission(): Promise<boolean> {
    if (!this.isSupported()) {
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Il permesso resta concesso per l'origine: questo stream serviva solo a
      // chiederlo, e tenerlo aperto accenderebbe il microfono senza registrare.
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return true;
    } catch {
      // Negato, revocato, o nessun microfono. Per chi chiama e' lo stesso caso.
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.#session !== null) {
      throw new Error("Registrazione gia' in corso");
    }
    if (!this.isSupported()) {
      throw new Error("Registrazione non supportata da questo browser");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // La voce parlata in una stanza qualsiasi: senza queste, un vocale
        // registrato in officina arriva a Whisper pieno di rumore di fondo.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const type = preferredType();
    const recorder = new MediaRecorder(stream, type === undefined ? {} : { mimeType: type });
    const chunks: Blob[] = [];

    recorder.ondataavailable = (event: BlobEvent): void => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    // Un pezzo al secondo invece di uno solo alla fine: se la scheda muore a
    // meta' registrazione si perde l'ultimo secondo, non l'intero racconto.
    recorder.start(1000);
    this.#session = { recorder, stream, chunks, startedAt: Date.now() };
  }

  async stop(): Promise<RecordingChunk> {
    const session = this.#session;
    if (session === null) {
      throw new Error("Nessuna registrazione in corso");
    }
    this.#session = null;

    const durationMs = Date.now() - session.startedAt;

    await new Promise<void>((resolve) => {
      // `onstop` arriva dopo l'ultimo `ondataavailable`: aspettarlo e' l'unico
      // modo di sapere che i pezzi sono tutti li'.
      session.recorder.onstop = (): void => {
        resolve();
      };
      session.recorder.stop();
    });

    release(session.stream);

    const mimeType = session.recorder.mimeType === "" ? "audio/webm" : session.recorder.mimeType;
    const blob = new Blob(session.chunks, { type: mimeType });
    return {
      data: new Uint8Array(await blob.arrayBuffer()),
      mimeType,
      durationMs,
    };
  }

  cancel(): Promise<void> {
    const session = this.#session;
    if (session === null) {
      return Promise.resolve();
    }
    this.#session = null;

    // Nessuna attesa e nessun blob: i pezzi restano nell'array e il garbage
    // collector se li prende. Annullare vuol dire non averla mai fatta.
    if (session.recorder.state !== "inactive") {
      session.recorder.stop();
    }
    release(session.stream);
    return Promise.resolve();
  }

  elapsedMs(): number {
    return this.#session === null ? 0 : Date.now() - this.#session.startedAt;
  }
}

function release(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
