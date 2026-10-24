-- BANC D'ESSAI des patrouilles programmees (paragraphe 7.17, EX-03).
--
-- Ce qu'il prouve : les invariants du programme (periodicite, mois), et la COUVERTURE mesuree
-- en base sur une geometrie connue -- un troncon entierement parcouru, un troncon a moitie, un
-- troncon jamais vu, et un detour hors itineraire dont la longueur est mesuree.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 \
--     -f - < backend/prisma/tests/patrouilles.test.sql
--
-- Transaction ANNULEE a la fin.

BEGIN;

INSERT INTO regions (nom) VALUES ('Region de test patrouilles');
INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-pat', 'pat@local.invalid', 'Fixture patrouille', 'fixture-sans-usage', 'GESTIONNAIRE', CURRENT_TIMESTAMP);

-- Trois troncons alignes est-ouest a la latitude 9,64, chacun d'environ 1,1 km
-- (0,01 degre de longitude a cette latitude = environ 1 097 m).
INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt") VALUES
 ('t-a', 'PAT-A', 'Troncon A', 'RN', (SELECT id FROM regions WHERE nom='Region de test patrouilles'), 1.1, 'BITUME', 0, 1.1,
  ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.59, 9.64)), 4326), CURRENT_TIMESTAMP),
 ('t-b', 'PAT-B', 'Troncon B', 'RN', (SELECT id FROM regions WHERE nom='Region de test patrouilles'), 1.1, 'BITUME', 1.1, 2.2,
  ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.59, 9.64), ST_MakePoint(-13.58, 9.64)), 4326), CURRENT_TIMESTAMP),
 ('t-c', 'PAT-C', 'Troncon C', 'RN', (SELECT id FROM regions WHERE nom='Region de test patrouilles'), 1.1, 'BITUME', 2.2, 3.3,
  ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.58, 9.64), ST_MakePoint(-13.57, 9.64)), 4326), CURRENT_TIMESTAMP);

DO $t$
DECLARE
  nb integer; v_taux double precision; v_hors double precision; v_long double precision;
