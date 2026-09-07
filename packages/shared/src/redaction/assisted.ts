/**
 * I tipi di dato che nessuna espressione regolare puo' riconoscere (§9).
 *
 * I quattro rilevatori di `detect.ts` hanno in comune una cosa: un formato. Un
 * codice fiscale ha sedici caratteri e un carattere di controllo, un IBAN ha un
 * mod-97, un'email ha una chiocciola. Cio' che resta fuori — il nome di una
 * persona, l'indirizzo di casa sua, il numero di pratica che la identifica — non
 * ha niente di tutto questo: «Mario Rossi» e «Nuova Delibera» sono due parole
 * maiuscole in fila, e distinguerle vuol dire capire la frase.
 *
 * Da qui la divisione fra i due elenchi di tipi. Non e' una tassonomia piu'
 * fine dello stesso fenomeno, e' il confine fra cio' che si sa e cio' che si
 * suppone, e l'interfaccia lo deve mostrare: davanti a un IBAN che ha passato
 * il checksum c'e' poco da guardare, davanti a un nome proposto da un modello
 * c'e' tutto da guardare.
 */

export const assistedKindValues = [
  "NOME_PERSONA",
  "INDIRIZZO",
  "IDENTIFICATIVO",
  "ALTRO",
] as const;

export type AssistedKind = (typeof assistedKindValues)[number];

export const AssistedKind = {
  NOME_PERSONA: "NOME_PERSONA",
  INDIRIZZO: "INDIRIZZO",
  IDENTIFICATIVO: "IDENTIFICATIVO",
  ALTRO: "ALTRO",
} as const satisfies Record<AssistedKind, AssistedKind>;

/**
 * Il segnaposto che sostituisce il dato, uno per tipo.
 *
 * `ALTRO` esiste malvolentieri. Senza, il modello e' costretto a incasellare in
 * uno dei tre tipi precisi qualunque cosa trovi, e un nome di societa' finirebbe
 * per essere un «nome di persona»: l'etichetta sbagliata su una proposta e'
 * peggio di un'etichetta generica, perche' chi legge le proposte si fida di
 * quello che c'e' scritto sopra.
 */
export const assistedPlaceholder: Record<AssistedKind, string> = {
  NOME_PERSONA: "[nome]",
  INDIRIZZO: "[indirizzo]",
  IDENTIFICATIVO: "[identificativo]",
  ALTRO: "[dato personale]",
};

/**
 * Da dove viene una proposta, e quindi quanto vale.
 *
 * `CERTA` non significa «da accettare»: un centralino pubblico e' un numero di
 * telefono vero, riconosciuto correttamente, e che non va tolto. Significa che
 * il dato e' del formato che dice di essere, perche' un checksum l'ha
 * confermato. `ASSISTITA` non promette nemmeno quello.
 */
export const proposalOriginValues = ["CERTA", "ASSISTITA"] as const;

export type ProposalOrigin = (typeof proposalOriginValues)[number];
