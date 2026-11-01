-- Descente de 20261021153000 : retirer l'index posé sur limites_admin_archive.
-- Aucune donnée n'est touchée. IF EXISTS : idempotent, et sans effet sur une base
-- de rejoué où la table (et l'index) n'existent pas.

DROP INDEX IF EXISTS limites_admin_archive_geom_geography_gist;
