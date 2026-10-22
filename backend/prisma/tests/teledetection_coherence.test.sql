-- BANC D'ESSAI de la coherence registre / propositions / verdicts (partie E, A30).
--
-- Ce qu'il prouve : une proposition hors de l'emprise de son produit, une reference non anterieure
-- ou qui ne couvre pas la geometrie, un produit retire, un troncon retire ou une distance saisie
-- au lieu d'etre mesuree sont REFUSES a l'insertion ; un produit cite a sa provenance figee et ne
-- se supprime pas physiquement ; la vue `coherence_teledetection` signale ce qui survient apres
-- coup (produit ou troncon retire, mission close sans verdict, verdict avant la fin de la mission),
-- et ne signale RIEN sur un jeu coherent.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/teledetection_coherence.test.sql
--
-- Transaction ANNULEE a la fin.

BEGIN;

INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-co', 'co@local.invalid', 'Fixture coherence', 'fixture-sans-usage', 'GESTIONNAIRE', CURRENT_TIMESTAMP);
INSERT INTO regions (nom) VALUES ('Region de test coherence');
INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
VALUES ('t-co', 'CO-A', 'Troncon de test', 'RN', (SELECT id FROM regions WHERE nom = 'Region de test coherence'), 1.1, 'BITUME', 0, 1.1,
        ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.59, 9.64)), 4326), CURRENT_TIMESTAMP);

DO $t$
DECLARE nb integer; d double precision;
  emprise geometry := ST_SetSRID(ST_MakeEnvelope(-13.7, 9.5, -13.4, 9.8), 4326);
  ailleurs geometry := ST_SetSRID(ST_MakeEnvelope(-10.0, 10.0, -9.8, 10.2), 4326);
  dedans geometry := ST_SetSRID(ST_MakePoint(-13.595, 9.6401), 4326);
