-- Coordonnees GPS et precision du releve sur les inspections.
--
-- POURQUOI
--
-- La saisie terrain capture deja la position de l'agent : InspectionTerrainPage la
-- lit, offlineDb la conserve dans le payload local. Mais le corps envoye a l'API ne
-- la transmettait pas — et surtout, le modele Inspection n'avait NI lat, NI lon, NI
-- geometrie. Il n'existait aucun endroit ou la mettre.
--
-- Consequence : l'agent releve sa position sur le terrain, l'application la garde
-- hors ligne, puis la perd definitivement a la synchronisation. Pour un geoportail,
-- c'est la donnee la plus difficile a recollecter — il faut retourner sur place.
--
-- PRECISION
--
-- `precisionM` retient l'incertitude annoncee par le telephone (coords.accuracy).
-- Une position a plus ou moins 500 m rattachee a un troncon precis cree une donnee
-- fausse, plus couteuse que pas de donnee : conserver la precision permet de decider
-- quoi en faire plutot que de la croire exacte.
--
-- La geometrie n'est PAS creee ici. Une colonne geometry(Point,4326) demanderait un
-- index GIST, et la mesure du 01/09 a montre que la FORME de l'index compte : sur la
-- table troncons, un index sur geom etait ignore la ou un index sur (geom::geography)
-- divisait le temps par quarante. Le jour ou les inspections seront interrogees
-- spatialement, la colonne et son index seront ajoutes ensemble, apres mesure.

ALTER TABLE "inspections"
  ADD COLUMN IF NOT EXISTS "lat"        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "lon"        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "precisionM" DOUBLE PRECISION;
