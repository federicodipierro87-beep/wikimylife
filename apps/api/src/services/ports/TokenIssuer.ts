export interface AccessTokenClaims {
  readonly userId: string;
  /**
   * La famiglia di refresh token da cui questo access token e' nato.
   *
   * Non serve a sapere chi sia l'utente — a quello basta `sub`. Serve a poterlo
   * revocare: senza, un access token e' un foglietto firmato che nessuno puo'
   * piu' ritirare, e "esci" resta una promessa a meta' per tutta la durata del
   * TTL. Con la famiglia dentro, la domanda «questa sessione esiste ancora?» ha
   * una risposta, ed e' una riga di database.
   *
   * La famiglia e non lo userId: le sessioni sono indipendenti per dispositivo,
   * e uscire dal telefono non deve buttare fuori dal portatile.
   */
  readonly familyId: string;
}

export interface TokenIssuer {
  /**
   * JWT HS256, payload `{ sub, typ: "access", fid }`, vita breve.
   * `now` arriva dal `Clock`: e' cio' che permette di testare la scadenza senza
   * fake timer globali.
   */
  issueAccessToken(input: {
    readonly userId: string;
    readonly familyId: string;
    readonly now: Date;
  }): Promise<string>;

  /** Lancia `AppError` (TOKEN_EXPIRED / TOKEN_INVALID). Mai `null` silenzioso. */
  verifyAccessToken(token: string, now: Date): Promise<AccessTokenClaims>;

  /**
   * Il refresh token NON e' un JWT: 32 byte casuali in base64url.
   *
   * Un JWT di refresh richiederebbe comunque una lettura del database per
   * essere revocabile — quindi non risparmierebbe nulla e aggiungerebbe solo
   * superficie: un secondo algoritmo di firma, un secondo segreto, un secondo
   * modo di sbagliare la validazione.
   */
  generateRefreshToken(): string;

  /**
   * sha256 esadecimale. Non argon2: l'input ha gia' 256 bit di entropia, non e'
   * una password indovinabile. Un KDF lento qui pagherebbe solo latenza.
   */
  hashRefreshToken(token: string): string;

  newFamilyId(): string;
}
