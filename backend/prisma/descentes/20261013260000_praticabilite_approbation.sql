-- RETOUR ARRIERE de `20261013260000_praticabilite_approbation`.
--
-- Ajoute referentiel_praticabilites.approuveeLe et approuveeParId, rend description NOT NULL, ajoute une cle etrangere et deux contraintes CHECK.
--
-- CE QUI EST PERDU : les APPROBATIONS des niveaux de praticabilite : qui a approuve quoi et quand. C'est une decision institutionnelle d'AGEROUTE, pas une valeur technique.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261013260000_praticabilite_approbation.sql
--
-- GARDE-TEST: INSERT INTO "referentiel_praticabilites" ("code","libelle","description","ordre","franchissable","updatedAt","approuveeLe","approuveeParId") VALUES ('X','x','une description de plus de vingt caracteres',1,true,now(),now(),'u');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "referentiel_praticabilites" WHERE num_nonnulls("approuveeLe", "approuveeParId") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % niveau(x) de praticabilite portent une approbation. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

ALTER TABLE "referentiel_praticabilites" DROP CONSTRAINT IF EXISTS "praticabilite_definition_substantielle";
ALTER TABLE "referentiel_praticabilites" DROP CONSTRAINT IF EXISTS "praticabilite_approbation_imputable";
ALTER TABLE "referentiel_praticabilites" DROP CONSTRAINT IF EXISTS "referentiel_praticabilites_approuveeParId_fkey";
ALTER TABLE "referentiel_praticabilites"
  DROP COLUMN IF EXISTS "approuveeLe",
  DROP COLUMN IF EXISTS "approuveeParId";
ALTER TABLE "referentiel_praticabilites" ALTER COLUMN "description" DROP NOT NULL;

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261013260000_praticabilite_approbation';
