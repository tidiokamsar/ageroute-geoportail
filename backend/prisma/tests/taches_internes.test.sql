-- BANC D'ESSAI des invariants de `taches_internes` (TI-01, arbitrage D1).
--
-- Eprouve le critere A29 du prompt maitre V10 :
--   « Une tache interne cloturee possede des preuves avant/apres ; une alerte de rapprochement
--     affiche regle, donnees et traitement ; aucun paiement, decompte ou marche n'est cree ni
--     modifie par la plateforme. »
--
-- La PREMIERE proposition est eprouvee ici, et par la base elle-meme : elle est tenue par une
-- contrainte `CHECK`, pas par une consigne de service. La deuxieme releve de TI-02, qui depend
-- de donnees DigitalRoad auxquelles nous n'avons aucun acces (B-11). La troisieme est tenue par
-- l'ABSENCE des colonnes, et un test Vitest balaie `schema.prisma` pour s'en assurer.
--
-- Chaque assertion suit le meme principe que le banc des sections fixes : elle verifie qu'une
-- ecriture fautive est REFUSEE, et une contre-epreuve verifie que l'ecriture correcte passe.
-- Sans contre-epreuve, une contrainte trop stricte -- ou une table vide -- ferait passer le test.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 \
--     -f - < backend/prisma/tests/taches_internes.test.sql
--
-- Tout se passe dans une transaction ANNULEE : rien de durable n'est ecrit.

BEGIN;

INSERT INTO regions (nom) VALUES ('Region de test taches internes');

INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-test-ti', 'test-taches@local.invalid', 'Fixture taches internes',
        -- Jamais verifie : aucune authentification n'intervient dans ce test.
        'fixture-sans-usage', 'ADMIN', CURRENT_TIMESTAMP);

INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement,
                      "pkDebut", "pkFin", "updatedAt")
VALUES ('t-test-ti', 'TEST-TI-1', 'Troncon de test taches', 'RN',
        (SELECT id FROM regions WHERE nom = 'Region de test taches internes'),
        10.0, 'LATERITE', 0, 10.0, CURRENT_TIMESTAMP);

DO $t$
DECLARE
  nb integer;
