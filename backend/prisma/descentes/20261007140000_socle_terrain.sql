-- RETOUR ARRIERE de `20261007140000_socle_terrain`.
--
-- Cree cinq types enumeres et huit tables du socle terrain : appareils, missions, traces, points_trace, observations, medias_observation, operations_sync, conflits_sync.
--
-- CE QUI EST PERDU : TOUT ce que le terrain a remonte : missions, traces GPS, observations, medias et file de synchronisation avec ses conflits. Les fichiers medias restent sur le disque.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261007140000_socle_terrain.sql
--
-- GARDE-TEST: INSERT INTO "appareils" ("id","userId","plateforme","updatedAt") VALUES ('g1','u','android',now());
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "appareils") + (SELECT count(*) FROM "missions") + (SELECT count(*) FROM "traces") + (SELECT count(*) FROM "points_trace") + (SELECT count(*) FROM "observations") + (SELECT count(*) FROM "medias_observation") + (SELECT count(*) FROM "operations_sync") + (SELECT count(*) FROM "conflits_sync") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de donnees terrain (appareils, missions, traces, observations, medias, synchronisation). Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "conflits_sync";
DROP TABLE IF EXISTS "operations_sync";
DROP TABLE IF EXISTS "medias_observation";
DROP TABLE IF EXISTS "observations";
DROP TABLE IF EXISTS "points_trace";
DROP TABLE IF EXISTS "traces";
DROP TABLE IF EXISTS "missions";
DROP TABLE IF EXISTS "appareils";
DROP TYPE IF EXISTS "StatutSync";
DROP TYPE IF EXISTS "StatutObservation";
DROP TYPE IF EXISTS "TypeObservation";
DROP TYPE IF EXISTS "StatutMission";
DROP TYPE IF EXISTS "TypeMission";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261007140000_socle_terrain';
