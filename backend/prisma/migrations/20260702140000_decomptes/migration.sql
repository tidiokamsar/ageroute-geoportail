-- Suivi des décaissements réels par marché (décomptes payés, avances, retenues de garantie)

DO $$ BEGIN
  CREATE TYPE "DecompteType" AS ENUM ('AVANCE', 'DECOMPTE', 'RETENUE_GARANTIE', 'SOLDE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "DecompteStatut" AS ENUM ('EMIS', 'PAYE', 'REJETE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "decomptes" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "marcheId"     UUID NOT NULL REFERENCES "marches"("id") ON DELETE CASCADE,
  "numero"       INTEGER NOT NULL,
  "type"         "DecompteType" NOT NULL DEFAULT 'DECOMPTE',
  "montantGnf"   BIGINT NOT NULL,
  "dateEmission" TIMESTAMP(3),
  "datePaiement" TIMESTAMP(3),
  "statut"       "DecompteStatut" NOT NULL DEFAULT 'EMIS',
  "observations" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "decomptes_marcheId_idx" ON "decomptes"("marcheId");
CREATE INDEX IF NOT EXISTS "decomptes_statut_idx"   ON "decomptes"("statut");
