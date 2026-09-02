#!/usr/bin/env bash
#
# Phase 5 — Autopsie du lot RES-* (P5-01).
#
# POURQUOI
#
# 1 028 tronçons BDRI portent un code RES-<ogc_fid> : un code de repli posé par
# la migration legacy pour des lignes sans identifiant métier. La Phase 4 a
# mesuré qu'ils ne se recouvrent qu'à 2,5 % avec le réseau OSM classé. Ce script
# établit, pour chaque RES-*, une fiche d'identité spatiale complète et une
# typologie ANALYTIQUE — sans toucher au champ classe ni à aucune donnée.
#
# METHODE
#
# Par tronçon : longueur géométrique vs métier, sommets, densité, bbox,
# orientation moyenne, intersections, composante connexe, distance au plus
# proche RN/RR/RU/OSM classé, part du linéaire à 25/100/250 m du réseau OSM
# classé, des chemins (pistes OSM, couche CHEMIN), et d'AUTRES tronçons BDRI
# (détection de doublons). La typologie applique des seuils EXPLICITES :
#
#   RES_DUPLICATE_OR_OVERLAP     >= 50 % du linéaire à 25 m d'un autre tronçon BDRI
#   RES_CONFIRMED_ROAD           >= 80 % du linéaire à 25 m d'une route OSM classée
#   RES_OUTSIDE_REFERENCE_NETWORK< 10 % à 250 m d'OSM classé ET < 10 % à 250 m d'un chemin
#   RES_POSSIBLE_ROAD            >= 50 % à 100 m d'OSM classé OU >= 50 % à 25 m d'un chemin
#   RES_UNDETERMINED             tout le reste
#
# Ces catégories sont des résultats d'analyse, pas des modifications.
# Lecture seule sur la copie restaurée (conteneur phase5-analyse).
#
# Usage : ./autopsie-res.sh   (prérequis : preparer-analyse.sh + interroger-legacy.sh)

set -euo pipefail

CONTENEUR="${CONTENEUR:-phase5-analyse}"
BASE="verification"
RESULTATS="$HOME/phase5-resultats"

q()  { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$1"; }
qt() { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "$1"; }
titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }

mkdir -p "$RESULTATS"
printf '\033[1mAutopsie du lot RES-* — %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M')"

# La table des attributs legacy (interroger-legacy.sh) rejoint l'analyse.
q "DROP TABLE IF EXISTS legacy_res CASCADE;
CREATE TABLE legacy_res (ogc_fid int, nom_route text, name text, nom_region text,
                         classement text, etat text, longueur numeric, trafic_jma numeric,
                         km_geometrique numeric, sommets int);"
[ -s "$RESULTATS/legacy-res.tsv" ] && docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" \
    -c "\copy legacy_res FROM STDIN WITH (FORMAT csv, DELIMITER E'\t', NULL '')" < "$RESULTATS/legacy-res.tsv" >/dev/null
info "attributs legacy chargés : $(q 'SELECT count(*) FROM legacy_res')"

# ─────────────────────────────────────────────────────────────
titre "1. Fiches d'identité géométriques (toutes classes, colonne typologie en fin de script)"
q "DROP TABLE IF EXISTS res_fiche CASCADE;
CREATE TABLE res_fiche AS
SELECT t.id, t.code, t.classe, t.nom, t.\"longueurKm\" AS longueur_metier,
       r.nom AS region,
       round((ST_Length(t.geom::geography)/1000)::numeric, 3) AS km_geometrique,
       ST_NPoints(t.geom) AS sommets,
       round((ST_NPoints(t.geom) / NULLIF(ST_Length(t.geom::geography)/1000, 0))::numeric, 2) AS sommets_par_km,
       round(ST_XMin(t.geom)::numeric, 5) AS bbox_xmin, round(ST_YMin(t.geom)::numeric, 5) AS bbox_ymin,
       round(ST_XMax(t.geom)::numeric, 5) AS bbox_xmax, round(ST_YMax(t.geom)::numeric, 5) AS bbox_ymax,
       degrees(ST_Azimuth(ST_StartPoint(t.geom), ST_EndPoint(t.geom)))::int AS azimut_global,
       l.nom_region AS legacy_region, l.classement AS legacy_classement, l.etat AS legacy_etat,
       l.km_geometrique AS legacy_km, l.nom_route AS legacy_nom
