/**
 * Le icone dell'app, disegnate a mano in SVG.
 *
 * ## Perche' non una libreria
 *
 * Servono otto disegni. Una libreria di icone ne porta migliaia, e il costo non
 * e' il peso — lo scuotimento degli alberi lo toglierebbe — ma la dipendenza da
 * aggiornare per otto tracciati che non cambieranno mai. E per la CSP: niente
 * font di icone da un altro dominio, niente `style` inline. Gli attributi di
 * presentazione dell'SVG (`fill`, `stroke`) non sono stili e la CSP li lascia
 * passare.
 *
 * ## Perche' sono sempre mute
 *
 * `aria-hidden` sempre, senza eccezioni e senza un parametro per toglierlo: il
 * nome di un pulsante lo porta il suo testo o il suo `aria-label`, mai il
 * disegno. Un'icona che parlasse cambierebbe il nome accessibile del pulsante
 * che la contiene — «Cerca» diventerebbe «lente Cerca» — e i test, che trovano
 * i pulsanti per nome, se ne accorgerebbero solo per caso. `focusable="false"`
 * e' per il vecchio Edge e per IE, che altrimenti mettevano l'SVG nel giro del
 * tasto Tab.
 *
 * Il colore e' `currentColor`: l'icona prende quello del testo che le sta
 * accanto, cosi' un pulsante spento o rosso non ha bisogno di una seconda
 * regola per la sua icona.
 */

export type NomeIcona =
  | "indietro"
  | "cerca"
  | "account"
  | "elenco"
  | "microfono"
  | "stop"
  | "cestino"
  | "avanti";

const TRACCIATI: Record<NomeIcona, React.JSX.Element> = {
  indietro: <path d="M15 18l-6-6 6-6" />,
  avanti: <path d="M9 18l6-6-6-6" />,
  cerca: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  elenco: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </>
  ),
  microfono: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  // Pieno e non a tratto: e' l'unico disegno che sta dentro il pulsante rosso
  // mentre si registra, e un quadrato vuoto a quella misura si legge come una
  // casella da spuntare.
  stop: <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" />,
  cestino: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
    </>
  ),
};

export function Icona({ nome }: { nome: NomeIcona }): React.JSX.Element {
  return (
    <svg
      className="icona"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {TRACCIATI[nome]}
    </svg>
  );
}
