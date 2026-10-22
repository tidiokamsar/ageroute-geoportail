-- BANC D'ESSAI de la cellule de veille (paragraphe 7.17, EX-04).
--
-- Ce qu'il prouve : les bornes des astreintes et des regles ; une seule regle active par
-- cas ; le journal des escalades et celui des modes sont en ajout seul, a l'heure du
-- serveur, une escalade par (evenement, niveau).
--
-- CE QUE CE BANC N'ASSERT PLUS, ET POURQUOI (22/10) : « aucune regle ni astreinte semee ».
-- Cette assertion etait vraie tant qu'aucun ecran ne savait creer de regle ; le
-- deploiement du 21/10 a livre l'ecran de configuration, et une regle saisie par un
-- gestionnaire d'AGEROUTE a fait echouer le banc sur la copie de PRODUCTION — des
-- donnees legitimes ne doivent pas bloquer un deploiement. La non-semination par les
-- migrations reste etablie ailleurs : aucune migration ne contient d'INSERT vers ces
-- tables (verifiable par grep, et le banc sur base de rejeu vierge les trouve vides).
-- Sur une base vivante, l'invariant VERIFIABLE est celui que l'index partiel impose :
-- au plus UNE regle ACTIVE par (type, mode, niveau).
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/cellule_veille.test.sql
--
-- Transaction ANNULEE a la fin.

BEGIN;

DO $t$
DECLARE nb integer; ts timestamp;
BEGIN
  SELECT count(*) INTO nb FROM (
    SELECT "typeCode", mode, niveau FROM regles_escalade WHERE actif
    GROUP BY 1, 2, 3 HAVING count(*) > 1
  ) d;
  IF nb <> 0 THEN RAISE EXCEPTION '% regle(s) active(s) en doublon par (type, mode, niveau)', nb; END IF;
  RAISE NOTICE 'Aucune regle active dupliquee ; astreintes et regles existantes respectent l''invariant';
END;
$t$;

INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-cv', 'cv@local.invalid', 'Fixture veille', 'fixture-sans-usage', 'GESTIONNAIRE', CURRENT_TIMESTAMP);
INSERT INTO main_courante (id, "evenementId", nature, "auteurId", "sourceCode", "typeCode", statut, texte, geom)
VALUES ('mc-cv', 'ev-cv', 'DECLARATION', 'u-cv', 'PATROUILLE', 'COUPURE', 'OUVERT', 'Radier', ST_SetSRID(ST_MakePoint(-13.6, 9.64), 4326));

