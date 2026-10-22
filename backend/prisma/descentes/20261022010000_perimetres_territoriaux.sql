-- RETOUR ARRIERE de `20261022010000_perimetres_territoriaux`.
--
-- CE QUI EST PERDU : les perimetres territoriaux attribues aux comptes, revocations comprises. Apres
-- descente, AUCUN compte n'est plus restreint : chacun ecrit de nouveau dans toutes les regions.
-- C'est un ELARGISSEMENT DE DROITS silencieux pour les comptes restreints ; a annoncer avant.
--
-- GARDE : la descente REFUSE de s'executer s'il existe une attribution. Pour passer outre, apres
-- sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261022010000_perimetres_territoriaux.sql
--
-- GARDE-TEST: INSERT INTO "users" ("id","email","nomComplet","passwordHash","updatedAt") VALUES ('gu1','g1@local.invalid','g','x',now()),('gu2','g2@local.invalid','g','x',now()); INSERT INTO "regions" ("nom") VALUES ('Garde perimetre'); INSERT INTO "perimetres_territoriaux" ("id","userId","regionId","motif","attribueParId") VALUES ('gp1','gu1',(SELECT id FROM regions WHERE nom='Garde perimetre'),'garde','gu2');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "perimetres_territoriaux";
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % attribution(s) de perimetre territorial ; leur perte elargit les droits des comptes restreints. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "perimetres_territoriaux";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261022010000_perimetres_territoriaux';
