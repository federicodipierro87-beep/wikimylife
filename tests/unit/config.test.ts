import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadConfig,
  parseOrigins,
} from "../../apps/api/src/config/env.js";

/**
 * Le regole di questo file sono l'unica difesa contro un deploy che sembra
 * riuscito.
 *
 * Un'API avviata con storage su disco effimero, o con i provider finti, o
 * senza origini CORS, non lascia nessuna traccia d'errore: risponde 200,
 * scrive nel database, e il guasto si manifesta giorni dopo come audio
 * spariti o schede inventate. Per questo la validazione fallisce all'avvio, e
 * per questo va provata: e' un comportamento che in produzione non si vuole
 * osservare mai.
 */

/** Il minimo perche' `loadConfig` non si lamenti di altro. */
const MINIMO = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  JWT_ACCESS_SECRET: "un-segreto-lungo-almeno-trentadue-caratteri",
} as const;

/** Un ambiente di produzione completo e valido, da rompere un pezzo alla volta. */
const PRODUZIONE = {
  ...MINIMO,
  NODE_ENV: "production",
  CORS_ORIGINS: "https://wikimylife.netlify.app",
  TRANSCRIPTION_PROVIDER: "openai",
  EXTRACTION_PROVIDER: "anthropic",
  EMBEDDING_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-finta",
  ANTHROPIC_API_KEY: "sk-ant-finta",
  STORAGE_PROVIDER: "s3",
  S3_BUCKET: "wikimylife-audio",
  S3_REGION: "auto",
  S3_ACCESS_KEY_ID: "chiave",
  S3_SECRET_ACCESS_KEY: "segreto",
} as const;

function errore(source: Record<string, string | undefined>): string {
  try {
    loadConfig(source);
  } catch (e) {
    if (e instanceof ConfigError) {
      return e.message;
    }
    throw e;
  }
  throw new Error("loadConfig doveva fallire e invece e' passata");
}

describe("parseOrigins", () => {
  it("separa e ripulisce gli spazi", () => {
    expect(parseOrigins("https://a.test, https://b.test")).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
  });

  it("toglie la barra finale, che non e' parte di un'origine", () => {
    // `Origin: https://a.test/` non lo manda nessun browser: con la barra la
    // lista non combacia mai e non c'e' nessun errore da leggere.
    expect(parseOrigins("https://a.test/")).toEqual(["https://a.test"]);
    expect(parseOrigins("https://a.test///")).toEqual(["https://a.test"]);
  });

  it("scarta i vuoti invece di produrre origini vuote", () => {
    expect(parseOrigins("https://a.test,,  ,")).toEqual(["https://a.test"]);
    expect(parseOrigins("")).toEqual([]);
    expect(parseOrigins("   ")).toEqual([]);
  });

  it("conserva la porta, che fa parte dell'origine", () => {
    expect(parseOrigins("http://localhost:5173")).toEqual(["http://localhost:5173"]);
  });
});

describe("loadConfig — sviluppo", () => {
  it("i default bastano a partire senza una sola chiave API", () => {
    const config = loadConfig({ ...MINIMO });
    expect(config.nodeEnv).toBe("development");
    expect(config.providers.transcription).toBe("fake");
    expect(config.providers.storage).toBe("fake");
    expect(config.corsOrigins).toEqual([]);
    expect(config.providers.s3).toBeUndefined();
  });

  it("una variabile vuota vale come assente", () => {
    // Svuotare un campo nel pannello di Railway lascia "", non l'assenza.
    const config = loadConfig({ ...MINIMO, OPENAI_API_KEY: "   " });
    expect(config.providers.openaiApiKey).toBeUndefined();
  });

  it("in sviluppo i provider finti e lo storage locale vanno bene", () => {
    const config = loadConfig({ ...MINIMO, STORAGE_PROVIDER: "local" });
    expect(config.providers.storage).toBe("local");
  });

  it("rifiuta un segreto JWT corto", () => {
    expect(errore({ ...MINIMO, JWT_ACCESS_SECRET: "troppo-corto" })).toContain(
      "JWT_ACCESS_SECRET",
    );
  });
});

