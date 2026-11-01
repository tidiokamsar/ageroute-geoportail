-- BANC D'ESSAI de l'Info Route et des bulletins (paragraphe 7.17, EX-05 et EX-06).
--
-- Ce qu'il prouve : la publication est en ajout seul et a l'heure du serveur ; elle cite un
-- evenement reel ; la sequence PUBLICATION -> MISE_A_JOUR -> RETRAIT est tenue en base ; la vue
-- publique ne montre que l'etat courant et valide ; un bulletin archive ne se retouche pas et
-- son empreinte est verifiee.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/info_route.test.sql
--
-- Transaction ANNULEE a la fin.

BEGIN;

INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-ir', 'ir@local.invalid', 'Fixture info route', 'fixture-sans-usage', 'GESTIONNAIRE', CURRENT_TIMESTAMP);
INSERT INTO main_courante (id, "evenementId", nature, "auteurId", "sourceCode", "typeCode", statut, texte, geom)
VALUES ('mc-1', 'ev-1', 'DECLARATION', 'u-ir', 'PATROUILLE', 'COUPURE', 'OUVERT', 'Radier submerge', ST_SetSRID(ST_MakePoint(-13.6, 9.64), 4326)),
       ('mc-2', 'ev-2', 'DECLARATION', 'u-ir', 'PATROUILLE', 'INONDATION', 'OUVERT', 'Eau sur la chaussee', ST_SetSRID(ST_MakePoint(-13.5, 9.7), 4326));

