-- PK pour les postes (peage/pesage), necessaire au referencement lineaire / geolocalisation
-- depuis le trace du troncon, comme deja fait pour ouvrages et points_noirs.
ALTER TABLE "postes" ADD COLUMN "pk" DOUBLE PRECISION;
