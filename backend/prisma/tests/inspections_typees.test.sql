-- BANC D'ESSAI des inspections typees (paragraphe 7.7, inspection post-travaux).
--
-- Ce qu'il prouve : une inspection POST_TRAVAUX ne s'enregistre pas sans reference
-- d'intervention, sans etat mesure ni sans photo ; un type inconnu est refuse ; un IRI estime
-- porte sa methode ; et les inspections existantes restent valides, en GENERALE.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 \
--     -f - < backend/prisma/tests/inspections_typees.test.sql
--
-- Transaction ANNULEE a la fin.

BEGIN;

INSERT INTO regions (nom) VALUES ('Region de test inspections');
INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-insp', 'insp@local.invalid', 'Fixture inspection', 'fixture-sans-usage', 'GESTIONNAIRE', CURRENT_TIMESTAMP);
INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", "updatedAt")
VALUES ('t-insp', 'TEST-INSP-1', 'Troncon de test inspections', 'RN',
        (SELECT id FROM regions WHERE nom = 'Region de test inspections'), 10, 'BITUME', 0, 10, CURRENT_TIMESTAMP);

DO $t$
DECLARE nb integer; v_type text;
BEGIN
  -- ---------- Une inspection comme avant : GENERALE par defaut, rien d'exige en plus ----------
  INSERT INTO inspections (id, "tronconId", "inspecteurId", "dateInspection", "etatObserve")
  VALUES ('i-gen', 't-insp', 'u-insp', CURRENT_TIMESTAMP, 'MOYEN');
  SELECT "type" INTO v_type FROM inspections WHERE id = 'i-gen';
  IF v_type <> 'GENERALE' THEN RAISE EXCEPTION 'type par defaut % au lieu de GENERALE', v_type; END IF;
  RAISE NOTICE 'Inspection sans type : GENERALE par defaut, les lignes existantes restent valides';

  -- ---------- POST_TRAVAUX sans reference d'intervention : refuse ----------
  BEGIN
    INSERT INTO inspections (id, "tronconId", "inspecteurId", "dateInspection", "etatObserve", "type", photos)
    VALUES ('i-pt1', 't-insp', 'u-insp', CURRENT_TIMESTAMP, 'BON', 'POST_TRAVAUX', ARRAY['apres.jpg']);
    RAISE EXCEPTION 'POST_TRAVAUX sans reference d''intervention accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'POST_TRAVAUX sans reference d''intervention REFUSE : quels travaux ?';
  END;

  -- ---------- POST_TRAVAUX sans photo : refuse ----------
  BEGIN
    INSERT INTO inspections (id, "tronconId", "inspecteurId", "dateInspection", "etatObserve", "type", "interventionRef")
    VALUES ('i-pt2', 't-insp', 'u-insp', CURRENT_TIMESTAMP, 'BON', 'POST_TRAVAUX', 'INT-2026-0007');
    RAISE EXCEPTION 'POST_TRAVAUX sans photo accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'POST_TRAVAUX sans photo REFUSE : un constat apres travaux se montre';
  END;

  -- ---------- POST_TRAVAUX sans etat mesure : refuse ----------
  BEGIN
    INSERT INTO inspections (id, "tronconId", "inspecteurId", "dateInspection", "etatObserve", "type", "interventionRef", photos)
    VALUES ('i-pt3', 't-insp', 'u-insp', CURRENT_TIMESTAMP, 'NON_EVALUE', 'POST_TRAVAUX', 'INT-2026-0007', ARRAY['apres.jpg']);
    RAISE EXCEPTION 'POST_TRAVAUX avec etat NON_EVALUE accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'POST_TRAVAUX avec NON_EVALUE REFUSE : l''etat apres travaux se mesure';
  END;

  -- ---------- Contre-epreuve : complete, elle passe ----------
  INSERT INTO inspections (id, "tronconId", "inspecteurId", "dateInspection", "etatObserve", "type", "interventionRef", photos, "iriEstime", "iriMethode")
  VALUES ('i-pt', 't-insp', 'u-insp', CURRENT_TIMESTAMP, 'BON', 'POST_TRAVAUX', 'INT-2026-0007', ARRAY['apres-1.jpg', 'apres-2.jpg'], 3.20, 'smartphone_experimental');
  RAISE NOTICE 'POST_TRAVAUX complete : reference, etat BON, deux photos, IRI estime 3,20 avec methode -- acceptee';

  -- ---------- Un type inconnu est refuse ----------
  BEGIN
    INSERT INTO inspections (id, "tronconId", "inspecteurId", "dateInspection", "etatObserve", "type")
    VALUES ('i-x', 't-insp', 'u-insp', CURRENT_TIMESTAMP, 'BON', 'RECEPTION');
    RAISE EXCEPTION 'Un type RECEPTION a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Type RECEPTION REFUSE : la reception est un acte contractuel, hors perimetre';
  END;

  -- ---------- IRI sans methode : refuse ----------
  BEGIN
    INSERT INTO inspections (id, "tronconId", "inspecteurId", "dateInspection", "etatObserve", "iriEstime")
    VALUES ('i-iri', 't-insp', 'u-insp', CURRENT_TIMESTAMP, 'MOYEN', 4.1);
    RAISE EXCEPTION 'Un IRI sans methode a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'IRI sans methode REFUSE : sans methode il se lirait comme un IRI normalise';
  END;
  BEGIN
    INSERT INTO inspections (id, "tronconId", "inspecteurId", "dateInspection", "etatObserve", "iriEstime", "iriMethode")
    VALUES ('i-iri2', 't-insp', 'u-insp', CURRENT_TIMESTAMP, 'MOYEN', -1, 'x');
    RAISE EXCEPTION 'Un IRI negatif a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'IRI negatif REFUSE';
  END;

  -- ---------- PERIODIQUE et VERIFICATION passent sans exigence supplementaire ----------
  INSERT INTO inspections (id, "tronconId", "inspecteurId", "dateInspection", "etatObserve", "type")
  VALUES ('i-per', 't-insp', 'u-insp', CURRENT_TIMESTAMP, 'MOYEN', 'PERIODIQUE'),
         ('i-ver', 't-insp', 'u-insp', CURRENT_TIMESTAMP, 'MAUVAIS', 'VERIFICATION');
  SELECT count(*) INTO nb FROM inspections WHERE "tronconId" = 't-insp';
  IF nb <> 4 THEN RAISE EXCEPTION '% inspections au lieu de 4', nb; END IF;
  RAISE NOTICE 'PERIODIQUE et VERIFICATION : acceptees, 4 inspections au total';

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
