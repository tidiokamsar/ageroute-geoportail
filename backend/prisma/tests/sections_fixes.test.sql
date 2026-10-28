-- BANC D'ESSAI de `reseau_sections_fixes` (IO-04, arbitrage D6).
--
-- Eprouve le critere B11 du prompt maitre V10 :
--   « La somme des sections fixes d'un troncon egale sa longueur ; chaque section porte l'etat
--     de la portion dominante et la note UEMOA ; aucune donnee n'est saisie au niveau section. »
--
-- POURQUOI UN FICHIER SQL ET PAS UN TEST VITEST
--
-- La fonction est du SQL, et son comportement depend de PostGIS -- `ST_Length` en `geography`,
-- l'intersection d'intervalles, la contrainte d'exclusion. Un test en TypeScript avec Prisma
-- mesurerait l'adaptateur, pas la fonction. Les 1 170 tests du paquet, eux, tournent SANS base,
-- et c'est une qualite a preserver : les y melanger imposerait une base a toute la suite.
--
-- COMMENT L'EXECUTER
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 \
--     -f - < backend/prisma/tests/sections_fixes.test.sql
--
-- Il N'ECRIT RIEN DE DURABLE : tout se passe dans une transaction annulee a la fin. Un
-- `RAISE EXCEPTION` sur la premiere assertion fausse suffit a faire echouer la commande, ce qui
-- rend le fichier utilisable en integration continue des qu'une base y sera disponible.

BEGIN;

-- ===== Donnees de test =====
--
-- Geometrie choisie pour que sa longueur soit CONNUE ET NON RONDE : un segment nord-sud de
-- 0,009 degre de latitude, soit environ 995,7 m en `geography`. Une longueur ronde cacherait
-- precisement le cas que le critere B11 interroge -- la derniere section est-elle un reste ?

INSERT INTO regions (nom) VALUES ('Region de test sections fixes');

INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-test-sf', 'test-sections-fixes@local.invalid', 'Fixture sections fixes',
        -- Jamais verifie : aucune authentification n'intervient dans ce test.
        'fixture-sans-usage', 'ADMIN', CURRENT_TIMESTAMP);

INSERT INTO referentiel_etats_chaussee (code, libelle, ordre, "updatedAt") VALUES
  ('TEST_BON',     'Bon (test)',     1, CURRENT_TIMESTAMP),
  ('TEST_MOYEN',   'Moyen (test)',   2, CURRENT_TIMESTAMP),
  ('TEST_MAUVAIS', 'Mauvais (test)', 3, CURRENT_TIMESTAMP);

INSERT INTO referentiel_revetements (code, libelle, ordre, bitumineux, "updatedAt") VALUES
  ('TEST_ENROBE',   'Enrobe (test)',   1, true,  CURRENT_TIMESTAMP),
  ('TEST_LATERITE', 'Laterite (test)', 2, false, CURRENT_TIMESTAMP);

INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement,
                      "pkDebut", "pkFin", geom, "updatedAt")
SELECT 't-test-sf', 'TEST-SF-1', 'Troncon de test sections fixes', 'RN',
       (SELECT id FROM regions WHERE nom = 'Region de test sections fixes'),
       -- LONGUEUR DECLAREE VOLONTAIREMENT FAUSSE : 1,2 km contre ~0,996 km de geometrie.
       -- C'est ainsi qu'on verifie que la fonction se fonde bien sur la geometrie, puisque
       -- c'est elle qui definit le systeme d'abscisses des portions.
       1.2, 'BITUME', 0, 1.2,
       ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.5784, 9.6412),
                              ST_MakePoint(-13.5784, 9.6502)), 4326),
       CURRENT_TIMESTAMP;

-- Un second troncon SANS GEOMETRIE : il doit etre absent du resultat, pas rendu avec des
-- sections derivees de sa longueur declaree.
INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement,
                      "pkDebut", "pkFin", geom, "updatedAt")
