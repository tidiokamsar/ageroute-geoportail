-- BANC D'ESSAI de l'observation de la Terre (partie E).
--
-- Ce qu'il prouve : un produit sans licence, sans couverture nuageuse (optique) ou sans
-- autorisation de depense (palier payant) est refuse ; une proposition est figee a l'insertion ;
-- le terrain juge une fois ; la precision n'existe qu'apres un verdict.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/observation_terre.test.sql
--
-- Transaction ANNULEE a la fin.

BEGIN;

INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-eo', 'eo@local.invalid', 'Fixture teledetection', 'fixture-sans-usage', 'GESTIONNAIRE', CURRENT_TIMESTAMP);
-- Un troncon a soi : la base de rejeu n'en contient aucun, et un « SELECT ... LIMIT 1 » rendrait
-- NULL -- l'essai du rattachement sans distance passerait alors pour une contre-epreuve.
INSERT INTO regions (nom) VALUES ('Region de test teledetection');
INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
VALUES ('t-eo', 'EO-A', 'Troncon de test', 'RN', (SELECT id FROM regions WHERE nom = 'Region de test teledetection'), 1.1, 'BITUME', 0, 1.1,
        ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.59, 9.64)), 4326), CURRENT_TIMESTAMP);

DO $t$
DECLARE nb integer; v double precision; ts timestamp;
  emprise geometry := ST_SetSRID(ST_MakeEnvelope(-13.7, 9.5, -13.4, 9.8), 4326);
