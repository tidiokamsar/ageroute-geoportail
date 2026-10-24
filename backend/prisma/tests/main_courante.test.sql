-- BANC D'ESSAI de la main courante (paragraphe 7.17, EX-01) et de la praticabilite P1-P4.
--
-- Ce qu'il prouve : l'AJOUT SEUL est tenu par la base -- UPDATE et DELETE refuses, heure du
-- serveur imposee -- ; un evenement est une chaine d'entrees dont la vue rend l'etat courant ;
-- une rectification cite ce qu'elle corrige et les deux restent ; les quatre niveaux P1-P4
-- sont semes, provisoires, non approuves.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 \
--     -f - < backend/prisma/tests/main_courante.test.sql
--
-- Transaction ANNULEE a la fin.

BEGIN;

INSERT INTO regions (nom) VALUES ('Region de test main courante');
INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-mc', 'mc@local.invalid', 'Fixture exploitation', 'fixture-sans-usage', 'GESTIONNAIRE', CURRENT_TIMESTAMP);
INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", "updatedAt")
VALUES ('t-mc', 'TEST-MC-1', 'Troncon de test main courante', 'RN',
        (SELECT id FROM regions WHERE nom = 'Region de test main courante'), 10, 'LATERITE', 0, 10, CURRENT_TIMESTAMP);

DO $t$
DECLARE
  nb integer;
  v_statut text;
  v_heure timestamp;
