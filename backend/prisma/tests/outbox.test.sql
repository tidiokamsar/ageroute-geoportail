-- BANC D'ESSAI des garanties de `outbox_evenements` et `outbox_tentatives` (A13, 7.10, 7.15).
--
-- Ce qu'il prouve : que LA BASE refuse, quel que soit le code appelant, (1) l'inscription d'une
-- donnee non validee, supprimee ou remplacee ; (2) une cle d'idempotence ou une empreinte qui ne
-- seraient pas les bonnes ; (3) toute transition hors de la machine a etats ; (4) la
-- modification d'un evenement ENVOYE ; (5) la suppression ; (6) toute modification du journal des
-- tentatives. Chaque refus a sa contre-epreuve : sans elle, une contrainte qui refuserait tout
-- ferait passer le test.
--
-- Ce qu'il ne prouve PAS : quoi que ce soit sur DigitalRoad, SharePoint ou la BDR / L2R. Aucun
-- n'est atteint ; le comportement du service applicatif est mesure par les tests Vitest et par
-- tests-integration/outbox.integration.mts, contre des simulateurs ecrits par AGEROUTE.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 \
--     -f - < backend/prisma/tests/outbox.test.sql
--
-- Transaction ANNULEE a la fin : rien de durable n'est ecrit.

BEGIN;

INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-obx', 'obx@local.invalid', 'Fixture outbox', 'fixture-sans-usage', 'ADMIN', CURRENT_TIMESTAMP);
INSERT INTO regions (nom) VALUES ('Region outbox');

-- Troncons : VALIDE, A_VALIDER, REJETE, A_CORRIGER, supprime, sans statut.
INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", "statutValidation", "deletedAt", "updatedAt")
SELECT v.id, v.code, 'Troncon ' || v.code, 'RN', (SELECT id FROM regions WHERE nom = 'Region outbox'), 1.0, 'BITUME', 0, 1,
       v.statut::"StatutValidation", v.supprime::timestamp, CURRENT_TIMESTAMP
  FROM (VALUES
    ('t-ok',  'OBX-OK',  'VALIDE',     NULL),
    ('t-av',  'OBX-AV',  'A_VALIDER',  NULL),
    ('t-rej', 'OBX-REJ', 'REJETE',     NULL),
    ('t-cor', 'OBX-COR', 'A_CORRIGER', NULL),
    ('t-sup', 'OBX-SUP', 'VALIDE',     '2026-10-01 00:00:00'),
    ('t-nul', 'OBX-NUL', NULL,         NULL)
  ) AS v(id, code, statut, supprime);

INSERT INTO portions (id, "tronconId", "debutM", "finM", "statutValidation", origine, "remplaceeLe", "creeParId", "updatedAt")
VALUES ('p-ok',  't-ok', 0, 100, 'VALIDE', 'SAISIE_TERRAIN', NULL, 'u-obx', CURRENT_TIMESTAMP),
       ('p-rem', 't-ok', 100, 200, 'VALIDE', 'SAISIE_TERRAIN', '2026-10-02 00:00:00', 'u-obx', CURRENT_TIMESTAMP);

INSERT INTO bulletins_routiers (id, numero, jour, "situationA", "genereParId", gabarit, texte, "empreinteSha256")
VALUES ('b-ok', 'BR-OBX-1', '2026-10-24', '2026-10-24 06:00:00', 'u-obx', 'v1', 'Bulletin de fixture',
        encode(sha256(convert_to('Bulletin de fixture', 'UTF8')), 'hex'));

-- Insere un evenement en calculant l'empreinte et la cle comme le fait l'application.
CREATE FUNCTION pg_temp.obx_inserer(p_id text, p_dest text, p_type text, p_stype text, p_sid text, p_charge text)
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO outbox_evenements (id, destination, "typeEvenement", "sourceType", "sourceId", "cleIdempotence",
                                 "chargeCanonique", "empreinteCharge", "creeParId")
  VALUES (p_id, p_dest, p_type, p_stype, p_sid,
          encode(sha256(convert_to(p_dest || '|' || p_type || '|' || p_stype || '|' || p_sid || '|'
                 || encode(sha256(convert_to(p_charge, 'UTF8')), 'hex'), 'UTF8')), 'hex'),
          p_charge, encode(sha256(convert_to(p_charge, 'UTF8')), 'hex'), 'u-obx');
$f$;

