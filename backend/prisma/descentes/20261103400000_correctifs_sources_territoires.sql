-- RETOUR ARRIERE de `20261103400000_correctifs_sources_territoires` (correctifs apres la revue T1+S1 du 09/11/2026).
--
-- CE QUI EST PERDU :
--   - B1 : le lien d'un dossier DIVERGENCE_SOURCES vers le jeu B de sa comparaison (`conflits_projet.jeuSourceBId`) ; il se deduit de la comparaison,
--     rien n'est perdu de ce qui a ete decide ou mesure ;
--   - M2 : le controle par la base de la methode d'acquisition d'un jeu contre le referentiel (le service d'avant revient a sa liste codee) ;
--   - M3 : le type de reseau dans la cle de version ; la descente REFUSE, meme autorisee, si deux jeux ne se distinguent que par leur type.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261103400000_correctifs_sources_territoires.sql

-- ===== Garde =====
DO $garde$
DECLARE dbl bigint;
BEGIN
  -- M3 : deux jeux AUTORISE (ou deux depots en attente) d'une meme cle (projet, role, concessionnaire, methode) qui ne se distinguent que par le type de
  -- reseau : l'index du lot S1 ne peut pas etre retabli sans choisir lequel garder (decision metier, pas une autorisation).
  SELECT count(*) INTO dbl FROM (
    SELECT 1 FROM "projets_voirie_jeux" WHERE "statut" = 'AUTORISE' AND "role" <> 'AUTRE'
     GROUP BY "projetId", "role", COALESCE("concessionnaireId", ''), (CASE WHEN "role" = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END) HAVING count(*) > 1
    UNION ALL
    SELECT 1 FROM "projets_voirie_jeux" WHERE "statut" IN ('RECU', 'CONTROLE') AND "role" <> 'AUTRE'
     GROUP BY "projetId", "role", COALESCE("concessionnaireId", ''), (CASE WHEN "role" = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END) HAVING count(*) > 1) q;
  IF dbl > 0 THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % cle(s) (projet, role, concessionnaire, methode) portent plusieurs jeux autorises ou en attente qui ne se distinguent que par le type de reseau : l''index du lot S1 ne peut pas etre retabli sans choisir lequel garder (decision metier).', dbl;
  END IF;
END
$garde$;

-- ===== M3 =====
DROP INDEX IF EXISTS "projets_voirie_jeux_cle_autorise_key";
DROP INDEX IF EXISTS "projets_voirie_jeux_cle_attente_key";
DROP FUNCTION IF EXISTS pv_identite_type_reseau(text, "TypeReseauTiers");
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_cle_autorise_key" ON "projets_voirie_jeux" ("projetId", "role", COALESCE("concessionnaireId", ''), (CASE WHEN "role" = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END))
  WHERE "statut" = 'AUTORISE' AND "role" <> 'AUTRE';
CREATE UNIQUE INDEX IF NOT EXISTS "projets_voirie_jeux_cle_attente_key" ON "projets_voirie_jeux" ("projetId", "role", COALESCE("concessionnaireId", ''), (CASE WHEN "role" = 'RESEAU_TIERS' THEN COALESCE("methodeAcquisition", '') ELSE '' END))
  WHERE "statut" IN ('RECU', 'CONTROLE') AND "role" <> 'AUTRE';

-- ===== M2 =====
-- RESIDU DE DONNEES (pas de schema) : les valeurs du lot S1 ajoutees au referentiel METHODE_ACQUISITION restent (des jeux les portent ; une valeur ne
-- se supprime pas physiquement). Le commentaire de colonne d'origine (lot S1) est retabli.
DROP TRIGGER IF EXISTS projets_voirie_jeux_methode_acquisition ON "projets_voirie_jeux";
DROP FUNCTION IF EXISTS projets_voirie_jeux_methode_acquisition();
COMMENT ON COLUMN "projets_voirie_jeux"."methodeAcquisition" IS 'Code de la methode d''acquisition (GNSS_RTK, GEORADAR, NUMERISATION_PLAN...) : liste du service (config.ts), reliable au referentiel METHODE_ACQUISITION (lot T1). Nul = non renseignee. Composante de la cle de version : deux methodes = deux sources du meme reseau.';

-- ===== B1 =====
DROP TRIGGER IF EXISTS conflits_projet_jeu_source_b ON "conflits_projet";
DROP FUNCTION IF EXISTS conflits_projet_jeu_source_b();
ALTER TABLE "conflits_projet" DROP CONSTRAINT IF EXISTS "cp_jeu_source_b";
DROP INDEX IF EXISTS "conflits_projet_jeuSourceBId_idx";
ALTER TABLE "conflits_projet" DROP COLUMN IF EXISTS "jeuSourceBId";

-- Apres une descente reussie, retirer la ligne de l'historique de Prisma :
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103400000_correctifs_sources_territoires';
