-- GARDE-FOU du paragraphe 7.1 : « index GiST sur toutes les colonnes geometriques ».
--
-- Echoue si UNE colonne geometrique du schema public n'a aucun index GiST, ni sur la colonne
-- elle-meme, ni sur une expression qui la cite (`(geom::geography)`, forme employee par le depot).
-- Une migration future qui ajoute une colonne geometrique sans index fera echouer ce banc.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/index_gist.test.sql

BEGIN;

DO $t$
DECLARE manquantes text; total integer;
BEGIN
  WITH cols AS (
    SELECT c.oid AS relid, c.relname, a.attnum, a.attname
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
       AND format_type(a.atttypid, a.atttypmod) LIKE 'geometry%'
  ),
  couv AS (
    SELECT k.*, EXISTS (
             SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
              WHERE i.indrelid = k.relid AND am.amname = 'gist'
                AND (k.attnum = ANY(i.indkey) OR pg_get_indexdef(i.indexrelid) ~ ('\m' || k.attname || '\M'))
           ) AS indexee
      FROM cols k
  )
  SELECT string_agg(relname || '.' || attname, ', ' ORDER BY relname, attname) FILTER (WHERE NOT indexee), count(*)
    INTO manquantes, total FROM couv;

  IF manquantes IS NOT NULL THEN
    RAISE EXCEPTION 'Colonnes geometriques sans index GiST (paragraphe 7.1) : %', manquantes;
  END IF;
  RAISE NOTICE '% colonnes geometriques, toutes couvertes par un index GiST', total;
  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