describe("loadConfig — il limite dei tentativi", () => {
  it("ha un default utilizzabile: chi non lo configura e' comunque protetto", () => {
    // E' la differenza fra una difesa e un'opzione. Una variabile dimenticata
    // non deve lasciare `/login` aperto a diecimila tentativi al minuto.
    const config = loadConfig({ ...MINIMO });
    expect(config.auth.rateLimit).toEqual({ windowMs: 60_000, max: 10 });
  });

  it("la finestra si scrive in secondi e arriva in millisecondi", () => {
    // Nel pannello si scrivono secondi perche' e' l'unita' in cui si ragiona;
    // il middleware lavora in millisecondi. La conversione sta in un punto
    // solo, ed e' qui che si prova che non e' sbagliata di mille.
    const config = loadConfig({ ...MINIMO, AUTH_RATE_LIMIT_WINDOW_SEC: "300" });
    expect(config.auth.rateLimit.windowMs).toBe(300_000);
  });

  it("rifiuta lo zero, che disattiverebbe l'autenticazione", () => {
    // `max: 0` nega ogni richiesta, finestra dopo finestra: nessuno entra piu'
    // e il log dice «troppi tentativi» al primo. Meglio non partire.
    expect(errore({ ...MINIMO, AUTH_RATE_LIMIT_MAX: "0" })).toContain("AUTH_RATE_LIMIT_MAX");
    expect(errore({ ...MINIMO, AUTH_RATE_LIMIT_WINDOW_SEC: "0" })).toContain(
      "AUTH_RATE_LIMIT_WINDOW_SEC",
    );
  });

  it("rifiuta un valore che non e' un numero", () => {
    expect(errore({ ...MINIMO, AUTH_RATE_LIMIT_MAX: "molti" })).toContain("AUTH_RATE_LIMIT_MAX");
  });
});

describe("loadConfig — i salti di proxy", () => {
  it("in sviluppo nessuno: X-Forwarded-For va ignorato del tutto", () => {
    expect(loadConfig({ ...MINIMO }).trustProxyHops).toBe(0);
  });

  it("in produzione uno, che e' la topologia descritta nel README", () => {
    expect(loadConfig({ ...PRODUZIONE }).trustProxyHops).toBe(1);
  });

  it("si puo' alzare per una CDN davanti al proxy", () => {
    expect(loadConfig({ ...PRODUZIONE, TRUST_PROXY_HOPS: "2" }).trustProxyHops).toBe(2);
  });

  it("si puo' azzerare anche in produzione", () => {
    // Chi espone l'API senza nessun proxy davanti deve poterlo dire: con `1`
    // Express prenderebbe una voce di X-Forwarded-For che nessun proxy ha
    // scritto, cioe' esattamente quella del client.
    expect(loadConfig({ ...PRODUZIONE, TRUST_PROXY_HOPS: "0" }).trustProxyHops).toBe(0);
  });

  it("rifiuta un numero negativo", () => {
    expect(errore({ ...MINIMO, TRUST_PROXY_HOPS: "-1" })).toContain("TRUST_PROXY_HOPS");
  });
});

describe("loadConfig — s3", () => {
  it("accetta una configurazione completa", () => {
    const config = loadConfig({ ...PRODUZIONE });
    expect(config.providers.s3).toEqual({
      bucket: "wikimylife-audio",
      region: "auto",
      endpoint: undefined,
      accessKeyId: "chiave",
      secretAccessKey: "segreto",
      forcePathStyle: false,
    });
  });

  it("porta l'endpoint quando c'e'", () => {
    const config = loadConfig({
      ...PRODUZIONE,
      S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    });
    expect(config.providers.s3?.endpoint).toBe("https://account.r2.cloudflarestorage.com");
  });

  it("elenca TUTTE le variabili mancanti, non solo la prima", () => {
    // Chi configura un servizio nuovo le sbaglia insieme: dirgliene una per
    // deploy significa quattro deploy.
    const messaggio = errore({ ...MINIMO, STORAGE_PROVIDER: "s3" });
    expect(messaggio).toContain("S3_BUCKET");
    expect(messaggio).toContain("S3_REGION");
    expect(messaggio).toContain("S3_ACCESS_KEY_ID");
    expect(messaggio).toContain("S3_SECRET_ACCESS_KEY");
  });

  it("una credenziale vuota conta come mancante", () => {
    expect(errore({ ...PRODUZIONE, S3_SECRET_ACCESS_KEY: "" })).toContain(
      "S3_SECRET_ACCESS_KEY",
    );
  });
});

