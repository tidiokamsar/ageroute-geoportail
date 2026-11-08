-- RETOUR ARRIERE de `20260901220000_inspection_coordonnees`.
--
-- Ajoute inspections.lat, inspections.lon et inspections.precisionM.
--
-- CE QUI EST PERDU : la position GPS des inspections : la donnee la plus difficile a recollecter, il faut retourner sur place.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260901220000_inspection_coordonnees.sql
--
-- GARDE-TEST: INSERT INTO "inspections" ("id","inspecteurId","dateInspection","etatObserve","lat","lon") VALUES ('g1','u',now(),'BON',9.5,-13.7);
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "inspections" WHERE num_nonnulls("lat", "lon", "precisionM") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % inspection(s) portent une position GPS. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

ALTER TABLE "inspections"
  DROP COLUMN IF EXISTS "lat",
  DROP COLUMN IF EXISTS "lon",
  DROP COLUMN IF EXISTS "precisionM";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260901220000_inspection_coordonnees';
