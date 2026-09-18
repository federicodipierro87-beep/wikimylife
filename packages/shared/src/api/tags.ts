import { z } from "zod";
import { scopeValues } from "../enums.js";

/**
 * Contratto HTTP delle categorie.
 *
 * ## Una parola nel database, un'altra sullo schermo
 *
 * Qui dentro — e in tutto il codice, e in tutto il contratto — la parola e'
 * `tag`: e' il nome del modello Prisma, della colonna, del parametro che
 * `listProceduresQuerySchema` accetta gia', e del campo che sta su ogni
 * `ProcedureSummary`. Cambiarla vorrebbe dire una migrazione, un contratto
 * rotto e un giro di rinominamenti in una decina di file per guadagnare
 * niente. «Categoria» e' soltanto l'etichetta che legge chi usa l'app, e vive
 * nel JSX. Sono due parole per una cosa sola, ed e' un costo: chi legge il
 * codice cercando «categoria» non trova niente. E' scritto qui e in
 * `ListScreen.tsx`, che sono i due capi del filo.
 *
 * ## Perche' un conteggio e non solo i nomi
 *
 * Una riga di nomi nudi non dice quale valga la pena di premere: con venti
 * categorie, quella con una scheda sola e quella con quaranta si presentano
 * identiche, e l'unico modo di distinguerle e' provarle una per una. Il numero
 * costa una `groupBy` che il database fa comunque per rispondere, e trasforma
 * un elenco in un indice.
 *
 * Il numero e' pero' una promessa, e va mantenuta: deve essere **lo stesso**
 * che si conta aprendo la categoria. Per questo il repository calcola il
 * conteggio con la stessa funzione di WHERE della lista, invece di una query
 * scritta a parte — se una chip dicesse «7» e la lista che apre ne mostrasse
 * 6, non ci si fiderebbe piu' di nessuno dei due numeri.
 */

export const tagCountSchema = z
  .object({
    nome: z.string(),
    /** Quante schede visibili hanno questa categoria. Mai zero: si veda `listTags`. */
    conteggio: z.number().int(),
  })
  .strict();

export const tagListSchema = z
  .object({
    items: z.array(tagCountSchema),
  })
  .strict();

/**
 * L'unico filtro, e non ce ne sono altri per scelta.
 *
 * `scope` c'e' perche' le due righe di chip dell'elenco si sommano: con
 * l'ambito su «Lavoro», una categoria che vive solo fra le schede personali non
 * ha niente da aprire, e mostrarla con il suo conteggio intero direbbe una
 * bugia.
 *
 * `status` non c'e'. Il cestino ha le sue categorie in teoria, ma nessun gesto
 * dell'app le chiede: e' la lezione di `revoke-one`, dove un parametro entrato
 * nel contratto prima della schermata che lo consumava e' rimasto li' a farsi
 * interpretare male. Il giorno in cui servira', il contratto cambia — e cambiare
 * un contratto per aggiungere un campo facoltativo e' molto meno costoso che
 * scoprire chi si era appoggiato a un campo che non voleva dire niente.
 */
export const listTagsQuerySchema = z
  .object({
    scope: z.enum(scopeValues).optional(),
  })
  .strict();

export type TagCount = z.infer<typeof tagCountSchema>;
export type TagList = z.infer<typeof tagListSchema>;

export type ListTagsQuery = z.infer<typeof listTagsQuerySchema>;
export type ListTagsQueryInput = z.input<typeof listTagsQuerySchema>;
