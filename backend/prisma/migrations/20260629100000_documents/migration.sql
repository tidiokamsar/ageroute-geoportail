CREATE TYPE "DocumentType" AS ENUM ('ARRETE', 'CAHIER_CHARGES', 'CAHIER_ENGAGEMENT', 'AUTRE');

CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "titre" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "annee" INTEGER,
    "tronconId" TEXT,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "documents_tronconId_idx" ON "documents"("tronconId");
CREATE INDEX "documents_type_idx" ON "documents"("type");
CREATE INDEX "documents_deletedAt_idx" ON "documents"("deletedAt");

ALTER TABLE "documents" ADD CONSTRAINT "documents_tronconId_fkey" FOREIGN KEY ("tronconId") REFERENCES "troncons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
