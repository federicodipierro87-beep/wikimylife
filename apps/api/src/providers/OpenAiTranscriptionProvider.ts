import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from "@wikimylife/shared";
import { z } from "zod";
import { TRANSCRIPTION_TIMEOUT_MS, postForJson } from "./http.js";

/**
 * Stadio 2 con Whisper (§3).
 *
 * Tre dettagli non ovvi, tutti e tre necessari perche' la trascrizione italiana
 * sia utilizzabile.
 *
 * IL NOME DEL FILE CONTA. Whisper sceglie il decoder dall'estensione della
 * parte multipart. Un blob chiamato "audio" senza estensione viene rifiutato
 * con un errore che parla di formato non supportato anche quando il formato e'
 * supportatissimo.
 *
 * LA LINGUA VA DICHIARATA. Con `language` assente il modello la indovina, e su
 * un vocale corto e rumoroso indovina italiano/spagnolo a caso. Il valore e'
 * ISO-639-1, due lettere: `Recording.deviceLocale` e' `it-IT`, quindi si taglia.
 *
 * IL VOCABOLARIO PASSA DA `prompt`. E' l'unico canale che l'endpoint offre per
 * suggerire delle stringhe, e serve esattamente per il caso della §3: senza,
 * "SPID" diventa "s pid" e "F24" diventa "effe ventiquattro".
 */

const responseSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  duration: z.number().optional(),
});

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

/**
 * `it-IT` -> `it`. Un locale intero fa fallire la richiesta con un errore di
 * validazione dell'endpoint, non con un fallback silenzioso.
 */
function toIso639(locale: string | undefined): string | undefined {
  if (locale === undefined) {
    return undefined;
  }
  const code = locale.split(/[-_]/)[0]?.toLowerCase() ?? "";
  return code.length === 2 ? code : undefined;
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

export class OpenAiTranscriptionProvider implements TranscriptionProvider {
  readonly name = "whisper";
  readonly #apiKey: string;
  readonly #model: string;

  constructor(options: { apiKey: string; model: string }) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const base = (input.mimeType.split(";")[0] ?? "").trim().toLowerCase();
    const extension = EXTENSION_BY_MIME[base] ?? "webm";

    const form = new FormData();
    form.append("model", this.#model);
    form.append("response_format", "verbose_json");
    form.append(
      "file",
      new Blob([input.audio], { type: base }),
      `registrazione.${extension}`,
    );

    const language = toIso639(input.languageHint);
    if (language !== undefined) {
      form.append("language", language);
    }

    if (input.vocabulary !== undefined && input.vocabulary.length > 0) {
      form.append("prompt", input.vocabulary.join(", "));
    }

    const payload = await postForJson({
      provider: this.name,
      url: ENDPOINT,
      // Nessun Content-Type: solo il runtime conosce il boundary che ha
      // generato per questa FormData, e scriverlo a mano produce un multipart
      // che nessun parser sa leggere.
      headers: { Authorization: `Bearer ${this.#apiKey}` },
      body: form,
      timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
    });

    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Risposta di trascrizione non interpretabile");
    }

    return {
      text: parsed.data.text,
      source: this.name,
      model: this.#model,
      detectedLanguage: parsed.data.language,
      durationMs:
        parsed.data.duration === undefined
          ? undefined
          : Math.round(parsed.data.duration * 1000),
    };
  }
}
