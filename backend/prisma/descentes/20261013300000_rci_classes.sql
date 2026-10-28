-- RETOUR ARRIERE de `20261013300000_rci_classes`.
--
-- Ajoute regles_condition.classes (JSONB) et une contrainte CHECK (tableau).
--
-- CE QUI EST PERDU : les classes de l'indice de condition de chaque regle (seuils de bon, moyen, mauvais, critique).
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261013300000_rci_classes.sql
--
-- GARDE-TEST: INSERT INTO "regles_condition" ("id","version","poids","fraicheurMaxJours","couvertureMinimale","creeParId","updatedAt","classes") VALUES ('g1','v','{}',30,0.5,'u',now(),'[1]');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "regles_condition" WHERE "classes" <> '[]'::jsonb) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % regle(s) portent des classes d''indice. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

ALTER TABLE "regles_condition" DROP CONSTRAINT IF EXISTS "regle_classes_est_un_tableau";
ALTER TABLE "regles_condition"
  DROP COLUMN IF EXISTS "classes";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261013300000_rci_classes';
