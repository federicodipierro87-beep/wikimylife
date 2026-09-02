import type { PrismaClient } from "@prisma/client";
import { SEED_IDS } from "./config.js";

/**
 * Cancella i dati del seed, e soltanto quelli.
 *
 * Serve perche' `Recording.user`, `Procedure.user` e `Tag.user` non hanno
 * `onDelete: Cascade` (la spec non lo prevede, e cancellare a cascata le
 * procedure di un utente e' una decisione di prodotto, non di schema). Quindi
 * l'ordine e' obbligato e va rispettato dal basso verso l'alto:
 *
 *   recordings → procedures → tags → refresh token → user
 *
 * I figli della Procedure (Step, Prerequisite, Pitfall, Cost, Reference,
 * Attachment, Execution, TagOnProcedure) hanno invece `onDelete: Cascade`:
 * spariscono con la procedura, non serve toccarli. Il Recording va prima
 * perche' punta alla Procedure con una FK senza cascade — cancellare la
 * procedura mentre un recording la referenzia darebbe violazione di vincolo.
 *
 * `deleteMany` con un `where` esplicito e mai `deleteMany({})`: eseguire il
 * seed su un database sbagliato deve costare al massimo i cinque record del
 * seed, non tutto il contenuto.
 */
export async function resetSeedData(prisma: PrismaClient): Promise<void> {
  const seedRecordingIds = [SEED_IDS.recordingA, SEED_IDS.recordingOrphan];
  const seedProcedureIds = [SEED_IDS.procedureA, SEED_IDS.procedureB];

  await prisma.recording.deleteMany({ where: { id: { in: seedRecordingIds } } });
  await prisma.procedure.deleteMany({ where: { id: { in: seedProcedureIds } } });
  await prisma.tag.deleteMany({ where: { userId: SEED_IDS.user } });
  await prisma.refreshToken.deleteMany({ where: { userId: SEED_IDS.user } });
  await prisma.user.deleteMany({ where: { id: SEED_IDS.user } });
}
