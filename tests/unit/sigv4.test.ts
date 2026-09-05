import { describe, expect, it } from "vitest";
import {
  amzDate,
  canonicalRequest,
  encodeKey,
  EMPTY_PAYLOAD_SHA256,
  signingKey,
  signRequest,
  uriEncode,
} from "../../apps/api/src/providers/s3/sigv4.js";

/**
 * La firma SigV4 e' scritta a mano, quindi va confrontata con qualcosa di
 * esterno: un'implementazione sbagliata non si nota finche' S3 non risponde
 * `SignatureDoesNotMatch`, e a quel punto il messaggio non dice quale dei sei
 * passaggi e' quello rotto.
 *
 * I valori qui sotto vengono dalla documentazione AWS e dalla
 * `aws-sig-v4-test-suite`. Non sono stati calcolati con questo codice: e' il
 * punto.
 */

// Le credenziali finte usate da tutti gli esempi ufficiali.
const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

describe("signingKey", () => {
  it("riproduce la catena di derivazione documentata da AWS", () => {
    // Dalla sezione «Examples of how to derive a signing key» della guida.
    const key = signingKey(SECRET, "20120215", "us-east-1", "iam");
    expect(key.toString("hex")).toBe(
      "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
    );
  });

  it("cambia se cambia anche solo il giorno", () => {
    const a = signingKey(SECRET, "20120215", "us-east-1", "iam");
    const b = signingKey(SECRET, "20120216", "us-east-1", "iam");
    expect(a.toString("hex")).not.toBe(b.toString("hex"));
  });

  it("cambia se cambia la regione", () => {
    const a = signingKey(SECRET, "20120215", "us-east-1", "iam");
    const b = signingKey(SECRET, "20120215", "eu-west-1", "iam");
    expect(a.toString("hex")).not.toBe(b.toString("hex"));
  });
});

