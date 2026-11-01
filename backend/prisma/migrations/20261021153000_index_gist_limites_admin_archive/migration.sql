-- INDEX GiST sur limites_admin_archive.geom (paragraphe 7.1) -- table legacy de production
--
-- Trouvé par le banc index_gist.test.sql le 21/10/2026 lors du premier déploiement réel :
-- limites_admin_archive est une table PRÉEXISTANTE de la production (import legacy,
-- 22 lignes, geom MULTIPOLYGON 4326, aucun index) absente de la base de rejoué -- le banc
-- local ne pouvait pas la voir. La migration 20261020020000 a couvert les six colonnes des
-- tables du dépôt ; celle-ci couvre la colonne oubliée, sur la même forme mesurée
-- (index sur l'expression `(geom::geography)`, celle qu'interroge le dépôt).
--
-- Garde : la table n'existe qu'en production ; sur une base de rejoué la migration ne fait
-- rien (to_regclass), elle reste idempotent partout.

DO $i$
BEGIN
  IF to_regclass('public.limites_admin_archive') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS limites_admin_archive_geom_geography_gist'
         || ' ON public.limites_admin_archive USING gist ((geom::geography))';
  END IF;
END
$i$;
