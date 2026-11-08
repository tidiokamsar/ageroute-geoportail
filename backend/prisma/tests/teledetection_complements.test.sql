-- BANC D'ESSAI des complements de coherence de la partie E (A30), migration
-- `20261025120000_teledetection_coherence_complements`. Le banc `teledetection_coherence.test.sql`
-- eprouve les regles de `20261022020000` ; celui-ci eprouve ce qui s'y ajoute, et que les regles
-- d'origine tiennent toujours.
--
-- Ce qu'il prouve : une proposition sur un produit ou une reference retire, sur un troncon retire,
-- ou a une distance declaree au lieu d'etre mesuree, est REFUSEE ; une reference optique anterieure
-- a un radar reste admise ; un produit cite a sa provenance figee et aucun produit ne se supprime
-- physiquement ; la vue signale un produit retire avec des propositions en attente, une mission close
-- sans verdict, un verdict rendu avant la fin de la mission, et ne signale rien sur un jeu coherent.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/teledetection_complements.test.sql
--
-- Transaction ANNULEE a la fin.

BEGIN;

INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-tcc', 'tcc@local.invalid', 'Fixture complements', 'fixture-sans-usage', 'GESTIONNAIRE', CURRENT_TIMESTAMP);
INSERT INTO regions (nom) VALUES ('Region de test complements');
INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
VALUES ('t-tcc', 'TCC-A', 'Troncon de test', 'RN', (SELECT id FROM regions WHERE nom = 'Region de test complements'), 1.1, 'BITUME', 0, 1.1,
        ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.59, 9.64)), 4326), CURRENT_TIMESTAMP),
       ('t-tcc-retire', 'TCC-B', 'Troncon retire', 'RN', (SELECT id FROM regions WHERE nom = 'Region de test complements'), 1.1, 'BITUME', 0, 1.1,
        ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.65), ST_MakePoint(-13.59, 9.65)), 4326), CURRENT_TIMESTAMP);
UPDATE troncons SET "deletedAt" = now() WHERE id = 't-tcc-retire';

DO $t$
DECLARE nb integer; d double precision;
  emprise geometry := ST_SetSRID(ST_MakeEnvelope(-13.7, 9.5, -13.4, 9.8), 4326);
  dedans geometry := ST_SetSRID(ST_MakePoint(-13.595, 9.6401), 4326);
