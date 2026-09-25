import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COLORE_FONDO, FILE_PNG } from "../../scripts/icone.js";

/**
 * Il guscio Android, letto da un test invece che da Gradle.
 *
 * Nessun comando di `npm test` costruisce l'APK: lo fa il job `android` della
 * CI, con Java 21 e l'SDK che questa macchina non ha. Quello che si puo'
 * verificare da qui e' che i file scritti a mano dicano cio' che devono, e
 * soprattutto che dicano cio' che Capacitor si aspetta.
 *
 * ## Il manifest contro il codice di Capacitor, non contro una lista nostra
 *
 * Il microfono funziona dentro l'app solo se ogni permesso che
 * `BridgeWebChromeClient` chiede a Android e' dichiarato nel manifest: uno che
 * manca, Android lo nega senza mostrare niente, e Capacitor nega la pagina.
 * Una lista scritta qui direbbe cio' che pensavamo il giorno in cui l'abbiamo
 * scritta. Il test legge invece il sorgente Java di Capacitor in
 * `node_modules`, cioe' la versione che il `package-lock.json` installa: se un
 * aggiornamento comincia a chiedere un permesso in piu', cade qui e non su un
 * telefono.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");

function leggi(percorso: string): string {
  return readFileSync(join(ROOT, percorso), "utf8");
}

const MOBILE = "apps/mobile";
const MAIN = `${MOBILE}/android/app/src/main`;
const MANIFEST = leggi(`${MAIN}/AndroidManifest.xml`);
const PONTE = leggi(
  "node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/BridgeWebChromeClient.java",
);

/** I permessi dichiarati nel manifest, fuori dai commenti. */
function dichiarati(manifest: string): string[] {
  const senzaCommenti = manifest.replace(/<!--[\s\S]*?-->/g, "");
  return [...senzaCommenti.matchAll(/<uses-permission android:name="android\.permission\.(\w+)"/g)].map(
    (m) => m[1] ?? "",
  );
}

/**
 * I permessi che il metodo `nome` di `BridgeWebChromeClient` chiede, cioe' ogni
 * `Manifest.permission.X` dal suo `public void nome(` al metodo dopo.
 */
function chiestiDa(nome: string): string[] {
  const inizio = PONTE.indexOf(`public void ${nome}(`);
  expect(inizio).toBeGreaterThan(-1);
  const fine = PONTE.indexOf("\n    public ", inizio + 1);
  const corpo = PONTE.slice(inizio, fine < 0 ? undefined : fine);
  return [...new Set([...corpo.matchAll(/Manifest\.permission\.(\w+)/g)].map((m) => m[1] ?? ""))];
}

describe("il manifest Android", () => {
  it("dichiara tutto cio' che Capacitor chiede per il microfono", () => {
    const chiesti = chiestiDa("onPermissionRequest");
    // Il primo e' la fotocamera, che la pagina non chiede mai: nel ramo di
    // `onPermissionRequest` ci entra solo per un `VIDEO_CAPTURE`.
    const perAudio = chiesti.filter((p) => p !== "CAMERA");
    expect(perAudio).toEqual(expect.arrayContaining(["RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS"]));
    expect(dichiarati(MANIFEST)).toEqual(expect.arrayContaining(perAudio));
  });

  it("dichiara tutto cio' che Capacitor chiede per la posizione", () => {
    const chiesti = chiestiDa("onGeolocationPermissionsShowPrompt");
    expect(chiesti).toContain("ACCESS_COARSE_LOCATION");
    expect(dichiarati(MANIFEST)).toEqual(expect.arrayContaining(chiesti));
  });

  it("non dichiara la fotocamera, che l'app non usa", () => {
    // Il caso opposto: il modo piu' semplice di far passare i due qui sopra
    // e' dichiarare tutto cio' che il ponte nomina, e una fotocamera chiesta
    // senza motivo e' una domanda in piu' alla revisione degli store.
    expect(dichiarati(MANIFEST)).not.toContain("CAMERA");
  });

  it("dichiarati legge i permessi, e salta quelli nei commenti", () => {
    const finto = `<!-- <uses-permission android:name="android.permission.CAMERA" /> -->
      <uses-permission android:name="android.permission.INTERNET" />`;
    expect(dichiarati(finto)).toEqual(["INTERNET"]);
  });
});

describe("la configurazione di Capacitor", () => {
  const config = JSON.parse(leggi(`${MOBILE}/capacitor.config.json`)) as {
    appId: string;
    appName: string;
    webDir: string;
  };

  it("prende il web dalla cartella che Vite scrive", () => {
    // Se non combaciano, `cap sync` copia una cartella vuota o vecchia, e
    // l'APK si costruisce lo stesso: un'app bianca, o un'app di ieri.
    const outDir = /outDir:\s*"([^"]+)"/.exec(leggi("apps/web/vite.config.ts"))?.[1];
    expect(outDir).not.toBeUndefined();
    expect(join(MOBILE, config.webDir)).toBe(join("apps/web", outDir ?? ""));
  });

  it("usa lo stesso identificativo del progetto Gradle", () => {
    // L'appId e' l'identita' dell'app per sempre: dopo il primo caricamento su
    // uno store non si cambia piu'. Capacitor lo copia in Gradle una volta
    // sola, alla creazione del progetto, e da li' in poi i due vivono separati.
    const gradle = leggi(`${MOBILE}/android/app/build.gradle`);
    expect(gradle).toContain(`applicationId "${config.appId}"`);
    expect(gradle).toContain(`namespace = "${config.appId}"`);
  });

  it("i quattro pacchetti di Capacitor hanno la stessa versione, fissata", () => {
    // Un `core` e un `android` di versioni diverse parlano due protocolli
    // diversi fra la pagina e il lato nativo, e il guasto si vede solo a
    // runtime. Fissata, senza `^`: un `npm install` non deve poterle separare.
    const pacchetto = JSON.parse(leggi(`${MOBILE}/package.json`)) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const versioni = [
      pacchetto.dependencies["@capacitor/core"],
      pacchetto.dependencies["@capacitor/android"],
      pacchetto.dependencies["@capacitor/ios"],
      pacchetto.devDependencies["@capacitor/cli"],
    ];
    expect(versioni[0]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(versioni).size).toBe(1);
  });
});

