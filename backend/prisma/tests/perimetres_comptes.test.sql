-- BANC D'ESSAI des perimetres territoriaux des comptes (A10).
--
-- Ce qu'il prouve : une region n'est rattachee qu'une fois a un compte ; l'auteur du rattachement
-- est obligatoire ; supprimer un compte retire son perimetre ; une region rattachee ne se
-- supprime pas ; aucun rattachement n'est seme.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/perimetres_comptes.test.sql
--
-- Transaction ANNULEE a la fin.

BEGIN;

DO $t$
DECLARE nb integer; r integer;
BEGIN
  SELECT count(*) INTO nb FROM perimetres_comptes;
  IF nb <> 0 THEN RAISE EXCEPTION 'Des perimetres ont ete semes (%)', nb; END IF;
  RAISE NOTICE 'Aucun perimetre seme';

  INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES
    ('u-pa', 'pa@local.invalid', 'Admin perimetre', 'x', 'ADMIN', CURRENT_TIMESTAMP),
    ('u-pg', 'pg@local.invalid', 'Gestionnaire regional', 'x', 'GESTIONNAIRE', CURRENT_TIMESTAMP);
  INSERT INTO regions (nom) VALUES ('Region de test perimetre') RETURNING id INTO r;

  INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ('u-pg', r, 'u-pa');
  RAISE NOTICE 'Rattachement ACCEPTE';

  BEGIN
    INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ('u-pg', r, 'u-pa');
    RAISE EXCEPTION 'Double rattachement accepte';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'Double rattachement de la meme region REFUSE'; END;

  BEGIN
    INSERT INTO perimetres_comptes ("userId", "regionId") VALUES ('u-pa', r);
    RAISE EXCEPTION 'Rattachement sans auteur accepte';
  EXCEPTION WHEN not_null_violation THEN RAISE NOTICE 'Rattachement sans auteur REFUSE'; END;

  BEGIN
    DELETE FROM regions WHERE id = r;
    RAISE EXCEPTION 'Region rattachee supprimee';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'Suppression d''une region rattachee REFUSEE'; END;

  DELETE FROM users WHERE id = 'u-pg';
  SELECT count(*) INTO nb FROM perimetres_comptes WHERE "userId" = 'u-pg';
  IF nb <> 0 THEN RAISE EXCEPTION 'Perimetre orphelin apres suppression du compte'; END IF;
  RAISE NOTICE 'Suppression du compte : son perimetre part avec lui';
  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END $t$;

ROLLBACK;
