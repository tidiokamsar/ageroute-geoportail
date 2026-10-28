-- RETOUR ARRIERE de `20261014220000_catalogue_traitements`.
--
-- EXECUTE ET VERIFIE le 14/10/2026 en aller-retour sur la base de developpement
-- `postgis/postgis:17-3.5`. Voir `MIGRATION_PLAN.md`.
--
-- CE QUE CETTE DESCENTE PEUT DETRUIRE : les douze lignes semees ne sont que la copie de ce que
-- `baremes_intervention` contient deja, donc leur perte est nulle. Mais toute duree de vie,
-- tout effet sur l'indice ou toute fenetre de realisation SAISIS APRES LE SEMIS -- precisement
-- les valeurs que le paragraphe 7.7 attend et que le semis a laissees nulles -- disparaitraient
-- sans recours, avec leur approbation.
--
-- COMPTER AVANT :
--
--   SELECT count(*) FILTER (WHERE "dureeVieAttendueAns" IS NOT NULL
--                              OR "effetSurIndice" IS NOT NULL
--                              OR "fenetreRealisation" IS NOT NULL) AS renseignes,
--          count(*) FILTER (WHERE "approuveLe" IS NOT NULL)        AS approuves,
--          count(*) FILTER (WHERE "source" <> 'standard_initial')  AS ajoutes
--     FROM catalogue_traitements;
--
-- Si l'un de ces comptes n'est pas nul, la descente EXIGE une sauvegarde verifiee et une
-- autorisation explicite (paragraphe A.5.2). Le paragraphe A.5.8 interdit toute suppression
-- silencieuse.
--
-- ORDRE : les conditions d'abord, le catalogue ensuite -- la cle etrangere l'impose.

DROP TABLE IF EXISTS "conditions_traitement";
DROP TABLE IF EXISTS "catalogue_traitements";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261014220000_catalogue_traitements';
--
-- Volontairement absente : ce geste doit etre conscient, pas un effet de bord.
