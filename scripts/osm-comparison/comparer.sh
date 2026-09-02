#!/usr/bin/env bash
#
# P4-03 — Comparaison spatiale BDRI / OSM.
#
# Tourne dans un conteneur PostGIS JETABLE. La base de production n'est lue
# qu'une fois, en SELECT, pour en extraire les tronçons ; elle n'est jamais
# écrite, et le conteneur d'analyse est détruit à la sortie.
#
# CE QUE LA COMPARAISON PRODUIT
#
#   A. BDRI seul     — tronçon BDRI sans voie OSM classée à proximité
#   B. OSM seul      — voie OSM sans tronçon BDRI à proximité
#   C. Correspondance— les deux se superposent
#   D. Conflit       — proches, mais longueur ou désignation divergentes
#
# MÉTHODE
#
# Pas de comparaison textuelle : les noms manquent des deux côtés (0,4 % côté
# OSM). Tout se joue en géométrie, par échantillonnage du linéaire.
#
# Un tronçon BDRI n'est pas « couvert » ou « absent » en bloc : on échantillonne
# un point tous les 200 m et on mesure la part de ces points proches d'OSM. Une
# route à moitié retrouvée doit se lire comme telle, pas basculer d'un côté.
#
# Seuils : 25 m (superposition), 100 m (même corridor), 250 m (même axe).
#
# Usage : comparer.sh [répertoire de sortie]

set -uo pipefail

CONTENEUR="p4-analyse-$$"
IMAGE="postgis/postgis:17-3.5"
BASE="p4"
TSV_OSM="${TSV_OSM:-$HOME/p4-osm-route.tsv.gz}"
SORTIE="${1:-$HOME/p4-resultats}"
DB_PROD="console-bdri-db-1"

# Un point tous les 200 m : assez fin pour qu'une route de 5 km donne 25 points,
# assez grossier pour rester calculable sur 21 000 km.
PAS_ECHANTILLON=200

titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32mv\033[0m %s\n' "$*"; }
info()  { printf '    %s\n' "$*"; }

nettoyer() { docker rm -f "$CONTENEUR" >/dev/null 2>&1 || true; }
trap nettoyer EXIT INT TERM

q() { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$1" 2>/dev/null | tr -d '\r'; }
qf() { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "$1" 2>&1; }

mkdir -p "$SORTIE"

titre "1. Base d'analyse jetable"
docker rm -f "$CONTENEUR" >/dev/null 2>&1 || true
docker run -d --name "$CONTENEUR" -e POSTGRES_PASSWORD=analyse -e POSTGRES_DB="$BASE" \
    "$IMAGE" >/dev/null || { echo "demarrage impossible"; exit 1; }
for _ in $(seq 1 60); do
    docker logs "$CONTENEUR" 2>&1 | grep -q "PostgreSQL init process complete" && break
    sleep 2
done
for _ in $(seq 1 30); do q 'SELECT 1' | grep -q 1 && break; sleep 2; done
q 'SELECT 1' | grep -q 1 || { echo "base indisponible"; exit 1; }
ok "conteneur $CONTENEUR prêt ($IMAGE)"

titre "2. Chargement des voies OSM"
docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -q <<'SQL'
CREATE TABLE osm_route (
  osm_id   text,
  nature   text,
  numero   text,
  nom      text,
  sens     text,
  date_maj text,
  wkt      text
);
SQL
gunzip -c "$TSV_OSM" | docker exec -i "$CONTENEUR" \
    psql -U postgres -d "$BASE" -q -c "COPY osm_route FROM STDIN" || {
    echo "chargement OSM en echec"; exit 1; }

docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -q <<'SQL'
ALTER TABLE osm_route ADD COLUMN geom geometry(LineString,4326);
UPDATE osm_route SET geom = ST_GeomFromText(wkt, 4326);
ALTER TABLE osm_route DROP COLUMN wkt;
DELETE FROM osm_route WHERE geom IS NULL OR NOT ST_IsValid(geom);
CREATE INDEX osm_route_geog_idx ON osm_route USING GIST ((geom::geography));
CREATE INDEX osm_route_nature_idx ON osm_route (nature);
ANALYZE osm_route;
SQL
ok "$(q 'SELECT count(*) FROM osm_route') voies OSM chargées et indexées"

titre "3. Extraction des tronçons BDRI (production, lecture seule)"
docker exec "$DB_PROD" psql -U bdri_app -d console_bdri -tAF$'\t' -c \
  "SELECT id, code, nom, classe::text, ST_AsText(geom)
   FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL" > /tmp/bdri-$$.tsv

docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -q <<'SQL'
CREATE TABLE bdri_troncon (id text, code text, nom text, classe text, wkt text);
SQL
docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -q -c \
    "COPY bdri_troncon FROM STDIN" < /tmp/bdri-$$.tsv
rm -f /tmp/bdri-$$.tsv

docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -q <<'SQL'
ALTER TABLE bdri_troncon ADD COLUMN geom geometry(LineString,4326);
UPDATE bdri_troncon SET geom = ST_GeomFromText(wkt, 4326);
ALTER TABLE bdri_troncon DROP COLUMN wkt;
-- Famille d'import, deduite du prefixe de code (audit P4-02).
ALTER TABLE bdri_troncon ADD COLUMN famille text;
UPDATE bdri_troncon SET famille = CASE
  WHEN code LIKE 'RES-%'   THEN 'RES-*'
  WHEN code LIKE '%-OSM-%' THEN '*-OSM-*'
  WHEN code LIKE 'GN N%'   THEN 'GN N*'
  ELSE 'autre' END;
CREATE INDEX bdri_troncon_geog_idx ON bdri_troncon USING GIST ((geom::geography));
ANALYZE bdri_troncon;
SQL
ok "$(q 'SELECT count(*) FROM bdri_troncon') tronçons BDRI chargés"

titre "4. Catégorisation des voies OSM"
docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -q <<'SQL'
-- Regroupement des 21 valeurs de NATURE. C'est une INFERENCE de lecture, pas une
-- classification presente dans la donnee : aucun champ ne la porte.
ALTER TABLE osm_route ADD COLUMN categorie text;
UPDATE osm_route SET categorie = CASE
  WHEN nature IN ('Voie rapide','Bretelle voie rapide')            THEN 'VOIE_RAPIDE'
  WHEN nature IN ('Route primaire','Bretelle route primaire')      THEN 'PRINCIPALE'
  WHEN nature IN ('Route secondaire','Bretelle route secondaire')  THEN 'SECONDAIRE'
  WHEN nature IN ('Route tertiaire','Bretelle route tertiaire')    THEN 'TERTIAIRE'
  WHEN nature IN ('Route non classifiée','Route en construction')  THEN 'VOIE_LOCALE'
  WHEN nature IN ('Route résidentielle','Zone de rencontre')       THEN 'RESIDENTIELLE'
  WHEN nature = 'Route d acc s' OR nature LIKE 'Route d%acc%'      THEN 'ACCES'
  WHEN nature = 'Chemin carrossable'                               THEN 'CHEMIN'
  WHEN nature = 'Chemin non carrossable'                           THEN 'SENTIER'
  WHEN nature IN ('Voie piétonne','Rue piétonne','Escaliers',
                  'Voie cyclable','Chemin équestre')               THEN 'PIETON'
  ELSE 'INCONNU' END;
CREATE INDEX osm_route_cat_idx ON osm_route (categorie);
ANALYZE osm_route;
SQL
qf "SELECT categorie, count(*) AS voies,
           ROUND(SUM(ST_Length(geom::geography)/1000)::numeric,0) AS km
    FROM osm_route GROUP BY categorie ORDER BY km DESC;"

titre "5. Couverture des tronçons BDRI par le réseau classé OSM"
info "un point tous les ${PAS_ECHANTILLON} m ; réseau classé = voie rapide, principale, secondaire, tertiaire"
docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -q <<SQL
CREATE TABLE osm_classe AS
  SELECT geom FROM osm_route
  WHERE categorie IN ('VOIE_RAPIDE','PRINCIPALE','SECONDAIRE','TERTIAIRE');
CREATE INDEX osm_classe_geog_idx ON osm_classe USING GIST ((geom::geography));
ANALYZE osm_classe;

CREATE TABLE echantillon AS
SELECT t.id, t.code, t.classe, t.famille,
       (ST_DumpPoints(ST_LineInterpolatePoints(
          t.geom,
          LEAST(1.0, ${PAS_ECHANTILLON}::float8 /
                GREATEST(ST_Length(t.geom::geography), ${PAS_ECHANTILLON}))
       ))).geom AS p
FROM bdri_troncon t;
CREATE INDEX echantillon_geog_idx ON echantillon USING GIST ((p::geography));
ANALYZE echantillon;
SQL
ok "$(q 'SELECT count(*) FROM echantillon') points d'échantillonnage"

for SEUIL in 25 100 250; do
docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -q <<SQL
CREATE TABLE IF NOT EXISTS couverture (seuil int, id text, code text, classe text,
                                       famille text, points int, proches int);
INSERT INTO couverture
SELECT ${SEUIL}, e.id, e.code, e.classe, e.famille, count(*),
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM osm_classe o
         WHERE ST_DWithin(e.p::geography, o.geom::geography, ${SEUIL})))
