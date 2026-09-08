import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { JoseTokenIssuer } from "../../apps/api/src/infra/JoseTokenIssuer.js";
import { createRequireAuth } from "../../apps/api/src/http/middleware/requireAuth.js";
import { createAuthService, type AuthService } from "../../apps/api/src/services/auth.service.js";
import type { FamilyRegistry } from "../../apps/api/src/services/ports/AuthRepository.js";
import { FakePasswordHasher, testAuthConfig } from "../support/auth.js";
import { FixedClock } from "../support/FixedClock.js";
import { InMemoryAuthRepository } from "../support/InMemoryAuthRepository.js";

/**
 * `requireAuth`, cioe' il punto in cui si decide chi entra.
 *
 * Fino a ieri questo middleware era una funzione pura: prendeva una stringa,
 * ne verificava la firma, e non chiedeva niente a nessuno. Adesso fa una
 * domanda al database — «questa sessione esiste ancora?» — e quella domanda e'
 * l'unica cosa che impedisce a un token rubato di continuare a funzionare per
 * quindici minuti dopo che l'utente ha premuto "esci".
 *
 * Sbagliarla non si vede: la firma resta valida, la risposta resta 200, e
 * l'unico modo di accorgersene e' che qualcuno rubi un token e lo usi. Percio'
 * i casi qui sotto non si limitano a contare i 401. Guardano *quale* famiglia
 * viene chiesta — un `isFamilyActive` invocato sempre sullo stesso valore
 * passerebbe qualunque conteggio senza proteggere niente — e guardano *quando*
 * viene chiesta, perche' interrogare il database prima di aver verificato la
 * firma trasformerebbe ogni stringa spedita da un anonimo in una query.
 *
 * ## Due strati, di proposito
 *
 * La prima meta' del file usa un registro finto: dice cosa fa il middleware
 * davanti a una risposta o all'altra, e lo dice senza intermediari.
 *
 * La seconda meta' non finge niente. Monta il servizio vero, il repository in
 * memoria e questo stesso middleware, e chiede le cose in italiano: dopo il
 * logout l'access token apre ancora? E dopo un furto? E il logout sul telefono
 * chiude anche il portatile? Sono domande sul sistema, non sul middleware, e
 * nessuna delle due meta' da sola risponderebbe: il registro finto potrebbe
 * essere d'accordo con un middleware che chiede la cosa sbagliata, e il
 * servizio da solo non sa che esiste un `Authorization`.
 */

const T0 = new Date("2026-04-01T10:00:00.000Z");
const EMAIL = "chi@esempio.it";
const PASSWORD = "una-password-lunga-abbastanza";
const CONFIG = testAuthConfig();

interface Esito {
  /** Cio' che il middleware ha messo in `req.auth`, se ha lasciato passare. */
  readonly auth: { userId: string } | undefined;
  /** L'errore consegnato a `next`, o `null` se e' passato. */
  readonly errore: { code?: string } | null;
}

interface Registro extends FamilyRegistry {
  /** Le famiglie per cui e' stato interrogato, in ordine. */
  readonly chieste: string[];
}

function registro(attive: readonly string[]): Registro {
  const chieste: string[] = [];
  return {
    chieste,
    async isFamilyActive(familyId: string): Promise<boolean> {
      chieste.push(familyId);
      return attive.includes(familyId);
    },
  };
}

function emittente(): JoseTokenIssuer {
  return new JoseTokenIssuer({
    accessSecret: CONFIG.accessSecret,
    accessTtlSeconds: CONFIG.accessTokenTtlSeconds,
  });
}

/**
 * Esegue il middleware su una richiesta finta.
 *
 * `handler` e' tipato `RequestHandler`, che dichiara di restituire `void`; la
 * funzione vera e' `async`, quindi restituisce una promessa. Senza il cast il
 * test proseguirebbe prima che il middleware abbia finito, e ogni asserzione
 * guarderebbe uno stato a meta'.
 */
async function chiama(params: {
  header?: string | undefined;
  families: FamilyRegistry;
  tokens?: JoseTokenIssuer | undefined;
  clock?: FixedClock | undefined;
}): Promise<Esito> {
  const handler = createRequireAuth({
    tokens: params.tokens ?? emittente(),
    clock: params.clock ?? new FixedClock(T0),
    families: params.families,
  });

  const req = {
    get: (name: string): string | undefined =>
      name.toLowerCase() === "authorization" ? params.header : undefined,
  } as unknown as Request;

  let errore: { code?: string } | null = null;
  const next = ((consegnato?: unknown) => {
    if (consegnato !== undefined) {
      errore = consegnato as { code?: string };
    }
  }) as unknown as NextFunction;

  await (handler(req, {} as Response, next) as unknown as Promise<void>);

  return { auth: req.auth, errore };
}

