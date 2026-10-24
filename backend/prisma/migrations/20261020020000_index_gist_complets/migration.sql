-- INDEX GiST SUR TOUTES LES COLONNES GEOMETRIQUES (paragraphe 7.1)
--
-- « Index GiST sur toutes les colonnes geometriques » -- paragraphe 7.1, verrouille.
--
-- LE CONSTAT DU 20/10/2026 : sur la base rejouee depuis les migrations, six colonnes geometriques
-- n'avaient AUCUN index GiST -- chantiers.geom, missions.itineraire, ouvrages.geom,
-- points_noirs.geom, postes.geom, propositions_localisation.geom. troncons.geom en a un, sur
-- l'expression `(geom::geography)`.
--
-- POURQUOI SUR L'EXPRESSION GEOGRAPHIQUE, ET PAS « USING GIST (geom) »
--
-- La forme d'interrogation du depot est `ST_DWithin(x.geom::geography, ..., rayon_m)` (voir
-- field/contexte.prisma.ts : actifs autour d'une position). Un index planaire sur `geom` n'est PAS
-- utilise par ce predicat : c'est ce que la mesure du 14/10 a etabli sur troncons -- 151 ms en
-- parcours sequentiel avec l'index planaire, 19,6 ms avec l'index sur l'expression geographique
-- (migration 20260901170000, docs/rai-v3/23_PLAN_ACHEVEMENT.md, ligne 0.4). On reprend donc la
-- forme mesuree, au lieu d'en poser une que la mesure a dementie.
--
-- CE QUI N'EST PAS MESURE : le gain sur ces six tables. La base de rejeu n'a pas leurs donnees et
-- la production est gelee. L'index est pose parce que le paragraphe 7.1 l'exige et que sa forme est
-- celle qui sert le predicat employe ; son effet se mesurera au premier deploiement autorise.
--
-- NATURE : additive. Six index. Sur ces tables (quelques milliers de lignes au plus), la creation
-- est breve ; elle prend un verrou en ecriture le temps de la construire. `IF NOT EXISTS` sur le
-- NOM : si la production portait deja un index equivalent sous un autre nom, il y aurait doublon,
-- a verifier avant deploiement (`\di+` sur ces tables) -- inscrit au plan de migration.

CREATE INDEX IF NOT EXISTS "chantiers_geom_geography_gist" ON "chantiers" USING GIST (("geom"::geography));
CREATE INDEX IF NOT EXISTS "missions_itineraire_geography_gist" ON "missions" USING GIST (("itineraire"::geography));
CREATE INDEX IF NOT EXISTS "ouvrages_geom_geography_gist" ON "ouvrages" USING GIST (("geom"::geography));
CREATE INDEX IF NOT EXISTS "points_noirs_geom_geography_gist" ON "points_noirs" USING GIST (("geom"::geography));
CREATE INDEX IF NOT EXISTS "postes_geom_geography_gist" ON "postes" USING GIST (("geom"::geography));
CREATE INDEX IF NOT EXISTS "propositions_localisation_geom_geography_gist" ON "propositions_localisation" USING GIST (("geom"::geography));
