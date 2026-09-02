#!/usr/bin/env bash
#
# Phase 5 — Export des couches pour l'outil de visualisation (hors production).
#
# POURQUOI
#
# Comprendre visuellement le lot RES-* exige de croiser sur une même carte les
# familles BDRI (RN/RR/RU/RES-*), le reseau classe OSM et ses tertiaires, avec
# des filtres par bande de distance. Cet export produit des GeoJSON SIMPLIFIES
# (tolerance 100 m, suffisante a l'echelle du pays) — les fichiers servis a
# l'outil de visualisation ne sont jamais les geometries de travail.
#
# Usage : ./exporter-carto.sh   (prérequis : preparer-analyse.sh, autopsie-res.sh)

set -euo pipefail

CONTENEUR="${CONTENEUR:-phase5-analyse}"
BASE="verification"
RESULTATS="$HOME/phase5-resultats"
SIMPLIFY="${SIMPLIFY:-0.001}"   # ~100 m en degres, suffisant a l'echelle nationale

q()  { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$1"; }
info() { printf '  %s\n' "$*"; }
mkdir -p "$RESULTATS/carto"

export_json() {  # $1 = fichier, $2 = SQL de la collection
  docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$2" > "$RESULTATS/carto/$1"
  info "$1 : $(du -h "$RESULTATS/carto/$1" | cut -f1)"
}

q "CREATE OR REPLACE VIEW carto_res AS
   SELECT t.id, s.code, s.region, s.typologie, s.p_osm25, s.p_osm100, s.p_osm250,
          s.p_chemin25, s.p_autre_troncon25,
          CASE WHEN s.p_osm25 >= 0.5 THEN 'osm<25m'
               WHEN s.p_osm100 >= 0.5 THEN 'osm25-100m'
               WHEN s.p_osm250 >= 0.5 THEN 'osm100-250m'
               ELSE 'osm>250m' END AS bande_osm,
          ST_SimplifyPreserveTopology(t.geom, $SIMPLIFY) AS g
   FROM troncons t JOIN res_synthese s ON s.id = t.id
   WHERE t.\"deletedAt\" IS NULL;" >/dev/null

printf '\033[1mExports carto (simplification %s deg)\033[0m\n' "$SIMPLIFY"

export_json bdri-res.geojson "
SELECT json_build_object('type','FeatureCollection','features', json_agg(json_build_object(
  'type','Feature','geometry', ST_AsGeoJSON(g, 5)::json,
  'properties', json_build_object('code', code, 'region', region, 'typologie', typologie,
     'bande', bande_osm,
     'p_osm25', round(p_osm25::numeric,2), 'p_osm100', round(p_osm100::numeric,2),
     'p_chemin25', round(p_chemin25::numeric,2), 'p_autre25', round(p_autre_troncon25::numeric,2)))))
FROM carto_res;"

export_json bdri-rn.geojson "
SELECT json_build_object('type','FeatureCollection','features', json_agg(json_build_object(
  'type','Feature','geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, $SIMPLIFY), 5)::json,
  'properties', json_build_object('code', code))))
FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL AND classe = 'RN' AND code NOT LIKE 'RES-%';"

export_json bdri-rr.geojson "
SELECT json_build_object('type','FeatureCollection','features', json_agg(json_build_object(
  'type','Feature','geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, $SIMPLIFY), 5)::json,
  'properties', json_build_object('code', code))))
FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL AND classe = 'RR' AND code NOT LIKE 'RES-%';"

export_json bdri-ru.geojson "
SELECT json_build_object('type','FeatureCollection','features', json_agg(json_build_object(
  'type','Feature','geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, $SIMPLIFY), 5)::json,
  'properties', json_build_object('code', code))))
FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL AND classe = 'RU';"

export_json osm-classe.geojson "
SELECT json_build_object('type','FeatureCollection','features', json_agg(json_build_object(
  'type','Feature','geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, $SIMPLIFY), 5)::json,
  'properties', json_build_object('nature', nature, 'numero', numero))))
FROM osm_classe;"

printf '\nExports terminés dans %s/carto/ — ouvrir visualisation-res.html\n' "$RESULTATS"