DO $t$
DECLARE nb integer; ts timestamp;
BEGIN
  BEGIN
    INSERT INTO astreintes (id, "userId", niveau, debut, fin, "creeParId") VALUES ('a-x', 'u-cv', 1, '2026-10-20', '2026-10-19', 'u-cv');
    RAISE EXCEPTION 'Astreinte a periode inversee acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Astreinte a periode inversee REFUSEE'; END;
  BEGIN
    INSERT INTO astreintes (id, "userId", niveau, debut, fin, "creeParId") VALUES ('a-x', 'u-cv', 0, '2026-10-19', '2026-10-20', 'u-cv');
    RAISE EXCEPTION 'Astreinte niveau 0 acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Astreinte niveau 0 REFUSEE'; END;
  INSERT INTO astreintes (id, "userId", niveau, debut, fin, "creeParId") VALUES ('a-1', 'u-cv', 1, '2026-10-19', '2026-10-20', 'u-cv');

  BEGIN
    INSERT INTO regles_escalade (id, "typeCode", mode, niveau, "delaiMinutes", "creeParId") VALUES ('r-x', 'COUPURE', 'NORMAL', 1, 0, 'u-cv');
    RAISE EXCEPTION 'Delai 0 accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Regle a delai 0 REFUSEE'; END;
  BEGIN
    INSERT INTO regles_escalade (id, "typeCode", mode, niveau, "delaiMinutes", "creeParId") VALUES ('r-x', 'COUPURE', 'HIVER', 1, 30, 'u-cv');
    RAISE EXCEPTION 'Mode hors liste accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Regle a mode hors liste REFUSEE'; END;

  -- Delais SAISIS PAR LE TEST, pour eprouver le mecanisme.
  INSERT INTO regles_escalade (id, "typeCode", mode, niveau, "delaiMinutes", "creeParId") VALUES ('r-1', 'COUPURE', 'NORMAL', 1, 30, 'u-cv');
  INSERT INTO regles_escalade (id, "typeCode", mode, niveau, "delaiMinutes", "creeParId") VALUES ('r-2', NULL, 'NORMAL', 1, 60, 'u-cv');
  BEGIN
    INSERT INTO regles_escalade (id, "typeCode", mode, niveau, "delaiMinutes", "creeParId") VALUES ('r-x', 'COUPURE', 'NORMAL', 1, 45, 'u-cv');
    RAISE EXCEPTION 'Deux regles actives pour le meme cas acceptees';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'Seconde regle active pour (COUPURE, NORMAL, 1) REFUSEE'; END;
  BEGIN
    INSERT INTO regles_escalade (id, "typeCode", mode, niveau, "delaiMinutes", "creeParId") VALUES ('r-x', NULL, 'NORMAL', 1, 45, 'u-cv');
    RAISE EXCEPTION 'Deux regles « tous types » actives acceptees';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'Seconde regle tous types REFUSEE (NULL compte comme une valeur)'; END;
  INSERT INTO regles_escalade (id, "typeCode", mode, niveau, "delaiMinutes", actif, "creeParId") VALUES ('r-3', 'COUPURE', 'NORMAL', 1, 45, false, 'u-cv');
  RAISE NOTICE 'Une regle inactive pour le meme cas est admise (historique)';

  -- ---------- Escalades ----------
  BEGIN
    INSERT INTO escalades (id, "evenementId", niveau, "regleId", "modeVeille", "evalueeParId") VALUES ('e-x', 'ev-inconnu', 1, 'r-1', 'NORMAL', 'u-cv');
    RAISE EXCEPTION 'Escalade d''un evenement inconnu acceptee';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'Escalade d''un evenement inconnu REFUSEE'; END;

  INSERT INTO escalades (id, "evenementId", niveau, "regleId", "astreinteId", "destinataireId", "modeVeille", "evalueeParId", "declencheeLe")
  VALUES ('e-1', 'ev-cv', 1, 'r-1', 'a-1', 'u-cv', 'NORMAL', 'u-cv', '2020-01-01');
  SELECT "declencheeLe" INTO ts FROM escalades WHERE id = 'e-1';
  IF ts < CURRENT_TIMESTAMP - interval '1 minute' THEN RAISE EXCEPTION 'declencheeLe antidate conserve'; END IF;
  RAISE NOTICE 'Escalade inscrite a l''heure du serveur';

  BEGIN
    INSERT INTO escalades (id, "evenementId", niveau, "regleId", "modeVeille", "evalueeParId") VALUES ('e-2', 'ev-cv', 1, 'r-2', 'NORMAL', 'u-cv');
    RAISE EXCEPTION 'Double escalade au meme niveau acceptee';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'Seconde escalade au niveau 1 REFUSEE'; END;

  -- Sans destinataire : un trou de permanence, inscrit et non masque.
  INSERT INTO escalades (id, "evenementId", niveau, "regleId", "modeVeille", "evalueeParId") VALUES ('e-3', 'ev-cv', 2, 'r-2', 'NORMAL', 'u-cv');
  RAISE NOTICE 'Escalade sans personne d''astreinte : inscrite';

  BEGIN
    UPDATE escalades SET niveau = 3 WHERE id = 'e-1';
    RAISE EXCEPTION 'UPDATE d''escalade accepte';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Escalades : UPDATE REFUSE'; END;
  BEGIN
    DELETE FROM escalades WHERE id = 'e-1';
    RAISE EXCEPTION 'DELETE d''escalade accepte';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Escalades : DELETE REFUSE'; END;

  -- ---------- Modes ----------
  BEGIN
    INSERT INTO modes_veille (id, mode, motif, "declareParId") VALUES ('mv-x', 'SAISON_PLUIES', '  ', 'u-cv');
    RAISE EXCEPTION 'Mode sans motif accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Mode sans motif REFUSE'; END;
  INSERT INTO modes_veille (id, mode, motif, "declareParId") VALUES ('mv-1', 'SAISON_PLUIES', 'Premieres crues en Guinee forestiere', 'u-cv');
  INSERT INTO modes_veille (id, mode, motif, "declareParId") VALUES ('mv-2', 'NORMAL', 'Fin des crues', 'u-cv');
  SELECT count(*) INTO nb FROM (SELECT mode FROM modes_veille ORDER BY rang DESC LIMIT 1) d WHERE d.mode = 'NORMAL';
  IF nb <> 1 THEN RAISE EXCEPTION 'Le mode courant n''est pas la derniere declaration'; END IF;
  BEGIN
    UPDATE modes_veille SET mode = 'SAISON_PLUIES' WHERE id = 'mv-2';
    RAISE EXCEPTION 'UPDATE de mode accepte';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Modes : UPDATE REFUSE ; le courant est la derniere declaration'; END;

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