BEGIN
  INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId") VALUES
    ('c-apres', 'TCC-S1-APRES', 0, 'Sentinel-1 GRD', 'RADAR', '2026-10-02', 10, 'x', 'scene-apres', 'licence relevee a la source', 'v0', emprise, 'u-tcc'),
    ('c-libre', 'TCC-S1-LIBRE', 0, 'Sentinel-1 GRD', 'RADAR', '2026-10-15', 10, 'x', 'scene-libre', 'licence relevee a la source', 'v0', emprise, 'u-tcc'),
    ('c-retire', 'TCC-S1-RETIRE', 0, 'Sentinel-1 GRD', 'RADAR', '2026-08-01', 10, 'x', 'scene-retiree', 'licence relevee a la source', 'v0', emprise, 'u-tcc');
  INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", "couvertureNuagesPct", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId")
  VALUES ('c-avant-opt', 'TCC-S2-AVANT', 0, 'Sentinel-2 L2A', 'OPTIQUE', '2026-09-01', 10, 5, 'x', 'scene-avant', 'licence relevee a la source', 'v0', emprise, 'u-tcc');
  UPDATE earth_observation_products SET "deletedAt" = now() WHERE id = 'c-retire';

  -- ---------- Refus ajoutes ----------
  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "creeParId") VALUES ('x', 'c-retire', 'INONDATION', 'seuil-sar v0', dedans, 'u-tcc');
    RAISE EXCEPTION 'Proposition sur produit retire acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Proposition sur un produit retire REFUSEE'; END;
  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, geom, "creeParId") VALUES ('x', 'c-apres', 'c-retire', 'INONDATION', 'diff v0', dedans, 'u-tcc');
    RAISE EXCEPTION 'Reference retiree acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Reference retiree du registre REFUSEE'; END;
  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "tronconId", "distanceTronconM", "creeParId") VALUES ('x', 'c-apres', 'INONDATION', 'seuil-sar v0', dedans, 't-tcc', 0.5, 'u-tcc');
    RAISE EXCEPTION 'Distance declaree acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Distance au troncon declaree au lieu d''etre mesuree REFUSEE'; END;
  SELECT ST_Distance(geom::geography, dedans::geography) INTO d FROM troncons WHERE id = 't-tcc-retire';
  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "tronconId", "distanceTronconM", "creeParId") VALUES ('x', 'c-apres', 'INONDATION', 'seuil-sar v0', dedans, 't-tcc-retire', d, 'u-tcc');
    RAISE EXCEPTION 'Rattachement a un troncon retire accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Rattachement a un troncon retire REFUSE'; END;

  -- ---------- Les regles d'origine tiennent toujours ----------
  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", type, methode, geom, "creeParId") VALUES ('x', 'c-apres', 'INONDATION', 'seuil-sar v0', ST_SetSRID(ST_MakePoint(-9.9, 10.1), 4326), 'u-tcc');
    RAISE EXCEPTION 'Proposition hors emprise acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Regle d''origine : hors emprise toujours REFUSE'; END;
  BEGIN
    INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, geom, "creeParId") VALUES ('x', 'c-apres', 'c-libre', 'INONDATION', 'diff v0', dedans, 'u-tcc');
    RAISE EXCEPTION 'Reference posterieure acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Regle d''origine : reference posterieure toujours REFUSEE'; END;

  -- ---------- Contre-epreuves : un jeu coherent passe, et la vue ne dit rien ----------
  SELECT ST_Distance(geom::geography, dedans::geography) INTO d FROM troncons WHERE id = 't-tcc';
  INSERT INTO propositions_teledetection (id, "produitId", "produitReferenceId", type, methode, score, geom, "tronconId", "distanceTronconM", "creeParId")
  VALUES ('tcc-1', 'c-apres', 'c-avant-opt', 'INONDATION', 'diff-optique-sar v0', 0.7, dedans, 't-tcc', d, 'u-tcc'),
         ('tcc-2', 'c-apres', NULL, 'INONDATION', 'seuil-sar v0', NULL, ST_SetSRID(ST_MakePoint(-13.5, 9.7), 4326), NULL, NULL, 'u-tcc'),
         ('tcc-3', 'c-apres', NULL, 'COUPURE_PROBABLE', 'seuil-sar v0', NULL, ST_SetSRID(ST_MakePoint(-13.45, 9.72), 4326), NULL, NULL, 'u-tcc');
  RAISE NOTICE 'Reference optique anterieure a un radar, distance mesuree (% m) : ACCEPTEES', round(d::numeric, 2);
  SELECT count(*) INTO nb FROM coherence_teledetection WHERE "propositionId" LIKE 'tcc-%';
  IF nb <> 0 THEN RAISE EXCEPTION 'Anomalies signalees sur un jeu coherent : %', nb; END IF;
  RAISE NOTICE 'Jeu coherent : aucune anomalie';

  -- ---------- Registre fige des qu'il est cite, et jamais supprime ----------
  BEGIN
    UPDATE earth_observation_products SET licence = 'autre licence' WHERE id = 'c-apres';
    RAISE EXCEPTION 'Licence d''un produit cite modifiee';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Modification de la licence d''un produit cite REFUSEE'; END;
  BEGIN
    UPDATE earth_observation_products SET emprise = ST_SetSRID(ST_MakeEnvelope(-10.0, 10.0, -9.8, 10.2), 4326) WHERE id = 'c-avant-opt';
    RAISE EXCEPTION 'Emprise d''un produit de reference modifiee';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Modification de l''emprise d''un produit de reference REFUSEE'; END;
  BEGIN
    DELETE FROM earth_observation_products WHERE id = 'c-libre';
    RAISE EXCEPTION 'Produit supprime physiquement';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Suppression physique d''un produit, meme non cite, REFUSEE'; END;
  -- Depuis le module Observation de la Terre (20261028130000), la provenance de TOUT produit est figee, cite ou non : une
  -- fiche ne se corrige que par la voie exceptionnelle, motivee et journalisee. Regle plus stricte que celle de lot/17
  -- (produit cite seulement) : sans motif, refus ; avec motif et auteur connu, la correction passe.
  BEGIN
    UPDATE earth_observation_products SET licence = 'licence relevee a la source le 22/10' WHERE id = 'c-libre';
    RAISE EXCEPTION 'Licence d''un produit non cite modifiee sans motif';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Produit non cite : correction SANS motif REFUSEE'; END;
  PERFORM set_config('bdri.correction_produit_motif', 'correction de la licence relevee a la source', true);
  PERFORM set_config('bdri.correction_produit_auteur', 'u-tcc', true);
  UPDATE earth_observation_products SET licence = 'licence relevee a la source le 22/10' WHERE id = 'c-libre';
  PERFORM set_config('bdri.correction_produit_motif', '', true);
  PERFORM set_config('bdri.correction_produit_auteur', '', true);
  RAISE NOTICE 'Produit non cite : sa fiche se corrige par la voie exceptionnelle motivee';

  -- ---------- Ce qui survient apres : la vue le signale ----------
  INSERT INTO missions (id, code, intitule, type, statut, "createurId", "updatedAt")
  VALUES ('m-tcc-close', 'TCC-M-CLOSE', 'Verification close', 'SURVEILLANCE', 'TERMINEE', 'u-tcc', now()),
         ('m-tcc-ouv', 'TCC-M-OUV', 'Verification ouverte', 'SURVEILLANCE', 'PLANIFIEE', 'u-tcc', now());
  UPDATE propositions_teledetection SET "missionId" = 'm-tcc-close' WHERE id = 'tcc-2';
  UPDATE propositions_teledetection SET "missionId" = 'm-tcc-ouv' WHERE id = 'tcc-3';
  UPDATE propositions_teledetection SET statut = 'CONFIRMEE', "verifieeParId" = 'u-tcc', "motifVerdict" = 'route coupee', "constatRef" = 'observation:TCC-1' WHERE id = 'tcc-3';
  UPDATE earth_observation_products SET "deletedAt" = now() WHERE id = 'c-apres';

  SELECT count(*) INTO nb FROM coherence_teledetection WHERE "propositionId" = 'tcc-2' AND regle = 'MISSION_SANS_VERDICT';
  IF nb <> 1 THEN RAISE EXCEPTION 'Mission terminee sans verdict non signalee'; END IF;
  SELECT count(*) INTO nb FROM coherence_teledetection WHERE "propositionId" = 'tcc-3' AND regle = 'VERDICT_AVANT_FIN_MISSION';
  IF nb <> 1 THEN RAISE EXCEPTION 'Verdict avant la fin de la mission non signale'; END IF;
  -- tcc-1 et tcc-2 restent a verifier sur un produit retire ; tcc-3 est jugee.
  SELECT count(*) INTO nb FROM coherence_teledetection WHERE regle = 'PRODUIT_RETIRE_EN_ATTENTE' AND "propositionId" LIKE 'tcc-%';
  IF nb <> 2 THEN RAISE EXCEPTION 'Propositions en attente sur produit retire : 2 attendues, % recues', nb; END IF;
  RAISE NOTICE 'Mission close sans verdict, verdict avant fin de mission, produit retire avec propositions en attente : SIGNALES';

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