BEGIN
  -- ---------- P1-P4 : semes, provisoires, non approuves ----------
  SELECT count(*) INTO nb FROM referentiel_praticabilites WHERE code IN ('P1','P2','P3','P4');
  IF nb <> 4 THEN RAISE EXCEPTION 'P1-P4 : % lignes semees au lieu de 4', nb; END IF;
  SELECT count(*) INTO nb FROM referentiel_praticabilites WHERE "approuveeLe" IS NOT NULL OR "approuveeParId" IS NOT NULL;
  IF nb <> 0 THEN RAISE EXCEPTION 'P1-P4 : % niveaux approuves au semis', nb; END IF;
  SELECT count(*) INTO nb FROM referentiel_praticabilites WHERE code = 'P4' AND NOT franchissable;
  IF nb <> 1 THEN RAISE EXCEPTION 'P4 devrait etre le seul niveau non franchissable'; END IF;
  SELECT count(*) INTO nb FROM referentiel_praticabilites WHERE source <> 'mandat_v10_proposition';
  IF nb <> 0 THEN RAISE EXCEPTION '% niveaux sans la source du mandat', nb; END IF;
  RAISE NOTICE 'P1-P4 : quatre niveaux semes, source mandat_v10_proposition, aucun approuve, P4 seul non franchissable';

  -- Une portion peut porter un niveau : le mecanisme est eprouvable sans qu'il fasse foi.
  INSERT INTO portions (id, "tronconId", "debutM", "finM", praticabilite, "praticabiliteCause", origine, "creeParId", "updatedAt")
  VALUES ('p-mc', 't-mc', 0, 500, 'P4', 'radier submerge', 'SAISIE_TERRAIN', 'u-mc', CURRENT_TIMESTAMP);
  RAISE NOTICE 'Une portion porte P4 (proposition A_VALIDER) : le mecanisme fonctionne, le niveau ne fait pas foi';

  -- ---------- Main courante : une declaration ouvre un evenement ----------
  INSERT INTO main_courante (id, "evenementId", nature, "horodatageClient", "auteurId", "sourceCode", "typeCode", statut, texte, "tronconId", "debutM", "finM")
  VALUES ('e1-d', 'ev-1', 'DECLARATION', TIMESTAMP '2026-10-15 06:12:00', 'u-mc', 'PATROUILLE', 'COUPURE', 'OUVERT',
          'Radier submerge au PK 3, circulation coupee dans les deux sens.', 't-mc', 2800, 3200);
  SELECT "enregistreLe" INTO v_heure FROM main_courante WHERE id = 'e1-d';
  IF abs(extract(epoch from (v_heure - CURRENT_TIMESTAMP))) > 5 THEN
    RAISE EXCEPTION 'enregistreLe devrait etre l''heure du serveur, recu %', v_heure;
  END IF;
  RAISE NOTICE 'Declaration enregistree ; enregistreLe = heure du serveur, horodatageClient conserve a part (06:12)';

  -- ---------- Immutabilite : UPDATE et DELETE refuses ----------
  BEGIN
    UPDATE main_courante SET texte = 'texte modifie' WHERE id = 'e1-d';
    RAISE EXCEPTION 'IMMUTABILITE ECHEC : un UPDATE a ete accepte';
  EXCEPTION WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'UPDATE REFUSE : la main courante est en ajout seul';
  END;
  BEGIN
    DELETE FROM main_courante WHERE id = 'e1-d';
    RAISE EXCEPTION 'IMMUTABILITE ECHEC : un DELETE a ete accepte';
  EXCEPTION WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'DELETE REFUSE : rien ne s''efface, on rectifie';
  END;

  -- ---------- L'heure du serveur ne se declare pas ----------
  BEGIN
    INSERT INTO main_courante (id, "evenementId", nature, "enregistreLe", "auteurId", texte)
    VALUES ('e1-x', 'ev-1', 'COMPLEMENT', TIMESTAMP '2020-01-01 00:00:00', 'u-mc', 'entree antidatee');
    RAISE EXCEPTION 'Une entree antidatee a ete acceptee';
  EXCEPTION WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'Entree antidatee REFUSEE : enregistreLe est pose par le serveur';
  END;

  -- ---------- Une seule declaration par evenement ----------
  BEGIN
    INSERT INTO main_courante (id, "evenementId", nature, "auteurId", "sourceCode", "typeCode", statut, texte, "tronconId")
    VALUES ('e1-d2', 'ev-1', 'DECLARATION', 'u-mc', 'CITOYEN', 'COUPURE', 'OUVERT', 'seconde declaration du meme evenement', 't-mc');
    RAISE EXCEPTION 'Deux declarations pour un meme evenement ont ete acceptees';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'Seconde declaration REFUSEE : un evenement n''est declare qu''une fois';
  END;

  -- ---------- Coherence des natures ----------
  BEGIN
    INSERT INTO main_courante (id, "evenementId", nature, "auteurId", texte)
    VALUES ('e1-s0', 'ev-1', 'STATUT', 'u-mc', 'statut sans statut');
    RAISE EXCEPTION 'Une entree STATUT sans statut a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Entree STATUT sans statut REFUSEE';
  END;
  BEGIN
    INSERT INTO main_courante (id, "evenementId", nature, "auteurId", texte)
    VALUES ('e1-r0', 'ev-1', 'RECTIFICATION', 'u-mc', 'rectification sans cible');
    RAISE EXCEPTION 'Une rectification sans entree citee a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Rectification sans entree citee REFUSEE';
  END;
  BEGIN
    INSERT INTO main_courante (id, "evenementId", nature, "auteurId", "sourceCode", "typeCode", statut, texte)
    VALUES ('e9-d', 'ev-9', 'DECLARATION', 'u-mc', 'PATROUILLE', 'ACCIDENT', 'OUVERT', 'declaration sans lieu');
    RAISE EXCEPTION 'Une declaration sans troncon ni point a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Declaration non localisee REFUSEE';
  END;

  -- ---------- Le cycle de vie par entrees, et la vue qui le lit ----------
  SELECT statut INTO v_statut FROM evenements_exploitation WHERE "evenementId" = 'ev-1';
  IF v_statut <> 'OUVERT' THEN RAISE EXCEPTION 'Statut initial % au lieu de OUVERT', v_statut; END IF;

  PERFORM pg_sleep(0.01);
  INSERT INTO main_courante (id, "evenementId", nature, "auteurId", statut, texte)
  VALUES ('e1-s1', 'ev-1', 'STATUT', 'u-mc', 'PRIS_EN_COMPTE', 'Patrouille de verification depechee.');
  PERFORM pg_sleep(0.01);
  INSERT INTO main_courante (id, "evenementId", nature, "auteurId", texte, pieces)
  VALUES ('e1-c1', 'ev-1', 'COMPLEMENT', 'u-mc', 'Photo du radier.', '[{"chemin":"mc/ev-1/radier.jpg","sha256":"0000"}]'::jsonb);
  PERFORM pg_sleep(0.01);
  INSERT INTO main_courante (id, "evenementId", nature, "auteurId", statut, texte)
  VALUES ('e1-s2', 'ev-1', 'STATUT', 'u-mc', 'CLOS', 'Niveau baisse, circulation retablie.');

  SELECT statut INTO v_statut FROM evenements_exploitation WHERE "evenementId" = 'ev-1';
  IF v_statut <> 'CLOS' THEN RAISE EXCEPTION 'Statut courant % au lieu de CLOS', v_statut; END IF;
  SELECT "nbEntrees" INTO nb FROM evenements_exploitation WHERE "evenementId" = 'ev-1';
  IF nb <> 4 THEN RAISE EXCEPTION '% entrees comptees au lieu de 4', nb; END IF;
  IF (SELECT "delaiPriseEnCompte" FROM evenements_exploitation WHERE "evenementId" = 'ev-1') IS NULL THEN
    RAISE EXCEPTION 'Le delai de prise en compte devrait etre calcule';
  END IF;
  RAISE NOTICE 'Cycle OUVERT -> PRIS_EN_COMPTE -> CLOS lu par la vue : 4 entrees, delai de prise en compte calcule';

  -- ---------- Rectification : l'entree fautive reste ----------
  INSERT INTO main_courante (id, "evenementId", nature, "auteurId", texte, "rectifieId")
  VALUES ('e1-r1', 'ev-1', 'RECTIFICATION', 'u-mc', 'Le PK exact est 3+150, non 3+000.', 'e1-d');
  SELECT count(*) INTO nb FROM main_courante WHERE id = 'e1-d';
  IF nb <> 1 THEN RAISE EXCEPTION 'L''entree rectifiee a disparu'; END IF;
  SELECT "nbRectifications" INTO nb FROM evenements_exploitation WHERE "evenementId" = 'ev-1';
  IF nb <> 1 THEN RAISE EXCEPTION '% rectifications comptees au lieu de 1', nb; END IF;
  RAISE NOTICE 'Rectification enregistree ; l''entree corrigee reste, la vue compte 1 rectification';

  -- ---------- Vocabulaires semes ----------
  SELECT count(*) INTO nb FROM referentiel_types_evenement WHERE source = 'mandat_v10';
  IF nb <> 10 THEN RAISE EXCEPTION '% types d''evenement au lieu de 10', nb; END IF;
  SELECT count(*) INTO nb FROM referentiel_sources_evenement WHERE source = 'mandat_v10';
  IF nb <> 4 THEN RAISE EXCEPTION '% sources au lieu de 4', nb; END IF;
  RAISE NOTICE 'Dix types et quatre sources, ceux du paragraphe 7.17, en tables administrables';

  -- ---------- Ordre total a heure egale (correctif 20261019030000) ----------
  -- Dans CETTE transaction, CURRENT_TIMESTAMP est fige : la declaration et son PRIS_EN_COMPTE
  -- portent la meme heure serveur. Le statut courant doit etre le second, toujours. On repete
  -- vingt fois : avec l'ancien ordre (uuid aleatoire), la moitie environ des essais echouait.
  FOR i IN 1..20 LOOP
    INSERT INTO main_courante (id, "evenementId", nature, "auteurId", "sourceCode", "typeCode", statut, texte, geom)
    VALUES (gen_random_uuid()::text, 'ev-ordre-' || i, 'DECLARATION', (SELECT id FROM users LIMIT 1), 'PATROUILLE', 'COUPURE', 'OUVERT', 'x',
            ST_SetSRID(ST_MakePoint(-13.6, 9.64), 4326));
    INSERT INTO main_courante (id, "evenementId", nature, "auteurId", statut, texte)
    VALUES (gen_random_uuid()::text, 'ev-ordre-' || i, 'STATUT', (SELECT id FROM users LIMIT 1), 'PRIS_EN_COMPTE', 'vu');
  END LOOP;
  SELECT count(*) INTO nb FROM evenements_exploitation WHERE "evenementId" LIKE 'ev-ordre-%' AND statut <> 'PRIS_EN_COMPTE';
  IF nb <> 0 THEN RAISE EXCEPTION 'A heure egale, % evenement(s) sur 20 rendus avec un statut anterieur', nb; END IF;
  RAISE NOTICE 'A heure serveur egale, le statut courant est la derniere entree inseree (20 sur 20)';

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
