/**
 * Rilevamento deterministico dei dati personali in un testo libero (§9).
 *
 * La §9 chiede una passata «deterministica dove possibile (regex per codici
 * fiscali, IBAN, email, telefoni), assistita dall'LLM per il resto». Questo file
 * e' la meta' deterministica, ed e' deliberatamente l'unica che esiste: quello
 * che si puo' decidere con una funzione pura non va chiesto a un modello che
 * costa, sbaglia in modo non riproducibile e cambia risposta fra due esecuzioni
 * identiche. Su un testo dato, questo file risponde sempre lo stesso.
 *
 * Il criterio che governa ogni scelta qui sotto e' asimmetrico, perche' i due
 * errori non costano uguale:
 *
 *  - un mancato rilevamento lascia un dato personale in una scheda che l'utente
 *    sta per pubblicare, e lo vedra' lui rileggendo — la §9 fa confermare le
 *    sostituzioni una per una proprio perche' l'ultimo controllo e' umano;
 *  - un falso positivo propone di cancellare del testo buono, e se l'utente
 *    conferma distrattamente la scheda perde un pezzo che nessuno recuperera'.
 *
 * Il secondo e' peggiore, quindi tutto qui e' tarato per non gridare. Codice
 * fiscale e IBAN non sono riconosciuti dalla forma ma dalla loro cifra di
 * controllo, che e' il motivo per cui quelle cifre esistono: `RSSMRA85M01H501Z`
 * passa e `RSSMRA85M01H501A` no, e sedici caratteri a caso non passano quasi
 * mai. I telefoni hanno le regole piu' strette di tutte, perche' sono l'unico
 * dato personale che assomiglia a un numero qualunque.
 */

export const sensitiveKindValues = ["CODICE_FISCALE", "IBAN", "EMAIL", "TELEFONO"] as const;

export type SensitiveKind = (typeof sensitiveKindValues)[number];

export const SensitiveKind = {
  CODICE_FISCALE: "CODICE_FISCALE",
  IBAN: "IBAN",
  EMAIL: "EMAIL",
  TELEFONO: "TELEFONO",
} as const satisfies Record<SensitiveKind, SensitiveKind>;

/** Il segnaposto che sostituisce il dato, uno per tipo. */
export const sensitivePlaceholder: Record<SensitiveKind, string> = {
  CODICE_FISCALE: "[codice fiscale]",
  IBAN: "[IBAN]",
  EMAIL: "[email]",
  TELEFONO: "[telefono]",
};

export interface SensitiveMatch {
  readonly kind: SensitiveKind;
  /** Indice del primo carattere, in unita' di `String.prototype.slice`. */
  readonly start: number;
  /** Indice del primo carattere DOPO il dato. */
  readonly end: number;
  /** Il testo esatto trovato, cosi' come compare. */
  readonly value: string;
  /** Cio' che lo sostituirebbe se l'utente confermasse. */
  readonly replacement: string;
}

// ---------------------------------------------------------------------------
// Codice fiscale
// ---------------------------------------------------------------------------

/**
 * Le lettere che l'omocodia mette al posto delle cifre quando due persone
 * otterrebbero lo stesso codice. Sono nell'ordine che vale come 0..9.
 */
const OMOCODIA = "LMNPQRSTUV";

/**
 * La forma di un codice fiscale, omocodia compresa. Da sola non basta e non
 * pretende di bastare: serve solo a trovare i candidati da passare alla cifra
 * di controllo, che e' cio' che decide davvero.
 */
const RE_CODICE_FISCALE = /[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]/g;

/**
 * I valori dispari della tabella ministeriale, per A..Z. Le cifre 0..9 valgono
 * come A..J — non e' una coincidenza da sfruttare per brevita', e' come e'
 * definita la tabella — quindi un indice solo basta per entrambe.
 */
const DISPARI = [
  1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23,
];

/** 0..25 per A..Z e per le cifre 0..9, oppure `null` per qualunque altra cosa. */
function indiceAlfanumerico(c: string): number | null {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  if (code >= 65 && code <= 90) {
    return code - 65;
  }
  return null;
}

/**
 * La cifra di controllo del codice fiscale, calcolata sui primi quindici
 * caratteri come sono scritti — le lettere dell'omocodia comprese, che nel
 * calcolo valgono per se stesse e non per la cifra che rappresentano.
 */
export function codiceFiscaleValido(codice: string): boolean {
  if (codice.length !== 16) {
    return false;
  }

  let somma = 0;
  for (let i = 0; i < 15; i += 1) {
    const indice = indiceAlfanumerico(codice.charAt(i));
    if (indice === null) {
      return false;
    }
    // Posizione UMANA, non indice: il primo carattere e' dispari.
    const dispari = i % 2 === 0;
    somma += dispari ? (DISPARI[indice] ?? 0) : indice;
  }

  const atteso = String.fromCharCode(65 + (somma % 26));
  return codice.charAt(15) === atteso;
}

