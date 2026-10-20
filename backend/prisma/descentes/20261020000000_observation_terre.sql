-- RETOUR ARRIERE de `20261020000000_observation_terre`.
--
-- CE QUI EST PERDU : le registre des produits d'observation de la Terre et les propositions de
-- teledetection, verdicts du terrain compris -- donc la mesure de precision des methodes.
-- Compter avant :
--
--   SELECT (SELECT count(*) FROM earth_observation_products) AS produits,
--          (SELECT count(*) FROM propositions_teledetection) AS propositions,
--          (SELECT count(*) FROM propositions_teledetection WHERE statut <> 'A_VERIFIER') AS verdicts;
--
-- Comptes non nuls : sauvegarde verifiee et autorisation explicite (paragraphe A.5.2). Les
-- missions de verification depechees restent : elles vivent dans `missions`.
--
-- EXECUTEE ET VERIFIEE en aller-retour le 20/10/2026 sur la base de developpement.

DROP VIEW IF EXISTS "precision_teledetection";
DROP TRIGGER IF EXISTS propositions_teledetection_garde ON "propositions_teledetection";
DROP FUNCTION IF EXISTS propositions_teledetection_garde();
DROP TABLE IF EXISTS "propositions_teledetection";
DROP TABLE IF EXISTS "earth_observation_products";

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261020000000_observation_terre';
