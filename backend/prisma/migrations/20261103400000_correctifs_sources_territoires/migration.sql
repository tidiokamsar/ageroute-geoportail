-- CORRECTIFS APRES LA REVUE INDEPENDANTE DES LOTS T1 (territoires, referentiels) ET S1 (sources multiples, comparaison) du 09/11/2026
--
-- Rapport de revue : REVUE-VAGUE3-T1S1.md (hors depot). Rapport des correctifs : docs/reports/CORRECTIFS-REVUE-T1S1.md. Contrats mis a jour :
-- docs/projets-voirie/CONTRAT-SOURCES.md, CONTRAT-TERRITOIRES.md, API.md.
--
-- CE QUE CETTE MIGRATION FAIT (ADDITIVE : aucune colonne ni table existante n'est supprimee, aucune valeur existante n'est perdue)
--
--   B1. `conflits_projet.jeuSourceBId` : le jeu B de la comparaison d'un dossier DIVERGENCE_SOURCES, renseigne pour les dossiers existants depuis leur
--       comparaison ; son statut entre dans la lisibilite du dossier (un lecteur ne voit rien d'un jeu B non AUTORISE, personne ne voit rien d'un jeu B
--       RETIRE). Fige, et egal au jeu B de la comparaison (declencheur).
--   (les sections suivantes sont ajoutees par les correctifs M2, M3 et M6, dans l'ordre de leurs commits)
--
-- Idempotente (IF NOT EXISTS, ON CONFLICT DO NOTHING, gardes par pg_constraint). Exige les migrations 20261103100000 (T1) et 20261103300000 (S1).
-- REVERSIBILITE : descentes/20261103400000_correctifs_sources_territoires.sql.

-- ===== B1. Dossier DIVERGENCE_SOURCES : le jeu B entre dans la lisibilite =====

ALTER TABLE "conflits_projet" ADD COLUMN IF NOT EXISTS "jeuSourceBId" TEXT REFERENCES "projets_voirie_jeux"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "conflits_projet_jeuSourceBId_idx" ON "conflits_projet" ("jeuSourceBId");
-- Dossiers deja ouverts : le jeu B est celui de leur comparaison (la colonne n'est pas une colonne d'identite : le declencheur de recalcul l'admet).
UPDATE "conflits_projet" c SET "jeuSourceBId" = cmp."jeuBId"
  FROM "comparaisons_sources_projet" cmp
 WHERE c."comparaisonId" = cmp."id" AND c."jeuSourceBId" IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cp_jeu_source_b') THEN
    ALTER TABLE "conflits_projet" ADD CONSTRAINT "cp_jeu_source_b" CHECK (("comparaisonId" IS NULL) = ("jeuSourceBId" IS NULL));
  END IF;
END $$;
COMMENT ON COLUMN "conflits_projet"."jeuSourceBId" IS 'Jeu B de la comparaison d''un dossier DIVERGENCE_SOURCES (correctifs T1+S1, B1) : son statut entre dans la lisibilite du dossier. Fige, egal au jeu B de la comparaison.';

-- Le jeu B d'un dossier est celui de sa comparaison, et ne change plus.
CREATE OR REPLACE FUNCTION conflits_projet_jeu_source_b() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_b text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."jeuSourceBId" IS NOT NULL AND NEW."jeuSourceBId" IS DISTINCT FROM OLD."jeuSourceBId" THEN
    RAISE EXCEPTION 'conflits_projet : le jeu B d''un dossier de divergence est fige' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."comparaisonId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."jeuSourceBId" IS DISTINCT FROM OLD."jeuSourceBId") THEN
    SELECT "jeuBId" INTO v_b FROM "comparaisons_sources_projet" WHERE "id" = NEW."comparaisonId";
    IF v_b IS DISTINCT FROM NEW."jeuSourceBId" THEN
      RAISE EXCEPTION 'conflits_projet : le jeu B d''un dossier de divergence doit etre le jeu B de sa comparaison' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS conflits_projet_jeu_source_b ON "conflits_projet";
CREATE TRIGGER conflits_projet_jeu_source_b BEFORE INSERT OR UPDATE ON "conflits_projet" FOR EACH ROW EXECUTE FUNCTION conflits_projet_jeu_source_b();
