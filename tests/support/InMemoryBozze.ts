import type { DraftPiece, RecordingDraft, RecordingDraftAdapter } from "@wikimylife/shared";

/**
 * Le bozze in memoria, al posto di IndexedDB.
 *
 * Riproduce l'unica cosa dell'originale da cui dipende il recupero: `list`
 * restituisce i pezzi in ordine di numero, qualunque sia l'ordine in cui sono
 * stati scritti, come fa la chiave composta `[bozza, numero]`. E conta cio' che
 * succede, perche' i casi possano dire non solo cosa resta ma in che ordine ci
 * si e' arrivati.
 */
export class InMemoryBozze implements RecordingDraftAdapter {
  readonly #pezzi: DraftPiece[] = [];
  /** Le operazioni, nell'ordine in cui sono finite: `append:<id>:<seq>`, `discard:<id>`. */
  readonly registro: string[] = [];
  /** Impostabili dal test per far fallire un'operazione. */
  appendFallisce = false;
  listFallisce = false;
  /** Ritardo artificiale per ogni `append`, in microtask: serve a provare le code. */
  attesaAppend: (() => Promise<void>) | null = null;

  async append(piece: DraftPiece): Promise<void> {
    if (this.attesaAppend !== null) {
      await this.attesaAppend();
    }
    if (this.appendFallisce) {
      throw new Error("disco pieno");
    }
    const i = this.#pezzi.findIndex((p) => p.draftId === piece.draftId && p.seq === piece.seq);
    if (i >= 0) {
      this.#pezzi[i] = piece;
    } else {
      this.#pezzi.push(piece);
    }
    this.registro.push(`append:${piece.draftId}:${String(piece.seq)}`);
  }

  list(): Promise<readonly RecordingDraft[]> {
    if (this.listFallisce) {
      return Promise.reject(new Error("IndexedDB negato"));
    }
    const ids = [...new Set(this.#pezzi.map((p) => p.draftId))];
    return Promise.resolve(
      ids.map((id) => {
        const pezzi = this.#pezzi.filter((p) => p.draftId === id).sort((a, b) => a.seq - b.seq);
        const primo = pezzi[0];
        if (primo === undefined) {
          throw new Error("bozza senza pezzi");
        }
        return {
          id,
          mimeType: primo.mimeType,
          startedAt: primo.startedAt,
          lastPieceAt: Math.max(...pezzi.map((p) => p.at)),
          pieces: pezzi.map((p) => p.data),
        };
      }),
    );
  }

  discard(id: string): Promise<void> {
    for (let i = this.#pezzi.length - 1; i >= 0; i -= 1) {
      if (this.#pezzi[i]?.draftId === id) {
        this.#pezzi.splice(i, 1);
      }
    }
    this.registro.push(`discard:${id}`);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#pezzi.length = 0;
    this.registro.push("clear");
    return Promise.resolve();
  }

  /** Gli id delle bozze che esistono adesso. */
  ids(): string[] {
    return [...new Set(this.#pezzi.map((p) => p.draftId))];
  }
}
