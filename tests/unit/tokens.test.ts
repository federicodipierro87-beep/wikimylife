import { describe, expect, it } from "vitest";
import { AppError } from "../../apps/api/src/errors/AppError.js";
import { JoseTokenIssuer } from "../../apps/api/src/infra/JoseTokenIssuer.js";

/**
 * `JoseTokenIssuer`.
 *
 * La scadenza si verifica passando date, non con `vi.useFakeTimers()`: `now` e'
 * un parametro sia di `issueAccessToken` sia di `verifyAccessToken` proprio per
 * questo. Il test dice "emesso alle 10:00, verificato alle 10:16" e si legge.
 */

const SECRET = "un-segreto-di-test-lungo-almeno-trentadue-caratteri";
const TTL = 15 * 60;
const T0 = new Date("2026-04-01T10:00:00.000Z");

function issuer(secret = SECRET): JoseTokenIssuer {
  return new JoseTokenIssuer({ accessSecret: secret, accessTtlSeconds: TTL });
}

function at(offsetSeconds: number): Date {
  return new Date(T0.getTime() + offsetSeconds * 1000);
}

describe("access token", () => {
  it("torna il sub emesso", async () => {
    const tokens = issuer();
    const token = await tokens.issueAccessToken({ userId: "u-1", now: T0 });

    await expect(tokens.verifyAccessToken(token, at(60))).resolves.toEqual({ userId: "u-1" });
  });

  it("e' ancora valido un secondo prima della scadenza", async () => {
    const tokens = issuer();
    const token = await tokens.issueAccessToken({ userId: "u-1", now: T0 });

    await expect(tokens.verifyAccessToken(token, at(TTL - 1))).resolves.toEqual({
      userId: "u-1",
    });
  });

  it("scade dopo il TTL", async () => {
    const tokens = issuer();
    const token = await tokens.issueAccessToken({ userId: "u-1", now: T0 });

    // Un minuto oltre: jose tollera qualche secondo di scarto sull'orologio, e
    // asserire sul secondo esatto renderebbe il test fragile per un motivo che
    // non interessa a nessuno.
    await expect(tokens.verifyAccessToken(token, at(TTL + 60))).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
    });
  });

  it("rifiuta un token firmato con un altro segreto", async () => {
    const foreign = issuer("un-segreto-diverso-ma-comunque-lungo-abbastanza");
    const token = await foreign.issueAccessToken({ userId: "u-1", now: T0 });

    await expect(issuer().verifyAccessToken(token, at(60))).rejects.toMatchObject({
      code: "TOKEN_INVALID",
    });
  });

  it("rifiuta un token manomesso", async () => {
    const tokens = issuer();
    const token = await tokens.issueAccessToken({ userId: "u-1", now: T0 });
    const [header, payload, signature] = token.split(".");
    // Payload di un altro utente, firma originale.
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: "u-2", typ: "access" }),
      "utf8",
    ).toString("base64url");

    await expect(
      tokens.verifyAccessToken(
        `${String(header)}.${forgedPayload}.${String(signature)}`,
        at(60),
      ),
    ).rejects.toMatchObject({ code: "TOKEN_INVALID" });

    expect(payload).not.toBe(forgedPayload);
  });

  it("rifiuta qualcosa che non e' nemmeno un JWT", async () => {
    await expect(issuer().verifyAccessToken("non-un-token", T0)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("non e' un refresh token: il typ e' verificato", async () => {
    // Un token di refresh accettato dove serve un access token sarebbe un
    // aggiramento del TTL breve: il refresh vive 30 giorni.
    const tokens = issuer();
    const token = await tokens.issueAccessToken({ userId: "u-1", now: T0 });
    const payload = JSON.parse(
      Buffer.from(String(token.split(".")[1]), "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    expect(payload["typ"]).toBe("access");
    expect(payload["sub"]).toBe("u-1");
  });

  it("non mette nel payload niente oltre a sub, typ e i claim standard", async () => {
    // Un JWT e' leggibile da chiunque lo intercetti. L'email nel payload
    // sarebbe una fuga di dati gratuita.
    const tokens = issuer();
    const token = await tokens.issueAccessToken({ userId: "u-1", now: T0 });
    const payload = JSON.parse(
      Buffer.from(String(token.split(".")[1]), "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      "aud",
      "exp",
      "iat",
      "iss",
      "jti",
      "nbf",
      "sub",
      "typ",
    ]);
  });
});

describe("refresh token", () => {
  it("ha almeno 256 bit di entropia ed e' base64url", () => {
    const token = issuer().generateRefreshToken();

    // 32 byte in base64url senza padding = 43 caratteri.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("non si ripete", () => {
    const tokens = issuer();
    const generated = new Set(Array.from({ length: 500 }, () => tokens.generateRefreshToken()));

    expect(generated.size).toBe(500);
  });

  it("l'hash e' sha256 esadecimale, deterministico e diverso dal token", () => {
    const tokens = issuer();
    const token = tokens.generateRefreshToken();
    const hash = tokens.hashRefreshToken(token);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(tokens.hashRefreshToken(token));
    expect(hash).not.toContain(token);
  });

  it("hash diversi per token diversi", () => {
    const tokens = issuer();
    expect(tokens.hashRefreshToken("a")).not.toBe(tokens.hashRefreshToken("b"));
  });

  it("l'hash non dipende dal segreto JWT", () => {
    // Se dipendesse, ruotare JWT_ACCESS_SECRET invaliderebbe in silenzio ogni
    // refresh token gia' salvato: tutti gli utenti buttati fuori senza che
    // niente nei log spieghi il perche'.
    const a = issuer();
    const b = issuer("tutt-altro-segreto-lungo-abbastanza-per-hs256");

    expect(a.hashRefreshToken("stesso-token")).toBe(b.hashRefreshToken("stesso-token"));
  });

  it("newFamilyId produce identificatori distinti", () => {
    const tokens = issuer();
    const ids = new Set(Array.from({ length: 200 }, () => tokens.newFamilyId()));

    expect(ids.size).toBe(200);
  });
});
