-- RETOUR ARRIERE de `20260905090000_troncon_section_pk`.
--
-- Ajoute troncons.sectionPk et son index partiel.
--
-- CE QUI EST PERDU : la section de PK des troncons.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260905090000_troncon_section_pk.sql
--
-- GARDE-TEST: INSERT INTO "troncons" ("id","code","nom","classe","regionId","longueurKm","revetement","pkDebut","pkFin","updatedAt","sectionPk") VALUES ('g1','G1','x','RN',1,1,'BITUME',0,1,now(),'S1');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "troncons" WHERE num_nonnulls("sectionPk") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % troncon(s) portent une section de PK. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP INDEX IF EXISTS "troncons_section_pk_idx";
ALTER TABLE "troncons"
  DROP COLUMN IF EXISTS "sectionPk";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260905090000_troncon_section_pk';
