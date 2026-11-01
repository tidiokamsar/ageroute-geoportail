-- RETOUR ARRIERE de `20261019030000_main_courante_ordre_total`.
--
-- CE QUI EST PERDU : l'ordre total des entrees. Aucune entree n'est effacee. La vue revient a
-- l'ordre par heure puis identifiant, AMBIGU a heure egale : c'est le defaut que la migration
-- corrige. Descendre la reintroduit.
--
-- EXECUTEE ET VERIFIEE en aller-retour le 19/10/2026 sur la base de developpement.

CREATE OR REPLACE VIEW "evenements_exploitation" AS
WITH declarations AS (
  SELECT "evenementId", "id" AS "declarationId", "enregistreLe" AS "ouvertLe", "typeCode", "sourceCode",
         "texte", "tronconId", "debutM", "finM", "geom", "auteurId" AS "declarantId"
    FROM "main_courante" WHERE "nature" = 'DECLARATION'
),
derniers_statuts AS (
  SELECT DISTINCT ON ("evenementId") "evenementId", "statut", "enregistreLe" AS "statutDepuis", "auteurId" AS "statutParId"
    FROM "main_courante"
   WHERE "nature" IN ('DECLARATION', 'STATUT')
   ORDER BY "evenementId", "enregistreLe" DESC, "id" DESC
),
comptes AS (
  SELECT "evenementId", count(*)::integer AS "nbEntrees",
         count(*) FILTER (WHERE "nature" = 'RECTIFICATION')::integer AS "nbRectifications",
         max("enregistreLe") AS "derniereEntreeLe"
    FROM "main_courante" GROUP BY "evenementId"
)
SELECT d.*, s."statut", s."statutDepuis", s."statutParId", c."nbEntrees", c."nbRectifications", c."derniereEntreeLe",
       (SELECT min(m."enregistreLe") FROM "main_courante" m
         WHERE m."evenementId" = d."evenementId" AND m."nature" = 'STATUT' AND m."statut" = 'PRIS_EN_COMPTE') - d."ouvertLe" AS "delaiPriseEnCompte",
       (SELECT min(m."enregistreLe") FROM "main_courante" m
         WHERE m."evenementId" = d."evenementId" AND m."nature" = 'STATUT' AND m."statut" = 'CLOS') - d."ouvertLe" AS "dureeTotale"
  FROM declarations d
  JOIN derniers_statuts s ON s."evenementId" = d."evenementId"
  JOIN comptes c ON c."evenementId" = d."evenementId";

DROP INDEX IF EXISTS "main_courante_rang_key";
ALTER TABLE "main_courante" DROP COLUMN IF EXISTS "rang";

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261019030000_main_courante_ordre_total';
