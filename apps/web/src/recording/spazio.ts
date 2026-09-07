/**
 * Quanto spazio resta, e cosa dirne.
 *
 * La difesa che c'e' gia' — l'audio rifiutato che resta in memoria con lo
 * scaricamento accanto — scatta a danno avvenuto: l'utente ha gia' parlato per
 * dieci minuti quando scopre che non c'era posto. `navigator.storage.estimate()`
 * permette di dirlo prima, e questo modulo e' la parte di quel conto che si puo'
 * provare senza un browser.
 *
 * ## Perche' avvisa e non impedisce
 *
 * La stima non e' una misura. Il numero e' volutamente approssimato dai browser
 * per non diventare un'impronta digitale, e' aggiornato con ritardo, e la quota
 * che riporta e' una previsione basata sullo spazio libero del disco — che un
 * altro programma puo' occupare un secondo dopo. Su questo si puo' costruire un
 * avviso, non un divieto: uno «spazio esaurito» sbagliato che impedisce di
 * registrare sarebbe un danno peggiore di un salvataggio fallito, perche' il
 * salvataggio fallito adesso ha una via d'uscita e la registrazione mai fatta
 * no.
 *
 * ## I byte al secondo sono una stima prudente
 *
 * `MediaRecorder` non dichiara il bitrate che usera' e i browser non concordano:
 * Opus in WebM sta spesso sotto la meta' di questa cifra, l'AAC di Safari le si
 * avvicina. Sovrastimare fa comparire l'avviso un po' presto, sottostimare lo fa
 * comparire quando non serve piu': fra i due sbagli conviene il primo.
 */

/** Byte al secondo assunti per il parlato registrato. Circa 128 kbps. */
export const BYTE_AL_SECONDO = 16_000;

/**
 * Quanto si tiene da parte senza contarlo.
 *
 * I browser cominciano a rifiutare le scritture prima di arrivare alla quota
 * dichiarata, e la stima e' arrotondata: contare fino all'ultimo byte
 * significherebbe promettere una registrazione che non entra.
 */
export const MARGINE_BYTE = 5 * 1024 * 1024;

/** Sotto questa soglia l'avviso compare. */
export const MINUTI_POCHI = 10;

export type Spazio =
  /** Il browser non sa dirlo, o non ha `storage.estimate`. */
  | { readonly kind: "ignoto" }
  | { readonly kind: "ok" }
  | { readonly kind: "poco"; readonly minuti: number }
  | { readonly kind: "pieno" };

/** Cio' che resta davvero, margine gia' tolto. */
export function disponibili(stima: { usage: number; quota: number }): number {
  return Math.max(0, stima.quota - stima.usage - MARGINE_BYTE);
}

/** Quanti minuti di parlato ci stanno ancora, arrotondati per difetto. */
export function minutiResidui(byte: number): number {
  return Math.floor(byte / (BYTE_AL_SECONDO * 60));
}

/**
 * Il verdetto da mostrare.
 *
 * `null` in ingresso vuol dire che non si e' potuto chiedere — Safari senza
 * `storage`, un contesto non sicuro, una `estimate()` che ha lanciato — e non
 * «e' pieno»: tacere e' l'unica cosa onesta quando non si sa.
 */
export function valutaSpazio(stima: { usage: number; quota: number } | null): Spazio {
  if (stima === null || !Number.isFinite(stima.quota) || !Number.isFinite(stima.usage)) {
    return { kind: "ignoto" };
  }

  const minuti = minutiResidui(disponibili(stima));
  if (minuti < 1) {
    return { kind: "pieno" };
  }
  if (minuti < MINUTI_POCHI) {
    return { kind: "poco", minuti };
  }
  return { kind: "ok" };
}

/**
 * La riga da mostrare sopra il pulsante, o `null` se non c'e' niente da dire.
 *
 * «Pieno» non dice «non puoi registrare», perche' non e' vero e perche' non e'
 * questo modulo a deciderlo: dice cosa succedera' se si registra lo stesso, che
 * e' l'informazione che serve a scegliere.
 */
export function avvisoSpazio(spazio: Spazio): string | null {
  switch (spazio.kind) {
    case "ignoto":
    case "ok":
      return null;
    case "poco":
      return `Sul telefono c'e' spazio per circa ${String(spazio.minuti)} minut${
        spazio.minuti === 1 ? "o" : "i"
      } di registrazione. Torna online per svuotare la coda.`;
    case "pieno":
      return "Lo spazio sul telefono e' finito: la prossima registrazione potrebbe non essere salvata. Torna online per svuotare la coda.";
  }
}