describe("amzDate", () => {
  it("produce il formato compatto senza millisecondi", () => {
    expect(amzDate(new Date("2015-08-30T12:36:00.000Z"))).toBe("20150830T123600Z");
  });

  it("non lascia passare i millisecondi", () => {
    expect(amzDate(new Date("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
  });
});

describe("uriEncode", () => {
  it("lascia intatti solo i caratteri non riservati", () => {
    expect(uriEncode("aZ0-_.~")).toBe("aZ0-_.~");
  });

  it("codifica i caratteri che encodeURIComponent risparmia", () => {
    // La differenza che produce SignatureDoesNotMatch quando non c'e'.
    expect(uriEncode("!")).toBe("%21");
    expect(uriEncode("'")).toBe("%27");
    expect(uriEncode("(")).toBe("%28");
    expect(uriEncode(")")).toBe("%29");
    expect(uriEncode("*")).toBe("%2A");
  });

  it("codifica anche la barra", () => {
    expect(uriEncode("a/b")).toBe("a%2Fb");
  });

  it("codifica lo spazio come %20 e non come +", () => {
    expect(uriEncode("un due")).toBe("un%20due");
  });
});

describe("encodeKey", () => {
  it("tiene le barre come separatori", () => {
    expect(encodeKey("utente/file.webm")).toBe("utente/file.webm");
  });

  it("codifica i segmenti ma non i separatori", () => {
    expect(encodeKey("un utente/il file (1).webm")).toBe(
      "un%20utente/il%20file%20%281%29.webm",
    );
  });

  it("non ricodifica una chiave gia' innocua", () => {
    const chiave = "3f2b/9c1e-4a77.webm";
    expect(encodeKey(chiave)).toBe(chiave);
  });
});

describe("canonicalRequest", () => {
  it("riproduce alla lettera il caso get-vanilla della test suite AWS", () => {
    const risultato = canonicalRequest(
      "GET",
      new URL("https://example.amazonaws.com/"),
      { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
      EMPTY_PAYLOAD_SHA256,
    );

    expect(risultato.text).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        EMPTY_PAYLOAD_SHA256,
      ].join("\n"),
    );
    expect(risultato.signedHeaders).toBe("host;x-amz-date");
  });

  it("ordina le intestazioni per nome, non per inserimento", () => {
    const risultato = canonicalRequest(
      "PUT",
      new URL("https://esempio.test/oggetto"),
      { "x-amz-date": "20150830T123600Z", "content-type": "audio/webm", host: "esempio.test" },
      EMPTY_PAYLOAD_SHA256,
    );
    expect(risultato.signedHeaders).toBe("content-type;host;x-amz-date");
  });

  it("abbassa i nomi e comprime gli spazi nei valori", () => {
    const risultato = canonicalRequest(
      "GET",
      new URL("https://esempio.test/"),
      { Host: "esempio.test", "Content-Type": "  audio/webm   ; x=1  " },
      EMPTY_PAYLOAD_SHA256,
    );
    expect(risultato.text).toContain("content-type:audio/webm ; x=1\n");
    expect(risultato.text).toContain("host:esempio.test\n");
  });

  it("ordina la query per coppia codificata", () => {
    const risultato = canonicalRequest(
      "GET",
      new URL("https://esempio.test/?zeta=1&alfa=2"),
      { host: "esempio.test" },
      EMPTY_PAYLOAD_SHA256,
    );
    expect(risultato.text.split("\n")[2]).toBe("alfa=2&zeta=1");
  });

  it("non tocca un percorso gia' codificato", () => {
    const risultato = canonicalRequest(
      "GET",
      new URL(`https://esempio.test/${encodeKey("a b/c.webm")}`),
      { host: "esempio.test" },
      EMPTY_PAYLOAD_SHA256,
    );
    expect(risultato.text.split("\n")[1]).toBe("/a%20b/c.webm");
  });
});

describe("signRequest", () => {
  it("riproduce la firma get-vanilla della test suite AWS", () => {
    const headers = signRequest({
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      headers: {},
      payloadSha256: EMPTY_PAYLOAD_SHA256,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET,
      region: "us-east-1",
      // Il servizio finto degli esempi ufficiali si chiama davvero "service".
      service: "service",
      now: new Date("2015-08-30T12:36:00.000Z"),
    });

    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("non restituisce host: lo mette fetch, e imporlo e' vietato", () => {
    const headers = signRequest({
      method: "GET",
      url: new URL("https://esempio.test/"),
      headers: {},
      payloadSha256: EMPTY_PAYLOAD_SHA256,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET,
      region: "auto",
      service: "s3",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(headers).not.toHaveProperty("host");
    expect(headers["authorization"]).toContain("SignedHeaders=host;");
  });

  it("aggiunge x-amz-content-sha256 per s3", () => {
    const headers = signRequest({
      method: "PUT",
      url: new URL("https://esempio.test/oggetto"),
      headers: { "content-type": "audio/webm" },
      payloadSha256: EMPTY_PAYLOAD_SHA256,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET,
      region: "auto",
      service: "s3",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(headers["x-amz-content-sha256"]).toBe(EMPTY_PAYLOAD_SHA256);
    expect(headers["authorization"]).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date",
    );
  });

  it("non lo aggiunge per gli altri servizi", () => {
    const headers = signRequest({
      method: "GET",
      url: new URL("https://esempio.test/"),
      headers: {},
      payloadSha256: EMPTY_PAYLOAD_SHA256,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET,
      region: "us-east-1",
      service: "iam",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(headers).not.toHaveProperty("x-amz-content-sha256");
  });

  it("cambia firma se cambia un byte del corpo", () => {
    const comune = {
      method: "PUT",
      url: new URL("https://esempio.test/oggetto"),
      headers: {},
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET,
      region: "auto",
      service: "s3",
      now: new Date("2026-01-01T00:00:00.000Z"),
    } as const;

    const a = signRequest({ ...comune, payloadSha256: EMPTY_PAYLOAD_SHA256 });
    const b = signRequest({ ...comune, payloadSha256: `${EMPTY_PAYLOAD_SHA256.slice(0, 63)}0` });

    expect(a["authorization"]).not.toBe(b["authorization"]);
  });

  it("cambia firma se cambia il minuto", () => {
    const comune = {
      method: "GET",
      url: new URL("https://esempio.test/oggetto"),
      headers: {},
      payloadSha256: EMPTY_PAYLOAD_SHA256,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET,
      region: "auto",
      service: "s3",
    } as const;

    const a = signRequest({ ...comune, now: new Date("2026-01-01T00:00:00.000Z") });
    const b = signRequest({ ...comune, now: new Date("2026-01-01T00:01:00.000Z") });

    expect(a["authorization"]).not.toBe(b["authorization"]);
  });
});