describe("loadConfig — le regole che valgono solo in produzione", () => {
  it("l'ambiente di produzione completo passa", () => {
    const config = loadConfig({ ...PRODUZIONE });
    expect(config.nodeEnv).toBe("production");
    expect(config.corsOrigins).toEqual(["https://wikimylife.netlify.app"]);
  });

  it("rifiuta lo storage su disco: e' perdita di dati differita", () => {
    const messaggio = errore({ ...PRODUZIONE, STORAGE_PROVIDER: "local" });
    expect(messaggio).toContain("STORAGE_PROVIDER");
    expect(messaggio).toContain("effimero");
  });

  it("rifiuta anche lo storage in memoria", () => {
    expect(errore({ ...PRODUZIONE, STORAGE_PROVIDER: "fake" })).toContain("STORAGE_PROVIDER");
  });

  it("rifiuta un CORS vuoto: la PWA non riuscirebbe a fare login", () => {
    expect(errore({ ...PRODUZIONE, CORS_ORIGINS: "" })).toContain("CORS_ORIGINS");
    expect(errore({ ...PRODUZIONE, CORS_ORIGINS: "   " })).toContain("CORS_ORIGINS");
  });

  it.each([
    ["TRANSCRIPTION_PROVIDER"],
    ["EXTRACTION_PROVIDER"],
    ["EMBEDDING_PROVIDER"],
    ["REDACTION_PROVIDER"],
  ])("rifiuta il provider finto: %s", (nome) => {
    // Schede finte in un database vero sono indistinguibili dalle buone.
    // Per la redazione il danno e' diverso: un fake che non trova mai niente
    // e' una schermata che dice «non ho trovato altro» a chi sta per
    // condividere una scheda con dentro il nome di qualcuno.
    expect(errore({ ...PRODUZIONE, [nome]: "fake" })).toContain(nome);
  });

  it("lascia passare la redazione assistita spenta", () => {
    // E' l'unico provider che ha un modo legittimo di non esserci, e la
    // produzione non deve costringere ad accenderlo: accenderlo significa
    // mandare a un terzo il testo integrale delle schede segnate come
    // contenenti dati sensibili, ed e' una decisione, non un default.
    expect(loadConfig({ ...PRODUZIONE }).providers.redaction).toBe("nessuno");
  });

  it("accetta la redazione assistita accesa", () => {
    const config = loadConfig({ ...PRODUZIONE, REDACTION_PROVIDER: "anthropic" });
    expect(config.providers.redaction).toBe("anthropic");
    // Il modello e' suo e non quello dell'estrazione: qui il testo e' corto e
    // c'e' qualcuno che aspetta, li' il testo e' lungo e aspetta un worker.
    expect(config.providers.redactionModel).not.toBe(config.providers.extractionModel);
  });

  it("le stesse configurazioni fuori produzione non danno fastidio", () => {
    const config = loadConfig({
      ...PRODUZIONE,
      NODE_ENV: "test",
      STORAGE_PROVIDER: "fake",
      CORS_ORIGINS: "",
      TRANSCRIPTION_PROVIDER: "fake",
      EXTRACTION_PROVIDER: "fake",
      EMBEDDING_PROVIDER: "fake",
      REDACTION_PROVIDER: "fake",
    });
    expect(config.nodeEnv).toBe("test");
  });
});
