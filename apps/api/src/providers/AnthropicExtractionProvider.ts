import type {
  ExtractionInput,
  ExtractionProvider,
  ExtractionResult,
} from "@wikimylife/shared";
import { z } from "zod";
import {
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_TEMPERATURE,
  EXTRACTION_TOOL,
  renderExtractionPrompt,
} from "../prompts/extraction.v1.js";
import { EXTRACTION_TIMEOUT_MS, postForJson } from "./http.js";

/**
 * Stadio 3 (§4.2).
 *
 * `tool_choice` forzato sullo strumento, non testo libero: e' cio' che la §4.2
 * chiede quando dice "structured output / tool use, non parsing di testo
 * libero". La differenza pratica e' che il modello non puo' rispondere "Certo,
 * ecco il JSON:" seguito da un blocco markdown — e quindi non esiste, da
 * nessuna parte in questo file, una funzione che cerca ```json in una stringa.
 *
 * Cio' che torna e' `content[].input` dello strumento, e viaggia come
 * `unknown`: e' la §5 a decidere se e' valido. Dichiararlo `ExtractionContract`
 * qui sarebbe far certificare al modello sé stesso.
 */

const responseSchema = z.object({
  model: z.string(),
  content: z.array(
    z.union([
      z.object({ type: z.literal("tool_use"), name: z.string(), input: z.unknown() }),
      z.object({ type: z.string() }).passthrough(),
    ]),
  ),
});

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/**
 * Il contratto §4.1 ha una ventina di campi e liste annidate senza tetto: una
 * procedura raccontata per bene con dieci passi e cinque trappole occupa
 * facilmente qualche migliaio di token. Un limite stretto non darebbe un errore
 * ma un JSON troncato, cioe' un `contratto.non_conforme` inspiegabile.
 */
const MAX_TOKENS = 8192;

export class AnthropicExtractionProvider implements ExtractionProvider {
  readonly name = "anthropic";
  readonly #apiKey: string;
  readonly #model: string;

  constructor(options: { apiKey: string; model: string }) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const prompt = renderExtractionPrompt({
      transcript: input.transcript,
      context: input.context,
    });

    const payload = await postForJson({
      provider: this.name,
      url: ENDPOINT,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model: this.#model,
        max_tokens: MAX_TOKENS,
        // §4.2: "Temperatura bassa (0–0.2): qui non serve creatività."
        temperature: EXTRACTION_TEMPERATURE,
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
        messages: [{ role: "user", content: prompt }],
      }),
      timeoutMs: EXTRACTION_TIMEOUT_MS,
    });

    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Risposta di estrazione non interpretabile");
    }

    const toolUse = parsed.data.content.find(
      (block): block is { type: "tool_use"; name: string; input: unknown } =>
        block.type === "tool_use" && "name" in block && block.name === EXTRACTION_TOOL.name,
    );

    if (toolUse === undefined) {
      // Con `tool_choice` forzato non dovrebbe accadere. Se accade e' un cambio
      // di comportamento dell'API, e va detto per quello che e': meglio un
      // errore esplicito di un `{}` che la §5 rifiuterebbe come se fosse colpa
      // della trascrizione.
      throw new Error("La risposta non contiene l'invocazione dello strumento di estrazione");
    }

    return {
      raw: toolUse.input,
      model: parsed.data.model,
      promptVersion: EXTRACTION_PROMPT_VERSION,
    };
  }
}
