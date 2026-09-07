import { describe, expect, it } from "vitest";
import { parseListObjectsV2 } from "../../apps/api/src/providers/s3/listResult.js";

/**
 * Un parser XML scritto a mano si prova contro risposte vere.
 *
 * Il rischio di questo modulo non e' di leggere una chiave in meno: e' di
 * leggerne una diversa da quella che c'e' nel bucket. Chi consuma questo
 * elenco confronta le chiavi con il database e cancella quelle che non trova,
 * quindi una chiave malamente sciolta dalle entita' XML non e' un dettaglio di
 * presentazione — e' un audio cancellato al posto di un altro.
 *
 * L'XML qui sotto ha la forma che S3 restituisce davvero, namespace e ordine
 * dei tag compresi, e non una forma minima costruita per far passare il codice.
 */

const RISPOSTA = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>wikimylife</Name>
  <Prefix></Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>utente-1/9f1c8c1e-0000-4000-8000-000000000001.webm</Key>
    <LastModified>2026-03-01T10:00:00.000Z</LastModified>
    <ETag>&quot;e3b0c44298fc1c149afbf4c8996fb924&quot;</ETag>
    <Size>48213</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>utente-2/9f1c8c1e-0000-4000-8000-000000000002.m4a</Key>
    <LastModified>2026-03-02T11:30:00.000Z</LastModified>
    <ETag>&quot;5d41402abc4b2a76b9719d911017c592&quot;</ETag>
    <Size>7</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>`;

describe("parseListObjectsV2", () => {
  it("legge chiave, dimensione e data di ogni oggetto", () => {
    const esito = parseListObjectsV2(RISPOSTA);

    expect(esito.objects).toEqual([
      {
        key: "utente-1/9f1c8c1e-0000-4000-8000-000000000001.webm",
        sizeBytes: 48213,
        lastModified: "2026-03-01T10:00:00.000Z",
      },
      {
        key: "utente-2/9f1c8c1e-0000-4000-8000-000000000002.m4a",
        sizeBytes: 7,
        lastModified: "2026-03-02T11:30:00.000Z",
      },
    ]);
  });

  it("non restituisce nessun segnalibro quando la pagina non e' troncata", () => {
    expect(parseListObjectsV2(RISPOSTA).continuationToken).toBeUndefined();
  });

  it("legge il segnalibro quando la pagina e' troncata", () => {
    const troncata = RISPOSTA.replace(
      "<IsTruncated>false</IsTruncated>",
      "<IsTruncated>true</IsTruncated>\n  <NextContinuationToken>1ueGcxLPRx/L4Nl</NextContinuationToken>",
    );
    expect(parseListObjectsV2(troncata).continuationToken).toBe("1ueGcxLPRx/L4Nl");
  });

  it("ignora un segnalibro presente ma vuoto", () => {
    // Alcuni servizi compatibili lo mandano sempre. Prenderlo per buono
    // vorrebbe dire chiedere all'infinito la pagina dopo l'ultima.
    const strana = RISPOSTA.replace(
      "<IsTruncated>false</IsTruncated>",
      "<IsTruncated>true</IsTruncated>\n  <NextContinuationToken></NextContinuationToken>",
    );
    expect(parseListObjectsV2(strana).continuationToken).toBeUndefined();
  });

  it("ignora il segnalibro se la pagina dice di non essere troncata", () => {
    const contraddittoria = RISPOSTA.replace(
      "<IsTruncated>false</IsTruncated>",
      "<IsTruncated>false</IsTruncated>\n  <NextContinuationToken>qualcosa</NextContinuationToken>",
    );
    expect(parseListObjectsV2(contraddittoria).continuationToken).toBeUndefined();
  });

  it("scioglie le entita' nelle chiavi", () => {
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents>
      <Key>utente/nome &amp; cognome.webm</Key>
      <LastModified>2026-03-01T10:00:00.000Z</LastModified>
      <Size>1</Size>
    </Contents></ListBucketResult>`;
    expect(parseListObjectsV2(xml).objects[0]?.key).toBe("utente/nome & cognome.webm");
  });

  it("non scioglie due volte", () => {
    // `&amp;lt;` e' il testo `&lt;`, non un `<`. Sciogliere `&amp;` per primo
    // produrrebbe una chiave che nel bucket non esiste.
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents>
      <Key>utente/a&amp;lt;b.webm</Key>
      <LastModified>2026-03-01T10:00:00.000Z</LastModified>
      <Size>1</Size>
    </Contents></ListBucketResult>`;
    expect(parseListObjectsV2(xml).objects[0]?.key).toBe("utente/a&lt;b.webm");
  });

  it("salta un blocco a cui manca la data", () => {
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents>
      <Key>utente/senza-data.webm</Key>
      <Size>1</Size>
    </Contents></ListBucketResult>`;
    expect(parseListObjectsV2(xml).objects).toEqual([]);
  });

  it("salta un blocco a cui manca la dimensione invece di dargliene una", () => {
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents>
      <Key>utente/senza-dimensione.webm</Key>
      <LastModified>2026-03-01T10:00:00.000Z</LastModified>
    </Contents></ListBucketResult>`;
    expect(parseListObjectsV2(xml).objects).toEqual([]);
  });

  it("salta un blocco con la chiave vuota", () => {
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents>
      <Key></Key>
      <LastModified>2026-03-01T10:00:00.000Z</LastModified>
      <Size>1</Size>
    </Contents></ListBucketResult>`;
    expect(parseListObjectsV2(xml).objects).toEqual([]);
  });

  it("salta un blocco con una dimensione che non e' un numero", () => {
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents>
      <Key>utente/strana.webm</Key>
      <LastModified>2026-03-01T10:00:00.000Z</LastModified>
      <Size>tanti</Size>
    </Contents></ListBucketResult>`;
    expect(parseListObjectsV2(xml).objects).toEqual([]);
  });

  it("tiene i blocchi buoni anche quando uno in mezzo e' rotto", () => {
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>
    <Contents><Key>a.webm</Key><LastModified>2026-03-01T10:00:00.000Z</LastModified><Size>1</Size></Contents>
    <Contents><Key>rotto.webm</Key><Size>2</Size></Contents>
    <Contents><Key>b.webm</Key><LastModified>2026-03-01T10:00:00.000Z</LastModified><Size>3</Size></Contents>
    </ListBucketResult>`;
    expect(parseListObjectsV2(xml).objects.map((o) => o.key)).toEqual(["a.webm", "b.webm"]);
  });

  it("su un bucket vuoto risponde un elenco vuoto e nessun segnalibro", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>wikimylife</Name><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;
    expect(parseListObjectsV2(xml)).toEqual({
      objects: [],
      continuationToken: undefined,
    });
  });

  it("su una risposta che non e' un elenco non inventa niente", () => {
    // Il corpo di un errore S3 e' anche lui XML. Non deve produrre chiavi.
    const errore = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`;
    expect(parseListObjectsV2(errore)).toEqual({
      objects: [],
      continuationToken: undefined,
    });
  });
});
