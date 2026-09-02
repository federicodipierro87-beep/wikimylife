-- Generata con:
--   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- e riletta a mano. Punti da ricontrollare a ogni modifica dello schema:
--   * "embedding" vector(1536)  sulla tabella Procedure
--   * due enum di stato distinti: "CardStatus" e "RecordingStatus"
--   * tutti gli @@index dichiarati nello schema
-- Dipende da 20260902090000_enable_pgvector per il tipo `vector`.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Scope" AS ENUM ('PERSONALE', 'LAVORO', 'CLIENTE');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PRIVATA', 'CONDIVISA_TEAM', 'PUBBLICA');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('BOZZA_AUDIO', 'IN_ELABORAZIONE', 'DA_RIVEDERE', 'COMPLETA', 'ARCHIVIATA', 'ESTRAZIONE_FALLITA');

-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('BOZZA_AUDIO', 'IN_ELABORAZIONE', 'ESTRAZIONE_FALLITA', 'ESTRATTO');

-- CreateEnum
CREATE TYPE "PrereqType" AS ENUM ('DOCUMENTO', 'CREDENZIALE', 'DENARO', 'TEMPO', 'PERSONA', 'STRUMENTO', 'ALTRO');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('BLOCCANTE', 'FASTIDIO', 'NOTA');

-- CreateEnum
CREATE TYPE "RefType" AS ENUM ('PERSONA', 'URL', 'TELEFONO', 'UFFICIO', 'SISTEMA');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('FUNZIONATO', 'CAMBIATA', 'FALLITA');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'it-IT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" TEXT,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recording" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "audioUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "capturedOffline" BOOLEAN NOT NULL DEFAULT false,
    "deviceLocale" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "placeLabel" TEXT,
    "status" "RecordingStatus" NOT NULL DEFAULT 'BOZZA_AUDIO',
    "transcript" TEXT,
    "transcriptSource" TEXT,
    "transcribedAt" TIMESTAMP(3),
    "rawExtraction" JSONB,
    "extractionModel" TEXT,
    "extractedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "procedureId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Procedure" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "titolo" TEXT NOT NULL,
    "trigger" TEXT,
    "esito" TEXT,
    "validitaEsito" TEXT,
    "durataStimataMin" INTEGER,
    "costoTotaleCent" INTEGER,
    "luogoNome" TEXT,
    "luogoDettaglio" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "scope" "Scope" NOT NULL DEFAULT 'PERSONALE',
    "clientLabel" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATA',
    "status" "CardStatus" NOT NULL DEFAULT 'BOZZA_AUDIO',
    "ultimaVerifica" TIMESTAMP(3),
    "volteEseguita" INTEGER NOT NULL DEFAULT 1,
    "contieneDatiSensibili" BOOLEAN NOT NULL DEFAULT false,
    "forkedFromId" TEXT,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Procedure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Step" (
    "id" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "ordine" INTEGER NOT NULL,
    "azione" TEXT NOT NULL,
    "dettaglio" TEXT,
    "durataStimataMin" INTEGER,

    CONSTRAINT "Step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prerequisite" (
    "id" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "descrizione" TEXT NOT NULL,
    "tipo" "PrereqType" NOT NULL DEFAULT 'ALTRO',
    "obbligatorio" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Prerequisite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pitfall" (
    "id" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "descrizione" TEXT NOT NULL,
    "gravita" "Severity" NOT NULL DEFAULT 'NOTA',

    CONSTRAINT "Pitfall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cost" (
    "id" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "descrizione" TEXT NOT NULL,
    "importoCent" INTEGER NOT NULL,
    "valuta" TEXT NOT NULL DEFAULT 'EUR',

    CONSTRAINT "Cost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reference" (
    "id" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "tipo" "RefType" NOT NULL,
    "valore" TEXT NOT NULL,

    CONSTRAINT "Reference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "didascalia" TEXT,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "eseguitaIl" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "esito" "Outcome" NOT NULL,
    "nota" TEXT,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagOnProcedure" (
    "procedureId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "TagOnProcedure_pkey" PRIMARY KEY ("procedureId","tagId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_replacedById_key" ON "RefreshToken"("replacedById");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE INDEX "Recording_userId_recordedAt_idx" ON "Recording"("userId", "recordedAt");

-- CreateIndex
CREATE INDEX "Recording_status_idx" ON "Recording"("status");

-- CreateIndex
CREATE INDEX "Procedure_userId_status_idx" ON "Procedure"("userId", "status");

-- CreateIndex
CREATE INDEX "Procedure_userId_updatedAt_idx" ON "Procedure"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Step_procedureId_ordine_key" ON "Step"("procedureId", "ordine");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_userId_nome_key" ON "Tag"("userId", "nome");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "RefreshToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Procedure" ADD CONSTRAINT "Procedure_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Procedure" ADD CONSTRAINT "Procedure_forkedFromId_fkey" FOREIGN KEY ("forkedFromId") REFERENCES "Procedure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Step" ADD CONSTRAINT "Step_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prerequisite" ADD CONSTRAINT "Prerequisite_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pitfall" ADD CONSTRAINT "Pitfall_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cost" ADD CONSTRAINT "Cost_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reference" ADD CONSTRAINT "Reference_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnProcedure" ADD CONSTRAINT "TagOnProcedure_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnProcedure" ADD CONSTRAINT "TagOnProcedure_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

