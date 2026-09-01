-- Champs de la fiche terrain reelle (mission inventaire ouvrages d'art) + PK pour les points noirs
-- (necessaire au referencement lineaire / geolocalisation depuis le trace du troncon).
ALTER TABLE "ouvrages" ADD COLUMN "ficheNumero" TEXT;
ALTER TABLE "ouvrages" ADD COLUMN "code" TEXT;
ALTER TABLE "ouvrages" ADD COLUMN "largeurM" DOUBLE PRECISION;
ALTER TABLE "ouvrages" ADD COLUMN "hauteurM" DOUBLE PRECISION;
ALTER TABLE "ouvrages" ADD COLUMN "nbTravees" INTEGER;
ALTER TABLE "ouvrages" ADD COLUMN "longueurTravee" DOUBLE PRECISION;
ALTER TABLE "ouvrages" ADD COLUMN "materiauAppuis" TEXT;
ALTER TABLE "ouvrages" ADD COLUMN "materiauTablier" TEXT;
ALTER TABLE "ouvrages" ADD COLUMN "materiauPiles" TEXT;
ALTER TABLE "ouvrages" ADD COLUMN "materiauAutre" TEXT;
ALTER TABLE "ouvrages" ADD COLUMN "remarques" TEXT;
ALTER TABLE "ouvrages" ADD COLUMN "travauxAPrevoir" TEXT;

ALTER TABLE "points_noirs" ADD COLUMN "pk" DOUBLE PRECISION;