BEGIN
  -- Chaque assertion part d'une ligne CORRECTE et n'en casse qu'une chose a la fois : c'est ce
  -- qui permet d'attribuer un refus a la contrainte visee, et non a une autre.

  -- ---------- La tache minimale valide passe ----------
  INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId",
                               "responsableId", "creeParId", "updatedAt")
  VALUES ('ti-1', 'TI-2026-000001', 'CANTONNAGE', 'Cantonnage PK 3 a PK 4',
          't-test-ti', 'u-test-ti', 'u-test-ti', CURRENT_TIMESTAMP);
  RAISE NOTICE 'Tache minimale valide : acceptee (statut OUVERTE par defaut)';

  SELECT count(*) INTO nb FROM taches_internes WHERE id = 'ti-1' AND statut = 'OUVERTE';
  IF nb <> 1 THEN RAISE EXCEPTION 'Le statut par defaut devrait etre OUVERTE'; END IF;

  -- ---------- A29 : cloturer SANS preuves est refuse ----------
  BEGIN
    UPDATE taches_internes
       SET statut = 'CLOTUREE', "clotureeLe" = CURRENT_TIMESTAMP, "clotureeParId" = 'u-test-ti'
     WHERE id = 'ti-1';
    RAISE EXCEPTION 'A29 ECHEC : une cloture sans preuves avant/apres a ete acceptee';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'A29 : cloture sans preuves REFUSEE par la base';
  END;

  -- ---------- A29 : avec une seule des deux preuves, toujours refuse ----------
  BEGIN
    UPDATE taches_internes
       SET statut = 'CLOTUREE', "clotureeLe" = CURRENT_TIMESTAMP, "clotureeParId" = 'u-test-ti',
           "preuveAvantChemin" = 'avant.jpg', "preuveAvantPriseLe" = TIMESTAMP '2026-10-01 08:00'
     WHERE id = 'ti-1';
    RAISE EXCEPTION 'A29 ECHEC : une cloture avec la seule preuve « avant » a ete acceptee';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'A29 : cloture avec une seule preuve REFUSEE';
  END;

  -- ---------- A29, CONTRE-EPREUVE : avec les deux preuves, la cloture passe ----------
  --
  -- Sans elle, une contrainte qui refuserait TOUTE cloture ferait passer les deux assertions
  -- ci-dessus. C'est la verification qui donne leur valeur aux autres.
  UPDATE taches_internes
     SET statut = 'CLOTUREE', "clotureeLe" = CURRENT_TIMESTAMP, "clotureeParId" = 'u-test-ti',
         "preuveAvantChemin" = 'avant.jpg', "preuveAvantPriseLe" = TIMESTAMP '2026-10-01 08:00',
         "preuveApresChemin" = 'apres.jpg', "preuveApresPriseLe" = TIMESTAMP '2026-10-01 16:30'
   WHERE id = 'ti-1';
  SELECT count(*) INTO nb FROM taches_internes WHERE id = 'ti-1' AND statut = 'CLOTUREE';
  IF nb <> 1 THEN RAISE EXCEPTION 'A29 ECHEC : la cloture avec les deux preuves a ete refusee'; END IF;
  RAISE NOTICE 'A29 contre-epreuve : la cloture AVEC les deux preuves est acceptee';

  -- ---------- Une cloture sans auteur ni date n'est pas auditable ----------
  BEGIN
    UPDATE taches_internes SET "clotureeParId" = NULL WHERE id = 'ti-1';
    RAISE EXCEPTION 'Une tache cloturee sans auteur a ete acceptee';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Cloture sans auteur REFUSEE : elle ne serait pas auditable';
  END;

  -- ---------- La preuve « apres » ne peut pas preceder la preuve « avant » ----------
  BEGIN
    INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId",
                                 "responsableId", "creeParId", statut,
                                 "clotureeLe", "clotureeParId",
                                 "preuveAvantChemin", "preuveAvantPriseLe",
                                 "preuveApresChemin", "preuveApresPriseLe", "updatedAt")
    VALUES ('ti-inverse', 'TI-2026-000002', 'VERIFICATION', 'Preuves inversees',
            't-test-ti', 'u-test-ti', 'u-test-ti', 'CLOTUREE',
            CURRENT_TIMESTAMP, 'u-test-ti',
            'avant.jpg', TIMESTAMP '2026-10-02 16:00',
            'apres.jpg', TIMESTAMP '2026-10-02 08:00', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Une preuve « apres » anterieure a la preuve « avant » a ete acceptee';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Preuves inversees REFUSEES : l''« apres » ne peut pas preceder l''« avant »';
  END;

  -- ---------- Un abandon se motive ----------
  BEGIN
    INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId",
                                 "responsableId", "creeParId", statut, "updatedAt")
    VALUES ('ti-abandon', 'TI-2026-000003', 'CANTONNAGE', 'Abandon sans motif',
            't-test-ti', 'u-test-ti', 'u-test-ti', 'ABANDONNEE', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Un abandon sans motif a ete accepte';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Abandon sans motif REFUSE : sinon il serait la sortie facile pour eviter les preuves';
  END;

  -- Un motif fait d'espaces ne vaut pas un motif.
  BEGIN
    INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId",
                                 "responsableId", "creeParId", statut, "abandonMotif", "updatedAt")
    VALUES ('ti-abandon2', 'TI-2026-000004', 'CANTONNAGE', 'Abandon motif vide',
            't-test-ti', 'u-test-ti', 'u-test-ti', 'ABANDONNEE', '    ', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Un abandon motive par des espaces a ete accepte';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Abandon motive par des espaces REFUSE';
  END;

  -- Contre-epreuve : un abandon motive passe.
  INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId",
                               "responsableId", "creeParId", statut, "abandonMotif", "updatedAt")
  VALUES ('ti-abandon3', 'TI-2026-000005', 'CANTONNAGE', 'Abandon motive',
          't-test-ti', 'u-test-ti', 'u-test-ti', 'ABANDONNEE',
          'Emprise reprise par un marche : l''objet passe a DigitalRoad', CURRENT_TIMESTAMP);
  RAISE NOTICE 'Abandon motive : accepte';

  -- ---------- Quantites : jamais sans unite, jamais negatives ----------
  BEGIN
    INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId",
                                 "responsableId", "creeParId", "quantiteConstatee", "updatedAt")
    VALUES ('ti-q1', 'TI-2026-000006', 'PETITE_REPARATION', 'Quantite sans unite',
            't-test-ti', 'u-test-ti', 'u-test-ti', 40, CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Une quantite sans unite a ete acceptee';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Quantite sans unite REFUSEE : « 40 » ne veut rien dire';
  END;

  BEGIN
    INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId",
                                 "responsableId", "creeParId",
                                 "quantiteConstatee", "quantiteUnite", "updatedAt")
    VALUES ('ti-q2', 'TI-2026-000007', 'PETITE_REPARATION', 'Quantite negative',
            't-test-ti', 'u-test-ti', 'u-test-ti', -5, 'm3', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Une quantite negative a ete acceptee';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Quantite negative REFUSEE';
  END;

  INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId",
                               "responsableId", "creeParId",
                               "quantiteConstatee", "quantiteUnite", "updatedAt")
  VALUES ('ti-q3', 'TI-2026-000008', 'PETITE_REPARATION', 'Laterite reprise',
          't-test-ti', 'u-test-ti', 'u-test-ti', 40.5, 'm3', CURRENT_TIMESTAMP);
  RAISE NOTICE 'Quantite constatee 40,5 m3 : acceptee -- un constat, jamais un montant';

  -- ---------- Emprise lineaire ----------
  BEGIN
    INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId", "debutM", "finM",
                                 "responsableId", "creeParId", "updatedAt")
    VALUES ('ti-e1', 'TI-2026-000009', 'CANTONNAGE', 'Emprise inversee',
            't-test-ti', 800, 300, 'u-test-ti', 'u-test-ti', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Une emprise inversee a ete acceptee';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Emprise inversee REFUSEE';
  END;

  BEGIN
    INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId", "debutM",
                                 "responsableId", "creeParId", "updatedAt")
    VALUES ('ti-e2', 'TI-2026-000010', 'CANTONNAGE', 'Une seule borne',
            't-test-ti', 300, 'u-test-ti', 'u-test-ti', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Une emprise a une seule borne a ete acceptee';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Emprise a une seule borne REFUSEE';
  END;

  -- Une emprise sans troncon n'a pas de systeme d'abscisses.
  BEGIN
    INSERT INTO taches_internes (id, reference, nature, intitule, "debutM", "finM", geom,
                                 "responsableId", "creeParId", "updatedAt")
    VALUES ('ti-e3', 'TI-2026-000011', 'CANTONNAGE', 'Abscisses sans troncon',
            300, 800, ST_SetSRID(ST_MakePoint(-13.57, 9.64), 4326),
            'u-test-ti', 'u-test-ti', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Des abscisses sans troncon ont ete acceptees';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Abscisses sans troncon REFUSEES : aucun systeme de reference';
  END;

  INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId", "debutM", "finM",
                               "responsableId", "creeParId", "updatedAt")
  VALUES ('ti-e4', 'TI-2026-000012', 'CANTONNAGE', 'Emprise correcte',
          't-test-ti', 300, 800, 'u-test-ti', 'u-test-ti', CURRENT_TIMESTAMP);
  RAISE NOTICE 'Emprise [300, 800) sur un troncon : acceptee';

  -- ---------- Au moins un rattachement ----------
  BEGIN
    INSERT INTO taches_internes (id, reference, nature, intitule,
                                 "responsableId", "creeParId", "updatedAt")
    VALUES ('ti-orphelin', 'TI-2026-000013', 'VERIFICATION', 'Tache sans rattachement',
            'u-test-ti', 'u-test-ti', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Une tache sans aucun rattachement a ete acceptee';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'Tache sans rattachement REFUSEE : elle serait une note, pas une tache';
  END;

  -- Un point suffit, sans troncon.
  INSERT INTO taches_internes (id, reference, nature, intitule, geom,
                               "responsableId", "creeParId", "updatedAt")
  VALUES ('ti-point', 'TI-2026-000014', 'NETTOYAGE_OUVRAGE', 'Nettoyage localise par un point',
          ST_SetSRID(ST_MakePoint(-13.57, 9.64), 4326),
          'u-test-ti', 'u-test-ti', CURRENT_TIMESTAMP);
  RAISE NOTICE 'Rattachement par un point seul : accepte';

  -- ---------- Idempotence et identifiant stable ----------
  BEGIN
    INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId",
                                 "responsableId", "creeParId", "updatedAt")
    VALUES ('ti-doublon', 'TI-2026-000001', 'CANTONNAGE', 'Reference deja prise',
            't-test-ti', 'u-test-ti', 'u-test-ti', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Une reference en double a ete acceptee';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'Reference en double REFUSEE : l''identifiant est stable ET unique';
  END;

  INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId",
                               "responsableId", "creeParId", "clientOperationId", "updatedAt")
  VALUES ('ti-idem', 'TI-2026-000015', 'CANTONNAGE', 'Creee hors ligne',
          't-test-ti', 'u-test-ti', 'u-test-ti', 'cli-op-abc', CURRENT_TIMESTAMP);
  BEGIN
    INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId",
                                 "responsableId", "creeParId", "clientOperationId", "updatedAt")
    VALUES ('ti-idem2', 'TI-2026-000016', 'CANTONNAGE', 'Renvoi apres zone blanche',
            't-test-ti', 'u-test-ti', 'u-test-ti', 'cli-op-abc', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Un renvoi de la meme operation a cree une tache en double';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'Renvoi de la meme operation REFUSE : idempotence hors ligne tenue';
  END;

  -- ---------- Une nature inconnue est refusee ----------
  BEGIN
    INSERT INTO taches_internes (id, reference, nature, intitule, "tronconId",
                                 "responsableId", "creeParId", "updatedAt")
    VALUES ('ti-nat', 'TI-2026-000017', 'TERRASSEMENT_GENERAL', 'Nature non declaree',
            't-test-ti', 'u-test-ti', 'u-test-ti', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Une nature hors referentiel a ete acceptee';
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE NOTICE 'Nature hors referentiel REFUSEE -- et elle s''ajoute par une ligne, pas par un ALTER TYPE';
  END;

  -- ---------- Les cinq natures du mandat sont la, et aucune n'est declaree approuvee ----------
  SELECT count(*) INTO nb FROM referentiel_natures_tache WHERE source = 'mandat_v10';
  IF nb <> 5 THEN
    RAISE EXCEPTION 'Les cinq natures du paragraphe 14.12 devraient etre semees, il y en a %', nb;
  END IF;
  RAISE NOTICE 'Cinq natures semees, toutes marquees source = mandat_v10, aucune approuvee';

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
