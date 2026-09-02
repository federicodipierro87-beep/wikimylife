import { PrismaClient } from "@prisma/client";
import { Argon2PasswordHasher } from "@wikimylife/api/infra";
import { SEED_IDS, loadSeedConfig } from "./seed/config.js";
import { seedProcedureA } from "./seed/procedureA.js";
import { seedProcedureB } from "./seed/procedureB.js";
import { seedRecordingC } from "./seed/recordingC.js";
import { resetSeedData } from "./seed/reset.js";

/**
 * Seed di sviluppo.
 *
 * Idempotente: cancella i propri dati e li ricrea. Eseguirlo due volte di fila
 * lascia il database nello stesso stato, e il test di integrazione lo verifica
 * contando le righe dopo due esecuzioni.
 *
 * La password dell'utente passa dallo STESSO `Argon2PasswordHasher` che usa
 * l'API. Non e' un dettaglio: se il seed usasse un hash diverso (o peggio, una
 * password in chiaro), dopo il seed il login non funzionerebbe e la prima cosa
 * che si fa dopo aver popolato un database e' provare a entrare.
 */
async function main(): Promise<void> {
  const config = loadSeedConfig();
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });

  try {
    await resetSeedData(prisma);

    const hasher = new Argon2PasswordHasher();
    await prisma.user.create({
      data: {
        id: SEED_IDS.user,
        email: config.userEmail.trim().toLowerCase(),
        passwordHash: await hasher.hash(config.userPassword),
        locale: "it-IT",
      },
    });

    await seedProcedureA(prisma);
    await seedProcedureB(prisma);
    await seedRecordingC(prisma);

    const [procedure, recording, execution] = await Promise.all([
      prisma.procedure.count({ where: { userId: SEED_IDS.user } }),
      prisma.recording.count({ where: { userId: SEED_IDS.user } }),
      prisma.execution.count({ where: { procedure: { userId: SEED_IDS.user } } }),
    ]);

    process.stdout.write(
      `Seed completato — utente ${config.userEmail}, ` +
        `${String(procedure)} procedure, ${String(recording)} registrazioni, ` +
        `${String(execution)} esecuzioni.\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
