/**
 * Il minimo indispensabile per parlare con un'API HTTP.
 *
 * Nessun SDK: `@anthropic-ai/sdk` e `openai` pesano insieme piu' di tutto il
 * resto delle dipendenze e portano un client, un sistema di retry, uno di
 * streaming e uno di paginazione per usare, qui, un endpoint a testa. `fetch`
 * e' nel runtime dalla 18.
 *
 * Quello che gli SDK darebbero e che qui va scritto a mano e' il timeout — e
 * non e' un dettaglio: senza, una richiesta che non riceve risposta tiene un
 * job occupato per sempre, e il Recording resta in `IN_ELABORAZIONE` senza che
 * nessun altro worker possa riprenderlo.
 */

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly provider: string;

  constructor(params: { provider: string; status: number; body: string }) {
    super(
      `${params.provider}: HTTP ${String(params.status)} — ${params.body.slice(0, 500)}`,
    );
    this.name = "ProviderHttpError";
    this.status = params.status;
    this.provider = params.provider;
  }
}

export interface ProviderRequest {
  readonly provider: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * `FormData` per l'audio, `string` per il JSON. Stretto di proposito: il tipo
   * `BodyInit` non e' globale in Node senza i lib del DOM, e queste due sono le
   * uniche forme che serve mandare davvero.
   */
  readonly body: FormData | string;
  readonly timeoutMs: number;
}

export async function postForJson(request: ProviderRequest): Promise<unknown> {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(request.timeoutMs),
  });

  if (!response.ok) {
    // Il corpo dell'errore si legge e si mette nel messaggio: e' l'unico modo
    // di sapere se il problema e' la chiave, il modello o la quota. Non esce
    // mai in risposta HTTP — finisce in `lastErrorMessage`, troncato.
    const body = await response.text().catch(() => "");
    throw new ProviderHttpError({ provider: request.provider, status: response.status, body });
  }

  return response.json();
}

/** Timeout generosi: un vocale di dieci minuti trascritto non e' istantaneo. */
export const TRANSCRIPTION_TIMEOUT_MS = 120_000;
export const EXTRACTION_TIMEOUT_MS = 120_000;
export const EMBEDDING_TIMEOUT_MS = 30_000;

/**
 * Molto piu' corto degli altri, e non perche' il lavoro sia piu' semplice.
 *
 * Trascrizione ed estrazione girano dentro un worker: se una richiesta ci mette
 * due minuti nessuno se ne accorge, il Recording resta `IN_ELABORAZIONE` e la
 * schermata dice che ci sta lavorando. La redazione assistita sta invece dentro
 * una GET, con qualcuno fermo davanti a una scheda che vuole condividere. Dopo
 * venti secondi quella persona ha gia' deciso che l'app non funziona, e la
 * §9 preferisce che le proposte certe arrivino subito senza quelle assistite
 * piuttosto che farle aspettare tutte insieme.
 */
export const REDACTION_TIMEOUT_MS = 20_000;
