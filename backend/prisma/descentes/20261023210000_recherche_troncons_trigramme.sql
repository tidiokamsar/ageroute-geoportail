-- RETOUR ARRIERE de `20261023210000_recherche_troncons_trigramme`.
--
-- CE QUI EST PERDU : deux index. Aucune donnee. La recherche par code ou nom repasse en parcours
-- sequentiel (voir docs/performance/MESURES-A15-A20.md pour l'ordre de grandeur mesure).
--
-- RESIDU VOLONTAIRE : l'extension `pg_trgm` reste installee. La retirer (`DROP EXTENSION`) casserait
-- tout objet qui l'aurait adoptee depuis, et une extension inutilisee ne coute rien.
-- RESIDU-ACCEPTE: ext[|]pg_trgm[|]

DROP INDEX IF EXISTS "troncons_code_trgm_idx";
DROP INDEX IF EXISTS "troncons_nom_trgm_idx";

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261023210000_recherche_troncons_trigramme';
