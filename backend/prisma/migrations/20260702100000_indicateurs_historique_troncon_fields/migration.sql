-- Migration: add indicateurs_reseau_historique + new troncons fields
-- Date: 2026-07-02

-- Nouveaux champs sur la table troncons (spec section 1.1)
ALTER TABLE "troncons"
  ADD COLUMN IF NOT EXISTS "traficDateComptage"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "criticiteStrategique"   INTEGER,
  ADD COLUMN IF NOT EXISTS "coutRehabEstime"         DECIMAL(12,3),
  ADD COLUMN IF NOT EXISTS "dateDerniereEvaluation" TIMESTAMP(3);

-- Table de snapshot mensuel pour les tendances (spec section 1.7)
CREATE TABLE IF NOT EXISTS "indicateurs_reseau_historique" (
  "id"                    SERIAL PRIMARY KEY,
  "periode"               TIMESTAMP(3) NOT NULL,
  "pctBon"                DOUBLE PRECISION NOT NULL DEFAULT 0,
  "pctMoyen"              DOUBLE PRECISION NOT NULL DEFAULT 0,
  "pctMauvais"            DOUBLE PRECISION NOT NULL DEFAULT 0,
  "pctCritique"           DOUBLE PRECISION NOT NULL DEFAULT 0,
  "pctNonEvalue"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "lineaireTraiteKm"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "budgetEngageCumul"     BIGINT NOT NULL DEFAULT 0,
  "budgetDecaisseCumul"   BIGINT NOT NULL DEFAULT 0,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "indicateurs_reseau_historique_periode_key"
  ON "indicateurs_reseau_historique"("periode");

CREATE INDEX IF NOT EXISTS "indicateurs_reseau_historique_periode_idx"
  ON "indicateurs_reseau_historique"("periode");
