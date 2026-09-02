#!/usr/bin/env bash
#
# Phase 5 — Interrogation de la source legacy sig_routier (P5-01).
#
# POURQUOI
#
# Les codes RES-* de la BDRI sont des codes de repli crees par
# migrate-legacy-data.ts:127 pour les lignes de reseau_routier_import sans
# code_bdr ni troncon. La base legacy sig_routier est encore en service sur ce
# serveur (conteneur sig_postgis) : plutot que de DEDUIRE ce que ces lignes
# contiennent, ce script va le LIRE dans la table d'origine, en lecture seule.
#
# Il produit notamment ~/phase5-resultats/legacy-res.tsv : pour chaque ligne
# source devenue RES-*, ses attributs legacy (nom_route, nom_region, classement,
# etat, longueur, trafic), charge ensuite dans le conteneur d'analyse pour etre
# joint a l'autopsie spatiale (autopsie-res.sh).
#
# LECTURE STRICTE. Aucune ecriture dans sig_routier.
#
# Usage : ./interroger-legacy.sh

set -euo pipefail

CONTENEUR_LEGACY="${CONTENEUR_LEGACY:-sig_postgis}"
ROLE="${ROLE:-sig_admin}"
BASE="${BASE:-sig_routier}"
RESULTATS="$HOME/phase5-resultats"

mkdir -p "$RESULTATS"

q()  { docker exec "$CONTENEUR_LEGACY" psql -U "$ROLE" -d "$BASE" -tAc "$1"; }
qt() { docker exec "$CONTENEUR_LEGACY" psql -U "$ROLE" -d "$BASE" -c "$1"; }
titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }

printf '\033[1mInterrogation de sig_routier.reseau_routier_import — %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M')"

# ─────────────────────────────────────────────────────────────
titre "1. Volume general de la table source"
qt "SELECT count(*) AS lignes,
       count(*) FILTER (WHERE btrim(coalesce(code_bdr,'')) <> '') AS avec_code_bdr,
       count(*) FILTER (WHERE btrim(coalesce(code_bdr,'')) = '' AND btrim(coalesce(troncon,'')) = '') AS devenues_res,
       count(*) FILTER (WHERE geom IS NULL) AS sans_geometrie
    FROM reseau_routier_import;"

titre "2. Ce que la source savait des lignes devenues RES-*"
qt "SELECT classement, count(*) AS lignes,
       count(*) FILTER (WHERE btrim(coalesce(nom_route,'')) <> '' OR btrim(coalesce(name,'')) <> '') AS avec_nom,
       count(*) FILTER (WHERE btrim(coalesce(nom_region,'')) <> '') AS avec_region,
       count(*) FILTER (WHERE btrim(coalesce(etat,'')) <> '') AS avec_etat,
       count(*) FILTER (WHERE longueur IS NOT NULL AND longueur > 0) AS avec_longueur,
       count(*) FILTER (WHERE trafic_jma IS NOT NULL) AS avec_trafic
    FROM reseau_routier_import
    WHERE btrim(coalesce(code_bdr,'')) = '' AND btrim(coalesce(troncon,'')) = '' AND geom IS NOT NULL
    GROUP BY classement ORDER BY 2 DESC;"

titre "3. Repartition regionale declaree (lignes RES) — telle que la source la connaissait"
qt "SELECT nullif(btrim(coalesce(nom_region,'')),'') AS nom_region, count(*)
    FROM reseau_routier_import
    WHERE btrim(coalesce(code_bdr,'')) = '' AND btrim(coalesce(troncon,'')) = '' AND geom IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC;"

titre "4. Etat declare (lignes RES)"
qt "SELECT etat, count(*)
    FROM reseau_routier_import
    WHERE btrim(coalesce(code_bdr,'')) = '' AND btrim(coalesce(troncon,'')) = '' AND geom IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC;"

titre "5. Noms distincts portes par les lignes RES (top 15)"
qt "SELECT nullif(btrim(coalesce(nom_route, name, '')),'') AS nom, count(*)
    FROM reseau_routier_import
    WHERE btrim(coalesce(code_bdr,'')) = '' AND btrim(coalesce(troncon,'')) = '' AND geom IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 15;"

titre "6. Export : attributs legacy de chaque ligne devenue RES-*> $RESULTATS/legacy-res.tsv"
docker exec "$CONTENEUR_LEGACY" psql -U "$ROLE" -d "$BASE" -tA -F$'\t' -c \
  "SELECT ogc_fid,
          nullif(btrim(coalesce(nom_route,'')),'') AS nom_route,
          nullif(btrim(coalesce(name,'')),'') AS name,
          nullif(btrim(coalesce(nom_region,'')),'') AS nom_region,
          nullif(btrim(coalesce(classement,'')),'') AS classement,
          nullif(btrim(coalesce(etat,'')),'') AS etat,
          longueur, trafic_jma,
          round((ST_Length(geom::geography)/1000)::numeric, 3) AS km_geometrique,
          ST_NPoints(geom) AS sommets
   FROM reseau_routier_import
   WHERE btrim(coalesce(code_bdr,'')) = '' AND btrim(coalesce(troncon,'')) = '' AND geom IS NOT NULL
   ORDER BY ogc_fid;" > "$RESULTATS/legacy-res.tsv"
wc -l "$RESULTATS/legacy-res.tsv"

titre "7. Provenance de la table elle-meme (metadonnees PostgreSQL)"
qt "SELECT obj_description('reseau_routier_import'::regclass) AS commentaire;"
qt "SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'reseau_routier_import' ORDER BY ordinal_position;" | head -30
qt "SELECT relname, reltuples::bigint AS estimation_lignes FROM pg_class
    WHERE relname LIKE 'reseau%' OR relname LIKE 'ref_%' ORDER BY relname;" | head -20
