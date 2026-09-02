#!/usr/bin/env bash
#
# P4 — Croisement franchissements OSM x ouvrages BDRI (lecture seule).
#
# POURQUOI
#
# L'extraction OSM 2023 identifie 2 698 Pont, 441 Gue et 39 Tunnel ; la BDRI ne
# reference que 126 ouvrages d'art. Ce script mesure, pour chaque franchissement
# OSM, la distance a l'ouvrage BDRI le plus proche, et classe :
#
#   PONT_BDRI_PROCHE_25M    un ouvrage BDRI (type pont/ponceau) a <= 25 m
#   PONT_BDRI_PROCHE_250M   un ouvrage BDRI a <= 250 m (correspondance probable)
#   PONT_SANS_OUVRAGE       rien a <= 250 m  -> PROPOSITION d'ouvrage manquant
#
# Ce sont des RESULTATS D'ANALYSE. Aucun ouvrage n'est cree : la regle Phase 5
# (jamais d'import automatique, propositions a valider par le metier) s'applique.
# Les dalots/buses BDRI sont aussi comptes comme correspondance possible : un
# passage signalé Pont par OSM peut avoir été saisi comme dalot.
#
# Usage (sur le serveur, conteneur phase5-analyse actif) :
#   ./croiser-ponts-osm.sh chemin/osm-franchissements.tsv
# Sortie : ~/phase5-resultats/ponts-osm-propositions.tsv + stdout

set -euo pipefail

CONTENEUR="${CONTENEUR:-phase5-analyse}"
BASE="verification"
FICHIER="${1:?chemin du TSV franchissements requis}"
RESULTATS="$HOME/phase5-resultats"

q()  { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$1"; }
qt() { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "$1"; }
titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }

mkdir -p "$RESULTATS"

printf '\033[1mCroisement franchissements OSM x ouvrages BDRI — %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M')"

titre "1. Chargement des franchissements (lecture seule)"
q "DROP TABLE IF EXISTS osm_franchissement CASCADE;
CREATE TABLE osm_franchissement (id text, nature text, numero text, nom text, franchissement text, wkt text);"
docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" \
  -c "\copy osm_franchissement FROM STDIN WITH (FORMAT csv, DELIMITER E'\t', NULL '')" < "$FICHIER" >/dev/null
q "SELECT AddGeometryColumn('public','osm_franchissement','geom',4326,'GEOMETRY',2);" >/dev/null
q "UPDATE osm_franchissement SET geom = ST_GeomFromText(wkt, 4326);" >/dev/null
q "CREATE INDEX osm_franch_geog ON osm_franchissement USING GIST ((geom::geography));" >/dev/null
info_ouvrages=$(q "SELECT count(*) || ' ouvrages BDRI, dont ' || count(*) FILTER (WHERE geom IS NOT NULL) || ' localisés' FROM ouvrages")
echo "  $(q 'SELECT count(*) FROM osm_franchissement') franchissements chargés ; $info_ouvrages"

titre "2. Contexte : où passent les franchissements sans ouvrage ?"
# Un franchissement sans ouvrage BDRI est-il sur une route connue de la BDRI ?
qt "SELECT f.franchissement,
       count(*) AS total,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM troncons t
         WHERE t.\"deletedAt\" IS NULL AND ST_DWithin(f.geom::geography, t.geom::geography, 100))) AS sur_troncon_bdri
FROM osm_franchissement f GROUP BY 1 ORDER BY 2 DESC;"

titre "3. Classement par distance a l'ouvrage BDRI le plus proche"
q "DROP TABLE IF EXISTS ponts_classement;
CREATE TABLE ponts_classement AS
SELECT f.id, f.franchissement, f.nature, f.numero, f.nom,
       round((ST_Length(f.geom::geography))::numeric, 0) AS longueur_m,
       o.id AS ouvrage_proche_id, o.nom AS ouvrage_proche_nom, o.type AS ouvrage_proche_type,
       round(ST_Distance(f.geom::geography, o.geom::geography)::numeric, 0) AS distance_m,
       (SELECT r.nom FROM troncons t JOIN regions r ON r.id = t.\"regionId\"
          WHERE t.\"deletedAt\" IS NULL AND t.geom IS NOT NULL
          ORDER BY t.geom <-> ST_PointOnSurface(f.geom) LIMIT 1) AS region_indicative,
       CASE
         WHEN o.id IS NULL THEN 'PONT_SANS_OUVRAGE'
         WHEN ST_Distance(f.geom::geography, o.geom::geography) <= 25  THEN 'PONT_BDRI_PROCHE_25M'
         WHEN ST_Distance(f.geom::geography, o.geom::geography) <= 250 THEN 'PONT_BDRI_PROCHE_250M'
         ELSE 'PONT_SANS_OUVRAGE'
       END AS classement
FROM osm_franchissement f
LEFT JOIN LATERAL (
  SELECT id, nom, type, geom FROM ouvrages
  WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL
  ORDER BY geom <-> ST_PointOnSurface(f.geom) LIMIT 1
) o ON true;"

qt "SELECT classement, franchissement, count(*),
       count(*) FILTER (WHERE nature LIKE '%rapide%' OR nature LIKE '%primaire%' OR nature LIKE '%secondaire%') AS sur_axe_majeur
FROM ponts_classement GROUP BY 1, 2 ORDER BY 3 DESC;"

titre "4. Les ponts sans ouvrage BDRI, par region indicative"
qt "SELECT region_indicative, count(*), sum(longueur_m) AS metres_de_pont
FROM ponts_classement WHERE classement = 'PONT_SANS_OUVRAGE' AND franchissement = 'Pont'
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;"

titre "5. Les 15 plus longues traversées sans aucun ouvrage BDRI"
qt "SELECT nature, coalesce(numero,''), coalesce(nom,''), longueur_m, distance_m, region_indicative
FROM ponts_classement WHERE classement = 'PONT_SANS_OUVRAGE' AND franchissement = 'Pont'
ORDER BY longueur_m DESC LIMIT 15;"

titre "6. Export des propositions > $RESULTATS/ponts-osm-propositions.tsv"
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tA -F$'\t' -c \
 "SELECT classement, franchissement, nature, numero, nom, longueur_m,
         coalesce(distance_m::text,''), coalesce(ouvrage_proche_type::text,''), coalesce(ouvrage_proche_nom,''),
         region_indicative, id
  FROM ponts_classement ORDER BY classement, franchissement, longueur_m DESC;" \
  > "$RESULTATS/ponts-osm-propositions.tsv"
wc -l "$RESULTATS/ponts-osm-propositions.tsv"
printf '\nAucune donnée modifiée. Ce fichier est une liste de PROPOSITIONS pour la Direction Technique.\n'