BEGIN
  SELECT count(*) INTO nb FROM earth_observation_products;
  IF nb <> 0 THEN RAISE EXCEPTION 'Des produits ont ete semes (%)', nb; END IF;
  RAISE NOTICE 'Aucun produit seme';

  -- ---------- Registre ----------
  BEGIN
    INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", "couvertureNuagesPct", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId")
    VALUES ('x', 'X', 0, 'Sentinel-2 L2A', 'OPTIQUE', '2026-10-01', 10, 12, 'georeferencement a +/- 1 pixel', 'scene-test', '  ', 'v0', emprise, 'u-eo');
    RAISE EXCEPTION 'Produit sans licence accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Produit sans licence REFUSE'; END;

  BEGIN
    INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId")
    VALUES ('x', 'X', 0, 'Sentinel-2 L2A', 'OPTIQUE', '2026-10-01', 10, 'x', 'scene-test', 'licence relevee a la source', 'v0', emprise, 'u-eo');
    RAISE EXCEPTION 'Produit optique sans couverture nuageuse accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Optique sans couverture nuageuse REFUSE'; END;

  BEGIN
    INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", "couvertureNuagesPct", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId")
    VALUES ('x', 'X', 1, 'Constellation commerciale', 'OPTIQUE', '2026-10-01', 3, 5, 'x', 'scene-test', 'contrat', 'v0', emprise, 'u-eo');
    RAISE EXCEPTION 'Palier payant sans autorisation de depense accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Palier 1 sans autorisation de depense REFUSE'; END;

  -- Contre-epreuves : radar sans nuages, optique complet.
  INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId")
  VALUES ('p-sar', 'S1-TEST', 0, 'Sentinel-1 GRD', 'RADAR', '2026-10-02', 10, 'chatoiement radar', 'scene-sar-test', 'licence relevee a la source', 'v0', emprise, 'u-eo');
  INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", "couvertureNuagesPct", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId")
  VALUES ('p-ref', 'S2-TEST', 0, 'Sentinel-2 L2A', 'OPTIQUE', '2026-09-01', 10, 30, 'x', 'scene-opt-test', 'licence relevee a la source', 'v0', emprise, 'u-eo');
  RAISE NOTICE 'Radar sans couverture nuageuse et optique complet : acceptes';

  -- ---------- Propositions ----------
  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "creeParId")
    VALUES ('x', 'p-sar', 'GLISSEMENT', 'seuil-sar v0', ST_SetSRID(ST_MakePoint(-13.6, 9.64), 4326), 'u-eo');
    RAISE EXCEPTION 'Type hors liste accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Type de proposition hors liste REFUSE'; END;

  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "tronconId", "creeParId")
    VALUES ('x', 'p-sar', 'INONDATION', 'seuil-sar v0', ST_SetSRID(ST_MakePoint(-13.6, 9.64), 4326), 't-eo', 'u-eo');
    RAISE EXCEPTION 'Rattachement sans distance accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Rattachement a un troncon sans distance REFUSE'; END;

  INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, score, geom, "creeParId")
  VALUES ('pr-1', 'p-sar', 'p-ref', 'INONDATION', 'seuil-sar v0', 0.8, ST_SetSRID(ST_MakePoint(-13.6, 9.64), 4326), 'u-eo'),
         ('pr-2', 'p-sar', NULL, 'INONDATION', 'seuil-sar v0', 0.4, ST_SetSRID(ST_MakePoint(-13.5, 9.70), 4326), 'u-eo'),
         ('pr-3', 'p-sar', NULL, 'INONDATION', 'seuil-sar v0', NULL, ST_SetSRID(ST_MakePoint(-13.45, 9.72), 4326), 'u-eo');

  SELECT precision INTO v FROM precision_teledetection WHERE type = 'INONDATION' AND methode = 'seuil-sar v0';
  IF v IS NOT NULL THEN RAISE EXCEPTION 'Precision calculee sans aucun verdict : %', v; END IF;
  RAISE NOTICE 'Sans verdict : precision NULLE, pas zero';

  -- ---------- Figee a l'insertion ----------
  BEGIN
    UPDATE propositions_teledetection SET score = 0.99 WHERE id = 'pr-2';
    RAISE EXCEPTION 'Score modifie apres coup';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Modification du score REFUSEE'; END;
  BEGIN
    UPDATE propositions_teledetection SET geom = ST_SetSRID(ST_MakePoint(-13.0, 9.0), 4326) WHERE id = 'pr-2';
    RAISE EXCEPTION 'Geometrie modifiee apres coup';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Modification de la geometrie REFUSEE'; END;
  BEGIN
    DELETE FROM propositions_teledetection WHERE id = 'pr-3';
    RAISE EXCEPTION 'Proposition supprimee';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Suppression REFUSEE'; END;

  -- ---------- Le terrain juge ----------
  BEGIN
    UPDATE propositions_teledetection SET statut = 'CONFIRMEE', "verifieeParId" = 'u-eo', "verifieeLe" = now() WHERE id = 'pr-1';
    RAISE EXCEPTION 'Verdict sans motif ni constat accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Verdict sans motif ni constat REFUSE'; END;

  UPDATE propositions_teledetection SET statut = 'CONFIRMEE', "verifieeParId" = 'u-eo', "verifieeLe" = '2020-01-01',
         "motifVerdict" = 'Eau sur la chaussee constatee', "constatRef" = 'mission:VER-TEST-1' WHERE id = 'pr-1';
  SELECT "verifieeLe" INTO ts FROM propositions_teledetection WHERE id = 'pr-1';
  IF ts < CURRENT_TIMESTAMP - interval '1 minute' THEN RAISE EXCEPTION 'verifieeLe antidate conserve'; END IF;
  UPDATE propositions_teledetection SET statut = 'INFIRMEE', "verifieeParId" = 'u-eo', "verifieeLe" = now(),
         "motifVerdict" = 'Chaussee seche, rizieres en eau a cote', "constatRef" = 'mission:VER-TEST-2' WHERE id = 'pr-2';
  RAISE NOTICE 'Deux verdicts poses, a l''heure du serveur';

  BEGIN
    UPDATE propositions_teledetection SET statut = 'INFIRMEE', "motifVerdict" = 'revu' WHERE id = 'pr-1';
    RAISE EXCEPTION 'Verdict repris';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Reprise du verdict REFUSEE'; END;

  SELECT precision INTO v FROM precision_teledetection WHERE type = 'INONDATION' AND methode = 'seuil-sar v0';
  IF v <> 0.5 THEN RAISE EXCEPTION 'Precision attendue 0,5 (1 confirmee, 1 infirmee), recu %', v; END IF;
  SELECT "aVerifier" INTO nb FROM precision_teledetection WHERE type = 'INONDATION' AND methode = 'seuil-sar v0';
  IF nb <> 1 THEN RAISE EXCEPTION 'Une proposition a verifier attendue, recu %', nb; END IF;
  RAISE NOTICE 'Precision 0,5 sur deux verdicts ; la troisieme reste a verifier et ne compte pas';

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
