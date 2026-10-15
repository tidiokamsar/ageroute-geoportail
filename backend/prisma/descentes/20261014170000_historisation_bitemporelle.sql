-- RETOUR ARRIERE de `20261014170000_historisation_bitemporelle`.
--
-- POURQUOI CE FICHIER EXISTE, ET CE QU'IL N'EST PAS
--
-- Le paragraphe 9.4 du mandat v2.1 exige des migrations « additives, reversibles, testees en
-- montee ET en descente sur une base de developpement ». Prisma ne gere pas de migrations
-- descendantes : ce fichier est donc ecrit a la main, et il n'est PAS execute par
-- `prisma migrate`.
--
-- IL N'A PAS ETE EXECUTE, ET JE NE LE DECLARE PAS TESTE.
--
-- Aucune base de developpement n'existe : pas de PostgreSQL local, pas de Docker fonctionnel
-- sur ce poste, et le garde-fou 2.1 interdit toute operation sur la production. C'est le
-- blocage B-13. L'exigence de test en descente n'est donc pas tenue, et l'ecrire ici sans le
-- dire serait precisement ce que le garde-fou 2.7 interdit.
--
-- CE QUE LA DESCENTE DETRUIRAIT
--
-- Elle retire des colonnes. Si des lignes ont ete ecrites entre-temps, LEUR CONTENU EST PERDU
-- SANS RECOURS : une date d'effet terrain ne se recalcule pas depuis les dates systeme, et un
-- resultat d'analyse ne se reconstitue pas.
--
-- Au 14/10/2026, `portions` et `medias_defaut` sont vides, donc la descente ne perd rien. Ce
-- n'est vrai qu'a cette date. Avant de l'executer un jour, il faut COMPTER les lignes et les
-- valeurs non nulles de chaque colonne retiree :
--
--   SELECT count(*) FILTER (WHERE "valideDu" IS NOT NULL) AS avec_date_effet,
--          count(*) FILTER (WHERE "praticabiliteCause" IS NOT NULL) AS avec_cause
--     FROM portions;
--   SELECT count(*) FILTER (WHERE "analyseeLe" IS NOT NULL) AS analysees
--     FROM medias_defaut;
--
-- Si l'un de ces comptes n'est pas nul, la descente EXIGE une sauvegarde verifiee et une
-- autorisation explicite (garde-fou 2.2). Le paragraphe 2.8 interdit par ailleurs toute
-- suppression silencieuse de donnees : une descente qui efface des dates d'effet sans que
-- personne l'ait voulu en serait une.

-- ===== medias_defaut =====

DROP INDEX IF EXISTS "medias_defaut_analyseeLe_idx";

ALTER TABLE "medias_defaut"
  DROP CONSTRAINT IF EXISTS "media_analyse_confiance_bornee",
  DROP CONSTRAINT IF EXISTS "media_analyse_resultat_est_un_tableau",
  DROP CONSTRAINT IF EXISTS "media_analyse_coherente";

ALTER TABLE "medias_defaut"
  DROP COLUMN IF EXISTS "analyseConfiance",
  DROP COLUMN IF EXISTS "analyseResultat",
  DROP COLUMN IF EXISTS "analyseVersion",
  DROP COLUMN IF EXISTS "analyseModele",
  DROP COLUMN IF EXISTS "analyseeLe";

-- ===== portions : praticabilite =====

ALTER TABLE "portions"
  DROP CONSTRAINT IF EXISTS "portion_praticabilite_tonnage_positif",
  DROP CONSTRAINT IF EXISTS "portion_praticabilite_duree_positive";

ALTER TABLE "portions"
  DROP COLUMN IF EXISTS "praticabiliteTonnageMaxT",
  DROP COLUMN IF EXISTS "praticabiliteDureeJours",
  DROP COLUMN IF EXISTS "praticabiliteDepuis",
  DROP COLUMN IF EXISTS "praticabiliteCause";

-- ===== portions : axe terrain =====

DROP INDEX IF EXISTS "portions_valideAu_idx";
DROP INDEX IF EXISTS "portions_tronconId_valideDu_idx";

ALTER TABLE "portions"
  DROP CONSTRAINT IF EXISTS "portion_intervalle_effet_non_vide";

ALTER TABLE "portions"
  DROP COLUMN IF EXISTS "valideAu",
  DROP COLUMN IF EXISTS "valideDu";

-- Et il faut retirer la ligne de `_prisma_migrations`, sinon `migrate deploy` considerera la
-- migration comme appliquee et ne la rejouera jamais :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261014170000_historisation_bitemporelle';
--
-- Cette ligne n'est pas incluse ci-dessus a dessein : elle doit etre un geste conscient, pas
-- un effet de bord d'un script.
