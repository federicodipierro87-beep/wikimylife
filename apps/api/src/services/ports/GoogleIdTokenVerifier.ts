/**
 * Chi ha firmato questo ID token di Google, se l'ha firmato Google.
 *
 * Una porta e non una chiamata a `jose` dentro il servizio, per la stessa
 * ragione di `TokenIssuer` e `PasswordHasher`: il servizio decide *cosa fare*
 * di un'identita' — aprire, collegare, creare, rifiutare — e quelle decisioni
 * si provano in millisecondi con un finto. La crittografia e la rete stanno
 * dall'altra parte, e si provano per conto loro.
 *
 * ## Due modi di dire no, e sono diversi
 *
 * `null` vuol dire «questo token non vale»: firma sbagliata, scaduto, emesso
 * per un'altra applicazione, malformato. E' colpa di chi l'ha mandato, e il
 * servizio risponde 401.
 *
 * Un'eccezione vuol dire «non sono riuscito a chiederlo»: le chiavi di Google
 * non si scaricano, la rete e' giu'. Non e' colpa di nessuno dei due, e
 * rispondere 401 direbbe a un utente legittimo che il suo account Google non
 * va — un errore che lo manda a cercare il problema nel posto sbagliato.
 */
export interface GoogleIdTokenVerifier {
  verify(idToken: string): Promise<GoogleIdentity | null>;
}

export interface GoogleIdentity {
  /** L'identificativo stabile dell'account Google. Non cambia mai. */
  readonly sub: string;
  /** L'indirizzo, gia' in minuscolo: e' la forma in cui sta nel database. */
  readonly email: string;
  /** Se Google garantisce che l'indirizzo appartiene a chi ha l'account. */
  readonly emailVerified: boolean;
  /** Quando Google ha firmato il token: serve a capire se la prova e' fresca. */
  readonly issuedAt: Date;
}
