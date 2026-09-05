-- Provenance des ouvrages, et discriminant de l'inventaire (P5).
--
-- POURQUOI MAINTENANT
--
-- 963 ponts issus d'une source cartographique externe vont entrer dans `ouvrages`,
-- qui en compte 126. Sans discriminant, l'inventaire d'AGEROUTE se noierait dans une
-- donnee qu'il n'a pas constituee — exactement ce qui est arrive a `troncons` le
-- 04/09, ou le tableau de bord s'est mis a annoncer 185 264 km de reseau routier pour
-- un pays qui en a 21 000.
--
-- `Troncon` porte deja ces quatre colonnes. Les ajouter ici n'invente rien : cela
-- aligne `Ouvrage` sur un modele existant, et rend possible le meme cadrage des
-- indicateurs.
--
-- CE QUE `sourceReference` PERMET DE DIRE
--
-- « ouvrage_osm:<id> » pour un pont repris d'une source externe, NULL pour les 126
-- ouvrages inventories par AGEROUTE. Le meme predicat que pour les troncons distingue
-- alors l'inventaire de reference du reste :
--
--     "sourceReference" IS NULL OR "sourceReference" NOT LIKE 'ouvrage_osm:%'
--
-- Le IS NULL n'est pas decoratif : en SQL, NULL NOT LIKE '...' vaut NULL, donc faux.
-- Sans lui, les 126 ouvrages d'origine disparaitraient de tous les comptages.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--
-- Elle n'ecrit aucune ligne. Les 126 ouvrages existants gardent une provenance nulle,
-- ce qui est la verite : le journal d'audit ne porte aucune trace de leur creation, et
-- leur origine n'est documentee nulle part. Leur attribuer une provenance
-- retrospective serait inventer.
--
-- REVERSIBILITE
--
--     DROP INDEX "ouvrages_inventaire_reference_idx";
--     ALTER TABLE "ouvrages"
--       DROP COLUMN "sourceType", DROP COLUMN "sourceReference",
--       DROP COLUMN "sourceConfidence", DROP COLUMN "sourceDetectedAt";

ALTER TABLE "ouvrages" ADD COLUMN IF NOT EXISTS "sourceType"       "SourceType";
ALTER TABLE "ouvrages" ADD COLUMN IF NOT EXISTS "sourceReference"  TEXT;
ALTER TABLE "ouvrages" ADD COLUMN IF NOT EXISTS "sourceConfidence" "NiveauConfiance";
ALTER TABLE "ouvrages" ADD COLUMN IF NOT EXISTS "sourceDetectedAt" TIMESTAMP(3);

-- Un objet source ne peut entrer deux fois. L'import est rejouable ; sans cette
-- contrainte, le rejouer creerait 963 doublons sans rien signaler.
CREATE UNIQUE INDEX IF NOT EXISTS "ouvrages_sourceReference_key"
  ON "ouvrages" ("sourceReference") WHERE "sourceReference" IS NOT NULL;

-- Servir l'inventaire de reference sans parcourir tout ce qui a ete repris.
CREATE INDEX IF NOT EXISTS "ouvrages_inventaire_reference_idx"
  ON "ouvrages" ("deletedAt")
  WHERE "sourceReference" IS NULL OR "sourceReference" NOT LIKE 'ouvrage_osm:%';
