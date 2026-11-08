-- REGISTRE DES ANOMALIES DU REFERENTIEL DES TRONCONS (BDRI, lot C)
--
-- Jusqu'ici le rapport de qualite (`/api/v2/qualite/anomalies`) etait recalcule a chaque appel et n'ecrivait
-- rien : une anomalie constatee ne pouvait etre ni examinee, ni rejetee, ni corrigee avec une trace. Ce registre
-- la rend PERSISTANTE et lui donne un cycle de decision :
--
--   A_EXAMINER -> CORRECTION_PROPOSEE -> VALIDEE -> CORRIGEE      (et REJETEE a toute etape avant CORRIGEE)
--
-- CE QUE CETTE MIGRATION NE FAIT PAS, ET C'EST VOLONTAIRE
--   * Aucune ligne n'est semee : le registre se remplit par une ANALYSE explicite (route d'analyse), bornee par
--     region comme le rapport existant. Une migration ne lit ni ne juge les donnees.
--   * Aucune correction n'est appliquee ici. Une correction est une PROPOSITION portee par une decision, puis
--     appliquee par une route qui verifie que la valeur courante est toujours celle qui a ete constatee.
--   * Aucun tronçon n'est modifie, supprime ou fusionne.
--
-- IDEMPOTENCE DE L'ANALYSE : une anomalie est identifiee par (tronconId, regle, empreinte), l'empreinte etant
-- calculee sur les VALEURS observees. Relancer l'analyse sur des donnees inchangees ne cree rien ; une valeur qui
-- change produit une nouvelle anomalie, et l'ancienne recoit `disparueLe` au lieu d'etre effacee.
--
-- JOURNAL DES DECISIONS EN AJOUT SEUL : `decisions_anomalie` refuse UPDATE et DELETE (declencheur). Chaque
-- decision porte son auteur, son instant serveur, le statut d'avant et d'apres, et la correction proposee ou
-- appliquee (ancienne valeur, nouvelle valeur, justification, source).
--
-- NATURE : additive, deux tables, une fonction de declencheur. Aucune donnee lue ni ecrite ailleurs.
-- REVERSIBILITE : voir backend/prisma/descentes/20261027100000_registre_anomalies_referentiel.sql.

CREATE TABLE IF NOT EXISTS "anomalies_referentiel" (
  "id"                  TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tronconId"           TEXT NOT NULL REFERENCES "troncons"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "regle"               TEXT NOT NULL,
  "empreinte"           TEXT NOT NULL,
  "gravite"             TEXT NOT NULL,
  "valeurs"             JSONB NOT NULL,
  "source"              TEXT NOT NULL,
  "statut"              TEXT NOT NULL DEFAULT 'A_EXAMINER',
  "correction"          JSONB,
  "regionId"            INTEGER REFERENCES "regions"("id") ON UPDATE CASCADE ON DELETE SET NULL,
  "detecteeLe"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "derniereDetectionLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disparueLe"          TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "anomalies_referentiel_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "anomalie_ref_statut" CHECK ("statut" IN ('A_EXAMINER','CORRECTION_PROPOSEE','VALIDEE','REJETEE','CORRIGEE')),
  CONSTRAINT "anomalie_ref_gravite" CHECK ("gravite" IN ('BLOQUANTE','MAJEURE','MINEURE','INFO')),
  CONSTRAINT "anomalie_ref_regle_forme" CHECK ("regle" ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT "anomalie_ref_source_non_vide" CHECK (length(btrim("source")) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "anomalies_referentiel_troncon_regle_empreinte_key"
  ON "anomalies_referentiel" ("tronconId", "regle", "empreinte");
CREATE INDEX IF NOT EXISTS "anomalies_referentiel_statut_idx" ON "anomalies_referentiel" ("statut");
CREATE INDEX IF NOT EXISTS "anomalies_referentiel_regle_idx" ON "anomalies_referentiel" ("regle");
CREATE INDEX IF NOT EXISTS "anomalies_referentiel_region_idx" ON "anomalies_referentiel" ("regionId");

CREATE TABLE IF NOT EXISTS "decisions_anomalie" (
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "anomalieId"  TEXT NOT NULL REFERENCES "anomalies_referentiel"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "statutAvant" TEXT,
  "statutApres" TEXT NOT NULL,
  "commentaire" TEXT,
  "correction"  JSONB,
  "auteurId"    TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "decideLe"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "decisions_anomalie_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "decision_anomalie_statut" CHECK ("statutApres" IN ('A_EXAMINER','CORRECTION_PROPOSEE','VALIDEE','REJETEE','CORRIGEE'))
);

CREATE INDEX IF NOT EXISTS "decisions_anomalie_anomalie_idx" ON "decisions_anomalie" ("anomalieId", "decideLe");

CREATE OR REPLACE FUNCTION decision_anomalie_ajout_seul() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  RAISE EXCEPTION 'decisions_anomalie : ajout seul (une decision ne se modifie ni ne s''efface)'
    USING ERRCODE = 'restrict_violation';
END
$f$;

DROP TRIGGER IF EXISTS "decisions_anomalie_ajout_seul" ON "decisions_anomalie";
CREATE TRIGGER "decisions_anomalie_ajout_seul"
  BEFORE UPDATE OR DELETE ON "decisions_anomalie"
  FOR EACH ROW EXECUTE FUNCTION decision_anomalie_ajout_seul();
