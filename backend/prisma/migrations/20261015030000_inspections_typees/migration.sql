-- INSPECTIONS TYPEES, ET L'INSPECTION POST-TRAVAUX (paragraphe 7.7)
--
-- « L'evaluation s'appuie sur une inspection typee « post-travaux » (photos apres, etat
-- mesure, IRI) rattachee a la fiche d'intervention et realisee par AGEROUTE ; c'est un CONSTAT
-- D'ETAT DU PATRIMOINE, PAS UNE RECEPTION DE TRAVAUX (hors perimetre, § A.3). »
--
-- La table `inspections` existait sans type : toute inspection etait une inspection. Le mandat
-- en distingue au moins trois usages, et chacun a ses exigences :
--
--   GENERALE       ce que sont toutes les lignes existantes ; aucune exigence nouvelle
--   PERIODIQUE     l'inspection periodique des ouvrages et du reseau (§ 7.4, TI-01)
--   VERIFICATION   la patrouille de verification depechee sur un signalement (§ 7.17)
--   POST_TRAVAUX   le constat d'etat apres travaux (§ 7.7) : il EXIGE la reference de
--                  l'intervention, un etat reellement mesure et au moins une photo « apres »
--
-- TEXTE CONTRAINT, PAS ENUMERATION : un type s'ajoute par une migration qui etend le CHECK,
-- reversible ; un ALTER TYPE ADD VALUE ne l'est pas (lecon D-06).
--
-- `interventionRef` est un TEXTE sans cle etrangere, et c'est dit : la fiche d'intervention
-- n'existe pas encore (etape 5 de MAINTENANCE_PROGRAMMING_DESIGN.md, apres D-07). Le jour ou
-- sa table existera, une migration posera la cle etrangere ; d'ici la, la reference est
-- conservee telle quelle, pour que les inspections post-travaux realisees avant ne soient pas
-- orphelines. C'est aussi par cette inspection que le cycle de vie passera en EVALUE
-- (`programmation/cycle-vie.noyau.ts`, origine INSPECTION_POST_TRAVAUX).
--
-- L'IRI porte son caractere ESTIME dans son nom (arbitrage D8 : « estimation experimentale de
-- rugosite » jusqu'a calibration) et exige sa methode : un IRI sans methode se lirait comme un
-- IRI normalise.
--
-- CE QUE CETTE TABLE NE RECOIT PAS : aucun champ de reception, de reserve, de proces-verbal,
-- de montant. Une inspection post-travaux constate l'etat ; la reception est un acte
-- contractuel qui vit dans DigitalRoad. Un test de garde-fou balaie le modele.
--
-- NATURE : additive. Colonnes nullables ou a defaut, aucune ligne modifiee. Sur une table
-- peuplee en production (nombre de lignes non verifiable depuis le gel), la contrainte sur
-- POST_TRAVAUX ne peut pas echouer : aucune ligne existante ne porte ce type.

ALTER TABLE "inspections"
  ADD COLUMN IF NOT EXISTS "type"            TEXT NOT NULL DEFAULT 'GENERALE',
  ADD COLUMN IF NOT EXISTS "interventionRef" TEXT,
  ADD COLUMN IF NOT EXISTS "iriEstime"       NUMERIC(6, 2),
  ADD COLUMN IF NOT EXISTS "iriMethode"      TEXT;

ALTER TABLE "inspections" DROP CONSTRAINT IF EXISTS "inspection_type_connu";
ALTER TABLE "inspections" ADD CONSTRAINT "inspection_type_connu"
  CHECK ("type" IN ('GENERALE', 'PERIODIQUE', 'VERIFICATION', 'POST_TRAVAUX'));

-- Un constat d'etat apres travaux dit QUELS travaux, QUEL etat, et le MONTRE.
ALTER TABLE "inspections" DROP CONSTRAINT IF EXISTS "inspection_post_travaux_complete";
ALTER TABLE "inspections" ADD CONSTRAINT "inspection_post_travaux_complete"
  CHECK (
    "type" <> 'POST_TRAVAUX'
    OR (
      "interventionRef" IS NOT NULL AND length(btrim("interventionRef")) > 0
      AND "etatObserve" <> 'NON_EVALUE'
      AND cardinality("photos") >= 1
    )
  );

-- Un IRI estime est positif et porte sa methode ; une methode sans valeur n'a pas de sens.
ALTER TABLE "inspections" DROP CONSTRAINT IF EXISTS "inspection_iri_coherent";
ALTER TABLE "inspections" ADD CONSTRAINT "inspection_iri_coherent"
  CHECK (
    ("iriEstime" IS NULL AND "iriMethode" IS NULL)
    OR ("iriEstime" IS NOT NULL AND "iriEstime" >= 0 AND "iriMethode" IS NOT NULL AND length(btrim("iriMethode")) > 0)
  );

CREATE INDEX IF NOT EXISTS "inspections_type_idx" ON "inspections" ("type");
CREATE INDEX IF NOT EXISTS "inspections_interventionRef_idx" ON "inspections" ("interventionRef");

COMMENT ON COLUMN "inspections"."type" IS
  'GENERALE, PERIODIQUE, VERIFICATION ou POST_TRAVAUX. POST_TRAVAUX est le constat d''etat '
  'apres travaux du paragraphe 7.7 -- un constat du patrimoine, pas une reception : il exige '
  'la reference de l''intervention, un etat mesure et au moins une photo.';
COMMENT ON COLUMN "inspections"."iriEstime" IS
  'Estimation experimentale de rugosite (arbitrage D8), jamais un IRI normalise : la methode '
  'est obligatoire a cote.';
