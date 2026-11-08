-- MAIN COURANTE : ORDRE TOTAL DES ENTREES (correctif d'EX-01, trouve le 19/10/2026)
--
-- LE DEFAUT. La vue `evenements_exploitation` retenait le dernier statut par
-- `ORDER BY "enregistreLe" DESC, "id" DESC`. Deux entrees du meme evenement peuvent porter la meme
-- heure serveur : dans une meme transaction (CURRENT_TIMESTAMP y est fige), ou dans la meme
-- milliseconde. L'egalite etait alors tranchee par un uuid ALEATOIRE : une DECLARATION (OUVERT)
-- pouvait passer pour plus recente que le PRIS_EN_COMPTE qui la suivait. L'epreuve de la cellule
-- de veille contre la base l'a montre : un evenement pris en compte a ete escalade comme s'il ne
-- l'etait pas.
--
-- LE CORRECTIF. Un rang d'insertion strictement croissant, `rang BIGSERIAL`, qui ordonne le
-- journal sans ambiguite. La vue et le service ordonnent desormais par lui. L'heure serveur reste
-- l'heure qui fait foi ; le rang ne dit que l'ordre.
--
-- NATURE : additive. Une colonne, un index, la vue recreee a l'identique hormis l'ordre. AJOUTER
-- une colonne a valeur par defaut ne declenche pas le declencheur d'ajout seul (ce n'est pas un
-- UPDATE de ligne). La table n'existe pas en production (migration `20261015010000` en attente) ;
-- sur une base qui aurait deja des lignes, les rangs des lignes existantes suivraient l'ordre
-- physique, et les egalites d'heure anterieures resteraient ce qu'elles etaient : ambigues.

ALTER TABLE "main_courante" ADD COLUMN IF NOT EXISTS "rang" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "main_courante_rang_key" ON "main_courante" ("rang");

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
   ORDER BY "evenementId", "rang" DESC
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
