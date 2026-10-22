-- RETOUR ARRIERE de `20261022000000_teledetection_coherence`.
--
-- CE QUI EST PERDU : aucune donnee. La migration n'ajoute que deux declencheurs, leurs fonctions et
-- une vue. Apres descente, la base accepte de nouveau une proposition hors de l'emprise de son
-- produit, une reference posterieure, une distance au troncon saisie, la modification d'un produit
-- cite et la suppression physique d'un produit : aucune garde n'est donc requise, mais la
-- coherence ne tient plus qu'au service.
--
-- Verifiee par le banc `verifier.sh` (aller-retour, schema compare objet par objet).

DROP VIEW IF EXISTS "coherence_teledetection";
DROP TRIGGER IF EXISTS earth_observation_products_garde ON "earth_observation_products";
DROP FUNCTION IF EXISTS earth_observation_products_garde();
DROP TRIGGER IF EXISTS propositions_teledetection_coherence ON "propositions_teledetection";
DROP FUNCTION IF EXISTS propositions_teledetection_coherence();

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261022000000_teledetection_coherence';
