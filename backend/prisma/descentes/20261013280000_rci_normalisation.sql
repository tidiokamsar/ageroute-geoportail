-- RETOUR ARRIERE de `20261013280000_rci_normalisation`.
--
-- Ajoute regles_condition.normalisation (JSONB) et deux contraintes CHECK (normalisation et poids sont des objets).
--
-- CE QUI EST PERDU : les parametres de normalisation de chaque regle de calcul de l'indice de condition.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261013280000_rci_normalisation.sql
--
-- GARDE-TEST: INSERT INTO "regles_condition" ("id","version","poids","fraicheurMaxJours","couvertureMinimale","creeParId","updatedAt","normalisation") VALUES ('g1','v','{}',30,0.5,'u',now(),'{"a":1}');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "regles_condition" WHERE "normalisation" <> '{}'::jsonb) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % regle(s) portent des parametres de normalisation. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

ALTER TABLE "regles_condition" DROP CONSTRAINT IF EXISTS "regle_poids_est_un_objet";
ALTER TABLE "regles_condition" DROP CONSTRAINT IF EXISTS "regle_normalisation_est_un_objet";
ALTER TABLE "regles_condition"
  DROP COLUMN IF EXISTS "normalisation";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261013280000_rci_normalisation';