VALUES ('t-test-sf-nogeom', 'TEST-SF-2', 'Troncon sans geometrie', 'RN',
        (SELECT id FROM regions WHERE nom = 'Region de test sections fixes'),
        5.0, 'BITUME', 0, 5.0, NULL, CURRENT_TIMESTAMP);

-- Portions FAISANT FOI, sans chevauchement (la contrainte d'exclusion l'impose) :
--
--   [  0, 120)  MAUVAIS / ENROBE     -> minoritaire dans la section 0
--   [120, 400)  BON     / ENROBE     -> dominant dans les sections 1, 2, 3
--   [400, 500)  MOYEN   / LATERITE
--   [500, 900)  BON     / ENROBE
--   [900, 996)  rien : la couverture de la derniere section sera partielle
--
-- La section 0 au pas de 100 m est [0, 100) et n'est couverte que par MAUVAIS : elle doit
-- porter MAUVAIS. La section 4 est [400, 500), entierement MOYEN/LATERITE.
INSERT INTO portions (id, "tronconId", "debutM", "finM", etat, revetement, origine,
                      "statutValidation", "creeParId", "updatedAt") VALUES
  ('p-sf-1', 't-test-sf',   0, 120, 'TEST_MAUVAIS', 'TEST_ENROBE',   'IMPORT', 'VALIDE', 'u-test-sf', CURRENT_TIMESTAMP),
  ('p-sf-2', 't-test-sf', 120, 400, 'TEST_BON',     'TEST_ENROBE',   'IMPORT', 'VALIDE', 'u-test-sf', CURRENT_TIMESTAMP),
  ('p-sf-3', 't-test-sf', 400, 500, 'TEST_MOYEN',   'TEST_LATERITE', 'IMPORT', 'VALIDE', 'u-test-sf', CURRENT_TIMESTAMP),
  ('p-sf-4', 't-test-sf', 500, 900, 'TEST_BON',     'TEST_ENROBE',   'IMPORT', 'VALIDE', 'u-test-sf', CURRENT_TIMESTAMP);

-- Une PROPOSITION non validee, couvrant toute la longueur avec un etat different. Elle ne doit
-- avoir AUCUN effet : le critere A9 exige qu'une proposition n'apparaisse jamais comme
-- officielle, et un export de sections fixes vers la BDR nationale est officiel.
INSERT INTO portions (id, "tronconId", "debutM", "finM", etat, revetement, origine,
                      "statutValidation", "creeParId", "updatedAt") VALUES
  ('p-sf-prop', 't-test-sf', 0, 990, 'TEST_MOYEN', 'TEST_LATERITE', 'SAISIE_TERRAIN', 'A_VALIDER', 'u-test-sf', CURRENT_TIMESTAMP);

-- ===== Assertions =====

DO $t$
DECLARE
  longueur_geo   double precision;
  somme          double precision;
  nb             integer;
  v_etat         text;
  v_revetement   text;
  v_taux         double precision;
  v_declaree     double precision;
  erreur_relative double precision;