BEGIN
  -- ---------- Invariants du programme ----------
  BEGIN
    INSERT INTO programmes_patrouille (id, code, libelle, "periodiciteJours", "responsableId", "creeParId")
    VALUES ('p0', 'PAT-0', 'Periodicite nulle', 0, 'u-pat', 'u-pat');
    RAISE EXCEPTION 'Une periodicite de 0 jour a ete acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Periodicite 0 REFUSEE'; END;

  BEGIN
    INSERT INTO programmes_patrouille (id, code, libelle, "periodiciteJours", "moisActifs", "responsableId", "creeParId")
    VALUES ('p0', 'PAT-0', 'Mois 13', 7, '{6,13}', 'u-pat', 'u-pat');
    RAISE EXCEPTION 'Un mois 13 a ete accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Mois 13 REFUSE'; END;

  BEGIN
    INSERT INTO programmes_patrouille (id, code, libelle, "periodiciteJours", "moisActifs", "responsableId", "creeParId")
    VALUES ('p0', 'PAT-0', 'Mois en double', 7, '{6,6}', 'u-pat', 'u-pat');
    RAISE EXCEPTION 'Un mois en double a ete accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Mois en double REFUSE'; END;

  -- Contre-epreuve : hebdomadaire, juin a octobre -- l'exemple du mandat, saisi ICI par le test,
  -- pas seme par la migration.
  INSERT INTO programmes_patrouille (id, code, libelle, "classeAxe", "periodiciteJours", "moisActifs", "responsableId", "creeParId")
  VALUES ('p1', 'PAT-RN-TEST', 'RN de test, hebdomadaire en saison des pluies', 'RN', 7, '{6,7,8,9,10}', 'u-pat', 'u-pat');
  INSERT INTO programme_troncons ("programmeId", "tronconId", ordre) VALUES ('p1','t-a',1), ('p1','t-b',2), ('p1','t-c',3);
  RAISE NOTICE 'Programme hebdomadaire, mois 6 a 10, itineraire A-B-C : accepte';

  BEGIN
    INSERT INTO programme_troncons ("programmeId", "tronconId", ordre) VALUES ('p1','t-a',4);
    RAISE EXCEPTION 'Un troncon en double dans l''itineraire a ete accepte';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'Troncon en double dans l''itineraire REFUSE'; END;

  -- ---------- Une mission du programme, et sa trace ----------
  INSERT INTO missions (id, code, intitule, type, statut, "createurId", "programmeId", "updatedAt")
  VALUES ('m1', 'PAT-RN-TEST-20261019', 'Passage du 19/10', 'SURVEILLANCE', 'TERMINEE', 'u-pat', 'p1', CURRENT_TIMESTAMP);

  -- Trace : tout A, la moitie ouest de B, puis un detour de ~555 m vers le nord, jamais C.
  INSERT INTO traces (id, "missionId", "userId", "debutA", geom)
  VALUES ('tr1', 'm1', 'u-pat', CURRENT_TIMESTAMP,
          ST_SetSRID(ST_MakeLine(ARRAY[ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.585, 9.64), ST_MakePoint(-13.585, 9.645)]), 4326));

  -- ---------- Couverture ----------
  -- A est suivi EXACTEMENT par la trace : c'est le cas ou l'overlay GEOS 3.9 rendait 0.
  SELECT taux INTO v_taux FROM couverture_patrouille('m1') WHERE "tronconId" = 't-a';
  IF v_taux < 0.99 THEN RAISE EXCEPTION 'A devrait etre couvert a ~100 %%, recu %', v_taux; END IF;

  SELECT taux INTO v_taux FROM couverture_patrouille('m1') WHERE "tronconId" = 't-b';
  -- La moitie de B, plus la tolerance de 30 m autour du virage : un peu plus de 50 %.
  IF v_taux < 0.50 OR v_taux > 0.56 THEN RAISE EXCEPTION 'B devrait etre couvert a ~50 %%, recu %', v_taux; END IF;
  RAISE NOTICE 'Troncon B couvert a %', round((v_taux*100)::numeric, 1);

  SELECT taux INTO v_taux FROM couverture_patrouille('m1') WHERE "tronconId" = 't-c';
  IF v_taux > 0.01 THEN RAISE EXCEPTION 'C ne devrait pas etre couvert, recu %', v_taux; END IF;
  RAISE NOTICE 'Troncon A ~100 %%, B ~50 %%, C 0 %% : la couverture suit la trace';

  SELECT "longueurM" INTO v_hors FROM couverture_patrouille('m1') WHERE "tronconId" IS NULL;
  -- Detour nord de ~555 m, dont les 30 premiers metres restent dans le tampon.
  IF v_hors < 480 OR v_hors > 560 THEN RAISE EXCEPTION 'Ecart hors itineraire attendu ~525 m, recu %', v_hors; END IF;
  RAISE NOTICE 'Ecart hors itineraire mesure : % m', round(v_hors::numeric);

  -- Tolerance plus large : la couverture ne peut que croitre.
  SELECT sum("couvertM") INTO v_long FROM couverture_patrouille('m1', 30) WHERE "tronconId" IS NOT NULL;
  SELECT sum("couvertM") INTO v_taux FROM couverture_patrouille('m1', 300) WHERE "tronconId" IS NOT NULL;
  IF v_taux < v_long THEN RAISE EXCEPTION 'Une tolerance plus large a reduit la couverture'; END IF;

  -- Une tolerance nulle est refusee bruyamment.
  BEGIN
    PERFORM count(*) FROM couverture_patrouille('m1', 0);
    RAISE EXCEPTION 'Une tolerance de 0 aurait du lever une erreur';
  EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'Tolerance 0 REFUSEE'; END;

  -- ---------- Une mission sans trace : couverture nulle, rendue et non absente ----------
  INSERT INTO missions (id, code, intitule, type, statut, "createurId", "programmeId", "updatedAt")
  VALUES ('m2', 'PAT-RN-TEST-20261026', 'Passage du 26/10', 'SURVEILLANCE', 'PLANIFIEE', 'u-pat', 'p1', CURRENT_TIMESTAMP);
  SELECT count(*) INTO nb FROM couverture_patrouille('m2') WHERE "tronconId" IS NOT NULL AND "couvertM" = 0;
  IF nb <> 3 THEN RAISE EXCEPTION 'Mission sans trace : 3 troncons a 0 attendus, recu %', nb; END IF;
  RAISE NOTICE 'Mission sans trace : les 3 troncons rendus a 0, aucun ne disparait';

  -- ---------- Dispatch de verification : une mission cite un signalement ----------
  INSERT INTO signalements_citoyens (id, "numeroPublic", "typeProbleme", statut, "updatedAt")
  VALUES ('s1', 'SIG-2026-00001', (SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='TypeProbleme' ORDER BY e.enumsortorder LIMIT 1)::"TypeProbleme", 'NOUVEAU', CURRENT_TIMESTAMP);
  INSERT INTO missions (id, code, intitule, type, statut, "createurId", "signalementId", "updatedAt")
  VALUES ('m3', 'VER-SIG-2026-00001-1', 'Verification', 'SURVEILLANCE', 'PLANIFIEE', 'u-pat', 's1', CURRENT_TIMESTAMP);
  SELECT count(*) INTO nb FROM missions WHERE "signalementId" = 's1';
  IF nb <> 1 THEN RAISE EXCEPTION 'La mission de verification ne cite pas son signalement'; END IF;
  RAISE NOTICE 'Mission de verification liee a son signalement';

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