// ---------------------------------------------------------------------------
// IBAN
// ---------------------------------------------------------------------------

/**
 * La forma di un IBAN, con gli spazi che la gente ci mette davvero quando lo
 * copia da un estratto conto. Il minimo mondiale e' quindici caratteri
 * (Norvegia), il massimo trentaquattro.
 *
 * Il separatore sta solo FRA due caratteri e mai in coda: una regex che si
 * mangia anche lo spazio finale fa finire `end` sulla prima lettera della
 * parola dopo, e il controllo di adiacenza qui sotto scarta il dato invece di
 * riconoscerlo. Il sintomo e' che l'IBAN si trova quando chiude la frase e non
 * si trova quando sta in mezzo.
 */
const RE_IBAN = /[A-Z]{2}[0-9]{2}(?:[ ]?[A-Z0-9]){11,30}/g;

/**
 * Il resto 97 della norma ISO 13616: si spostano in fondo le prime quattro
 * posizioni, ogni lettera diventa il suo numero, e cio' che resta diviso 97
 * deve dare uno.
 *
 * Il modulo si calcola a pezzi perche' un IBAN di trentaquattro caratteri
 * diventa un numero di quaranta cifre, che in un `number` non ci sta: sarebbe
 * il tipo di baco che passa i test con gli IBAN italiani e si presenta il
 * giorno che qualcuno incolla un conto maltese.
 */
export function ibanValido(iban: string): boolean {
  const pulito = iban.replace(/\s/g, "").toUpperCase();
  if (pulito.length < 15 || pulito.length > 34) {
    return false;
  }
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(pulito)) {
    return false;
  }

  const riordinato = pulito.slice(4) + pulito.slice(0, 4);

  let resto = 0;
  for (const carattere of riordinato) {
    const indice = indiceAlfanumerico(carattere);
    if (indice === null) {
      return false;
    }
    const pezzo = /[0-9]/.test(carattere) ? String(indice) : String(indice + 10);
    for (const cifra of pezzo) {
      resto = (resto * 10 + Number(cifra)) % 97;
    }
  }

  return resto === 1;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Non la RFC 5322, che nessuna regex esprime davvero, ma cio' che una email
 * scritta da un essere umano dentro una frase e' fatta. Il TLD di almeno due
 * lettere evita di trasformare `@casa` o `@2` in un indirizzo.
 */
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// ---------------------------------------------------------------------------
// Telefono
// ---------------------------------------------------------------------------

/**
 * Le tre forme, e nient'altro.
 *
 * E' il rilevatore piu' stretto del file perche' e' l'unico il cui dato
 * assomiglia a qualunque altro numero: una durata, un importo, un numero di
 * protocollo, un anno. Una regex generosa qui cancellerebbe «servono 3287654321
 * euro» tanto quanto un cellulare, e sopra ogni cosa cancellerebbe cose che con
 * un telefono non c'entrano niente.
 *
 *  1. `+` seguito da 8..15 cifre e' la forma E.164 e si riconosce da sola: il
 *     `+` davanti a un numero lungo non capita per caso.
 *  2. dieci cifre che iniziano per 3 sono un cellulare italiano. La lunghezza
 *     esatta e' cio' che rende la regola sicura — nove o undici cifre no.
 *  3. da nove a undici cifre che iniziano per 0 sono un fisso italiano. Lo zero
 *     iniziale e' quello che esclude gli anni, gli importi e i conteggi, che
 *     con uno zero davanti non si scrivono.
 *
 * Non c'e' nessuna forma senza prefisso: sette cifre nude possono essere
 * qualunque cosa, e la §9 non vale il prezzo di cancellarle.
 *
 * Come per l'IBAN, il separatore non compare mai in coda: `328 123 4567 poi`
 * finirebbe per includere lo spazio, e il numero verrebbe scartato perche'
 * sembra attaccato alla parola successiva.
 */
const RE_TELEFONO =
  /\+(?:[\s.-]?[0-9]){8,15}|3(?:[\s.-]?[0-9]){9}|0(?:[\s.-]?[0-9]){8,10}/g;

const RE_CIFRA = /[0-9]/g;

/** Un carattere che, attaccato al dato, dice che il dato non finisce li'. */
function attaccato(testo: string, indice: number): boolean {
  const c = testo.charAt(indice);
  return c !== "" && /[0-9A-Za-z]/.test(c);
}

// ---------------------------------------------------------------------------
// Composizione
// ---------------------------------------------------------------------------

interface Candidato extends SensitiveMatch {
  /** Piu' basso vince quando due candidati si sovrappongono. */
  readonly priorita: number;
}