BEGIN
  INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId") VALUES
    ('c-apres', 'CO-S1-APRES', 0, 'Sentinel-1 GRD', 'RADAR', '2026-10-02', 10, 'x', 'scene-apres', 'licence relevee a la source', 'v0', emprise, 'u-co'),
    ('c-ailleurs', 'CO-S1-AILLEURS', 0, 'Sentinel-1 GRD', 'RADAR', '2026-09-01', 10, 'x', 'scene-ailleurs', 'licence relevee a la source', 'v0', ailleurs, 'u-co'),
    ('c-plus-tard', 'CO-S1-PLUS-TARD', 0, 'Sentinel-1 GRD', 'RADAR', '2026-10-15', 10, 'x', 'scene-plus-tard', 'licence relevee a la source', 'v0', emprise, 'u-co'),
    ('c-retire', 'CO-S1-RETIRE', 0, 'Sentinel-1 GRD', 'RADAR', '2026-08-01', 10, 'x', 'scene-retiree', 'licence relevee a la source', 'v0', emprise, 'u-co');
  INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", "couvertureNuagesPct", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId")
  VALUES ('c-avant-opt', 'CO-S2-AVANT', 0, 'Sentinel-2 L2A', 'OPTIQUE', '2026-09-01', 10, 5, 'x', 'scene-avant', 'licence relevee a la source', 'v0', emprise, 'u-co');
  UPDATE earth_observation_products SET "deletedAt" = now() WHERE id = 'c-retire';

  -- ---------- Refus a l'insertion ----------
  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "creeParId")
    VALUES ('x', 'c-apres', 'INONDATION', 'seuil-sar v0', ST_SetSRID(ST_MakePoint(-9.9, 10.1), 4326), 'u-co');
    RAISE EXCEPTION 'Proposition hors emprise acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Proposition hors de l''emprise de son produit REFUSEE'; END;

  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "creeParId")
    VALUES ('x', 'c-retire', 'INONDATION', 'seuil-sar v0', dedans, 'u-co');
    RAISE EXCEPTION 'Proposition sur produit retire acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Proposition sur un produit retire REFUSEE'; END;

  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, geom, "creeParId")
    VALUES ('x', 'c-apres', 'c-plus-tard', 'INONDATION', 'diff-sar v0', dedans, 'u-co');
    RAISE EXCEPTION 'Reference posterieure acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Reference posterieure au produit REFUSEE'; END;

  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, geom, "creeParId")
    VALUES ('x', 'c-apres', 'c-ailleurs', 'INONDATION', 'diff-sar v0', dedans, 'u-co');
    RAISE EXCEPTION 'Reference qui ne couvre pas la geometrie acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Reference qui ne couvre pas la geometrie REFUSEE'; END;

  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, geom, "creeParId")
    VALUES ('x', 'c-apres', 'c-retire', 'INONDATION', 'diff-sar v0', dedans, 'u-co');
    RAISE EXCEPTION 'Reference retiree acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Reference retiree du registre REFUSEE'; END;

  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "tronconId", "distanceTronconM", "creeParId")
    VALUES ('x', 'c-apres', 'INONDATION', 'seuil-sar v0', dedans, 't-co', 0.5, 'u-co');
    RAISE EXCEPTION 'Distance saisie acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Distance au troncon saisie au lieu d''etre mesuree REFUSEE'; END;

  -- ---------- Contre-epreuves : un jeu coherent passe, et la vue ne dit rien ----------
  SELECT ST_Distance(geom::geography, dedans::geography) INTO d FROM troncons WHERE id = 't-co';
  INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, score, geom, "tronconId", "distanceTronconM", "creeParId")
  VALUES ('co-1', 'c-apres', 'c-avant-opt', 'INONDATION', 'diff-optique-sar v0', 0.7, dedans, 't-co', d, 'u-co'),
         ('co-2', 'c-apres', NULL, 'INONDATION', 'seuil-sar v0', NULL, ST_SetSRID(ST_MakePoint(-13.5, 9.7), 4326), NULL, NULL, 'u-co'),
         ('co-3', 'c-apres', NULL, 'COUPURE_PROBABLE', 'seuil-sar v0', NULL, ST_SetSRID(ST_MakePoint(-13.45, 9.72), 4326), NULL, NULL, 'u-co');
  RAISE NOTICE 'Reference optique anterieure a un radar, distance mesuree (% m) : ACCEPTEES', round(d::numeric, 2);
  SELECT count(*) INTO nb FROM coherence_teledetection WHERE "propositionId" LIKE 'co-%';
  IF nb <> 0 THEN RAISE EXCEPTION 'Anomalies signalees sur un jeu coherent : %', nb; END IF;
  RAISE NOTICE 'Jeu coherent : aucune anomalie';

  -- ---------- Registre fige des qu'il est cite ----------
  BEGIN
    UPDATE earth_observation_products SET licence = 'autre licence' WHERE id = 'c-apres';
    RAISE EXCEPTION 'Licence d''un produit cite modifiee';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Modification de la licence d''un produit cite REFUSEE'; END;
  BEGIN
    UPDATE earth_observation_products SET emprise = ailleurs WHERE id = 'c-avant-opt';
    RAISE EXCEPTION 'Emprise d''un produit de reference modifiee';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Modification de l''emprise d''un produit de reference REFUSEE'; END;
  BEGIN
    DELETE FROM earth_observation_products WHERE id = 'c-plus-tard';
    RAISE EXCEPTION 'Produit supprime physiquement';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Suppression physique d''un produit, meme non cite, REFUSEE'; END;
  UPDATE earth_observation_products SET licence = 'licence relevee a la source le 22/10' WHERE id = 'c-plus-tard';
  RAISE NOTICE 'Produit non cite : sa fiche se corrige';

  -- ---------- Ce qui survient apres : la vue le signale ----------
  INSERT INTO missions (id, code, intitule, type, statut, "createurId", "updatedAt")
  VALUES ('m-close', 'CO-M-CLOSE', 'Verification close', 'SURVEILLANCE', 'TERMINEE', 'u-co', now()),
         ('m-ouverte', 'CO-M-OUV', 'Verification ouverte', 'SURVEILLANCE', 'PLANIFIEE', 'u-co', now());
  UPDATE propositions_teledetection SET "missionId" = 'm-close' WHERE id = 'co-2';
  UPDATE propositions_teledetection SET "missionId" = 'm-ouverte' WHERE id = 'co-3';
  UPDATE propositions_teledetection SET statut = 'CONFIRMEE', "verifieeParId" = 'u-co', "motifVerdict" = 'route coupee', "constatRef" = 'observation:CO-1' WHERE id = 'co-3';
  UPDATE troncons SET "deletedAt" = now() WHERE id = 't-co';
  UPDATE earth_observation_products SET "deletedAt" = now() WHERE id = 'c-apres';

  SELECT count(*) INTO nb FROM coherence_teledetection WHERE "propositionId" = 'co-2' AND code = 'MISSION_SANS_VERDICT';
  IF nb <> 1 THEN RAISE EXCEPTION 'Mission terminee sans verdict non signalee'; END IF;
  SELECT count(*) INTO nb FROM coherence_teledetection WHERE "propositionId" = 'co-3' AND code = 'VERDICT_AVANT_FIN_MISSION';
  IF nb <> 1 THEN RAISE EXCEPTION 'Verdict avant la fin de la mission non signale'; END IF;
  SELECT count(*) INTO nb FROM coherence_teledetection WHERE "propositionId" = 'co-1' AND code = 'TRONCON_RETIRE';
  IF nb <> 1 THEN RAISE EXCEPTION 'Troncon retire non signale'; END IF;
  -- co-1 et co-2 restent a verifier sur un produit retire ; co-3 est jugee, elle n'est pas en attente.
  SELECT count(*) INTO nb FROM coherence_teledetection WHERE code = 'PRODUIT_RETIRE_EN_ATTENTE' AND "propositionId" LIKE 'co-%';
  IF nb <> 2 THEN RAISE EXCEPTION 'Propositions en attente sur produit retire : 2 attendues, % recues', nb; END IF;
  SELECT count(*) INTO nb FROM coherence_teledetection WHERE gravite = 'BLOQUANTE' AND "propositionId" LIKE 'co-%';
  IF nb <> 0 THEN RAISE EXCEPTION 'Anomalie bloquante inattendue : %', nb; END IF;
  RAISE NOTICE 'Mission close sans verdict, verdict avant fin de mission, troncon retire, produit retire : SIGNALES (A_EXAMINER)';

  -- ---------- Lignes anterieures au declencheur : la vue les voit ----------
  ALTER TABLE propositions_teledetection DISABLE TRIGGER propositions_teledetection_coherence;
  INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, geom, "creeParId")
  VALUES ('co-ancienne', 'c-plus-tard', 'c-ailleurs', 'INONDATION', 'ancienne v0', ST_SetSRID(ST_MakePoint(-9.0, 11.0), 4326), 'u-co');
  ALTER TABLE propositions_teledetection ENABLE TRIGGER propositions_teledetection_coherence;
  SELECT count(*) INTO nb FROM coherence_teledetection WHERE "propositionId" = 'co-ancienne' AND gravite = 'BLOQUANTE';
  IF nb <> 2 THEN RAISE EXCEPTION 'Ligne ancienne incoherente : 2 anomalies bloquantes attendues (hors emprise, reference), % recues', nb; END IF;
  RAISE NOTICE 'Ligne anterieure au declencheur, hors emprise et a reference posterieure : SIGNALEE (BLOQUANTE x2)';

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
