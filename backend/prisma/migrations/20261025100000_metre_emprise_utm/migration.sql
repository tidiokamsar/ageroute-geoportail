-- METRE D'UN DEFAUT PAR SON EMPRISE RELEVEE, EN PROJECTION UTM (paragraphe 7.1, scenario A5)
--
-- `20261020010000_metre_utm` a donne a la base `metre_utm(geom)`, mais aucun releve ne s'en
-- servait : les defauts se metraient par mesures (longueur, largeur...) et leur colonne `emprise`
-- n'etait jamais ecrite. Desormais un defaut contourne au GPS (ligne pour un defaut lineaire,
-- polygone pour un defaut surfacique) peut etre metre par son emprise, quand l'agent n'a pas
-- donne de mesures.
--
-- CE QUE CETTE MIGRATION FAIT : une valeur d'enumeration, `EMPRISE_UTM`, pour dire d'ou vient la
-- quantite. Elle est DERIVEE (calculee depuis une geometrie), jamais OBSERVEE.
--
-- `ALTER TYPE ADD VALUE` ne se retire pas en PostgreSQL : la descente reconstruit le type, et
-- refuse si un defaut porte la valeur (aucune valeur de remplacement n'est inventee).
--
-- NATURE : additive. Aucune ligne touchee.

ALTER TYPE "MethodeQuantite" ADD VALUE IF NOT EXISTS 'EMPRISE_UTM';
