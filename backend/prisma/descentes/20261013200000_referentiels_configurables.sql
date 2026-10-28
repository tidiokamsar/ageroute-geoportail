-- RETOUR ARRIERE de `20261013200000_referentiels_configurables`.
--
-- Convertit portions.revetement et portions.etat de types enumeres en TEXT, cree les tables referentiel_revetements, referentiel_etats_chaussee, referentiel_praticabilites et les cles etrangeres des portions vers elles.
--
-- CE QUI EST PERDU : les trois referentiels configurables, qui sont du VOCABULAIRE DEFINI PAR AGEROUTE. Le retour aux enumerations est refuse si une portion porte une valeur absente de l'enumeration.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261013200000_referentiels_configurables.sql
--
-- GARDE-TEST: INSERT INTO "referentiel_revetements" ("code","libelle","ordre","bitumineux","updatedAt") VALUES ('X','x',1,false,now());
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "referentiel_revetements") + (SELECT count(*) FROM "referentiel_etats_chaussee") + (SELECT count(*) FROM "referentiel_praticabilites")
    + (SELECT count(*) FROM "portions" WHERE ("revetement" IS NOT NULL AND "revetement" NOT IN (SELECT unnest(enum_range(NULL::"Revetement"))::text))
                                          OR ("etat" IS NOT NULL AND "etat" NOT IN (SELECT unnest(enum_range(NULL::"EtatPatrimoine"))::text))) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de referentiel ou portions portant une valeur absente des enumerations. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

ALTER TABLE "portions" DROP CONSTRAINT IF EXISTS "portions_revetement_fkey";
ALTER TABLE "portions" DROP CONSTRAINT IF EXISTS "portions_etat_fkey";
ALTER TABLE "portions" DROP CONSTRAINT IF EXISTS "portions_praticabilite_fkey";
ALTER TABLE "portions"
  ALTER COLUMN "revetement" TYPE "Revetement" USING "revetement"::"Revetement",
  ALTER COLUMN "etat"       TYPE "EtatPatrimoine" USING "etat"::"EtatPatrimoine";
DROP TABLE IF EXISTS "referentiel_praticabilites";
DROP TABLE IF EXISTS "referentiel_etats_chaussee";
DROP TABLE IF EXISTS "referentiel_revetements";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261013200000_referentiels_configurables';
