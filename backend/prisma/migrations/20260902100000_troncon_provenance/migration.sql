-- Provenance des troncons (T2).
--
-- POURQUOI
--
-- Mesure du 01/09/2026 sur la production : le journal d'audit contient 1 155
-- modifications de troncons et ZERO creation. Les 1 690 troncons sont entres par un
-- chemin qui n'ecrit pas dans le journal — import direct ou amorcage. Leur origine
-- n'etait donc consignee nulle part, et aucune des six questions de provenance
-- (« d'ou vient cette donnee ? ») n'avait de reponse.
--
-- CE QUE LE CODE TRAHIT DEJA
--
-- La provenance est pourtant lisible dans le champ `code`, qui porte la marque de son
-- lot d'import :
--
--     GN N*      551 RN   11,2 pts/km   longueur renseignee 551/551
--     *-OSM-*     70 RN   18,1 pts/km   longueur renseignee  70/70
--     RES-*    1 028 RR    2,1 pts/km   longueur renseignee   0/1 028
--     autre       41 RU/RR
--
-- Ce decoupage explique entierement le probleme des longueurs nulles : il ne se
-- repartit pas au hasard, il coincide EXACTEMENT avec la famille RES-*. Un lot, une
-- etape d'import manquante.
--
-- DEDUIT N'EST PAS DOCUMENTE
--
-- La distinction porte tout le ticket. `sourceType = IMPORT_CODE_PATTERN` signifie
-- « provenance deduite du prefixe du code », et non « provenance documentee ». Ce que
-- le prefixe designe est un LOT D'IMPORT, pas une source primaire : ce que recouvre
-- reellement « RES-* » reste a etablir aupres d'AGEROUTE. Confondre les deux ferait
-- passer une inference pour un fait, ce qui est precisement l'erreur que ce ticket
-- corrige.
--
-- REVERSIBILITE
--
-- Quatre colonnes ajoutees, aucune donnee existante modifiee. Retrait :
--     ALTER TABLE "troncons"
--       DROP COLUMN "sourceType", DROP COLUMN "sourceReference",
--       DROP COLUMN "sourceConfidence", DROP COLUMN "sourceDetectedAt";
--     DROP TYPE "SourceType"; DROP TYPE "NiveauConfiance";

DO $$ BEGIN
  CREATE TYPE "SourceType" AS ENUM (
    'IMPORT_CODE_PATTERN',
    'IMPORT_DOCUMENTE',
    'SAISIE_APPLICATIVE',
    'RECUPERATION_AUDIT',
    'INCONNUE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "NiveauConfiance" AS ENUM ('HIGH', 'MEDIUM', 'LOW');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "troncons"
  ADD COLUMN IF NOT EXISTS "sourceType"       "SourceType",
  ADD COLUMN IF NOT EXISTS "sourceReference"  TEXT,
  ADD COLUMN IF NOT EXISTS "sourceConfidence" "NiveauConfiance",
  ADD COLUMN IF NOT EXISTS "sourceDetectedAt" TIMESTAMP(3);

-- Aucune valeur n'est ecrite ici. Le renseignement retroactif est un script separe
-- et rejouable (scripts/backfill-provenance.ts), pour que la migration reste une
-- modification de structure et que le remplissage puisse etre rejoue, verifie ou
-- annule sans toucher au schema.
