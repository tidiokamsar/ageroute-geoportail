-- RETOUR ARRIERE de `20260629140000_chantier_observations`.
--
-- Ajoute chantiers.numContrat et chantiers.observations.
--
-- CE QUI EST PERDU : le numero de contrat et les observations des chantiers.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260629140000_chantier_observations.sql
--
-- GARDE-TEST: INSERT INTO "chantiers" ("id","intitule","entreprise","regionId","updatedAt","numContrat") VALUES ('g1','x','x',1,now(),'C-1');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "chantiers" WHERE num_nonnulls("numContrat", "observations") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % chantier(s) portent un numero de contrat ou des observations. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

ALTER TABLE "chantiers"
  DROP COLUMN IF EXISTS "numContrat",
  DROP COLUMN IF EXISTS "observations";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260629140000_chantier_observations';
