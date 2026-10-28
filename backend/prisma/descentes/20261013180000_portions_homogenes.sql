-- RETOUR ARRIERE de `20261013180000_portions_homogenes`.
--
-- Cree l'extension btree_gist, le type OriginePortion et les tables portions (avec contrainte d'exclusion de chevauchement) et portions_lignage.
--
-- CE QUI EST PERDU : les portions homogenes de chaque troncon et leur lignage (decoupes, fusions, requalifications).
--
-- A SAVOIR : L'extension btree_gist est LAISSEE EN PLACE : elle peut avoir ete installee avant cette migration, et son retrait demande des droits de superutilisateur. C'est le seul residu, declare ci-dessous.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261013180000_portions_homogenes.sql
--
-- RESIDUS : les lignes de l'instantane de schema que cette descente laisse volontairement en place sont declarees ci-dessous, et lues par le banc.
-- RESIDU-ACCEPTE: ext[|]btree_gist[|]
--
-- GARDE-TEST: INSERT INTO "portions" ("id","tronconId","debutM","finM","origine","creeParId","updatedAt") VALUES ('g1','t',0,10,'IMPORT','u',now());
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "portions") + (SELECT count(*) FROM "portions_lignage") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % portion(s) ou lien(s) de lignage enregistres. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "portions_lignage";
DROP TABLE IF EXISTS "portions";
DROP TYPE IF EXISTS "OriginePortion";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261013180000_portions_homogenes';
