-- Modules : Ordres de travaux, Courbes de dégradation, Signalements citoyens
-- Spec benchmark Streetlogix adaptée AGEROUTE Guinée — 2026-07-06

-- ── Enums ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "TypeInterventionOT" AS ENUM ('REPARATION_CHAUSSEE','CURAGE_ASSAINISSEMENT','SIGNALISATION','DEBROUSSAILLAGE','OUVRAGE_ART_MINEUR','URGENCE_SECURITE','AUTRE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "PrioriteOT" AS ENUM ('URGENTE','HAUTE','NORMALE','BASSE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "StatutOT" AS ENUM ('BROUILLON','ASSIGNE','EN_COURS','SUSPENDU','TERMINE','ANNULE','CONVERTI_CHANTIER'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "TypePhotoOT" AS ENUM ('AVANT','PENDANT','APRES'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "CanalSignalement" AS ENUM ('PWA','SMS_USSD','AGENT'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "TypeProbleme" AS ENUM ('NID_DE_POULE','CHAUSSEE_DEGRADEE','OUVRAGE_ENDOMMAGE','ROUTE_COUPEE','INONDATION','PANNEAU_SIGNALISATION','VEGETATION','DANGER_AUTRE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "StatutSignalement" AS ENUM ('NOUVEAU','EN_QUALIFICATION','VALIDE','REJETE','DOUBLON','CONVERTI_OT','RESOLU'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Signalements citoyens (créée avant ordres_travaux : FK signalementId) ──────
CREATE TABLE IF NOT EXISTS "signalements_citoyens" (
  "id"                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "numeroPublic"        TEXT NOT NULL UNIQUE,
  "canal"               "CanalSignalement" NOT NULL DEFAULT 'PWA',
  "typeProbleme"        "TypeProbleme" NOT NULL,
  "description"         TEXT,
  "lat"                 DOUBLE PRECISION,
  "lon"                 DOUBLE PRECISION,
  "localisationTexte"   TEXT,
  "tronconId"           TEXT REFERENCES "troncons"("id"),
  "photoFileName"       TEXT,
  "statut"              "StatutSignalement" NOT NULL DEFAULT 'NOUVEAU',
  "motifRejet"          TEXT,
  "signalementParentId" TEXT REFERENCES "signalements_citoyens"("id"),
  "contactTel"          TEXT,
  "qualifieParId"       TEXT REFERENCES "users"("id"),
  "qualifieLe"          TIMESTAMP(3),
  "resoluLe"            TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "signalements_statut_idx" ON "signalements_citoyens"("statut");
CREATE INDEX IF NOT EXISTS "signalements_type_idx"   ON "signalements_citoyens"("typeProbleme");

-- ── Ordres de travaux ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ordres_travaux" (
  "id"               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "numero"           TEXT NOT NULL UNIQUE,
  "titre"            TEXT NOT NULL,
  "description"      TEXT,
  "typeIntervention" "TypeInterventionOT" NOT NULL,
  "priorite"         "PrioriteOT" NOT NULL DEFAULT 'NORMALE',
  "statut"           "StatutOT" NOT NULL DEFAULT 'BROUILLON',
  "regionId"         INTEGER REFERENCES "regions"("id"),
  "tronconId"        TEXT REFERENCES "troncons"("id"),
  "ouvrageId"        TEXT REFERENCES "ouvrages"("id"),
  "pointNoirId"      TEXT REFERENCES "points_noirs"("id"),
  "signalementId"    TEXT REFERENCES "signalements_citoyens"("id"),
  "chantierId"       TEXT,
  "pkLocalisation"   DOUBLE PRECISION,
  "lat"              DOUBLE PRECISION,
  "lon"              DOUBLE PRECISION,
  "coutEstimeGnf"    BIGINT,
  "coutReelGnf"      BIGINT,
  "assigneAId"       TEXT REFERENCES "users"("id"),
  "entreprise"       TEXT,
  "dateEcheance"     TIMESTAMP(3),
  "dateDebutReel"    TIMESTAMP(3),
  "dateFinReelle"    TIMESTAMP(3),
  "creeParId"        TEXT NOT NULL REFERENCES "users"("id"),
  "deletedAt"        TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ot_statut_idx"    ON "ordres_travaux"("statut");
CREATE INDEX IF NOT EXISTS "ot_priorite_idx"  ON "ordres_travaux"("priorite");
CREATE INDEX IF NOT EXISTS "ot_region_idx"    ON "ordres_travaux"("regionId");
CREATE INDEX IF NOT EXISTS "ot_assigne_idx"   ON "ordres_travaux"("assigneAId");
CREATE INDEX IF NOT EXISTS "ot_deleted_idx"   ON "ordres_travaux"("deletedAt");

CREATE TABLE IF NOT EXISTS "ot_photos" (
  "id"         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "otId"       TEXT NOT NULL REFERENCES "ordres_travaux"("id") ON DELETE CASCADE,
  "fileName"   TEXT NOT NULL,
  "type"       "TypePhotoOT" NOT NULL DEFAULT 'AVANT',
  "lat"        DOUBLE PRECISION,
  "lon"        DOUBLE PRECISION,
  "priseLe"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "priseParId" TEXT REFERENCES "users"("id")
);
CREATE INDEX IF NOT EXISTS "ot_photos_ot_idx" ON "ot_photos"("otId");

CREATE TABLE IF NOT EXISTS "ot_historique" (
  "id"            SERIAL PRIMARY KEY,
  "otId"          TEXT NOT NULL REFERENCES "ordres_travaux"("id") ON DELETE CASCADE,
  "action"        TEXT NOT NULL,
  "ancienStatut"  "StatutOT",
  "nouveauStatut" "StatutOT",
  "commentaire"   TEXT,
  "userId"        TEXT REFERENCES "users"("id"),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ot_historique_ot_idx" ON "ot_historique"("otId");

-- ── Courbes de dégradation ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "matrices_degradation" (
  "id"                   SERIAL PRIMARY KEY,
  "familleRevetement"    TEXT NOT NULL,
  "classeTrafic"         TEXT NOT NULL,
  "pBonVersMoyen"        DOUBLE PRECISION NOT NULL,
  "pMoyenVersMauvais"    DOUBLE PRECISION NOT NULL,
  "pMauvaisVersCritique" DOUBLE PRECISION NOT NULL,
  "source"               TEXT NOT NULL DEFAULT 'standard_initial',
  "version"              INTEGER NOT NULL DEFAULT 1,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("familleRevetement", "classeTrafic")
);

-- Valeurs initiales HDM-4 simplifiées zone tropicale humide — À VALIDER par la
-- Direction Technique AGEROUTE, recalées dès 2 inspections datées par tronçon.
INSERT INTO "matrices_degradation" ("familleRevetement","classeTrafic","pBonVersMoyen","pMoyenVersMauvais","pMauvaisVersCritique") VALUES
  ('bitume','T1_faible',0.08,0.12,0.18),
  ('bitume','T2_moyen',0.12,0.18,0.25),
  ('bitume','T3_fort',0.18,0.28,0.38),
  ('terre_laterite','T1_faible',0.25,0.35,0.45),
  ('terre_laterite','T2_moyen',0.35,0.50,0.60),
  ('terre_laterite','T3_fort',0.50,0.65,0.75),
  ('pave','T1_faible',0.06,0.10,0.15),
  ('pave','T2_moyen',0.09,0.14,0.20),
  ('pave','T3_fort',0.14,0.22,0.30)
ON CONFLICT ("familleRevetement","classeTrafic") DO NOTHING;

CREATE TABLE IF NOT EXISTS "baremes_intervention" (
  "id"                SERIAL PRIMARY KEY,
  "familleRevetement" TEXT NOT NULL,
  "etatDepart"        TEXT NOT NULL,
  "typeIntervention"  TEXT NOT NULL,
  "coutKmGnf"         BIGINT NOT NULL,
  UNIQUE ("familleRevetement", "etatDepart")
);

-- Barèmes M GNF/km — ratio ~1:3:10, à calibrer avec les coûts réels du module Marchés
INSERT INTO "baremes_intervention" ("familleRevetement","etatDepart","typeIntervention","coutKmGnf") VALUES
  ('bitume','MOYEN','entretien_periodique',350000000),
  ('bitume','MAUVAIS','rehabilitation',1100000000),
  ('bitume','CRITIQUE','reconstruction',3500000000),
  ('terre_laterite','MOYEN','entretien_periodique',80000000),
  ('terre_laterite','MAUVAIS','rehabilitation',250000000),
  ('terre_laterite','CRITIQUE','reconstruction',700000000),
  ('pave','MOYEN','entretien_periodique',300000000),
  ('pave','MAUVAIS','rehabilitation',900000000),
  ('pave','CRITIQUE','reconstruction',2800000000)
ON CONFLICT ("familleRevetement","etatDepart") DO NOTHING;