-- Tente une insertion et rend ce qui s'est passe : 'ok' ou le SQLSTATE du refus.
CREATE FUNCTION pg_temp.obx_essayer(p_stype text, p_sid text, p_id text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_temp.obx_inserer(p_id, 'BDR_L2R', 'PIVOT_OBJET_VALIDE', p_stype, p_sid, '{"id":"' || p_sid || '"}');
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END
$f$;

DO $t$
DECLARE
  r text;
  v int;
  empreinte text := encode(sha256(convert_to('{"a":1}', 'UTF8')), 'hex');
BEGIN
  -- ---------- 1. SEULES LES DONNEES VALIDEES ENTRENT ----------
  FOREACH r IN ARRAY ARRAY['t-av', 't-rej', 't-cor', 't-sup', 't-nul', 't-inconnu'] LOOP
    IF pg_temp.obx_essayer('Troncon', r, 'x-' || r) <> '23514' THEN
      RAISE EXCEPTION 'ECHEC : le troncon % a ete accepte (ou refuse pour une autre raison : %)', r, pg_temp.obx_essayer('Troncon', r, 'y-' || r);
    END IF;
  END LOOP;
  RAISE NOTICE 'Troncon A_VALIDER, REJETE, A_CORRIGER, supprime, sans statut, inconnu : TOUS REFUSES (23514)';

  IF pg_temp.obx_essayer('Portion', 'p-rem', 'x-prem') <> '23514' THEN
    RAISE EXCEPTION 'ECHEC : une portion remplacee a ete acceptee';
  END IF;
  RAISE NOTICE 'Portion remplacee (version close) : REFUSEE';

  -- Contre-epreuves : les sources valides passent.
  IF pg_temp.obx_essayer('Troncon', 't-ok', 'e-t-ok') <> 'ok' THEN RAISE EXCEPTION 'CONTRE-EPREUVE : le troncon VALIDE a ete refuse'; END IF;
  IF pg_temp.obx_essayer('Portion', 'p-ok', 'e-p-ok') <> 'ok' THEN RAISE EXCEPTION 'CONTRE-EPREUVE : la portion VALIDE a ete refusee'; END IF;
  PERFORM pg_temp.obx_inserer('e-b-ok', 'SHAREPOINT', 'DEPOT_BULLETIN_ROUTIER', 'BulletinRoutier', 'b-ok', '{"numero":"BR-OBX-1"}');
  RAISE NOTICE 'Contre-epreuve : troncon VALIDE, portion VALIDE, bulletin archive acceptes';

  -- Aucune table de fiches : la fiche ne peut pas entrer.
  BEGIN
    PERFORM pg_temp.obx_inserer('x-fiche', 'DIGITALROAD', 'FICHE_INTERVENTION_PROGRAMMEE', 'FicheIntervention', 'f-1', '{"a":1}');
    RAISE EXCEPTION 'ECHEC : une fiche d''intervention a ete acceptee alors qu''aucune table n''existe';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Fiche d''intervention : REFUSEE (aucune table de fiches, D-07)';
  END;

  -- Une route non prevue (SharePoint ne recoit pas de troncon) est refusee par la contrainte.
  BEGIN
    PERFORM pg_temp.obx_inserer('x-route', 'SHAREPOINT', 'DEPOT_BULLETIN_ROUTIER', 'Troncon', 't-ok', '{"a":1}');
    RAISE EXCEPTION 'ECHEC : un troncon a ete route vers SharePoint';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Route non prevue (troncon vers SharePoint) : REFUSEE';
  END;

  -- ---------- 2. CLE ET EMPREINTE VERIFIEES ----------
  BEGIN
    INSERT INTO outbox_evenements (id, destination, "typeEvenement", "sourceType", "sourceId", "cleIdempotence",
                                   "chargeCanonique", "empreinteCharge", "creeParId")
    VALUES ('x-cle', 'BDR_L2R', 'PIVOT_OBJET_VALIDE', 'Troncon', 't-ok', repeat('a', 64), '{"a":1}', empreinte, 'u-obx');
    RAISE EXCEPTION 'ECHEC : une cle d''idempotence arbitraire a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Cle d''idempotence qui n''est pas le SHA-256 de (destination, type, source, empreinte) : REFUSEE';
  END;
  BEGIN
    INSERT INTO outbox_evenements (id, destination, "typeEvenement", "sourceType", "sourceId", "cleIdempotence",
                                   "chargeCanonique", "empreinteCharge", "creeParId")
    VALUES ('x-emp', 'BDR_L2R', 'PIVOT_OBJET_VALIDE', 'Troncon', 't-ok',
            encode(sha256(convert_to('BDR_L2R|PIVOT_OBJET_VALIDE|Troncon|t-ok|' || repeat('b', 64), 'UTF8')), 'hex'),
            '{"a":1}', repeat('b', 64), 'u-obx');
    RAISE EXCEPTION 'ECHEC : une empreinte qui n''est pas celle de la charge a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Empreinte qui n''est pas le SHA-256 de la charge : REFUSEE';
  END;

  -- ---------- 3. IDEMPOTENCE ET RANG ----------
  -- Le meme contenu, deux fois : la base refuse le second (23505).
  BEGIN
    PERFORM pg_temp.obx_inserer('e-t-ok-bis', 'BDR_L2R', 'PIVOT_OBJET_VALIDE', 'Troncon', 't-ok', '{"id":"t-ok"}');
    RAISE EXCEPTION 'ECHEC : le meme contenu s''est inscrit deux fois';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'Meme contenu, meme destination : second REFUSE (unique)';
  END;
  -- Un contenu different pour la meme source prend le rang suivant.
  PERFORM pg_temp.obx_inserer('e-t-ok-2', 'BDR_L2R', 'PIVOT_OBJET_VALIDE', 'Troncon', 't-ok', '{"id":"t-ok","longueurKm":2}');
  SELECT "version" INTO v FROM outbox_evenements WHERE id = 'e-t-ok';
  IF v <> 1 THEN RAISE EXCEPTION 'ECHEC : rang du premier evenement = % (attendu 1)', v; END IF;
  SELECT "version" INTO v FROM outbox_evenements WHERE id = 'e-t-ok-2';
  IF v <> 2 THEN RAISE EXCEPTION 'ECHEC : rang du second evenement = % (attendu 2)', v; END IF;
  RAISE NOTICE 'Rangs affectes par le declencheur : 1 puis 2 pour la meme source';

  -- Un evenement ne nait que EN_ATTENTE, sans tentative.
  BEGIN
    INSERT INTO outbox_evenements (id, destination, "typeEvenement", "sourceType", "sourceId", "cleIdempotence",
                                   "chargeCanonique", "empreinteCharge", statut, "envoyeLe", "accuseReference", "creeParId")
    SELECT 'x-ne', 'BDR_L2R', 'PIVOT_OBJET_VALIDE', 'Troncon', 't-ok',
           encode(sha256(convert_to('BDR_L2R|PIVOT_OBJET_VALIDE|Troncon|t-ok|' || encode(sha256(convert_to('{"n":1}', 'UTF8')), 'hex'), 'UTF8')), 'hex'),
           '{"n":1}', encode(sha256(convert_to('{"n":1}', 'UTF8')), 'hex'), 'ENVOYE', now()::timestamp, 'REF', 'u-obx';
    RAISE EXCEPTION 'ECHEC : un evenement est ne ENVOYE';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Un evenement ne peut pas naitre ENVOYE : REFUSE';
  END;

  -- ---------- 4. MACHINE A ETATS ----------
  -- EN_ATTENTE > ENVOYE : saute l'etape EN_COURS.
  BEGIN
    UPDATE outbox_evenements SET statut = 'ENVOYE', "envoyeLe" = now()::timestamp, "accuseReference" = 'R' WHERE id = 'e-t-ok';
    RAISE EXCEPTION 'ECHEC : EN_ATTENTE > ENVOYE accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'EN_ATTENTE > ENVOYE (sans verrou) : REFUSE';
  END;
  -- EN_COURS sans verrou : refuse par contrainte.
  BEGIN
    UPDATE outbox_evenements SET statut = 'EN_COURS' WHERE id = 'e-t-ok';
    RAISE EXCEPTION 'ECHEC : EN_COURS sans verrou accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'EN_COURS sans verrou : REFUSE';
  END;
  -- Contre-epreuve : le chemin nominal passe.
  UPDATE outbox_evenements SET statut = 'EN_COURS', "verrouPar" = 'w1', "verrouJusqua" = now()::timestamp + interval '1 minute' WHERE id = 'e-t-ok';
  UPDATE outbox_evenements SET statut = 'ECHEC', tentatives = 1, "verrouPar" = NULL, "verrouJusqua" = NULL,
         "dernierCode" = 'HTTP_503' WHERE id = 'e-t-ok';
  UPDATE outbox_evenements SET statut = 'EN_COURS', "verrouPar" = 'w1', "verrouJusqua" = now()::timestamp + interval '1 minute' WHERE id = 'e-t-ok';
  UPDATE outbox_evenements SET statut = 'ENVOYE', tentatives = 2, "verrouPar" = NULL, "verrouJusqua" = NULL,
         "envoyeLe" = now()::timestamp, "accuseReference" = 'REF-1' WHERE id = 'e-t-ok';
  RAISE NOTICE 'Contre-epreuve : EN_ATTENTE > EN_COURS > ECHEC > EN_COURS > ENVOYE passe';

  -- ENVOYE est IMMUABLE : rejeu sans effet de bord.
  BEGIN
    UPDATE outbox_evenements SET "dernierMessage" = 'x' WHERE id = 'e-t-ok';
    RAISE EXCEPTION 'ECHEC : un evenement ENVOYE a ete modifie';
  EXCEPTION WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'Evenement ENVOYE : toute modification REFUSEE';
  END;
  BEGIN
    UPDATE outbox_evenements SET statut = 'EN_ATTENTE', "envoyeLe" = NULL WHERE id = 'e-t-ok';
    RAISE EXCEPTION 'ECHEC : ENVOYE > EN_ATTENTE accepte';
  EXCEPTION WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'ENVOYE > EN_ATTENTE : REFUSE (un evenement envoye ne se rejoue pas)';
  END;

  -- La charge, la cle et la source sont figees.
  BEGIN
    UPDATE outbox_evenements SET "chargeCanonique" = '{"id":"autre"}',
           "empreinteCharge" = encode(sha256(convert_to('{"id":"autre"}', 'UTF8')), 'hex') WHERE id = 'e-t-ok-2';
    RAISE EXCEPTION 'ECHEC : la charge a ete modifiee';
  EXCEPTION WHEN integrity_constraint_violation OR check_violation THEN
    RAISE NOTICE 'Modification de la charge : REFUSEE';
  END;

  -- ABANDONNE exige un motif ; il se releve par EN_ATTENTE seulement.
  BEGIN
    UPDATE outbox_evenements SET statut = 'ABANDONNE', "abandonneLe" = now()::timestamp WHERE id = 'e-t-ok-2';
    RAISE EXCEPTION 'ECHEC : abandon sans motif accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Abandon sans motif : REFUSE';
  END;
  UPDATE outbox_evenements SET statut = 'ABANDONNE', "abandonneLe" = now()::timestamp, "motifAbandon" = 'essai' WHERE id = 'e-t-ok-2';
  BEGIN
    UPDATE outbox_evenements SET statut = 'EN_COURS', "verrouPar" = 'w', "verrouJusqua" = now()::timestamp + interval '1 minute',
           "abandonneLe" = NULL, "motifAbandon" = NULL WHERE id = 'e-t-ok-2';
    RAISE EXCEPTION 'ECHEC : ABANDONNE > EN_COURS accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ABANDONNE > EN_COURS : REFUSE (relance humaine = EN_ATTENTE)';
  END;
  UPDATE outbox_evenements SET statut = 'EN_ATTENTE', "abandonneLe" = NULL, "motifAbandon" = NULL, relances = 1, tentatives = 0 WHERE id = 'e-t-ok-2';
  RAISE NOTICE 'Contre-epreuve : ABANDONNE > EN_ATTENTE (relance) passe';

  -- ---------- 5. AUCUNE SUPPRESSION ----------
  BEGIN
    DELETE FROM outbox_evenements WHERE id = 'e-t-ok-2';
    RAISE EXCEPTION 'ECHEC : un evenement a ete supprime';
  EXCEPTION WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'DELETE d''un evenement : REFUSE';
  END;

  RAISE NOTICE 'OUTBOX : verifications 1 a 5 passees';
END
$t$;

-- ---------- 6. TENTATIVES EN AJOUT SEUL ----------
DO $t$
BEGIN
  INSERT INTO outbox_tentatives ("evenementId", numero, "debutLe", "finLe", issue, "codeHttp", message)
  VALUES ('e-t-ok', 1, now()::timestamp, now()::timestamp, 'ECHEC_TEMPORAIRE', 503, 'HTTP 503');
  BEGIN
    UPDATE outbox_tentatives SET message = 'retouche' WHERE "evenementId" = 'e-t-ok';
    RAISE EXCEPTION 'ECHEC : une tentative a ete modifiee';
  EXCEPTION WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'UPDATE d''une tentative : REFUSE';
  END;
  BEGIN
    DELETE FROM outbox_tentatives WHERE "evenementId" = 'e-t-ok';
    RAISE EXCEPTION 'ECHEC : une tentative a ete supprimee';
  EXCEPTION WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'DELETE d''une tentative : REFUSE';
  END;
  BEGIN
    INSERT INTO outbox_tentatives ("evenementId", numero, "debutLe", "finLe", issue)
    VALUES ('e-t-ok', 2, now()::timestamp, now()::timestamp, 'REUSSITE_INVENTEE');
    RAISE EXCEPTION 'ECHEC : une issue inconnue a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Issue inconnue : REFUSEE';
  END;
  RAISE NOTICE 'OUTBOX : toutes les verifications SQL sont passees';
END
$t$;

ROLLBACK;