describe("le risorse Android", () => {
  it("lo sfondo dell'icona adattiva e' il fondo del microfono", () => {
    // Capacitor lo genera bianco. Il primo piano e' opaco e copre lo sfondo
    // quasi ovunque, ma non sotto la maschera piu' larga di certi launcher:
    // li' si vedrebbe un filo bianco.
    const colore = /<color name="ic_launcher_background">([^<]+)<\/color>/.exec(
      leggi(`${MAIN}/res/values/ic_launcher_background.xml`),
    )?.[1];
    expect(colore?.toLowerCase()).toBe(COLORE_FONDO);
  });

  it("lo splash di Android 12 usa lo stesso fondo", () => {
    expect(leggi(`${MAIN}/res/values/styles.xml`)).toContain(
      '<item name="windowSplashScreenBackground">@color/ic_launcher_background</item>',
    );
  });

  it("la copia del web non e' in git, e il progetto lo sa", () => {
    // `cap sync` la rigenera a ogni build: versionata, sarebbe una seconda
    // copia dell'app da tenere allineata, e un diff enorme a ogni commit.
    const ignora = leggi(`${MOBILE}/android/.gitignore`);
    expect(ignora).toMatch(/^app\/src\/main\/assets\/public$/m);
    expect(existsSync(join(ROOT, MAIN, "AndroidManifest.xml"))).toBe(true);
  });
});

describe("il progetto iOS", () => {
  const IOS = `${MOBILE}/ios/App`;
  const PLIST = leggi(`${IOS}/App/Info.plist`);
  const config = JSON.parse(leggi(`${MOBILE}/capacitor.config.json`)) as { appId: string };

  /** Il valore stringa di una chiave dell'Info.plist, fuori dai commenti. */
  function valore(plist: string, chiave: string): string | null {
    const senzaCommenti = plist.replace(/<!--[\s\S]*?-->/g, "");
    const m = new RegExp(`<key>${chiave}</key>\\s*<string>([^<]*)</string>`).exec(senzaCommenti);
    return m?.[1] ?? null;
  }

  it.each(["NSMicrophoneUsageDescription", "NSLocationWhenInUseUsageDescription"])(
    "%s c'e', e dice a cosa serve",
    (chiave) => {
      // Senza la frase, iOS non nega il permesso: chiude l'app nell'istante in
      // cui la pagina lo chiede. Lunga almeno una frase vera, perche' Apple
      // rifiuta alla revisione quelle che dicono solo «serve il microfono».
      expect(valore(PLIST, chiave)?.length ?? 0).toBeGreaterThan(40);
    },
  );

  it("valore legge le chiavi, e salta quelle nei commenti", () => {
    const finto = `<!-- <key>A</key><string>commento</string> -->
      <key>B</key>
      <string>vero</string>`;
    expect(valore(finto, "A")).toBeNull();
    expect(valore(finto, "B")).toBe("vero");
  });

  it("usa lo stesso identificativo di Capacitor e di Android", () => {
    // Il bundle id vive nel progetto Xcode, due volte (Debug e Release), e
    // Capacitor ce lo scrive solo alla creazione.
    const pbxproj = leggi(`${IOS}/App.xcodeproj/project.pbxproj`);
    const id = [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1]);
    expect(id).toHaveLength(2);
    expect(new Set(id)).toEqual(new Set([config.appId]));
  });

  it("il pacchetto Swift di Capacitor e' della stessa versione di quello npm", () => {
    // Il lato Swift non viene da npm ma da GitHub, via Swift Package Manager.
    // Lo riscrive `cap sync`; se qualcuno aggiorna npm e non sincronizza, la
    // pagina e il lato nativo parlano due versioni diverse del ponte.
    const pacchetto = JSON.parse(leggi(`${MOBILE}/package.json`)) as {
      dependencies: Record<string, string>;
    };
    const swift = /capacitor-swift-pm\.git", exact: "([^"]+)"/.exec(
      leggi(`${IOS}/CapApp-SPM/Package.swift`),
    )?.[1];
    expect(swift).toBe(pacchetto.dependencies["@capacitor/ios"]);
  });

  it.each(["AppIcon.appiconset", "Splash.imageset"])(
    "%s nomina solo immagini che lo script scrive",
    (cartella) => {
      // Xcode legge i file dal Contents.json: un nome che lo script non
      // scrive e' un'immagine che resta quella di Capacitor, o che manca.
      const contenuto = JSON.parse(
        leggi(`${IOS}/App/Assets.xcassets/${cartella}/Contents.json`),
      ) as { images: { filename?: string }[] };
      const nomi = contenuto.images.map((i) => i.filename);
      expect(nomi.length).toBeGreaterThan(0);
      const scritti = FILE_PNG.map((f) => f.percorso);
      for (const nome of nomi) {
        expect(scritti).toContain(`${IOS}/App/Assets.xcassets/${cartella}/${String(nome)}`);
      }
    },
  );

  it("la copia del web non e' in git", () => {
    expect(leggi(`${MOBILE}/ios/.gitignore`)).toMatch(/^App\/App\/public$/m);
  });
});
