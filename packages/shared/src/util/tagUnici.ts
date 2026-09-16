/**
 * I tag di una scheda, senza ripetizioni e senza vuoti.
 *
 * ## Perche' esiste
 *
 * `TagOnProcedure` ha `@@id([procedureId, tagId])`. Chi scrive i tag risolve
 * prima ogni nome in un `Tag` (upsert per `[userId, nome]`) e poi crea le
 * righe di legame in blocco: due nomi uguali diventano lo *stesso* `tagId` due
 * volte, e la seconda riga viola la chiave composta. Prisma alza P2002, la
 * transazione cade, e chi ha premuto «salva» vede un 500 — oppure, sulla via
 * della pipeline, un vocale che non diventa mai una scheda perche' il modello
 * ha proposto `["casa", "casa"]`.
 *
 * Il vincolo non si rilassa: e' lui che ha trovato il difetto. Si ripulisce
 * l'input prima di arrivarci.
 *
 * ## Perche' qui e non in uno schema di zod
 *
 * Sembrerebbe naturale un `.transform` su `extractionContractSchema`, ma quello
 * e' il contratto della §4: deve dire cosa il modello ha risposto, alla
 * lettera. Una validazione che aggiusta di nascosto e' meno onesta proprio dove
 * serve che sia letterale, e lo stesso vale per `updateProcedureBodySchema`,
 * dove il corpo accettato e il corpo mandato dal client resterebbero due cose
 * diverse senza che nessuno lo dica.
 *
 * ## Perche' non minuscola
 *
 * `embeddingInput` minuscola i tag, e per lui e' giusto: serve un vettore
 * stabile. Qui no. I tag sono il vocabolario dell'utente e la §4.2 li rimette
 * dentro il prompt: riscrivere «Casa» in «casa» impoverisce le sue parole. In
 * piu' `@@unique([userId, nome])` in Postgres e' case-sensitive, quindi una
 * dedup che ignorasse le maiuscole non sarebbe comunque garantita dal
 * database — sarebbe solo una regola in piu' da ricordarsi.
 *
 * Il prezzo e' dichiarato: «Casa» e «casa» restano due categorie. La cura non e'
 * qui, e' far scegliere invece di far riscrivere.
 *
 * ## Perche' non ordina
 *
 * L'ordine in cui i tag arrivano e' quello in cui il modello (o l'utente) li ha
 * proposti, ed e' un'informazione. In lettura `toSummary` ordina gia' per conto
 * suo dove serve; ordinare qui butterebbe via quell'informazione senza che
 * nessuno l'abbia chiesto.
 */

export function tagUnici(tag: readonly string[]): string[] {
  const visti = new Set<string>();
  const out: string[] = [];

  for (const nome of tag) {
    const pulito = nome.trim();
    if (pulito === "" || visti.has(pulito)) {
      continue;
    }
    visti.add(pulito);
    out.push(pulito);
  }

  return out;
}
