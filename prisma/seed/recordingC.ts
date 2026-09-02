import { Prisma, type PrismaClient } from "@prisma/client";
import { SEED_IDS } from "./config.js";

/**
 * Recording C — l'audio orfano.
 *
 * Dieci righe che valgono quanto le due procedure sopra, perche' sono la prova
 * che la decisione 2 regge: `procedureId: null`, stato `ESTRAZIONE_FALLITA`,
 * `retryCount: 1`.
 *
 * Se lo stato dell'elaborazione fosse stato messo sulla `Procedure` (come nella
 * lettura letterale della §6), questa riga non sarebbe rappresentabile: per
 * registrare il fallimento servirebbe una Procedure, ma una Procedure ha
 * `titolo` NOT NULL e qui il titolo non esiste — l'estrazione non e' arrivata a
 * produrlo. Si sarebbe finiti a inventare un titolo segnaposto, cioe' a
 * mettere spazzatura nella tabella che l'utente legge.
 *
 * `retryCount: 1` e' il "un solo retry poi ESTRAZIONE_FALLITA" della §5, gia'
 * consumato.
 */
export async function seedRecordingC(prisma: PrismaClient): Promise<void> {
  await prisma.recording.create({
    data: {
      id: SEED_IDS.recordingOrphan,
      userId: SEED_IDS.user,
      audioUrl: "seed://audio/orfano.m4a",
      // m4a e non webm: e' il motivo per cui `mimeType` esiste [D7]. Un audio
      // registrato da iOS non ha lo stesso contenitore di uno registrato da
      // MediaRecorder nel browser.
      mimeType: "audio/mp4",
      sizeBytes: 96_120,
      durationMs: 9_400,
      recordedAt: new Date("2026-03-02T18:41:00.000Z"),
      // Registrato senza rete: la §1 dice che lo stadio 1 non fallisce mai.
      capturedOffline: true,
      deviceLocale: "it-IT",
      status: "ESTRAZIONE_FALLITA",
      transcript: "eh niente volevo dire che... no aspetta",
      transcriptSource: "fake-transcription",
      transcribedAt: new Date("2026-03-02T18:42:10.000Z"),
      // `Prisma.DbNull` e non `null`: su una colonna Json, Prisma distingue il
      // NULL della colonna (DbNull) dal valore JSON `null` (JsonNull). Qui
      // l'estrazione non e' mai avvenuta, quindi e' la colonna a essere vuota.
      rawExtraction: Prisma.DbNull,
      lastErrorCode: "EXTRACTION_NOT_A_PROCEDURE",
      lastErrorMessage:
        "Il modello ha classificato la trascrizione come NON_PROCEDURA: nessun passo riconoscibile.",
      lastErrorAt: new Date("2026-03-02T18:42:45.000Z"),
      retryCount: 1,
      procedureId: null,
    },
  });
}
