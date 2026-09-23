/**
 * Il collegamento alla pagina della privacy, uguale ovunque compaia.
 *
 * ## Perche' dentro l'app, e non solo sullo store
 *
 * Apple chiede la pagina due volte: un indirizzo nei metadati dello store, e un
 * modo facile di raggiungerla **dall'app**. Due posti: prima di creare il conto,
 * che e' il momento in cui si decide se darglieli, i dati; e nella schermata
 * del conto, dove si torna quando ci si chiede cosa ne e' stato.
 *
 * ## Perche' un `<a>` normale, e non il router
 *
 * `privacy.html` e' un file statico in `public/`, fuori dall'app a pagina
 * singola: il router a frammento non lo conosce e non deve conoscerlo. Stessa
 * scheda e non `target="_blank"`: dentro il guscio nativo una scheda nuova
 * aprirebbe il browser di sistema, cioe' uscirebbe dall'app per leggere una
 * pagina che l'app si porta dentro. La pagina ha un «Torna all'app» in fondo.
 *
 * Un componente e non una costante: l'indirizzo scritto in due schermate e'
 * una precauzione scritta due volte, e la prima volta che ne cambia una sola
 * l'altra punta a un 404.
 */
export const INDIRIZZO_PRIVACY = "/privacy.html";

export function CollegamentoPrivacy(): React.JSX.Element {
  return (
    <p className="muto nota-privacy">
      <a href={INDIRIZZO_PRIVACY}>Privacy: cosa conserviamo e a chi lo mandiamo</a>
    </p>
  );
}
