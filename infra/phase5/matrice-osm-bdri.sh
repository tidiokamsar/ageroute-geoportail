#!/usr/bin/env bash
#
# Phase 5 — Matrice de correspondance BDRI x OSM par famille (P5-02).
#
# POURQUOI
#
# La Phase 4 a mesure le recouvrement par classe BDRI (RN 90,7 %, RR 2,5 %) sans
# discriminer par NATURE OSM. L'hypothese de correspondance RN=primary,
# RR=secondary, RU=tertiary reste une hypothese : cette matrice la teste.
# Pour chaque couple (classe BDRI x nature OSM) : part du lineaire BDRI de cette
# classe a moins de 25 m d'un segment OSM de cette nature.
#
# Methode : echantillonnage 100 m (identique a la Phase 4), un EXISTS par couple.
# Lecture seule sur le conteneur d'analyse.
#
# Usage : ./matrice-osm-bdri.sh   (prerequis : preparer-analyse.sh)

set -euo pipefail

CONTENEUR="${CONTENEUR:-phase5-analyse}"
BASE="verification"
RESULTATS="$HOME/phase5-resultats"
mkdir -p "$RESULTATS"

q()  { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$1"; }
qt() { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "$1"; }
titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }

printf '\033[1mMatrice BDRI x OSM par famille — %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M')"

titre "1. Points echantillons de TOUT le reseau BDRI (100 m)"
q "DROP TABLE IF EXISTS bdri_points CASCADE;
CREATE TABLE bdri_points AS
SELECT t.id, t.classe, t.code LIKE 'RES-%' AS est_res,
       (ST_DumpPoints(ST_Segmentize(t.geom::geography, 100)::geometry)).geom AS p
FROM troncons t WHERE t.\"deletedAt\" IS NULL AND t.geom IS NOT NULL;
CREATE INDEX bdri_points_geog ON bdri_points USING GIST ((p::geography));"
info_count=$(q 'SELECT count(*) FROM bdri_points')
echo "  $info_count points"

titre "2. Mesure par couple classe BDRI x nature OSM (25 m)"
q "DROP TABLE IF EXISTS matrice;
CREATE TABLE matrice AS
WITH natures AS (
  SELECT unnest(ARRAY['Voie rapide','Route primaire','Route secondaire','Route tertiaire']) AS nature
)
SELECT b.classe, b.est_res, n.nature, count(*) AS pts,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM osm_classe o WHERE o.nature = n.nature
           AND ST_DWithin(b.p::geography, o.geom::geography, 25))) AS pts_a_25m
FROM bdri_points b CROSS JOIN natures n
GROUP BY b.classe, b.est_res, n.nature;"

titre "3. La matrice (part du lineaire a 25 m de la nature OSM)"
qt "SELECT classe, CASE WHEN est_res THEN 'RES-* (le lot)' ELSE 'hors lot RES (toutes origines)' END AS origine,
       MAX(CASE WHEN nature='Voie rapide'      THEN round(100.0*pts_a_25m/pts,1) END) AS voie_rapide,
       MAX(CASE WHEN nature='Route primaire'   THEN round(100.0*pts_a_25m/pts,1) END) AS primaire,
       MAX(CASE WHEN nature='Route secondaire' THEN round(100.0*pts_a_25m/pts,1) END) AS secondaire,
       MAX(CASE WHEN nature='Route tertiaire'  THEN round(100.0*pts_a_25m/pts,1) END) AS tertiaire
FROM matrice
GROUP BY classe, est_res ORDER BY classe, origine DESC;"

titre "4. Export > $RESULTATS/matrice-osm-bdri.tsv"
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tA -F$'\t' -c \
 "SELECT classe, est_res, nature, pts, pts_a_25m, round(100.0*pts_a_25m/pts,2) AS pct_25m
  FROM matrice ORDER BY classe, est_res DESC, nature;" > "$RESULTATS/matrice-osm-bdri.tsv"
wc -l "$RESULTATS/matrice-osm-bdri.tsv"
printf '\nMatrice terminée. Hypothèse RN=primary / RR=secondary / RU=tertiary : lecture en diagonale.\n'
