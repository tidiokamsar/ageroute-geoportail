-- Migration: tables bailleurs, marches, marches_chantiers, avancement_marche
-- Date: 2026-07-02

-- Enums
DO $$ BEGIN
  CREATE TYPE "DeviseMarche" AS ENUM ('GNF', 'USD', 'EUR');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "StatutMarche" AS ENUM ('PLANIFIE', 'EN_COURS', 'SUSPENDU', 'TERMINE', 'SOLDE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Table bailleurs
CREATE TABLE IF NOT EXISTS "bailleurs" (
  "id"    SERIAL PRIMARY KEY,
  "nom"   TEXT NOT NULL UNIQUE,
  "type"  TEXT NOT NULL DEFAULT 'autre'
);

-- Seed bailleurs initiaux
INSERT INTO "bailleurs" ("nom", "type") VALUES
  ('État guinéen',          'etat'),
  ('Banque mondiale',       'multilateral'),
  ('BAD',                   'multilateral'),
  ('Union européenne',      'bilateral'),
  ('Coopération bilatérale','bilateral')
ON CONFLICT ("nom") DO NOTHING;

-- Table marches
CREATE TABLE IF NOT EXISTS "marches" (
  "id"                        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "intitule"                  TEXT NOT NULL,
  "bailleurId"                INTEGER REFERENCES "bailleurs"("id"),
  "montantTotal"              BIGINT,
  "devise"                    "DeviseMarche" NOT NULL DEFAULT 'GNF',
  "dateSignature"             TIMESTAMP(3),
  "dateDebutPrevue"           TIMESTAMP(3),
  "dateFinPrevue"             TIMESTAMP(3),
  "dateReceptionProvisoire"   TIMESTAMP(3),
  "garantieBonneExecutionExp" TIMESTAMP(3),
  "tauxPenaliteRetardPct"     DOUBLE PRECISION,
  "statut"                    "StatutMarche" NOT NULL DEFAULT 'PLANIFIE',
  "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "marches_bailleurId_idx" ON "marches"("bailleurId");
CREATE INDEX IF NOT EXISTS "marches_statut_idx"     ON "marches"("statut");

-- Table de liaison marches_chantiers (many-to-many)
CREATE TABLE IF NOT EXISTS "marches_chantiers" (
  "marcheId"   TEXT NOT NULL REFERENCES "marches"("id") ON DELETE CASCADE,
  "chantierId" TEXT NOT NULL REFERENCES "chantiers"("id") ON DELETE CASCADE,
  "tronconId"  TEXT REFERENCES "troncons"("id"),
  PRIMARY KEY ("marcheId", "chantierId")
);

-- Table avancement_marche (courbe en S)
CREATE TABLE IF NOT EXISTS "avancement_marche" (
  "id"                        SERIAL PRIMARY KEY,
  "marcheId"                  TEXT NOT NULL REFERENCES "marches"("id") ON DELETE CASCADE,
  "periode"                   TIMESTAMP(3) NOT NULL,
  "avancementPhysiquePrevu"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "avancementPhysiqueReel"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "avancementFinancierPrevu"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  "avancementFinancierReel"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("marcheId", "periode")
);

CREATE INDEX IF NOT EXISTS "avancement_marche_marcheId_idx" ON "avancement_marche"("marcheId");