FROM troncons t
JOIN regions r ON r.id = t.\"regionId\"
LEFT JOIN legacy_res l ON l.ogc_fid = nullif(regexp_replace(t.code, '^RES-', ''), '')::int
WHERE t.\"deletedAt\" IS NULL AND t.geom IS NOT NULL AND t.code LIKE 'RES-%';
CREATE INDEX res_fiche_id ON res_fiche(id);"
info "$(q 'SELECT count(*) FROM res_fiche') tronçons RES-*"

titre "2. Orientation moyenne pondérée par la longueur des segments (moyenne circulaire)"
q "DROP VIEW IF EXISTS res_orientation CASCADE;
CREATE VIEW res_orientation AS
WITH seg AS (
  SELECT f.id,
         ST_Azimuth(p.geom, lead(p.geom) OVER (PARTITION BY f.id ORDER BY p.path)) AS az,
         ST_Distance(p.geom, lead(p.geom) OVER (PARTITION BY f.id ORDER BY p.path)) AS d
  FROM res_fiche f
  JOIN troncons t ON t.id = f.id,
       LATERAL (SELECT (ST_DumpPoints(t.geom)).geom, (ST_DumpPoints(t.geom)).path) p
)
SELECT id, degrees(atan2(sum(sin(az)*d), sum(cos(az)*d)))::int AS azimut_moyen
FROM seg WHERE d IS NOT NULL AND d > 0 GROUP BY id;" >/dev/null
info "orientation moyenne par tronçon (vue res_orientation)"

titre "3. Composantes connexes du réseau BDRI (ST_ClusterIntersecting, intersection géométrique stricte)"
q "DROP TABLE IF EXISTS composantes CASCADE;
CREATE TABLE composantes AS
WITH clusters AS (
  SELECT row_number() OVER () AS composante, unnest(ST_ClusterIntersecting(geom)) AS c
  FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL
)
SELECT t.id, cl.composante
FROM troncons t JOIN clusters cl ON ST_Intersects(t.geom, cl.c)
WHERE t.\"deletedAt\" IS NULL AND t.geom IS NOT NULL;
CREATE INDEX composantes_id ON composantes(id);"
info "composantes : $(q 'SELECT count(DISTINCT composante) FROM composantes')"
qt "SELECT t.classe, count(DISTINCT c.composante) AS composantes,
       count(*) FILTER (WHERE nb_membres > 1) AS troncons_connectes
FROM (SELECT composante, count(*) AS nb_membres FROM composantes GROUP BY 1) c
JOIN composantes m ON m.composante = c.composante
JOIN troncons t ON t.id = m.id
GROUP BY t.classe ORDER BY t.classe;"

titre "4. Intersections géométriques entre RES-* et le reste du réseau"
q "DROP VIEW IF EXISTS res_intersections;
CREATE VIEW res_intersections AS
SELECT f.id, count(o.id) AS intersections
FROM res_fiche f JOIN troncons t ON t.id = f.id
JOIN troncons o ON o.id <> f.id AND o.\"deletedAt\" IS NULL AND o.geom IS NOT NULL
              AND ST_Intersects(t.geom, o.geom)
GROUP BY f.id;" >/dev/null
info "intersections calculées"

# ─────────────────────────────────────────────────────────────
titre "5. Échantillonnage (100 m) et mesures de proximité — l'étape lourde"
q "DROP TABLE IF EXISTS res_points CASCADE;
CREATE TABLE res_points AS
SELECT t.id,
       (ST_DumpPoints(ST_Segmentize(t.geom::geography, 100)::geometry)).geom AS p
FROM troncons t
JOIN res_fiche f ON f.id = t.id
WHERE t.geom IS NOT NULL;
CREATE INDEX res_points_geog ON res_points USING GIST ((p::geography));"
info "points échantillonnés : $(q 'SELECT count(*) FROM res_points')"

q "DROP TABLE IF EXISTS res_points_mesure CASCADE;
CREATE TABLE res_points_mesure AS
SELECT rp.id,
  EXISTS (SELECT 1 FROM osm_classe o WHERE ST_DWithin(rp.p::geography, o.geom::geography, 25))   AS osm25,
  EXISTS (SELECT 1 FROM osm_classe o WHERE ST_DWithin(rp.p::geography, o.geom::geography, 100))  AS osm100,
  EXISTS (SELECT 1 FROM osm_classe o WHERE ST_DWithin(rp.p::geography, o.geom::geography, 250))  AS osm250,
  EXISTS (SELECT 1 FROM osm_chemin c WHERE c.nature = 'Chemin'
          AND ST_DWithin(rp.p::geography, c.geom::geography, 25))                                AS chemin25,
  EXISTS (SELECT 1 FROM osm_chemin c WHERE c.nature = 'Chemin'
          AND ST_DWithin(rp.p::geography, c.geom::geography, 100))                               AS chemin100,
  EXISTS (SELECT 1 FROM osm_chemin c WHERE ST_DWithin(rp.p::geography, c.geom::geography, 250))  AS tout_chemin250,
  EXISTS (SELECT 1 FROM troncons o WHERE o.id <> rp.id AND o.\"deletedAt\" IS NULL AND o.geom IS NOT NULL
          AND ST_DWithin(rp.p::geography, o.geom::geography, 25))                                AS autre_troncon25
