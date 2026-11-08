-- RETOUR ARRIERE de `20260701150000_troncon_draw_fields`.
--
-- Ajoute troncons.prefecture, troncons.commune et troncons.observations.
--
-- CE QUI EST PERDU : la prefecture, la commune et les observations des troncons.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260701150000_troncon_draw_fields.sql
--
-- GARDE-TEST: INSERT INTO "troncons" ("id","code","nom","classe","regionId","longueurKm","revetement","pkDebut","pkFin","updatedAt","commune") VALUES ('g1','G1','x','RN',1,1,'BITUME',0,1,now(),'Kaloum');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "troncons" WHERE num_nonnulls("prefecture", "commune", "observations") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % troncon(s) portent une prefecture, une commune ou des observations. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

ALTER TABLE "troncons"
  DROP COLUMN IF EXISTS "prefecture",
  DROP COLUMN IF EXISTS "commune",
  DROP COLUMN IF EXISTS "observations";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260701150000_troncon_draw_fields';
