-- Recuperation controlee des postes de peage et de pesage (T9).
--
-- CE QUE LE JOURNAL D'AUDIT CONSERVE
--
-- La table `postes` compte 0 ligne et passait pour n'avoir jamais ete alimentee. Le
-- journal conserve pourtant DIX suppressions du 01/07/2026, qui se reduisent a SIX
-- sites distincts — les autres etaient des doublons d'accentuation (« Peage de
-- Kilissi » et « Péage de Kilissi »).
--
-- La suppression etait justifiee : elle retirait des doublons. L'absence de reprise
-- ensuite ne l'est pas.
--
-- CE QUI EST REPRIS, ET CE QUI NE L'EST PAS
--
-- Les sites, oui : nom, type, statut, region. Quatre portaient aussi une valeur de
-- trafic et deux une recette mensuelle. Ces valeurs-la ne sont PAS reprises comme des
-- mesures, pour trois raisons mesurees :
--
--     Kilissi et Linsan portent exactement la meme valeur, 3 200 ;
--     toutes les valeurs sont rondes a la centaine ou au million ;
--     aucun de ces postes n'avait de coordonnees (pk et geometrie vides).
--
-- C'est la signature d'un jeu de demonstration, pas d'une campagne de comptage. Les
-- restaurer comme du trafic reel remplirait un module aujourd'hui vide avec de la
-- fiction — exactement ce que cette phase interdit.
--
-- PENDING_VALIDATION PAR DEFAUT
--
-- Un site recupere n'est pas un site confirme. `recoveryStatus` reste en attente
-- jusqu'a ce qu'un agent tranche, et `recoveredFrom` garde la trace de l'origine pour
-- qu'on ne confonde jamais une reprise d'audit avec un releve.
--
-- REVERSIBILITE
--
--     ALTER TABLE "postes"
--       DROP COLUMN "historicalRecovered", DROP COLUMN "recoveredFrom",
--       DROP COLUMN "recoveryStatus";
--     DROP TYPE "StatutRecuperation";

DO $$ BEGIN
  CREATE TYPE "StatutRecuperation" AS ENUM ('PENDING_VALIDATION', 'VALIDATED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "postes"
  ADD COLUMN IF NOT EXISTS "historicalRecovered" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "recoveredFrom"       TEXT,
  ADD COLUMN IF NOT EXISTS "recoveryStatus"      "StatutRecuperation";

-- Empeche le retour du defaut qui a motive la suppression d'origine : deux postes
-- dont les noms ne different que par les accents ou la casse. unaccent() n'etant pas
-- garanti disponible, la normalisation est faite par translate() sur les caracteres
-- effectivement rencontres.
CREATE UNIQUE INDEX IF NOT EXISTS "postes_nom_normalise_key"
  ON "postes" (lower(translate("nom", 'àáâãäçèéêëìíîïñòóôõöùúûü', 'aaaaaceeeeiiiinooooouuuu')))
  WHERE "deletedAt" IS NULL;
