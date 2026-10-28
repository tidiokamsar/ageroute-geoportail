-- RETOUR ARRIERE de `20261026400000_extension_unaccent`.
--
-- CE QUI EST PERDU : rien. La migration ne creait qu'une extension, et cette descente la LAISSE EN PLACE.
--
-- RESIDU VOLONTAIRE : l'extension `unaccent` reste installee, pour trois raisons.
--   1. Elle peut avoir ete installee AVANT cette migration : c'est le cas en production, ou elle a ete
--      creee a la main. Une descente ne sait pas distinguer l'extension qu'elle a posee de celle qu'elle
--      a trouvee ; la retirer casserait la carte publique et le rattachement des chantiers.
--   2. Des objets peuvent s'etre mis a en dependre depuis (vue, valeur par defaut, colonne generee) :
--      un `DROP EXTENSION` sans CASCADE echouerait, avec CASCADE il les detruirait en silence.
--   3. Le code applicatif (chantiers.service.ts, qualite.routes.ts) continue de l'appeler : sans elle,
--      GET /api/public/carte/geo repond 500.
-- Une extension inutilisee ne coute rien. Pour la retirer malgre tout, a la main et apres avoir verifie
-- qu'aucun objet n'en depend : `DROP EXTENSION unaccent;` (sans CASCADE).
-- RESIDU-ACCEPTE: ext[|]unaccent[|]
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261026400000_extension_unaccent.sql

SELECT 1 AS "descente 20261026400000_extension_unaccent : extension unaccent laissee en place";

-- Et la ligne de `_prisma_migrations` :
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261026400000_extension_unaccent';
