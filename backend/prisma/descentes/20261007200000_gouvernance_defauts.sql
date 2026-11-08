-- RETOUR ARRIERE de `20261007200000_gouvernance_defauts`.
--
-- Cree huit types enumeres, les tables validations, catalogue_defauts, defauts et medias_defaut, ajoute statutValidation a cinq tables patrimoniales et quatre colonnes de perimetre a troncons.
--
-- CE QUI EST PERDU : le journal des validations, le catalogue des types de defauts, les defauts releves et leurs medias, le statut de validation de chaque troncon, ouvrage, point noir, poste et chantier, et le perimetre des troncons.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261007200000_gouvernance_defauts.sql
--
-- GARDE-TEST: INSERT INTO "validations" ("id","entityType","entityId","statutApres") VALUES ('g1','t','e','VALIDE');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "validations") + (SELECT count(*) FROM "catalogue_defauts") + (SELECT count(*) FROM "defauts") + (SELECT count(*) FROM "medias_defaut")
    + (SELECT count(*) FROM "troncons" WHERE "statutValidation" IS NOT NULL) + (SELECT count(*) FROM "ouvrages" WHERE "statutValidation" IS NOT NULL) + (SELECT count(*) FROM "points_noirs" WHERE "statutValidation" IS NOT NULL) + (SELECT count(*) FROM "postes" WHERE "statutValidation" IS NOT NULL) + (SELECT count(*) FROM "chantiers" WHERE "statutValidation" IS NOT NULL)
    + (SELECT count(*) FROM "troncons" WHERE num_nonnulls("perimetre", "paysTerritoire", "motifPerimetre", "perimetreClasseA") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de validations, catalogue, defauts, medias, statuts de validation ou perimetres. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "medias_defaut";
DROP TABLE IF EXISTS "defauts";
DROP TABLE IF EXISTS "catalogue_defauts";
DROP TABLE IF EXISTS "validations";
ALTER TABLE "troncons"
  DROP COLUMN IF EXISTS "statutValidation",
  DROP COLUMN IF EXISTS "perimetre",
  DROP COLUMN IF EXISTS "paysTerritoire",
  DROP COLUMN IF EXISTS "motifPerimetre",
  DROP COLUMN IF EXISTS "perimetreClasseA";
ALTER TABLE "ouvrages"
  DROP COLUMN IF EXISTS "statutValidation";
ALTER TABLE "points_noirs"
  DROP COLUMN IF EXISTS "statutValidation";
ALTER TABLE "postes"
  DROP COLUMN IF EXISTS "statutValidation";
ALTER TABLE "chantiers"
  DROP COLUMN IF EXISTS "statutValidation";
DROP TYPE IF EXISTS "EtatDefaut";
DROP TYPE IF EXISTS "EtendueDefaut";
DROP TYPE IF EXISTS "MethodeQuantite";
DROP TYPE IF EXISTS "FamilleDefaut";
DROP TYPE IF EXISTS "MesureDefaut";
DROP TYPE IF EXISTS "UniteDefaut";
DROP TYPE IF EXISTS "PerimetreReseau";
DROP TYPE IF EXISTS "StatutValidation";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261007200000_gouvernance_defauts';
