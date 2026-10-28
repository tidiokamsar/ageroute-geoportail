-- RETOUR ARRIERE de `20261014230000_lots_import`.
--
-- EXECUTE ET VERIFIE le 14/10/2026 en aller-retour sur la base de developpement
-- `postgis/postgis:17-3.5`. Voir `MIGRATION_PLAN.md`.
--
-- CE QUE CETTE DESCENTE DETRUIT : la trace de tous les imports -- qui a fait entrer quoi, depuis
-- quelle source, avec quelle autorisation, et la charge originale de chaque ligne. Les OBJETS
-- CREES par les imports (troncons, defauts, portions en A_VALIDER) ne sont pas touches : ils
-- vivent dans leurs tables. Mais ils perdraient leur provenance, ce que le paragraphe E.3
-- interdit precisement.
--
-- COMPTER AVANT :
--
--   SELECT count(*) AS lots,
--          sum("lignesImportees") AS lignes_importees,
--          count(*) FILTER (WHERE statut IN ('IMPORTE', 'IMPORTE_TEST')) AS lots_appliques
--     FROM lots_import;
--
-- Si `lignes_importees` n'est pas nul, des objets du referentiel ont une provenance dans cette
-- table : la descente EXIGE une sauvegarde verifiee et une autorisation explicite. Le
-- paragraphe A.5.8 interdit toute suppression silencieuse, et effacer la provenance d'un
-- import en est une.
--
-- ORDRE : les lignes d'abord, les lots ensuite, puis les types.

DROP TABLE IF EXISTS "lignes_import";
DROP TABLE IF EXISTS "lots_import";
DROP TYPE IF EXISTS "StatutLigneImport";
DROP TYPE IF EXISTS "StatutLotImport";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261014230000_lots_import';
--
-- Volontairement absente : ce geste doit etre conscient, pas un effet de bord.