FROM res_points rp;"
info "mesures par point : $(q 'SELECT count(*) FROM res_points_mesure')"

titre "6. Plus proches voisins par tronçon (KNN centroïde, distance exacte ensuite)"
q "DROP TABLE IF EXISTS res_plus_proches CASCADE;
CREATE TABLE res_plus_proches AS
SELECT f.id,
       (SELECT round(min(ST_Distance(t.geom::geography, o.geom::geography))::numeric, 0)
          FROM (SELECT g.geom FROM osm_classe g ORDER BY g.geom <-> ST_Centroid(t.geom) LIMIT 5) o) AS dist_osm_classe_m,
       (SELECT round(min(ST_Distance(t.geom::geography, o.geom::geography))::numeric, 0)
          FROM (SELECT g.geom FROM osm_chemin g WHERE g.nature = 'Chemin'
                ORDER BY g.geom <-> ST_Centroid(t.geom) LIMIT 5) o) AS dist_chemin_m,
       (SELECT round(ST_Distance(t.geom::geography, o.geom::geography)::numeric, 0)
          FROM troncons o WHERE o.\"deletedAt\" IS NULL AND o.geom IS NOT NULL AND o.classe = 'RN'
          ORDER BY o.geom <-> ST_Centroid(t.geom) LIMIT 1) AS dist_rn_m,
       (SELECT round(ST_Distance(t.geom::geography, o.geom::geography)::numeric, 0)
          FROM troncons o WHERE o.\"deletedAt\" IS NULL AND o.geom IS NOT NULL AND o.classe = 'RR'
                AND o.id <> t.id
          ORDER BY o.geom <-> ST_Centroid(t.geom) LIMIT 1) AS dist_rr_m,
       (SELECT round(ST_Distance(t.geom::geography, o.geom::geography)::numeric, 0)
          FROM troncons o WHERE o.\"deletedAt\" IS NULL AND o.geom IS NOT NULL AND o.classe = 'RU'
          ORDER BY o.geom <-> ST_Centroid(t.geom) LIMIT 1) AS dist_ru_m
FROM res_fiche f JOIN troncons t ON t.id = f.id;" >/dev/null
info "plus proches voisins calculés"

# ─────────────────────────────────────────────────────────────
titre "7. Synthèse par tronçon + typologie (seuils explicites, voir en-tête)"
q "DROP TABLE IF EXISTS res_synthese CASCADE;
CREATE TABLE res_synthese AS
WITH part AS (
  SELECT m.id,
         count(*)::numeric AS pts,
         avg(CASE WHEN m.osm25 THEN 1 ELSE 0 END)             AS p_osm25,
         avg(CASE WHEN m.osm100 THEN 1 ELSE 0 END)            AS p_osm100,
         avg(CASE WHEN m.osm250 THEN 1 ELSE 0 END)            AS p_osm250,
         avg(CASE WHEN m.chemin25 THEN 1 ELSE 0 END)          AS p_chemin25,
         avg(CASE WHEN m.chemin100 THEN 1 ELSE 0 END)         AS p_chemin100,
         avg(CASE WHEN m.tout_chemin250 THEN 1 ELSE 0 END)    AS p_tout_chemin250,
         avg(CASE WHEN m.autre_troncon25 THEN 1 ELSE 0 END)   AS p_autre_troncon25
  FROM res_points_mesure m GROUP BY m.id
)
SELECT f.*, part.p_osm25, part.p_osm100, part.p_osm250,
       part.p_chemin25, part.p_chemin100, part.p_tout_chemin250, part.p_autre_troncon25,
       pp.dist_osm_classe_m, pp.dist_chemin_m, pp.dist_rn_m, pp.dist_rr_m, pp.dist_ru_m,
       o.azimut_moyen, i.intersections, c.composante,
       CASE
         WHEN part.p_autre_troncon25  >= 0.5 THEN 'RES_DUPLICATE_OR_OVERLAP'
         WHEN part.p_osm25            >= 0.8 THEN 'RES_CONFIRMED_ROAD'
         WHEN part.p_osm250 < 0.1 AND part.p_tout_chemin250 < 0.1 THEN 'RES_OUTSIDE_REFERENCE_NETWORK'
         WHEN part.p_osm100 >= 0.5 OR part.p_chemin25 >= 0.5 THEN 'RES_POSSIBLE_ROAD'
         ELSE 'RES_UNDETERMINED'
       END AS typologie
