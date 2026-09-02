import type { z } from "zod";
import type {
  costoSchema,
  extractionContractSchema,
  extractionMetaSchema,
  luogoSchema,
  passoSchema,
  prerequisitoSchema,
  riferimentoSchema,
  trappolaSchema,
} from "./contract.schema.js";

/**
 * Solo `z.infer`. Nessun tipo scritto a mano: se lo schema e il tipo possono
 * divergere, prima o poi divergono.
 */

export type Prerequisito = z.infer<typeof prerequisitoSchema>;
export type Passo = z.infer<typeof passoSchema>;
export type Trappola = z.infer<typeof trappolaSchema>;
export type Costo = z.infer<typeof costoSchema>;
export type Luogo = z.infer<typeof luogoSchema>;
export type Riferimento = z.infer<typeof riferimentoSchema>;
export type ExtractionMeta = z.infer<typeof extractionMetaSchema>;
export type ExtractionContract = z.infer<typeof extractionContractSchema>;