function raccogli(
  testo: string,
  re: RegExp,
  kind: SensitiveKind,
  priorita: number,
  accetta: (value: string) => boolean,
): Candidato[] {
  const trovati: Candidato[] = [];
  // `lastIndex` e' stato globale su un letterale di modulo: azzerarlo qui e'
  // cio' che impedisce alla seconda chiamata di partire da dove si era fermata
  // la prima. Ha morso abbastanza gente da meritare una riga.
  re.lastIndex = 0;

  let match = re.exec(testo);
  while (match !== null) {
    const value = match[0];
    const start = match.index;
    const end = start + value.length;

    if (accetta(value)) {
      trovati.push({
        kind,
        start,
        end,
        value,
        replacement: sensitivePlaceholder[kind],
        priorita,
      });
    }

    // Un solo carattere avanti e non `end`: due dati possono toccarsi, e con
    // `exec` in modalita' globale saltare oltre la fine di un candidato
    // scartato nasconderebbe quello che comincia dentro di lui.
    re.lastIndex = start + 1;
    match = re.exec(testo);
  }

  return trovati;
}

/**
 * Tutti i dati personali riconoscibili in un testo, in ordine di comparsa e
 * senza sovrapposizioni.
 *
 * L'ordine di priorita' non e' estetico. Le cifre di un IBAN contengono
 * sequenze che il rilevatore dei telefoni riconoscerebbe volentieri, e un
 * indirizzo email contiene un dominio che assomiglia a poco altro ma il cui
 * pezzo prima della chiocciola puo' essere qualunque cosa: chi ha il criterio
 * piu' forte decide per primo, e chi arriva dopo si tiene solo cio' che avanza.
 */
export function detectSensitive(testo: string): readonly SensitiveMatch[] {
  const candidati = [
    ...raccogli(testo, RE_IBAN, SensitiveKind.IBAN, 0, ibanValido),
    ...raccogli(testo, RE_CODICE_FISCALE, SensitiveKind.CODICE_FISCALE, 1, codiceFiscaleValido),
    ...raccogli(testo, RE_EMAIL, SensitiveKind.EMAIL, 2, () => true),
    ...raccogli(testo, RE_TELEFONO, SensitiveKind.TELEFONO, 3, () => true),
  ];

  // Un candidato che comincia o finisce in mezzo a una parola non e' un dato,
  // e' un pezzo di qualcos'altro. Il controllo sta qui e non nelle regex
  // perche' `\b` non si comporta come ci si aspetta accanto a un `+`.
  const interi = candidati.filter(
    (c) => !attaccato(testo, c.start - 1) && !attaccato(testo, c.end),
  );

  // Le cifre attorno a un telefono vanno guardate anche attraverso i
  // separatori: in «prot. 12 0612345678» il fisso e' un fisso, ma in
  // «0612345678999» non c'e' nessun telefono, c'e' un numero lungo.
  const plausibili = interi.filter((c) => {
    if (c.kind !== SensitiveKind.TELEFONO) {
      return true;
    }
    const cifre = c.value.match(RE_CIFRA)?.length ?? 0;
    return cifre >= 9 && cifre <= 16;
  });

  const ordinati = [...plausibili].sort((a, b) => {
    if (a.priorita !== b.priorita) {
      return a.priorita - b.priorita;
    }
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    // A parita' di tutto vince il piu' lungo: e' quello che copre piu' dato.
    return b.end - b.start - (a.end - a.start);
  });

  const accettati: Candidato[] = [];
  for (const candidato of ordinati) {
    const sovrapposto = accettati.some((a) => candidato.start < a.end && a.start < candidato.end);
    if (!sovrapposto) {
      accettati.push(candidato);
    }
  }

  return accettati
    .sort((a, b) => a.start - b.start)
    .map(({ kind, start, end, value, replacement }) => ({
      kind,
      start,
      end,
      value,
      replacement,
    }));
}

/**
 * Sostituisce nel testo solo i tratti indicati, dall'ultimo al primo.
 *
 * Da destra a sinistra perche' ogni sostituzione cambia la lunghezza del testo:
 * andando in avanti, il secondo `start` punterebbe gia' al posto sbagliato. E'
 * il baco classico di questa funzione, e non si vede finche' i dati da
 * sostituire sono uno solo — cioe' in tutti i test scritti di fretta.
 */
export function applyRedactions(
  testo: string,
  matches: readonly SensitiveMatch[],
): string {
  const ordinati = [...matches].sort((a, b) => b.start - a.start);

  let risultato = testo;
  for (const match of ordinati) {
    risultato = risultato.slice(0, match.start) + match.replacement + risultato.slice(match.end);
  }

  return risultato;
}