describe("requireAuth: prima ancora di guardare la sessione", () => {
  it("senza header e' 401 e il database non viene toccato", async () => {
    // Una richiesta anonima non deve costare una query: sarebbe un modo
    // gratuito, da fuori e senza credenziali, di far lavorare Postgres.
    const reg = registro([]);
    const esito = await chiama({ families: reg });

    expect(esito.errore).toMatchObject({ code: "UNAUTHORIZED" });
    expect(esito.auth).toBeUndefined();
    expect(reg.chieste).toEqual([]);
  });

  it("uno schema che non e' Bearer non arriva al database", async () => {
    const reg = registro([]);
    const esito = await chiama({ families: reg, header: "Basic aGVsbG86d29ybGQ=" });

    expect(esito.errore).toMatchObject({ code: "UNAUTHORIZED" });
    expect(reg.chieste).toEqual([]);
  });

  it("una firma falsa non arriva al database", async () => {
    // La verifica della firma viene prima della lettura, e l'ordine e' la
    // proprieta': al contrario, chiunque potrebbe far interrogare l'indice
    // spedendo stringhe a caso.
    const estraneo = new JoseTokenIssuer({
      accessSecret: "tutt-altro-segreto-lungo-abbastanza-per-hs256",
      accessTtlSeconds: CONFIG.accessTokenTtlSeconds,
    });
    const token = await estraneo.issueAccessToken({
      userId: "u-1",
      familyId: "fam-1",
      now: T0,
    });

    const reg = registro(["fam-1"]);
    const esito = await chiama({ families: reg, header: `Bearer ${token}` });

    expect(esito.errore).toMatchObject({ code: "TOKEN_INVALID" });
    expect(reg.chieste).toEqual([]);
  });

  it("un token scaduto non arriva al database", async () => {
    const tokens = emittente();
    const token = await tokens.issueAccessToken({ userId: "u-1", familyId: "fam-1", now: T0 });
    const clock = new FixedClock(T0);
    clock.advanceSeconds(CONFIG.accessTokenTtlSeconds + 60);

    const reg = registro(["fam-1"]);
    const esito = await chiama({ families: reg, tokens, clock, header: `Bearer ${token}` });

    expect(esito.errore).toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(reg.chieste).toEqual([]);
  });
});