BEGIN
  SELECT ST_Length(geom::geography) INTO longueur_geo FROM troncons WHERE id = 't-test-sf';

  -- ---------- B11.1 : la somme des sections egale la longueur du troncon ----------
  --
  -- Eprouve a QUATRE pas, dont deux qui ne divisent pas la longueur et un plus grand que le
  -- troncon entier. Ce dernier est le cas limite qui fait tomber les implementations naives :
  -- une seule section, qui est un reste.
  FOREACH v_taux IN ARRAY ARRAY[100, 200, 37, 5000]::double precision[] LOOP
    SELECT SUM("longueurM"), COUNT(*) INTO somme, nb
      FROM reseau_sections_fixes(v_taux, ARRAY['t-test-sf']);

    IF nb = 0 THEN
      RAISE EXCEPTION 'B11.1 : aucune section au pas de % m', v_taux;
    END IF;

    -- Egalite a la virgule flottante pres, et non egalite stricte : la somme de n flottants
    -- n'est pas le flottant de la somme. Un millimetre sur un kilometre est le bon ordre.
    IF abs(somme - longueur_geo) > 0.001 THEN
      RAISE EXCEPTION 'B11.1 ECHEC au pas de % m : somme % contre longueur %',
        v_taux, somme, longueur_geo;
    END IF;

    RAISE NOTICE 'B11.1 pas % m : % sections, somme % m = longueur', v_taux, nb, round(somme::numeric, 3);
  END LOOP;

  -- ---------- La derniere section est un RESTE, pas un paquet complet ----------
  SELECT "longueurM" INTO v_taux
    FROM reseau_sections_fixes(100, ARRAY['t-test-sf'])
   ORDER BY "indexSection" DESC LIMIT 1;
  IF v_taux >= 100 THEN
    RAISE EXCEPTION 'La derniere section devrait etre un reste, elle fait % m', v_taux;
  END IF;
  RAISE NOTICE 'Derniere section : % m, donc un reste', round(v_taux::numeric, 3);

  -- ---------- B11.2 : chaque section porte l'etat de la portion DOMINANTE ----------

  -- Section 0 = [0, 100), couverte uniquement par MAUVAIS.
  SELECT etat INTO v_etat FROM reseau_sections_fixes(100, ARRAY['t-test-sf']) WHERE "indexSection" = 0;
  IF v_etat IS DISTINCT FROM 'TEST_MAUVAIS' THEN
    RAISE EXCEPTION 'B11.2 ECHEC section 0 : etat % au lieu de TEST_MAUVAIS', v_etat;
  END IF;

  -- Section 1 = [100, 200) : 20 m de MAUVAIS contre 80 m de BON. La MAJORITE doit gagner,
  -- et non la portion qui commence la premiere -- c'est exactement le piege de ce critere.
  SELECT etat, "dominanteTaux" INTO v_etat, v_taux
    FROM reseau_sections_fixes(100, ARRAY['t-test-sf']) WHERE "indexSection" = 1;
  IF v_etat IS DISTINCT FROM 'TEST_BON' THEN
    RAISE EXCEPTION 'B11.2 ECHEC section 1 : etat % au lieu de TEST_BON', v_etat;
  END IF;
  IF abs(v_taux - 0.8) > 0.0001 THEN
    RAISE EXCEPTION 'B11.2 ECHEC section 1 : taux de dominance % au lieu de 0,8', v_taux;
  END IF;
  RAISE NOTICE 'B11.2 section 1 : TEST_BON domine a % du lineaire', round((v_taux * 100)::numeric, 1);

  -- Section 4 = [400, 500), entierement MOYEN/LATERITE.
  SELECT etat, revetement, "dominanteTaux" INTO v_etat, v_revetement, v_taux
    FROM reseau_sections_fixes(100, ARRAY['t-test-sf']) WHERE "indexSection" = 4;
  IF v_etat IS DISTINCT FROM 'TEST_MOYEN' THEN
    RAISE EXCEPTION 'B11.2 ECHEC section 4 : etat %', v_etat;
  END IF;
  IF v_revetement IS DISTINCT FROM 'TEST_LATERITE' THEN
    RAISE EXCEPTION 'B11.2 ECHEC section 4 : revetement %', v_revetement;
  END IF;
  IF abs(v_taux - 1.0) > 0.0001 THEN
    RAISE EXCEPTION 'B11.2 ECHEC section 4 : taux % au lieu de 1', v_taux;
  END IF;

  -- ---------- Une section sans portion existe, et le dit ----------
  --
  -- La section 9 = [900, 996) n'est couverte par aucune portion faisant foi. Elle doit
  -- APPARAITRE avec un etat nul et une couverture nulle, et non disparaitre : une section
  -- absente du resultat se lirait comme une section sans existence, alors que la route est la
  -- et que c'est l'observation qui manque.
  SELECT etat, "couvertureTaux", "portionsCouvrantes"
    INTO v_etat, v_taux, nb
    FROM reseau_sections_fixes(100, ARRAY['t-test-sf']) WHERE "indexSection" = 9;
  IF v_etat IS NOT NULL OR v_taux <> 0 OR nb <> 0 THEN
    RAISE EXCEPTION 'Section non couverte mal rendue : etat %, taux %, portions %', v_etat, v_taux, nb;
  END IF;
  RAISE NOTICE 'Section 9 non couverte : etat NULL, couverture 0, 0 portion -- presente et honnete';

  -- ---------- La couverture ne depasse JAMAIS 1 ----------
  --
  -- Garantie par construction : l'ensemble filtre est celui de la contrainte d'exclusion, donc
  -- sans chevauchement, et les intervalles sont semi-ouverts. On le verifie quand meme, car
  -- c'est la propriete qui casserait en silence si le predicat changeait un jour.
  SELECT COUNT(*) INTO nb
    FROM reseau_sections_fixes(100, ARRAY['t-test-sf']) WHERE "couvertureTaux" > 1.0000001;
  IF nb > 0 THEN
    RAISE EXCEPTION 'ECHEC : % sections ont une couverture superieure a 1', nb;
  END IF;

  -- ---------- Une proposition non validee n'a aucun effet (critere A9) ----------
  --
  -- `p-sf-prop` couvre [0, 990) en MOYEN/LATERITE. Si elle comptait, la section 0 porterait
  -- MOYEN et la section 9 serait couverte.
  SELECT COUNT(*) INTO nb
    FROM reseau_sections_fixes(100, ARRAY['t-test-sf'])
   WHERE revetement = 'TEST_LATERITE' AND "indexSection" <> 4;
  IF nb > 0 THEN
    RAISE EXCEPTION 'A9 ECHEC : une proposition non validee influence % sections', nb;
  END IF;
  RAISE NOTICE 'A9 : la proposition A_VALIDER qui couvre tout le troncon n''a aucun effet';

  -- ---------- La geometrie fait foi, pas la longueur declaree ----------
  SELECT DISTINCT "longueurTronconM", "longueurDeclareeM" INTO v_taux, v_declaree
    FROM reseau_sections_fixes(100, ARRAY['t-test-sf']);
  IF abs(v_declaree - 1200) > 0.001 THEN
    RAISE EXCEPTION 'La longueur declaree devrait etre 1200 m, elle vaut %', v_declaree;
  END IF;
  IF abs(v_taux - longueur_geo) > 0.001 THEN
    RAISE EXCEPTION 'La longueur de reference devrait etre la geometrique';
  END IF;
  erreur_relative := abs(v_declaree - v_taux) / v_taux;
  IF erreur_relative < 0.1 THEN
    RAISE EXCEPTION 'Le test perd son sens : les deux longueurs ne divergent plus assez';
  END IF;
  RAISE NOTICE 'Longueurs rendues cote a cote : geometrique % m, declaree % m, ecart % %%',
    round(v_taux::numeric, 1), round(v_declaree::numeric, 1), round((erreur_relative * 100)::numeric, 1);

  -- ---------- Un troncon sans geometrie est exclu, et non devine ----------
  SELECT COUNT(*) INTO nb FROM reseau_sections_fixes(100, ARRAY['t-test-sf-nogeom']);
  IF nb <> 0 THEN
    RAISE EXCEPTION 'Un troncon sans geometrie a produit % sections', nb;
  END IF;
  RAISE NOTICE 'Troncon sans geometrie : 0 section, aucun repli sur la longueur declaree';

  -- ---------- Un pas invalide echoue bruyamment ----------
  BEGIN
    PERFORM COUNT(*) FROM reseau_sections_fixes(0, ARRAY['t-test-sf']);
    RAISE EXCEPTION 'Un pas de 0 aurait du lever une erreur';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      RAISE NOTICE 'Pas de 0 : refuse bruyamment, et non rendu comme un resultat vide';
  END;

  BEGIN
    PERFORM COUNT(*) FROM reseau_sections_fixes(-100, ARRAY['t-test-sf']);
    RAISE EXCEPTION 'Un pas negatif aurait du lever une erreur';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      RAISE NOTICE 'Pas negatif : refuse bruyamment';
  END;

  -- ---------- L'axe terrain de la bitemporalite ----------
  --
  -- On clot la portion BON de [120, 400) au 01/06/2026 et on en ajoute une version MAUVAIS
  -- valide a partir de cette date. Interrogee avant, la section 2 doit dire BON ; apres,
  -- MAUVAIS. C'est la propriete que `valideDu`/`valideAu` existent pour servir.
  UPDATE portions SET "valideDu" = DATE '2026-01-01', "valideAu" = DATE '2026-06-01'
   WHERE id = 'p-sf-2';
  INSERT INTO portions (id, "tronconId", "debutM", "finM", etat, revetement, origine,
                        "statutValidation", "creeParId", "valideDu", "updatedAt")
  VALUES ('p-sf-2b', 't-test-sf', 120, 400, 'TEST_MAUVAIS', 'TEST_ENROBE', 'IMPORT',
          'VALIDE', 'u-test-sf', DATE '2026-06-01', CURRENT_TIMESTAMP);

  SELECT etat INTO v_etat FROM reseau_sections_fixes(100, ARRAY['t-test-sf'], DATE '2026-03-01')
   WHERE "indexSection" = 2;
  IF v_etat IS DISTINCT FROM 'TEST_BON' THEN
    RAISE EXCEPTION 'Bitemporel ECHEC au 01/03 : etat % au lieu de TEST_BON', v_etat;
  END IF;

  SELECT etat INTO v_etat FROM reseau_sections_fixes(100, ARRAY['t-test-sf'], DATE '2026-09-01')
   WHERE "indexSection" = 2;
  IF v_etat IS DISTINCT FROM 'TEST_MAUVAIS' THEN
    RAISE EXCEPTION 'Bitemporel ECHEC au 01/09 : etat % au lieu de TEST_MAUVAIS', v_etat;
  END IF;
  RAISE NOTICE 'Bitemporel : section 2 rend BON au 01/03 et MAUVAIS au 01/09';

  -- ---------- CONTRE-EPREUVE : la contrainte refuse encore un vrai doublon ----------
  --
  -- Les deux insertions ci-dessus prouvent que la contrainte corrigee ACCEPTE deux versions
  -- disjointes dans le temps. Elles ne prouvent pas qu'elle refuse encore quoi que ce soit --
  -- supprimer purement la contrainte les ferait passer aussi.
  --
  -- On insere donc une troisieme version qui chevauche la seconde SUR LES DEUX AXES : meme
  -- emprise metrique, et une periode de terrain qui recouvre la sienne. Elle doit etre refusee.
  BEGIN
    INSERT INTO portions (id, "tronconId", "debutM", "finM", etat, revetement, origine,
                          "statutValidation", "creeParId", "valideDu", "updatedAt")
    VALUES ('p-sf-2c', 't-test-sf', 120, 400, 'TEST_MOYEN', 'TEST_ENROBE', 'IMPORT',
            'VALIDE', 'u-test-sf', DATE '2026-07-01', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'La contrainte aurait du refuser un chevauchement sur les deux axes';
  EXCEPTION
    WHEN exclusion_violation THEN
      RAISE NOTICE 'Contre-epreuve : un chevauchement sur les DEUX axes reste refuse';
  END;

  -- Et le cas symetrique : meme periode de terrain, emprise metrique chevauchante.
  BEGIN
    INSERT INTO portions (id, "tronconId", "debutM", "finM", etat, revetement, origine,
                          "statutValidation", "creeParId", "valideDu", "updatedAt")
    VALUES ('p-sf-2d', 't-test-sf', 300, 450, 'TEST_MOYEN', 'TEST_ENROBE', 'IMPORT',
            'VALIDE', 'u-test-sf', DATE '2026-09-01', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'La contrainte aurait du refuser un chevauchement metrique a date egale';
  EXCEPTION
    WHEN exclusion_violation THEN
      RAISE NOTICE 'Contre-epreuve : un chevauchement metrique a periode commune reste refuse';
  END;

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
