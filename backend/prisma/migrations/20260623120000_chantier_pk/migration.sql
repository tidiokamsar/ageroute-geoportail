-- Referencement lineaire des chantiers : PK debut/fin pour deriver la geometrie du troncon
ALTER TABLE "chantiers" ADD COLUMN "pkDebut" DOUBLE PRECISION;
ALTER TABLE "chantiers" ADD COLUMN "pkFin" DOUBLE PRECISION;
