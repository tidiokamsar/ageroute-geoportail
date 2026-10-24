-- RETOUR ARRIERE de `20261014190000_sections_fixes_derivees`.
--
-- Comme pour la descente precedente, ce fichier vit HORS du dossier de migration : Prisma lit
-- `migration.sql`, et un second `.sql` y est tres probablement ignore, mais je n'ai pas pu
-- l'etablir avec certitude et le risque est asymetrique (ADR-008).
--
-- EXECUTE ET VERIFIE le 14/10/2026, en aller-retour, sur la base de developpement
-- `postgis/postgis:17-3.5` -- la meme image que la production. Voir `MIGRATION_PLAN.md`.
--
-- CETTE DESCENTE NE PEUT RIEN DETRUIRE, et c'est la consequence directe de n'avoir cree aucune
-- table. La montee ajoute une FONCTION ; la retirer ne touche aucune ligne, aucune colonne et
-- aucune contrainte. Les portions homogenes, qui portent la verite, sont intactes de part et
-- d'autre.
--
-- C'est le seul retour arriere de ce depot dont on puisse dire cela sans compter de lignes au
-- prealable, et c'est un argument de plus pour la vue derivee contre la table derivee.

DROP FUNCTION IF EXISTS reseau_sections_fixes(double precision, text[], date);

-- Et il faut retirer la ligne de `_prisma_migrations`, sinon `migrate deploy` considerera la
-- migration comme appliquee et ne la rejouera jamais :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261014190000_sections_fixes_derivees';
--
-- Volontairement absente ci-dessus : ce geste doit etre conscient, pas un effet de bord.
