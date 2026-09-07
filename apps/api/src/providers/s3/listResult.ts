import type { ListedObject } from "@wikimylife/shared";

/**
 * Il lettore della risposta di `ListObjectsV2`, scritto a mano.
 *
 * S3 risponde in XML e non c'e' modo di chiedergli JSON: e' l'unica operazione
 * del bucket che non si esaurisce nelle intestazioni HTTP. Aggiungere un parser
 * XML per leggere tre campi da una struttura fissa e documentata sarebbe stata
 * la prima dipendenza di questo repository presa per comodita', e va contro la
 * stessa ragione per cui `sigv4.ts` esiste al posto di `@aws-sdk/client-s3`.
 *
 * Questo modulo e' puro — dentro una stringa, fuori delle chiavi — perche' il
 * parsing a mano di XML e' esattamente il genere di codice che va provato
 * contro risposte vere invece che riletto.
 *
 * ## Cosa NON fa, di proposito
 *
 * Non e' un parser XML. Non gestisce i namespace, i commenti, i CDATA, gli
 * attributi, i tag annidati con lo stesso nome. Legge la forma che `ListObjectsV2`
 * documenta da quindici anni e niente altro. La conseguenza va detta: una
 * risposta che non sia quella forma produce meno chiavi, non chiavi sbagliate —
 * e meno chiavi, per chi cancella, e' il verso giusto in cui sbagliare.
 */

/** I cinque riferimenti che XML predefinisce. Non ce ne sono altri qui. */
const ENTITA: ReadonlyArray<readonly [RegExp, string]> = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  // Per ultimo, sempre: `&amp;lt;` e' il testo `&lt;`, e sciogliere `&amp;`
  // prima trasformerebbe quel testo in un `<`.
  [/&amp;/g, "&"],
];

function unescapeXml(value: string): string {
  let out = value;
  for (const [pattern, char] of ENTITA) {
    out = out.replace(pattern, char);
  }
  return out;
}

/**
 * Il contenuto del primo `<tag>` dentro `xml`, gia' sciolto dalle entita'.
 *
 * `undefined` se il tag non c'e': un campo assente e un campo vuoto non sono la
 * stessa cosa, e chi chiama decide cosa farne.
 */
function tag(xml: string, nome: string): string | undefined {
  const trovato = new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`).exec(xml);
  return trovato?.[1] === undefined ? undefined : unescapeXml(trovato[1]);
}

export interface ParsedListResult {
  readonly objects: readonly ListedObject[];
  readonly continuationToken: string | undefined;
}

/**
 * Legge un `ListBucketResult`.
 *
 * Un blocco `<Contents>` a cui manchi la chiave, la data o la dimensione viene
 * saltato in silenzio invece di diventare un oggetto con dei valori inventati:
 * un `sizeBytes` messo a zero perche' il tag mancava sarebbe una chiave che
 * sembra vuota, e una chiave che sembra vuota e' una chiave che qualcuno
 * cancellera'.
 *
 * Il segnalibro si legge solo se `IsTruncated` dice `true`. S3 non manda un
 * `NextContinuationToken` sull'ultima pagina, ma alcune implementazioni
 * compatibili ne mandano uno vuoto, e trattarlo come valido significherebbe
 * chiedere la pagina dopo l'ultima all'infinito.
 */
export function parseListObjectsV2(xml: string): ParsedListResult {
  const objects: ListedObject[] = [];

  for (const blocco of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const contenuto = blocco[1];
    if (contenuto === undefined) {
      continue;
    }

    const key = tag(contenuto, "Key");
    const lastModified = tag(contenuto, "LastModified");
    const size = tag(contenuto, "Size");
    if (key === undefined || key === "" || lastModified === undefined || size === undefined) {
      continue;
    }

    const sizeBytes = Number(size);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      continue;
    }

    objects.push({ key, sizeBytes, lastModified });
  }

  const troncata = tag(xml, "IsTruncated") === "true";
  const segnalibro = troncata ? tag(xml, "NextContinuationToken") : undefined;

  return {
    objects,
    continuationToken:
      segnalibro === undefined || segnalibro === "" ? undefined : segnalibro,
  };
}
