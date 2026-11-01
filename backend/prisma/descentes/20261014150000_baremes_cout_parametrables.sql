-- RETOUR ARRIERE de `20261014150000_baremes_cout_parametrables`.
--
-- Ajoute seize colonnes a baremes_intervention (code, version, approbation, devise, unite...), quatre a matrices_degradation, referentiel_revetements.familleCout, sept contraintes CHECK, remplace l'unicite (famille, etat) par (famille, etat, type, version) et ajoute deux index.
--
-- CE QUI EST PERDU : les versions, approbations, devises, unites et commentaires des baremes de cout et des matrices, et la famille de cout des revetements. Le retour a l'unicite (famille, etat) est refuse, sans derogation, si des versions multiples coexistent.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261014150000_baremes_cout_parametrables.sql
--
-- GARDE-TEST: UPDATE "baremes_intervention" SET "approuveLe" = now() WHERE "familleRevetement" = 'bitume' AND "etatDepart" = 'MOYEN';
-- GARDE-TEST-SANS-DEROGATION: INSERT INTO "baremes_intervention" ("familleRevetement","etatDepart","typeIntervention","coutKmGnf","version") VALUES ('bitume','MOYEN','entretien_periodique',1,2);
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $doublons$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM (SELECT 1 FROM "baremes_intervention" GROUP BY "familleRevetement", "etatDepart" HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % couple(s) (famille, etat) existent en plusieurs versions ou types : l''ancienne unicite ne peut pas etre restauree. Aucune version n''est supprimee ici : decision metier.', n;
  END IF;
END
$doublons$;
DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "baremes_intervention" WHERE "version" <> 1 OR "source" <> 'standard_initial' OR "approuveLe" IS NOT NULL OR "code" IS NOT NULL OR "libelle" IS NOT NULL OR "anneeReference" IS NOT NULL OR "largeurChausseeM" IS NOT NULL OR NOT "actif" OR "commentaire" IS NOT NULL OR "validDe" IS NOT NULL OR "validA" IS NOT NULL OR "devise" <> 'GNF' OR "uniteCout" <> 'KM' OR "ordre" <> 0)
    + (SELECT count(*) FROM "matrices_degradation" WHERE "approuveLe" IS NOT NULL OR "commentaire" IS NOT NULL OR NOT "actif")
    + (SELECT count(*) FROM "referentiel_revetements" WHERE "familleCout" IS NOT NULL) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de baremes, de matrices ou de revetements portent des valeurs de parametrage. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

COMMENT ON COLUMN "referentiel_revetements"."familleCout" IS NULL;
ALTER TABLE "referentiel_revetements"
  DROP COLUMN IF EXISTS "familleCout";
ALTER TABLE "matrices_degradation" DROP CONSTRAINT IF EXISTS "matrice_probabilites_bornees";
ALTER TABLE "matrices_degradation" DROP CONSTRAINT IF EXISTS "matrices_degradation_approuveParId_fkey";
ALTER TABLE "matrices_degradation"
  DROP COLUMN IF EXISTS "approuveLe",
  DROP COLUMN IF EXISTS "approuveParId",
  DROP COLUMN IF EXISTS "commentaire",
  DROP COLUMN IF EXISTS "actif";
DROP INDEX IF EXISTS "baremes_intervention_code_key";
DROP INDEX IF EXISTS "baremes_intervention_actif_famille_idx";
ALTER TABLE "baremes_intervention" DROP CONSTRAINT IF EXISTS "baremes_intervention_famille_etat_type_version_key";
ALTER TABLE "baremes_intervention" DROP CONSTRAINT IF EXISTS "bareme_cout_strictement_positif";
ALTER TABLE "baremes_intervention" DROP CONSTRAINT IF EXISTS "bareme_version_positive";
ALTER TABLE "baremes_intervention" DROP CONSTRAINT IF EXISTS "bareme_annee_plausible";
ALTER TABLE "baremes_intervention" DROP CONSTRAINT IF EXISTS "bareme_largeur_positive";
ALTER TABLE "baremes_intervention" DROP CONSTRAINT IF EXISTS "bareme_fenetre_coherente";
ALTER TABLE "baremes_intervention" DROP CONSTRAINT IF EXISTS "bareme_unite_connue";
ALTER TABLE "baremes_intervention" DROP CONSTRAINT IF EXISTS "bareme_devise_non_vide";
ALTER TABLE "baremes_intervention" DROP CONSTRAINT IF EXISTS "baremes_intervention_approuveParId_fkey";
ALTER TABLE "baremes_intervention"
  DROP COLUMN IF EXISTS "code",
  DROP COLUMN IF EXISTS "libelle",
  DROP COLUMN IF EXISTS "source",
  DROP COLUMN IF EXISTS "version",
  DROP COLUMN IF EXISTS "approuveLe",
  DROP COLUMN IF EXISTS "approuveParId",
  DROP COLUMN IF EXISTS "anneeReference",
  DROP COLUMN IF EXISTS "devise",
  DROP COLUMN IF EXISTS "largeurChausseeM",
  DROP COLUMN IF EXISTS "uniteCout",
  DROP COLUMN IF EXISTS "actif",
  DROP COLUMN IF EXISTS "ordre",
  DROP COLUMN IF EXISTS "commentaire",
  DROP COLUMN IF EXISTS "validDe",
  DROP COLUMN IF EXISTS "validA",
  DROP COLUMN IF EXISTS "createdAt",
  DROP COLUMN IF EXISTS "updatedAt";
ALTER TABLE "baremes_intervention" ADD CONSTRAINT "baremes_intervention_familleRevetement_etatDepart_key" UNIQUE ("familleRevetement", "etatDepart");

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261014150000_baremes_cout_parametrables';
