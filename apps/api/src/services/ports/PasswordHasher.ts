export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;

  /**
   * Hash valido di una password che nessuno conosce.
   *
   * Serve al login quando l'utente non esiste: senza, il ramo "utente assente"
   * risponderebbe in un millisecondo e quello "password sbagliata" in cinquanta,
   * e la differenza e' un oracolo che dice quali indirizzi sono registrati.
   * Verificare comunque contro questo hash rende i due rami indistinguibili.
   */
  readonly dummyHash: string;
}
