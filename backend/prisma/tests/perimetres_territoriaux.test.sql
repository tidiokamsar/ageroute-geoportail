-- BANC D'ESSAI des perimetres territoriaux (A10).
--
-- Ce qu'il prouve : personne ne s'attribue un territoire a soi-meme ; une attribution a un motif et
-- un terme posterieur a son debut ; une seule attribution non revoquee par compte et region, une
-- nouvelle redevenant possible apres revocation ; aucun perimetre seme.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/perimetres_territoriaux.test.sql
--
-- Transaction ANNULEE a la fin.

BEGIN;
INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES
  ('u-pt-admin', 'pt-admin@local.invalid', 'Admin banc', 'x', 'ADMIN', now()),
  ('u-pt-agent', 'pt-agent@local.invalid', 'Agent banc', 'x', 'GESTIONNAIRE', now());
INSERT INTO regions (nom) VALUES ('Region banc perimetre A'), ('Region banc perimetre B');

DO $t$
DECLARE nb integer; ra integer := (SELECT id FROM regions WHERE nom = 'Region banc perimetre A');
BEGIN
  SELECT count(*) INTO nb FROM perimetres_territoriaux WHERE "userId" NOT IN ('u-pt-admin', 'u-pt-agent');
  IF nb <> 0 THEN RAISE EXCEPTION 'Des perimetres ont ete semes (%)', nb; END IF;
  RAISE NOTICE 'Aucun perimetre seme';

  BEGIN
    INSERT INTO perimetres_territoriaux (id, "userId", "regionId", motif, "attribueParId") VALUES ('x', 'u-pt-admin', ra, 'moi', 'u-pt-admin');
    RAISE EXCEPTION 'Auto-attribution acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Auto-attribution REFUSEE'; END;
  BEGIN
    INSERT INTO perimetres_territoriaux (id, "userId", "regionId", motif, "attribueParId") VALUES ('x', 'u-pt-agent', ra, '  ', 'u-pt-admin');
    RAISE EXCEPTION 'Attribution sans motif acceptee';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Attribution sans motif REFUSEE'; END;
  BEGIN
    INSERT INTO perimetres_territoriaux (id, "userId", "regionId", motif, "attribueParId", "debutLe", "finLe") VALUES ('x', 'u-pt-agent', ra, 'm', 'u-pt-admin', '2026-10-22', '2026-10-01');
    RAISE EXCEPTION 'Terme anterieur au debut accepte';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'Terme anterieur au debut REFUSE'; END;

  INSERT INTO perimetres_territoriaux (id, "userId", "regionId", motif, "attribueParId") VALUES ('pt-1', 'u-pt-agent', ra, 'note de service', 'u-pt-admin');
  BEGIN
    INSERT INTO perimetres_territoriaux (id, "userId", "regionId", motif, "attribueParId") VALUES ('pt-2', 'u-pt-agent', ra, 'doublon', 'u-pt-admin');
    RAISE EXCEPTION 'Doublon non revoque accepte';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'Seconde attribution non revoquee de la meme region REFUSEE'; END;
  UPDATE perimetres_territoriaux SET "revoqueLe" = now() WHERE id = 'pt-1';
  INSERT INTO perimetres_territoriaux (id, "userId", "regionId", motif, "attribueParId") VALUES ('pt-3', 'u-pt-agent', ra, 'retour', 'u-pt-admin');
  SELECT count(*) INTO nb FROM perimetres_territoriaux WHERE "userId" = 'u-pt-agent';
  IF nb <> 2 THEN RAISE EXCEPTION 'Revocation : la ligne revoquee doit rester (2 attendues, %)', nb; END IF;
  RAISE NOTICE 'Apres revocation, nouvelle attribution acceptee ; la revoquee est conservee';
  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;
ROLLBACK;
