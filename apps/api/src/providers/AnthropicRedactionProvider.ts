import {
  assistedKindValues,
  type RedactionInput,
  type RedactionProvider,
  type RedactionSuggestions,
} from "@wikimylife/shared";
import { z } from "zod";
import {
  REDACTION_PROMPT_VERSION,
  REDACTION_TEMPERATURE,
  redactionTool,
  renderRedactionPrompt,
} from "../prompts/redaction.v1.js";
import { REDACTION_TIMEOUT_MS, postForJson } from "./http.js";

/**
 * La meta' assistita della §9, contro Anthropic.
 *
 * Stessa forma di `AnthropicExtractionProvider` — tool use forzato, niente
 * parsing di testo libero — con una differenza che vale la pena notare: qui
 * l'uscita si valida subito, dentro il provider, e non viaggia come `unknown`
 * fino a un validatore piu' in la'. Non e' incoerenza. Il contratto
 * dell'estrazione ha venti campi e liste annidate, e la §5 esiste apposta per
 * decidere cosa farne di uno malformato; qui l'uscita e' una lista di tre
 * stringhe, e cio' che non le somiglia non ha nessun uso a valle.
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

const toolInputSchema = z.object({
  trovati: z.array(
    z.object({
      campo: z.string().min(1),
      valore: z.string().min(1),
      kind: z.enum(assistedKindValues),
    }),
  ),
});

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/**
 * Il tetto e' basso perche' l'uscita e' corta: qualche decina di stringhe, non
 * una scheda intera. Se una risposta lo tocca vuol dire che il modello sta
 * elencando mezza scheda, cioe' che sta facendo esattamente cio' che il prompt
 * gli chiede di non fare, e troncarla e' il minore dei mali.
 */
const MAX_TOKENS = 2048;

export class AnthropicRedactionProvider implements RedactionProvider {
  readonly name = "anthropic";
  readonly #apiKey: string;
  readonly #model: string;

  constructor(options: { apiKey: string; model: string }) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
  }

  async suggest(input: RedactionInput): Promise<RedactionSuggestions> {
    const tool = redactionTool(input.campi);

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
        temperature: REDACTION_TEMPERATURE,
        tools: [tool],
        tool_choice: { type: "tool", name: tool.name },
        messages: [{ role: "user", content: renderRedactionPrompt(input.campi) }],
      }),
      timeoutMs: REDACTION_TIMEOUT_MS,
    });

    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Risposta di redazione non interpretabile");
    }

    const toolUse = parsed.data.content.find(
      (block): block is { type: "tool_use"; name: string; input: unknown } =>
        block.type === "tool_use" && "name" in block && block.name === tool.name,
    );

    if (toolUse === undefined) {
      throw new Error("La risposta non contiene l'invocazione dello strumento di redazione");
    }

    const trovati = toolInputSchema.safeParse(toolUse.input);
    if (!trovati.success) {
      throw new Error("L'elenco dei dati personali non e' nella forma attesa");
    }

    return {
      findings: trovati.data.trovati,
      model: parsed.data.model,
      promptVersion: REDACTION_PROMPT_VERSION,
    };
  }
}
