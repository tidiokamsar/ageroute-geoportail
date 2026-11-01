-- BANC D'ESSAI de la coherence registre / propositions / verdicts (partie E, A30).
--
-- Ce qu'il prouve : une detection hors de l'emprise de son produit (ou de son produit de reference)
-- est refusee ; une comparaison dont la reference n'est pas anterieure est refusee ; la vue
-- `coherence_teledetection` est vide sur des donnees coherentes et nomme chaque anomalie sinon.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/teledetection_coherence.test.sql
--
-- Transaction ANNULEE a la fin.

BEGIN;

INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-eoc', 'eoc@local.invalid', 'Fixture coherence', 'fixture-sans-usage', 'GESTIONNAIRE', CURRENT_TIMESTAMP);
INSERT INTO regions (nom) VALUES ('Region de test coherence');
INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
VALUES ('t-eoc', 'EOC-A', 'Troncon de test', 'RN', (SELECT id FROM regions WHERE nom = 'Region de test coherence'), 1.1, 'BITUME', 0, 1.1,
        ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.59, 9.64)), 4326), CURRENT_TIMESTAMP);

-- Deux produits sur la meme scene (Conakry) a deux dates, un troisieme ailleurs (Kankan).
INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", "couvertureNuagesPct", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId")
VALUES
  ('p-ref', 'EOC-REF', 0, 'Sentinel-2 L2A', 'OPTIQUE', '2026-09-01', 10, 5, 'x', 'scene-ref', 'licence relevee a la source', 'v0',
   ST_SetSRID(ST_MakeEnvelope(-13.7, 9.5, -13.4, 9.8), 4326), 'u-eoc'),
  ('p-new', 'EOC-NEW', 0, 'Sentinel-2 L2A', 'OPTIQUE', '2026-10-01', 10, 5, 'x', 'scene-new', 'licence relevee a la source', 'v0',
   ST_SetSRID(ST_MakeEnvelope(-13.7, 9.5, -13.4, 9.8), 4326), 'u-eoc'),
  ('p-ail', 'EOC-AIL', 0, 'Sentinel-2 L2A', 'OPTIQUE', '2026-08-01', 10, 5, 'x', 'scene-ailleurs', 'licence relevee a la source', 'v0',
   ST_SetSRID(ST_MakeEnvelope(-9.4, 10.3, -9.2, 10.5), 4326), 'u-eoc');

DO $t$
DECLARE nb integer;
  dedans geometry := ST_SetSRID(ST_MakePoint(-13.595, 9.6401), 4326);
  dehors geometry := ST_SetSRID(ST_MakePoint(-12.0, 9.64), 4326);
BEGIN
  -- ---------- Emprise ----------
  INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "creeParId")
  VALUES ('c-ok', 'p-new', 'VEGETATION', 'ndvi-v1', dedans, 'u-eoc');
  RAISE NOTICE 'Detection dans l''emprise ACCEPTEE';

  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "creeParId")
    VALUES ('c-ko', 'p-new', 'VEGETATION', 'ndvi-v1', dehors, 'u-eoc');
    RAISE EXCEPTION 'Detection hors emprise acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Detection hors de l''emprise du produit REFUSEE'; END;

  -- ---------- Deux dates ----------
  INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, geom, "creeParId")
  VALUES ('c-2d', 'p-new', 'p-ref', 'NOUVELLE_ROUTE', 'diff-v1', dedans, 'u-eoc');
  RAISE NOTICE 'Comparaison reference anterieure ACCEPTEE';

  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, geom, "creeParId")
    VALUES ('c-2i', 'p-ref', 'p-new', 'NOUVELLE_ROUTE', 'diff-v1', dedans, 'u-eoc');
    RAISE EXCEPTION 'Reference posterieure acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Reference posterieure au produit REFUSEE'; END;

  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, geom, "creeParId")
    VALUES ('c-2e', 'p-new', 'p-ail', 'NOUVELLE_ROUTE', 'diff-v1', dedans, 'u-eoc');
    RAISE EXCEPTION 'Detection hors emprise de la reference acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Detection hors de l''emprise de la reference REFUSEE'; END;

  -- ---------- La vue : vide sur des donnees coherentes ----------
  SELECT count(*) INTO nb FROM coherence_teledetection WHERE "propositionId" LIKE 'c-%';
  IF nb <> 0 THEN RAISE EXCEPTION 'coherence_teledetection non vide sur des donnees coherentes (%)', nb; END IF;
  RAISE NOTICE 'Vue de coherence VIDE sur des donnees coherentes';
END $t$;

-- ---------- La vue nomme chaque anomalie ----------
-- Une ligne ancienne, deposee avant le controle : on la fabrique declencheur desactive.
ALTER TABLE propositions_teledetection DISABLE TRIGGER propositions_teledetection_coherence;
INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, geom, "tronconId", "distanceTronconM", "creeParId")
VALUES ('c-old', 'p-ref', 'p-new', 'COUPURE_PROBABLE', 'diff-v0', ST_SetSRID(ST_MakePoint(-12.0, 9.64), 4326), 't-eoc', 10, 'u-eoc');
ALTER TABLE propositions_teledetection ENABLE TRIGGER propositions_teledetection_coherence;
UPDATE troncons SET "deletedAt" = CURRENT_TIMESTAMP WHERE id = 't-eoc';

DO $t$
DECLARE regles text;
BEGIN
  SELECT string_agg(regle, ',' ORDER BY regle) INTO regles FROM coherence_teledetection WHERE "propositionId" = 'c-old';
  IF regles IS DISTINCT FROM 'HORS_EMPRISE_PRODUIT,HORS_EMPRISE_REFERENCE,REFERENCE_NON_ANTERIEURE,TRONCON_SUPPRIME' THEN
    RAISE EXCEPTION 'Anomalies attendues non nommees : %', regles;
  END IF;
  RAISE NOTICE 'Vue de coherence : les quatre anomalies de la ligne ancienne NOMMEES (%)', regles;
END $t$;

ROLLBACK;
