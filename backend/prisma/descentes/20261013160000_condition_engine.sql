-- RETOUR ARRIERE de `20261013160000_condition_engine`.
--
-- Cree les types ComposanteRci et MotifExclusionRci et les tables regles_condition, evaluations_condition, composantes_evaluation (avec neuf contraintes CHECK).
--
-- CE QUI EST PERDU : les regles de calcul de l'indice de condition, leurs approbations, et TOUTES les evaluations calculees avec leurs composantes.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261013160000_condition_engine.sql
--
-- GARDE-TEST: INSERT INTO "regles_condition" ("id","version","poids","fraicheurMaxJours","couvertureMinimale","creeParId","updatedAt") VALUES ('g1','v','{}',30,0.5,'u',now());
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "regles_condition") + (SELECT count(*) FROM "evaluations_condition") + (SELECT count(*) FROM "composantes_evaluation") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de regles, d''evaluations ou de composantes. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP TABLE IF EXISTS "composantes_evaluation";
DROP TABLE IF EXISTS "evaluations_condition";
DROP TABLE IF EXISTS "regles_condition";
DROP TYPE IF EXISTS "MotifExclusionRci";
DROP TYPE IF EXISTS "ComposanteRci";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261013160000_condition_engine';