FROM res_fiche f
JOIN part ON part.id = f.id
LEFT JOIN res_plus_proches pp ON pp.id = f.id
LEFT JOIN res_orientation o ON o.id = f.id
LEFT JOIN res_intersections i ON i.id = f.id
LEFT JOIN composantes c ON c.id = f.id;"

titre "8. Résultats — typologie"
qt "SELECT typologie, count(*) AS troncons, round(sum(km_geometrique)) AS km,
       round(avg(km_geometrique), 1) AS km_moyen
FROM res_synthese GROUP BY typologie ORDER BY km DESC;"

titre "9. Résultats — par région déclarée en BDRI"
qt "SELECT region, count(*) AS troncons, round(sum(km_geometrique)) AS km,
       count(*) FILTER (WHERE typologie = 'RES_OUTSIDE_REFERENCE_NETWORK') AS hors_reference,
       count(*) FILTER (WHERE typologie = 'RES_CONFIRMED_ROAD') AS confirmees
FROM res_synthese GROUP BY region ORDER BY km DESC;"

titre "10. Résultats — ce que la source legacy déclarait, par typologie"
qt "SELECT typologie, count(*) FILTER (WHERE legacy_region IS NOT NULL) AS avec_region_legacy,
       count(*) FILTER (WHERE legacy_etat IS NOT NULL AND legacy_etat <> '6- non observe') AS avec_etat_legacy,
       count(*) FILTER (WHERE legacy_km IS NOT NULL) AS avec_km_legacy,
       count(*) AS total
FROM res_synthese GROUP BY typologie ORDER BY total DESC;"

titre "11. Distributions de longueur et densité"
qt "SELECT width_bucket(km_geometrique, 0, 60, 12) AS tranche_x5km, count(*),
       sum(round(km_geometrique)) AS km
FROM res_synthese GROUP BY 1 ORDER BY 1;"
qt "SELECT round(avg(sommets_par_km)::numeric, 1) AS densite_moyenne,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY sommets_par_km) AS densite_mediane,
       max(sommets_par_km) AS densite_max
FROM res_synthese;"

# ─────────────────────────────────────────────────────────────
titre "12. Exports vers $RESULTATS"
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tA -F$'\t' -c \
 "SELECT code, classe, region, km_geometrique, longueur_metier, sommets, sommets_par_km,
         azimut_moyen, azimut_global, intersections, composante,
         bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax,
         round(p_osm25::numeric,3), round(p_osm100::numeric,3), round(p_osm250::numeric,3),
         round(p_chemin25::numeric,3), round(p_chemin100::numeric,3), round(p_tout_chemin250::numeric,3),
         round(p_autre_troncon25::numeric,3),
         dist_osm_classe_m, dist_chemin_m, dist_rn_m, dist_rr_m, dist_ru_m,
         legacy_region, legacy_classement, legacy_etat, legacy_km, legacy_nom,
         typologie
 FROM res_synthese ORDER BY code;" > "$RESULTATS/res-autopsie.tsv"
info "res-autopsie.tsv : $(wc -l < "$RESULTATS/res-autopsie.tsv") lignes"

docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc \
 "SELECT json_build_object('type','FeatureCollection','features', json_agg(feature)) FROM (
   SELECT json_build_object('type','Feature',
     'geometry', ST_AsGeoJSON(t.geom, 5)::json,
     'properties', json_build_object('code', s.code, 'region', s.region,
        'km', s.km_geometrique, 'typologie', s.typologie,
        'p_osm25', round(s.p_osm25::numeric,3), 'p_chemin25', round(s.p_chemin25::numeric,3),
        'p_autre25', round(s.p_autre_troncon25::numeric,3))) AS feature
   FROM troncons t JOIN res_synthese s ON s.id = t.id
   WHERE t.\"deletedAt\" IS NULL AND t.geom IS NOT NULL
 ) f;" > "$RESULTATS/res-typologie.geojson"
info "res-typologie.geojson : $(du -h "$RESULTATS/res-typologie.geojson" | cut -f1)"

printf '\nAutopsie terminée. Fichiers : res-autopsie.tsv, res-typologie.geojson\n'
printf 'Typologies et seuils : ANALYTIQUES, aucune donnée métier modifiée.\n'
