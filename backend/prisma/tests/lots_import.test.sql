-- BANC D'ESSAI des invariants de `lots_import` et `lignes_import` (contrat d'import unique).
--
-- Ce qu'il prouve : que le critere A28 est tenu PAR LA BASE -- 100 % des lignes dans un statut,
-- idempotence par empreinte -- et que chaque refus a sa contre-epreuve. Sans contre-epreuve,
-- une contrainte qui refuserait tout ferait passer le test.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 \
--     -f - < backend/prisma/tests/lots_import.test.sql
--
-- Transaction ANNULEE a la fin : rien de durable n'est ecrit.

BEGIN;

INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-imp', 'imp@local.invalid', 'Fixture import', 'fixture-sans-usage', 'ADMIN', CURRENT_TIMESTAMP);

DO $t$
DECLARE
  h text := repeat('a', 64);
BEGIN
  -- ---------- A28 : les compteurs doivent se sommer ----------
  BEGIN
    INSERT INTO lots_import (id, reference, "systemeSource", format, "empreinteFichier", "nomFichier",
                             "tailleOctets", "importeParId", "methodeSource", "versionMapping",
                             "autorisationRef", statut, "lignesLues", "lignesValidees")
    VALUES ('l1', 'IMP-1', 'ONR', 'csv', h, 'a.csv', 10, 'u-imp', 'export', 'v1', 'AUT-1', 'VALIDE_SCHEMA', 5, 2);
    RAISE EXCEPTION 'A28 ECHEC : 5 lues, 2 comptees, accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'A28 : compteurs incomplets (5 lues, 2 comptees) REFUSES';
  END;

  -- Contre-epreuve : 5 = 2 validees + 1 rejetee + 1 en conflit + 1 ignoree, lot VALIDE_SCHEMA.
  INSERT INTO lots_import (id, reference, "systemeSource", format, "empreinteFichier", "nomFichier",
                           "tailleOctets", "importeParId", "methodeSource", "versionMapping",
                           "autorisationRef", statut, "lignesLues", "lignesValidees", "lignesRejetees",
                           "lignesEnConflit", "lignesIgnorees")
  VALUES ('l1', 'IMP-1', 'ONR', 'csv', h, 'a.csv', 10, 'u-imp', 'export', 'v1', 'AUT-1', 'VALIDE_SCHEMA', 5, 2, 1, 1, 1);
  RAISE NOTICE 'A28 contre-epreuve : 5 = 2 + 1 + 1 + 1 accepte, lot VALIDE_SCHEMA';

  -- ---------- Un lot non applique n'a rien importe ----------
  BEGIN
    UPDATE lots_import SET "lignesValidees" = 1, "lignesImportees" = 1 WHERE id = 'l1';
    RAISE EXCEPTION 'Un lot VALIDE_SCHEMA avec des lignes importees a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Lot VALIDE_SCHEMA avec lignes importees REFUSE : rien n''est applique avant l''application';
  END;

  -- ---------- Un lot REJETE n'a rien valide ----------
  BEGIN
    INSERT INTO lots_import (id, reference, "systemeSource", format, "empreinteFichier", "nomFichier",
                             "tailleOctets", "importeParId", "methodeSource", "versionMapping",
                             "autorisationRef", statut, "lignesLues", "lignesValidees", "lignesRejetees")
    VALUES ('lr', 'IMP-R', 'ONR', 'csv', repeat('c', 64), 'c.csv', 10, 'u-imp', 'export', 'v1', 'AUT-1', 'REJETE', 3, 1, 2);
    RAISE EXCEPTION 'Un lot REJETE avec une ligne validee a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Lot REJETE avec une ligne validee REFUSE';
  END;
  -- Contre-epreuve : un lot REJETE dont toutes les lignes sont rejetees passe.
  INSERT INTO lots_import (id, reference, "systemeSource", format, "empreinteFichier", "nomFichier",
                           "tailleOctets", "importeParId", "methodeSource", "versionMapping",
                           "autorisationRef", statut, "lignesLues", "lignesRejetees")
  VALUES ('lr', 'IMP-R', 'ONR', 'csv', repeat('c', 64), 'c.csv', 10, 'u-imp', 'export', 'v1', 'AUT-1', 'REJETE', 3, 3);
  RAISE NOTICE 'Lot REJETE, 3 lues = 3 rejetees : accepte';

  -- ---------- Idempotence : le meme fichier pour la meme source n'entre qu'une fois ----------
  BEGIN
    INSERT INTO lots_import (id, reference, "systemeSource", format, "empreinteFichier", "nomFichier",
                             "tailleOctets", "importeParId", "methodeSource", "versionMapping", "autorisationRef")
    VALUES ('l2', 'IMP-2', 'ONR', 'csv', h, 'a-bis.csv', 10, 'u-imp', 'export', 'v1', 'AUT-1');
    RAISE EXCEPTION 'IDEMPOTENCE ECHEC : meme fichier deux fois accepte';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'Idempotence : le meme fichier pour la meme source REFUSE avant toute ecriture';
  END;
  -- Contre-epreuve : le meme fichier pour une AUTRE source est un autre lot.
  INSERT INTO lots_import (id, reference, "systemeSource", format, "empreinteFichier", "nomFichier",
                           "tailleOctets", "importeParId", "methodeSource", "versionMapping", "autorisationRef")
  VALUES ('l2', 'IMP-2', 'ANASUR_COLLECT', 'csv', h, 'a.csv', 10, 'u-imp', 'export', 'v1', 'AUT-2');
  RAISE NOTICE 'Meme empreinte, autre source : accepte -- l''idempotence est par source';

  -- ---------- Empreinte et autorisation ----------
  BEGIN
    INSERT INTO lots_import (id, reference, "systemeSource", format, "empreinteFichier", "nomFichier",
                             "tailleOctets", "importeParId", "methodeSource", "versionMapping", "autorisationRef")
    VALUES ('l3', 'IMP-3', 'ONR', 'csv', 'fichier.csv', 'a.csv', 10, 'u-imp', 'export', 'v1', 'AUT-1');
    RAISE EXCEPTION 'Une empreinte qui n''est pas un SHA-256 a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Empreinte non SHA-256 REFUSEE : l''idempotence ne repose pas sur la bonne foi de l''appelant';
  END;
  BEGIN
    INSERT INTO lots_import (id, reference, "systemeSource", format, "empreinteFichier", "nomFichier",
                             "tailleOctets", "importeParId", "methodeSource", "versionMapping", "autorisationRef")
    VALUES ('l4', 'IMP-4', 'ONR', 'csv', repeat('b', 64), 'b.csv', 10, 'u-imp', 'export', 'v1', '   ');
    RAISE EXCEPTION 'Un lot sans autorisation a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Lot sans autorisation ecrite REFUSE (paragraphe B.4)';
  END;

  -- ---------- Lignes : rejet motive, cible coherente, numero unique ----------
  BEGIN
    INSERT INTO lignes_import (id, "lotId", "numeroLigne", "chargeOriginale", statut) VALUES ('g1', 'l1', 1, '{}', 'REJETEE');
    RAISE EXCEPTION 'Un rejet sans motif a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Rejet sans motif REFUSE : il n''apprendrait rien a la source';
  END;
  BEGIN
    INSERT INTO lignes_import (id, "lotId", "numeroLigne", "chargeOriginale", statut) VALUES ('g2', 'l1', 1, '{}', 'IMPORTEE');
    RAISE EXCEPTION 'Une ligne importee sans cible a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Ligne IMPORTEE sans objet cible REFUSEE';
  END;
  BEGIN
    INSERT INTO lignes_import (id, "lotId", "numeroLigne", "chargeOriginale", statut, "objetCibleType", "objetCibleId")
    VALUES ('g2b', 'l1', 1, '{}', 'VALIDEE', 'troncon', 't-1');
    RAISE EXCEPTION 'Une ligne VALIDEE avec une cible a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Ligne VALIDEE avec objet cible REFUSEE : validee veut dire pas encore appliquee';
  END;
  INSERT INTO lignes_import (id, "lotId", "numeroLigne", "chargeOriginale", statut) VALUES ('g3', 'l1', 1, '{"x":1}', 'VALIDEE');
  BEGIN
    INSERT INTO lignes_import (id, "lotId", "numeroLigne", "chargeOriginale", statut, "motifRejet") VALUES ('g4', 'l1', 1, '{}', 'REJETEE', 'doublon');
    RAISE EXCEPTION 'La ligne 1 a ete comptee deux fois';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'Meme numero de ligne deux fois REFUSE : une ligne n''est comptee qu''une fois';
  END;
  INSERT INTO lignes_import (id, "lotId", "numeroLigne", "chargeOriginale", statut, "motifRejet")
  VALUES ('g5', 'l1', 2, '{"x":2}', 'REJETEE', 'identifiant_source manquant');
  INSERT INTO lignes_import (id, "lotId", "numeroLigne", "chargeOriginale", statut, "motifRejet")
  VALUES ('g6', 'l1', 3, '{"x":1}', 'IGNOREE', 'doublon dans le lot : meme identifiant que la ligne 1');
  RAISE NOTICE 'Contre-epreuves : VALIDEE sans cible, REJETEE avec motif, IGNOREE avec raison acceptees';

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
