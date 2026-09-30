import type {
  GoogleIdentity,
  GoogleIdTokenVerifier,
} from "../../services/ports/GoogleIdTokenVerifier.js";

/**
 * Google finto, per lo sviluppo e per i test d'integrazione.
 *
 * Il «token» e' un prefisso seguito da un JSON in base64url con l'identita' che
 * il test vuole far passare: nessuna firma, nessuna rete. Lo costruisce
 * `tokenGoogleFinto`, cosi' un test d'integrazione puo' dire «entra come questo
 * account Google, emesso adesso» con una riga, e attraversare la rotta vera.
 *
 * Qualunque stringa che non abbia la forma giusta vale `null`, come un token
 * falso per quello vero: e' il modo per provare il ramo 401 senza una chiave.
 *
 * In produzione non si accende: `env.ts` rifiuta `GOOGLE_AUTH_PROVIDER=fake`
 * con `NODE_ENV=production`, per la stessa ragione degli altri finti — qui con
 * un motivo in piu', perche' questo finto apre qualunque conto a chiunque sappia
 * scrivere un JSON.
 */

const PREFISSO = "finto-google.";

export interface IdentitaGoogleFinta {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified?: boolean;
  /** Predefinito: adesso. */
  readonly issuedAt?: Date;
}

export function tokenGoogleFinto(identita: IdentitaGoogleFinta): string {
  const corpo = {
    sub: identita.sub,
    email: identita.email,
    emailVerified: identita.emailVerified ?? true,
    issuedAt: (identita.issuedAt ?? new Date()).toISOString(),
  };
  return PREFISSO + Buffer.from(JSON.stringify(corpo), "utf8").toString("base64url");
}

export class FakeGoogleIdTokenVerifier implements GoogleIdTokenVerifier {
  #chiamate = 0;
  #guastoProssimo: { readonly error: unknown } | null = null;

  /** Quante verifiche sono state chieste: serve a provare che un ramo non verifica. */
  get chiamate(): number {
    return this.#chiamate;
  }

  /** La prossima verifica lancia invece di rispondere: Google che non risponde. */
  guastoProssimo(error?: unknown): this {
    this.#guastoProssimo = { error: error ?? new Error("FakeGoogleIdTokenVerifier: Google giu'") };
    return this;
  }

  async verify(idToken: string): Promise<GoogleIdentity | null> {
    this.#chiamate += 1;
    if (this.#guastoProssimo !== null) {
      const { error } = this.#guastoProssimo;
      this.#guastoProssimo = null;
      throw error;
    }

    if (!idToken.startsWith(PREFISSO)) {
      return null;
    }

    let corpo: unknown;
    try {
      corpo = JSON.parse(Buffer.from(idToken.slice(PREFISSO.length), "base64url").toString("utf8"));
    } catch {
      return null;
    }

    if (
      typeof corpo !== "object" ||
      corpo === null ||
      !("sub" in corpo) ||
      !("email" in corpo) ||
      !("emailVerified" in corpo) ||
      !("issuedAt" in corpo) ||
      typeof corpo.sub !== "string" ||
      typeof corpo.email !== "string" ||
      typeof corpo.emailVerified !== "boolean" ||
      typeof corpo.issuedAt !== "string"
    ) {
      return null;
    }

    return {
      sub: corpo.sub,
      email: corpo.email.trim().toLowerCase(),
      emailVerified: corpo.emailVerified,
      issuedAt: new Date(corpo.issuedAt),
    };
  }
}
