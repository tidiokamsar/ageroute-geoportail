#!/usr/bin/env bash
#
# Phase 5 — Les ~9 500 km OSM classés absents de la BDRI (P5-03).
#
# POURQUOI
#
# La Phase 4 a mesure que 10,7 % seulement du lineaire tertiaire OSM etait a
# 25 m d'un troncon BDRI. Ce script identifie SEGMENT PAR SEGMENT ce qui manque,
# avec une classification analytique explicite — aucune de ces categories ne
# devient une route BDRI sans decision humaine.
#
# METHODE
#
# Par segment OSM classe : part du lineaire (points 100 m) a moins de 250 m d'un
# troncon BDRI -> couverture s250. Categories :
#
#   LIKELY_DUPLICATE          s250 >= 0,5  (essentiellement represente dans la BDRI)
#   POTENTIAL_BDRI_MISSING    s250 < 0,1 ET (nature non tertiaire OU longueur >= 3 km)
#   LIKELY_LOCAL_ROAD         s250 < 0,1 ET tertiaire ET longueur < 3 km
#   OUTSIDE_BDRI_SCOPE        0,1 <= s250 < 0,5 ET tertiaire (reseau local, hors
#                             perimetre PROBABLE — statut INFERE, a valider)
#   UNDETERMINED              le reste
#
# Le contexte administratif n'existe pas (cf. REFERENTIEL-ADMINISTRATIF-SPEC.md) :
# la region du troncon BDRI le plus proche est donnee a titre d'indication seulement.
#
# Usage : ./osm-manquant.sh   (prerequis : preparer-analyse.sh)

set -euo pipefail

CONTENEUR="${CONTENEUR:-phase5-analyse}"
BASE="verification"
RESULTATS="$HOME/phase5-resultats"
mkdir -p "$RESULTATS"

q()  { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$1"; }
qt() { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "$1"; }
titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }

printf '\033[1mRéseau OSM classé sans correspondance BDRI — %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M')"

titre "1. Points echantillons du reseau OSM classe (100 m)"
q "DROP TABLE IF EXISTS osm_points CASCADE;
CREATE TABLE osm_points AS
SELECT o.id, o.nature, o.numero,
       (ST_DumpPoints(ST_Segmentize(o.geom::geography, 100)::geometry)).geom AS p
FROM osm_classe o;
CREATE INDEX osm_points_geog ON osm_points USING GIST ((p::geography));"
echo "  $(q 'SELECT count(*) FROM osm_points') points"

titre "2. Couverture BDRI par segment (25 / 250 m)"
q "DROP TABLE IF EXISTS osm_seg_mesure;
CREATE TABLE osm_seg_mesure AS
SELECT m.id, m.nature, m.numero,
       count(*) AS pts,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM troncons t
         WHERE t.\"deletedAt\" IS NULL AND t.geom IS NOT NULL
           AND ST_DWithin(m.p::geography, t.geom::geography, 25))) AS pts_25,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM troncons t
         WHERE t.\"deletedAt\" IS NULL AND t.geom IS NOT NULL
           AND ST_DWithin(m.p::geography, t.geom::geography, 250))) AS pts_250
FROM osm_points m GROUP BY m.id, m.nature, m.numero;"

titre "3. Classification analytique (seuils en en-tete)"
q "DROP TABLE IF EXISTS osm_manquant;
CREATE TABLE osm_manquant AS
WITH s AS (
  SELECT o.id, o.nature, o.numero,
         round((ST_Length(o.geom::geography)/1000)::numeric, 3) AS km,
         mm.pts, mm.pts_25, mm.pts_250,
         mm.pts_250::numeric / NULLIF(mm.pts, 0) AS s250,
         mm.pts_25::numeric  / NULLIF(mm.pts, 0) AS s25,
         (SELECT r.nom FROM troncons t JOIN regions r ON r.id = t.\"regionId\"
          WHERE t.\"deletedAt\" IS NULL AND t.geom IS NOT NULL
          ORDER BY t.geom <-> ST_PointOnSurface(o.geom) LIMIT 1) AS region_proche
  FROM osm_classe o JOIN osm_seg_mesure mm ON mm.id = o.id
)
SELECT *,
  CASE
    WHEN s250 >= 0.5 THEN 'LIKELY_DUPLICATE'
    WHEN s250 < 0.1 AND (nature <> 'Route tertiaire' OR km >= 3) THEN 'POTENTIAL_BDRI_MISSING'
    WHEN s250 < 0.1 AND nature = 'Route tertiaire' AND km < 3 THEN 'LIKELY_LOCAL_ROAD'
    WHEN s250 < 0.5 AND nature = 'Route tertiaire' THEN 'OUTSIDE_BDRI_SCOPE'
    ELSE 'UNDETERMINED'
  END AS categorie
FROM s;"

titre "4. Resultats par categorie et par nature"
qt "SELECT categorie, nature, count(*) AS segments, round(sum(km)) AS km,
       round(avg(km), 2) AS km_moyen
FROM osm_manquant GROUP BY categorie, nature
ORDER BY sum(km) DESC;"

titre "5. Le defaut original : combien manquent reellement"
qt "SELECT count(*) FILTER (WHERE categorie = 'POTENTIAL_BDRI_MISSING') AS segments_manquants,
       round(sum(km) FILTER (WHERE categorie = 'POTENTIAL_BDRI_MISSING')) AS km_manquants,
       count(*) FILTER (WHERE categorie = 'LIKELY_LOCAL_ROAD') AS segments_locaux,
       round(sum(km) FILTER (WHERE categorie = 'LIKELY_LOCAL_ROAD')) AS km_locaux
FROM osm_manquant;"

titre "6. Les 20 plus gros segments POTENTIAL_BDRI_MISSING"
qt "SELECT nature, numero, km, region_proche FROM osm_manquant
WHERE categorie = 'POTENTIAL_BDRI_MISSING' ORDER BY km DESC LIMIT 20;"

titre "7. Export > $RESULTATS/osm-manquant.tsv"
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tA -F$'\t' -c \
 "SELECT nature, coalesce(numero,''), km, region_proche,
         round(s25::numeric,3), round(s250::numeric,3), categorie
  FROM osm_manquant ORDER BY km DESC;" > "$RESULTATS/osm-manquant.tsv"
wc -l "$RESULTATS/osm-manquant.tsv"
printf '\nAnalyse terminée. Aucune catégorie ne devient une route BDRI sans décision humaine.\n'