DO $t$
DECLARE nb integer; v text; b boolean; ts timestamp;
BEGIN
  -- ---------- Refus ----------
  BEGIN
    INSERT INTO publications_info_route (id, "evenementId", action, categorie, titre, "textePublic", "localisationPublique", "publieParId")
    VALUES ('p-x', 'ev-inconnu', 'PUBLICATION', 'COUPURE', 'Coupure', 'Route coupee', 'RN1 PK 45', 'u-ir');
    RAISE EXCEPTION 'Publication d''un evenement inconnu acceptee';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'Evenement inconnu REFUSE'; END;

  BEGIN
    INSERT INTO publications_info_route (id, "evenementId", action, categorie, titre, "textePublic", "localisationPublique", "publieParId")
    VALUES ('p-x', 'ev-1', 'MISE_A_JOUR', 'COUPURE', 'Coupure', 'Route coupee', 'RN1 PK 45', 'u-ir');
    RAISE EXCEPTION 'Mise a jour sans publication acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'MISE_A_JOUR avant PUBLICATION REFUSEE'; END;

  BEGIN
    INSERT INTO publications_info_route (id, "evenementId", action, categorie, titre, "textePublic", "publieParId")
    VALUES ('p-x', 'ev-1', 'PUBLICATION', 'COUPURE', 'Coupure', 'Route coupee', 'u-ir');
    RAISE EXCEPTION 'Publication sans localisation acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Publication sans localisation REFUSEE'; END;

  BEGIN
    INSERT INTO publications_info_route (id, "evenementId", action, categorie, titre, "textePublic", "localisationPublique", "publieParId")
    VALUES ('p-x', 'ev-1', 'PUBLICATION', 'DEVIATION', 'Deviation', 'Deviation en place', 'RN1 PK 45', 'u-ir');
    RAISE EXCEPTION 'Deviation sans itineraire acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Deviation sans itineraire REFUSEE'; END;

  BEGIN
    INSERT INTO publications_info_route (id, "evenementId", action, categorie, titre, "textePublic", "localisationPublique", "publieParId")
    VALUES ('p-x', 'ev-1', 'PUBLICATION', 'FERMETURE', 'X', 'X', 'X', 'u-ir');
    RAISE EXCEPTION 'Categorie hors liste acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Categorie hors liste REFUSEE'; END;

  -- ---------- Un niveau non approuve ne se publie pas ----------
  BEGIN
    INSERT INTO publications_info_route (id, "evenementId", action, categorie, "praticabiliteCode", titre, "textePublic", "localisationPublique", "publieParId")
    VALUES ('p-x', 'ev-1', 'PUBLICATION', 'COUPURE', 'P4', 'RN1 coupee', 'Radier submerge.', 'RN1, PK 45', 'u-ir');
    RAISE EXCEPTION 'Niveau P4 non approuve publie';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Niveau P4 NON APPROUVE : publication REFUSEE'; END;

  -- Contre-epreuve : approbation accordee DANS CETTE TRANSACTION ANNULEE, pour eprouver le
  -- chemin d'acceptation. Aucune approbation ne survit au banc.
  UPDATE referentiel_praticabilites SET "approuveeLe" = CURRENT_TIMESTAMP, "approuveeParId" = 'u-ir' WHERE code = 'P4';

  -- ---------- Publication, heure serveur ----------
  INSERT INTO publications_info_route (id, "evenementId", action, categorie, "praticabiliteCode", titre, "textePublic", "localisationPublique", "publieParId", "publieLe")
  VALUES ('p-1', 'ev-1', 'PUBLICATION', 'COUPURE', 'P4', 'RN1 coupee a Kindia', 'Radier submerge, passage impossible.', 'RN1, PK 45, Kindia', 'u-ir', '2020-01-01');
  SELECT "publieLe" INTO ts FROM publications_info_route WHERE id = 'p-1';
  IF ts < CURRENT_TIMESTAMP - interval '1 minute' THEN RAISE EXCEPTION 'publieLe antidate conserve : %', ts; END IF;
  RAISE NOTICE 'Publication acceptee, publieLe pose par le serveur (antidatage ignore)';

  BEGIN
    INSERT INTO publications_info_route (id, "evenementId", action, categorie, titre, "textePublic", "localisationPublique", "publieParId")
    VALUES ('p-x', 'ev-1', 'PUBLICATION', 'COUPURE', 'Bis', 'Bis', 'Bis', 'u-ir');
    RAISE EXCEPTION 'Seconde publication du meme evenement acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Seconde PUBLICATION REFUSEE'; END;

  SELECT count(*), bool_and("niveauApprouve") INTO nb, b FROM info_route_courante WHERE "evenementId" = 'ev-1';
  IF nb <> 1 OR NOT b THEN RAISE EXCEPTION 'Vue : 1 ligne, niveau approuve attendus (recu %, %)', nb, b; END IF;
  -- Approbation retiree apres coup : la vue le dit au lieu de le taire.
  UPDATE referentiel_praticabilites SET "approuveeLe" = NULL, "approuveeParId" = NULL WHERE code = 'P4';
  SELECT "niveauApprouve" INTO b FROM info_route_courante WHERE "evenementId" = 'ev-1';
  IF b THEN RAISE EXCEPTION 'Vue : approbation retiree non signalee'; END IF;
  UPDATE referentiel_praticabilites SET "approuveeLe" = CURRENT_TIMESTAMP, "approuveeParId" = 'u-ir' WHERE code = 'P4';
  RAISE NOTICE 'Vue publique : l''evenement apparait ; une approbation retiree se voit (niveauApprouve faux)';

  -- ---------- Ajout seul ----------
  BEGIN
    UPDATE publications_info_route SET titre = 'retouche' WHERE id = 'p-1';
    RAISE EXCEPTION 'UPDATE accepte';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'UPDATE REFUSE'; END;
  BEGIN
    DELETE FROM publications_info_route WHERE id = 'p-1';
    RAISE EXCEPTION 'DELETE accepte';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'DELETE REFUSE'; END;

  -- ---------- Mise a jour : la vue rend la derniere ligne ----------
  INSERT INTO publications_info_route (id, "evenementId", action, categorie, "praticabiliteCode", titre, "textePublic", "localisationPublique", deviation, "publieParId")
  VALUES ('p-2', 'ev-1', 'MISE_A_JOUR', 'DEVIATION', 'P4', 'RN1 coupee, deviation par Friguiagbe', 'Deviation balisee.', 'RN1, PK 45, Kindia', 'Par la RN6 via Friguiagbe', 'u-ir');
  SELECT categorie INTO v FROM info_route_courante WHERE "evenementId" = 'ev-1';
  IF v <> 'DEVIATION' THEN RAISE EXCEPTION 'La vue ne rend pas la mise a jour (recu %)', v; END IF;
  SELECT count(*) INTO nb FROM publications_info_route WHERE "evenementId" = 'ev-1';
  IF nb <> 2 THEN RAISE EXCEPTION 'La publication initiale a disparu'; END IF;
  RAISE NOTICE 'MISE_A_JOUR : la vue rend la derniere, la premiere reste au journal';

  -- ---------- Validite expiree : hors de la vue ----------
  INSERT INTO publications_info_route (id, "evenementId", action, categorie, titre, "textePublic", "localisationPublique", "publieParId", "debutValidite", "finValidite")
  VALUES ('p-3', 'ev-2', 'PUBLICATION', 'RESTRICTION', 'Poids lourds interdits', 'Chaussee inondee.', 'RN3, PK 12', 'u-ir', '2020-01-01', '2020-01-02');
  SELECT count(*) INTO nb FROM info_route_courante WHERE "evenementId" = 'ev-2';
  IF nb <> 0 THEN RAISE EXCEPTION 'Une publication expiree est encore dans la vue'; END IF;
  RAISE NOTICE 'Publication expiree : absente de la vue, presente au journal';

  -- ---------- Retrait, puis republication ----------
  INSERT INTO publications_info_route (id, "evenementId", action, "publieParId") VALUES ('p-4', 'ev-1', 'RETRAIT', 'u-ir');
  SELECT count(*) INTO nb FROM info_route_courante WHERE "evenementId" = 'ev-1';
  IF nb <> 0 THEN RAISE EXCEPTION 'Un evenement retire est encore dans la vue'; END IF;
  BEGIN
    INSERT INTO publications_info_route (id, "evenementId", action, "publieParId") VALUES ('p-x', 'ev-1', 'RETRAIT', 'u-ir');
    RAISE EXCEPTION 'Double retrait accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Double RETRAIT REFUSE'; END;
  INSERT INTO publications_info_route (id, "evenementId", action, categorie, titre, "textePublic", "localisationPublique", "publieParId")
  VALUES ('p-5', 'ev-1', 'PUBLICATION', 'COUPURE', 'RN1 de nouveau coupee', 'Nouvelle crue.', 'RN1, PK 45, Kindia', 'u-ir');
  SELECT count(*) INTO nb FROM info_route_courante WHERE "evenementId" = 'ev-1';
  IF nb <> 1 THEN RAISE EXCEPTION 'Republication apres retrait absente de la vue'; END IF;
  RAISE NOTICE 'RETRAIT retire de la vue ; une PUBLICATION apres retrait rouvre';

  -- ---------- Bulletins ----------
  BEGIN
    INSERT INTO bulletins_routiers (id, numero, jour, "situationA", "genereParId", gabarit, texte, "empreinteSha256")
    VALUES ('b-x', 'BR-X', CURRENT_DATE, CURRENT_TIMESTAMP, 'u-ir', 'v1', 'Bulletin', repeat('0', 64));
    RAISE EXCEPTION 'Empreinte fausse acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Bulletin a empreinte fausse REFUSE'; END;

  INSERT INTO bulletins_routiers (id, numero, jour, "situationA", "genereParId", gabarit, texte, "empreinteSha256", "publicationsIds")
  VALUES ('b-1', 'BR-20261019-1', CURRENT_DATE, CURRENT_TIMESTAMP, 'u-ir', 'v1', 'Bulletin du jour : RN1 coupée.',
          encode(sha256(convert_to('Bulletin du jour : RN1 coupée.', 'UTF8')), 'hex'), ARRAY['p-5']);
  RAISE NOTICE 'Bulletin a empreinte exacte (texte accentue) accepte';
  BEGIN
    UPDATE bulletins_routiers SET texte = 'retouche' WHERE id = 'b-1';
    RAISE EXCEPTION 'Bulletin retouche';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Bulletin : UPDATE REFUSE'; END;
  BEGIN
    DELETE FROM bulletins_routiers WHERE id = 'b-1';
    RAISE EXCEPTION 'Bulletin efface';
  EXCEPTION WHEN integrity_constraint_violation THEN RAISE NOTICE 'Bulletin : DELETE REFUSE'; END;

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
