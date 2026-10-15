-- RETOUR ARRIERE de `20261015010000_main_courante`.
--
-- CE QUE CETTE DESCENTE DETRUIT : LA MAIN COURANTE ELLE-MEME, c'est-a-dire la preuve de ce
-- qu'AGEROUTE savait et a quel moment. C'est, de toutes les descentes de ce depot, celle qui
-- efface le plus : un journal probatoire ne se reconstitue pas.
--
-- COMPTER AVANT, et tenir ce compte pour une decision humaine :
--
--   SELECT count(*) AS entrees, count(DISTINCT "evenementId") AS evenements,
--          min("enregistreLe") AS premiere, max("enregistreLe") AS derniere
--     FROM main_courante;
--
-- Si `entrees` n'est pas nul, la descente EXIGE une sauvegarde verifiee ET une autorisation
-- explicite (paragraphe A.5.2) -- et il faut se demander pourquoi on descend une table concue
-- pour ne jamais rien perdre.
--
-- Les deux referentiels (types, sources) sont conserves : vocabulaires administrables, une
-- table orpheline ne gene rien, et des valeurs propres a AGEROUTE ont pu y etre ajoutees.
--
-- ORDRE : la vue, le declencheur et sa fonction, la table, les types.

DROP VIEW IF EXISTS "evenements_exploitation";
DROP TRIGGER IF EXISTS main_courante_ajout_seul ON "main_courante";
-- Le declencheur refuse les DELETE ligne a ligne ; DROP TABLE n'est pas un DELETE et passe.
DROP TABLE IF EXISTS "main_courante";
DROP FUNCTION IF EXISTS main_courante_immuable();
DROP TYPE IF EXISTS "NatureEntreeMainCourante";
DROP TYPE IF EXISTS "StatutEvenement";

-- Pour retirer sciemment les referentiels :
--   DROP TABLE IF EXISTS "referentiel_types_evenement";
--   DROP TABLE IF EXISTS "referentiel_sources_evenement";
-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261015010000_main_courante';