describe("requireAuth: la sessione dietro al token", () => {
  async function conFamiglia(
    famigliaDelToken: string,
    attive: readonly string[],
  ): Promise<Esito & { reg: Registro }> {
    const tokens = emittente();
    const token = await tokens.issueAccessToken({
      userId: "u-1",
      familyId: famigliaDelToken,
      now: T0,
    });
    const reg = registro(attive);
    const esito = await chiama({ families: reg, tokens, header: `Bearer ${token}` });
    return { ...esito, reg };
  }

  it("famiglia viva: passa, con lo userId del token", async () => {
    const esito = await conFamiglia("fam-1", ["fam-1"]);

    expect(esito.errore).toBeNull();
    expect(esito.auth).toEqual({ userId: "u-1" });
  });

  it("famiglia revocata: 401, e req.auth resta vuoto", async () => {
    // Il caso per cui esiste tutto il resto. `req.auth` conta quanto il 401:
    // un middleware che segnalasse l'errore ma lasciasse comunque il contesto
    // autenticato regalerebbe la sessione a qualunque gestore montato dopo che
    // non guardasse l'esito.
    const esito = await conFamiglia("fam-1", []);

    expect(esito.errore).toMatchObject({ code: "UNAUTHORIZED" });
    expect(esito.auth).toBeUndefined();
  });

  it("chiede proprio la famiglia scritta nel token", async () => {
    // Chiedere sempre la stessa, o chiedere lo userId al posto della famiglia,
    // supererebbe ogni conteggio di chiamate e non proteggerebbe niente.
    const { reg } = await conFamiglia("fam-42", ["fam-42"]);

    expect(reg.chieste).toEqual(["fam-42"]);
  });

  it("non basta che una qualsiasi famiglia sia viva", async () => {
    // Un altro dispositivo dello stesso utente e' ancora dentro. Non e' un
    // motivo per far passare questo token: le sessioni si chiudono una per
    // volta, ed e' esattamente cio' che si chiede quando si perde il telefono.
    const esito = await conFamiglia("fam-telefono", ["fam-portatile"]);

    expect(esito.errore).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("la sessione chiusa e' UNAUTHORIZED, non TOKEN_REUSED", async () => {
    // Non e' pignoleria sui codici. Il client di `shared` ritenta la rotazione
    // su un 401 tranne che su TOKEN_REUSED: mandare TOKEN_REUSED da qui gli
    // farebbe saltare il tentativo, e un utente che ha solo cambiato
    // dispositivo si troverebbe buttato fuori senza che nessuno abbia rubato
    // niente.
    const esito = await conFamiglia("fam-1", []);

    expect(esito.errore).toMatchObject({ code: "UNAUTHORIZED" });
    expect(esito.errore?.code).not.toBe("TOKEN_REUSED");
  });
});

describe("dal logout al 401, senza database", () => {
  interface Mondo {
    readonly service: AuthService;
    readonly repo: InMemoryAuthRepository;
    readonly clock: FixedClock;
    readonly apre: (accessToken: string) => Promise<boolean>;
  }

  function mondo(): Mondo {
    const repo = new InMemoryAuthRepository();
    const clock = new FixedClock(T0);
    const tokens = emittente();
    const service = createAuthService({
      repo,
      hasher: new FakePasswordHasher(),
      tokens,
      clock,
      config: CONFIG,
    });

    return {
      service,
      repo,
      clock,
      apre: async (accessToken: string): Promise<boolean> => {
        const esito = await chiama({
          families: repo,
          tokens,
          clock,
          header: `Bearer ${accessToken}`,
        });
        return esito.errore === null && esito.auth !== undefined;
      },
    };
  }

  it("dopo il logout l'access token non apre piu' niente", async () => {
    // La promessa che "esci" fa all'utente. Prima di questo cambiamento era
    // mantenuta a meta': i refresh morivano subito, l'access token restava
    // buono fino a quindici minuti dopo — cioe' per tutto il tempo in cui
    // qualcuno che avesse rubato il telefono avrebbe potuto usarlo.
    const m = mondo();
    const s = await m.service.signup({ email: EMAIL, password: PASSWORD });

    expect(await m.apre(s.tokens.accessToken)).toBe(true);

    await m.service.logout(s.tokens.refreshToken);

    expect(await m.apre(s.tokens.accessToken)).toBe(false);
  });

  it("il logout su un dispositivo non chiude l'altro", async () => {
    // Il prezzo da non pagare. Una revoca che guardasse l'utente invece della
    // famiglia chiuderebbe qui, e "esci dal telefono" diventerebbe "esci da
    // tutto", che nessuno ha chiesto.
    const m = mondo();
    const telefono = await m.service.signup({ email: EMAIL, password: PASSWORD });
    const portatile = await m.service.login({ email: EMAIL, password: PASSWORD });

    await m.service.logout(telefono.tokens.refreshToken);

    expect(await m.apre(telefono.tokens.accessToken)).toBe(false);
    expect(await m.apre(portatile.tokens.accessToken)).toBe(true);
  });

  it("il riuso rilevato spegne anche l'access token del ladro", async () => {
    // La reuse detection esisteva gia' e uccideva la famiglia dei refresh. Ora
    // arriva fino in fondo: scoperto il furto, non resta in giro un token che
    // apre ancora. Prima restava, ed era il quarto d'ora piu' scomodo da
    // spiegare dell'intero sistema.
    const m = mondo();
    const primo = await m.service.signup({ email: EMAIL, password: PASSWORD });
    m.clock.advanceSeconds(1);
    const secondo = await m.service.refresh(primo.tokens.refreshToken);

    await expect(m.service.refresh(primo.tokens.refreshToken)).rejects.toMatchObject({
      code: "TOKEN_REUSED",
    });

    expect(await m.apre(secondo.tokens.accessToken)).toBe(false);
  });

  it("una rotazione normale non butta fuori chi ha ancora il token di prima", async () => {
    // L'altro sbaglio, opposto e ugualmente invisibile: se la rotazione
    // aprisse una famiglia nuova, o se la revoca del vecchio refresh contasse
    // come sessione chiusa, ogni rinnovo scollegherebbe le richieste ancora in
    // volo con l'access token precedente. Sarebbero errori sporadici sotto
    // rete lenta, cioe' i piu' difficili da attribuire a una causa.
    const m = mondo();
    const primo = await m.service.signup({ email: EMAIL, password: PASSWORD });
    m.clock.advanceSeconds(1);
    await m.service.refresh(primo.tokens.refreshToken);

    expect(await m.apre(primo.tokens.accessToken)).toBe(true);
  });

  it("l'access token nato dalla rotazione apre a sua volta", async () => {
    // Se il rinnovo firmasse il token con una famiglia inventata invece di
    // quella della catena, il difetto non comparirebbe subito: la sessione
    // funzionerebbe finche' dura il token precedente e poi smetterebbe di
    // colpo. L'utente verrebbe buttato fuori a ogni rinnovo, e nel log non ci
    // sarebbe niente che assomigli a una causa.
    const m = mondo();
    const primo = await m.service.signup({ email: EMAIL, password: PASSWORD });
    m.clock.advanceSeconds(1);
    const secondo = await m.service.refresh(primo.tokens.refreshToken);

    expect(await m.apre(secondo.tokens.accessToken)).toBe(true);
  });
});
