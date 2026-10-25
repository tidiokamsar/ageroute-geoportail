-- RETOUR ARRIERE de `20261027110000_chantier_sections`.
--
-- CE QUI EST PERDU : tous les liens entre chantiers et troncons ou sections, en vigueur et retires, avec leurs
-- auteurs et motifs. `chantiers.tronconId` (le troncon principal) n'est pas touche par cette table et reste en place.
--
-- GARDE : la descente REFUSE de s'executer si un lien existe. Pour passer outre, apres sauvegarde verifiee et
-- autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261027110000_chantier_sections.sql
--
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "troncons" ("id","code","nom","classe","regionId","longueurKm","revetement","pkDebut","pkFin","updatedAt") VALUES ('g1','G1','x','RN',1,1,'BITUME',0,1,now()); INSERT INTO "chantiers" ("id","intitule","entreprise","regionId","updatedAt") VALUES ('gc','x','x',1,now()); INSERT INTO "chantier_sections" ("chantierId","tronconId","creeParId") VALUES ('gc','g1','g-u');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT count(*) FROM "chantier_sections" INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % lien(s) chantier / troncon enregistres. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "chantier_sections";
DROP FUNCTION IF EXISTS chantier_section_sans_suppression();

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261027110000_chantier_sections';
