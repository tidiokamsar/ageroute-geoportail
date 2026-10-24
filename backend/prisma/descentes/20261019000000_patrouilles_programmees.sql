-- RETOUR ARRIERE de `20261019000000_patrouilles_programmees`.
--
-- CE QUI EST PERDU : les programmes de patrouille, leurs itineraires, et le lien de chaque
-- mission a son programme ou au signalement qu'elle verifiait. Les MISSIONS elles-memes, leurs
-- traces et leurs observations restent : elles vivent dans leurs tables. Compter avant :
--
--   SELECT (SELECT count(*) FROM programmes_patrouille) AS programmes,
--          (SELECT count(*) FROM missions WHERE "programmeId" IS NOT NULL) AS missions_programmees,
--          (SELECT count(*) FROM missions WHERE "signalementId" IS NOT NULL) AS verifications;
--
-- Si l'un de ces comptes n'est pas nul, la descente efface une organisation de l'exploitation
-- et la trace de ce qui a ete depeche sur quel signalement : sauvegarde verifiee et autorisation
-- explicite (paragraphe A.5.2).
--
-- EXECUTEE ET VERIFIEE en aller-retour le 19/10/2026 sur la base de developpement.

DROP FUNCTION IF EXISTS couverture_patrouille(TEXT, DOUBLE PRECISION);
DROP INDEX IF EXISTS "missions_signalementId_idx";
DROP INDEX IF EXISTS "missions_programmeId_idx";
ALTER TABLE "missions" DROP COLUMN IF EXISTS "signalementId", DROP COLUMN IF EXISTS "programmeId";
DROP TABLE IF EXISTS "programme_troncons";
DROP TABLE IF EXISTS "programmes_patrouille";
DROP FUNCTION IF EXISTS mois_actifs_valides(INTEGER[]);

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261019000000_patrouilles_programmees';