FROM echantillon e GROUP BY 1,2,3,4,5;
SQL
info "seuil ${SEUIL} m calculé"
done

qf "SELECT seuil, classe,
       count(*) AS troncons,
       ROUND(100.0*SUM(proches)/NULLIF(SUM(points),0),1) AS pct_lineaire_couvert,
       count(*) FILTER (WHERE proches = 0) AS sans_aucune_correspondance
    FROM couverture GROUP BY seuil, classe ORDER BY seuil, classe;"

titre "6. Voies OSM sans correspondance BDRI"
docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -q <<'SQL'
CREATE TABLE osm_orphelin AS
SELECT o.osm_id, o.categorie, o.nature, o.numero, o.nom,
       ST_Length(o.geom::geography)/1000 AS km,
       NOT EXISTS (SELECT 1 FROM bdri_troncon b
                   WHERE ST_DWithin(o.geom::geography, b.geom::geography, 25))  AS hors_25m,
       NOT EXISTS (SELECT 1 FROM bdri_troncon b
                   WHERE ST_DWithin(o.geom::geography, b.geom::geography, 250)) AS hors_250m
FROM osm_route o;
ANALYZE osm_orphelin;
SQL
qf "SELECT categorie, count(*) AS voies,
       ROUND(SUM(km)::numeric,0) AS km_total,
       count(*) FILTER (WHERE hors_250m) AS sans_bdri_a_250m,
       ROUND(SUM(km) FILTER (WHERE hors_250m)::numeric,0) AS km_sans_bdri
    FROM osm_orphelin GROUP BY categorie ORDER BY km_total DESC;"

titre "7. Export des résultats"
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c \
  "COPY (SELECT seuil, code, classe, famille, points, proches,
          ROUND(100.0*proches/NULLIF(points,0),1) AS pct
        FROM couverture ORDER BY seuil, pct) TO STDOUT WITH CSV HEADER" \
  > "$SORTIE/bdri_couverture_osm.csv"

docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c \
  "COPY (SELECT code, classe, famille, points, proches
        FROM couverture WHERE seuil = 250 AND proches = 0 ORDER BY code)
   TO STDOUT WITH CSV HEADER" > "$SORTIE/bdri_only.csv"

docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c \
  "COPY (SELECT categorie, nature, numero, nom, ROUND(km::numeric,3) AS km, osm_id
        FROM osm_orphelin WHERE hors_250m ORDER BY km DESC)
   TO STDOUT WITH CSV HEADER" > "$SORTIE/osm_candidats.csv"

docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c \
  "COPY (SELECT categorie, count(*) AS voies, ROUND(SUM(km)::numeric,0) AS km,
          count(*) FILTER (WHERE hors_25m) AS hors_25m,
          count(*) FILTER (WHERE hors_250m) AS hors_250m
        FROM osm_orphelin GROUP BY categorie ORDER BY 3 DESC)
   TO STDOUT WITH CSV HEADER" > "$SORTIE/osm_synthese.csv"

for f in "$SORTIE"/*.csv; do
    printf '  %-34s %s lignes\n' "$(basename "$f")" "$(($(wc -l < "$f") - 1))"
done

printf '\n\033[32mComparaison terminée — production non modifiée\033[0m\n'
