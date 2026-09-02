#!/usr/bin/env bash
#
# Recouvrement spatial entre le reseau BDRI et le reseau classe OpenStreetMap (§14).
#
# POURQUOI
#
# Les longueurs concordent — 21 156 km cote BDRI, 21 490 km cote OSM, 1,6 % d'ecart.
# Mais une longueur commune ne prouve pas que les traces se superposent : deux reseaux
# de meme longueur peuvent ne pas decrire les memes routes. Cette mesure repond a la
# seule question qui compte avant tout usage d'OSM : ou les deux reseaux se
# recouvrent-ils, et ou pas ?
#
# METHODE
#
# Tout se passe dans un conteneur jetable : restauration de la derniere sauvegarde
# BDRI, chargement du reseau classe OSM (5 394 polylignes en WKT, extraites sans
# GDAL), puis mesures croisees a plusieurs tolerances. Aucune ecriture en production.
#
# La tolerance est le parametre qui decide. A 25 m, deux traces du meme axe se
# recouvrent presque toujours ; a 250 m, on rattrape les traces grossiers des
# regionales (2,1 points/km). Rendre les deux dit ce qui tient a la precision et ce
# qui tient a la couverture.
#
# Usage : recouvrement-osm-bdri.sh chemin/vers/osm-classe.tsv

set -uo pipefail

FICHIER_OSM="${1:?chemin du TSV OSM requis}"
SAUVEGARDES="${SAUVEGARDES:-$HOME/sauvegardes-bdri}"
CLE="${CLE:-$HOME/.bdri/cle-sauvegarde}"
IMAGE_POSTGRES="${IMAGE_POSTGRES:-postgis/postgis:17-3.5}"
CONTENEUR="recouvrement-osm-$$"
BASE="verification"

titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }
nettoyer() { docker rm -f "$CONTENEUR" >/dev/null 2>&1 || true; rm -f /tmp/dump-$$.dump; }
trap nettoyer EXIT INT TERM

q()  { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$1" 2>/dev/null | tr -d '\r'; }
qt() { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "$1" 2>/dev/null; }

printf '\033[1mRecouvrement spatial OSM 2023 / BDRI\033[0m\n'

# ─────────────────────────────────────────────────────────────
titre "1. Base BDRI restauree dans un conteneur jetable"
DUMP=$(ls -1t "$SAUVEGARDES"/bdri_*.dump.enc 2>/dev/null | head -1)
[ -n "$DUMP" ] || { echo "aucune sauvegarde"; exit 1; }
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$DUMP" -out /tmp/dump-$$.dump -pass file:"$CLE" 2>/dev/null \
    || { echo "dechiffrement impossible"; exit 1; }

docker run -d --name "$CONTENEUR" -e POSTGRES_PASSWORD=x -e POSTGRES_DB="$BASE" "$IMAGE_POSTGRES" >/dev/null
for _ in $(seq 1 90); do docker logs "$CONTENEUR" 2>&1 | grep -q "init process complete" && break; sleep 2; done
for _ in $(seq 1 30); do q 'SELECT 1' | grep -q 1 && break; sleep 2; done
docker exec -i "$CONTENEUR" pg_restore -U postgres -d "$BASE" --no-owner --no-acl < /tmp/dump-$$.dump >/dev/null 2>&1 || true
info "$(q "SELECT count(*) FROM troncons WHERE \"deletedAt\" IS NULL") troncons BDRI"

# ─────────────────────────────────────────────────────────────
titre "2. Reseau classe OSM charge"
q "CREATE TABLE osm_classe (id text, nature text, numero text, nom text, wkt text);" >/dev/null
docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -c "\copy osm_classe FROM STDIN WITH (FORMAT csv, DELIMITER E'\t')" < "$FICHIER_OSM" >/dev/null 2>&1
q "SELECT AddGeometryColumn('public','osm_classe','geom',4326,'GEOMETRY',2);" >/dev/null
q "UPDATE osm_classe SET geom = ST_GeomFromText(wkt, 4326);" >/dev/null
q "CREATE INDEX osm_classe_geog ON osm_classe USING GIST ((geom::geography));" >/dev/null
q "CREATE INDEX IF NOT EXISTS troncons_geog_tmp ON troncons USING GIST ((geom::geography));" >/dev/null
qt "SELECT nature, count(*) AS segments, ROUND(SUM(ST_Length(geom::geography)/1000)::numeric,0) AS km
    FROM osm_classe GROUP BY nature ORDER BY km DESC;"

# ─────────────────────────────────────────────────────────────
titre "3. Couverture de la BDRI par OSM — part du lineaire BDRI a moins de X m d'une route OSM"
#
# Pour chaque troncon BDRI : quelle part de sa longueur est a moins de X metres du
# reseau OSM ? On decoupe le troncon en points tous les 100 m et on compte ceux qui
# ont une route OSM a portee. C'est plus fidele qu'un test tout-ou-rien par troncon.
qt "
WITH points AS (
  SELECT t.id, t.classe,
         (ST_DumpPoints(ST_Segmentize(t.geom::geography, 100)::geometry)).geom AS p
  FROM troncons t WHERE t.\"deletedAt\" IS NULL AND t.geom IS NOT NULL
),
mesure AS (
  SELECT classe,
         count(*) AS pts,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM osm_classe o WHERE ST_DWithin(p::geography, o.geom::geography, 25)))  AS a_25m,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM osm_classe o WHERE ST_DWithin(p::geography, o.geom::geography, 100))) AS a_100m,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM osm_classe o WHERE ST_DWithin(p::geography, o.geom::geography, 250))) AS a_250m
  FROM points GROUP BY classe
)
SELECT classe, pts AS points_echantillonnes,
       ROUND(100.0*a_25m/pts,1)  AS pct_a_25m,
       ROUND(100.0*a_100m/pts,1) AS pct_a_100m,
       ROUND(100.0*a_250m/pts,1) AS pct_a_250m
FROM mesure ORDER BY classe;"

# ─────────────────────────────────────────────────────────────
titre "4. Couverture d'OSM par la BDRI — part du lineaire OSM a moins de X m d'un troncon BDRI"
qt "
WITH points AS (
  SELECT o.nature,
         (ST_DumpPoints(ST_Segmentize(o.geom::geography, 100)::geometry)).geom AS p
  FROM osm_classe o
),
mesure AS (
  SELECT nature,
         count(*) AS pts,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM troncons t WHERE t.\"deletedAt\" IS NULL AND ST_DWithin(p::geography, t.geom::geography, 25)))  AS a_25m,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM troncons t WHERE t.\"deletedAt\" IS NULL AND ST_DWithin(p::geography, t.geom::geography, 100))) AS a_100m,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM troncons t WHERE t.\"deletedAt\" IS NULL AND ST_DWithin(p::geography, t.geom::geography, 250))) AS a_250m
  FROM points GROUP BY nature
)
SELECT nature, pts AS points_echantillonnes,
       ROUND(100.0*a_25m/pts,1)  AS pct_a_25m,
       ROUND(100.0*a_100m/pts,1) AS pct_a_100m,
       ROUND(100.0*a_250m/pts,1) AS pct_a_250m
FROM mesure ORDER BY pts DESC;"

# ─────────────────────────────────────────────────────────────
titre "5. Troncons BDRI sans aucune correspondance OSM a 250 m"
qt "
SELECT t.classe, count(*) AS troncons_sans_osm,
       ROUND(SUM(ST_Length(t.geom::geography)/1000)::numeric,0) AS km
FROM troncons t
WHERE t.\"deletedAt\" IS NULL AND t.geom IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM osm_classe o WHERE ST_DWithin(t.geom::geography, o.geom::geography, 250))
GROUP BY t.classe ORDER BY t.classe;"

# ─────────────────────────────────────────────────────────────
titre "6. Distance entre traces la ou ils se correspondent (troncons BDRI a moins de 250 m d'OSM)"
#
# Pour chaque troncon apparie : distance de Hausdorff au segment OSM le plus proche.
# Elle borne l'ecart maximal entre les deux traces, et dit si OSM peut servir a
# densifier la geometrie BDRI sans la deplacer.
qt "
WITH app AS (
  SELECT t.id, t.classe,
         (SELECT ST_HausdorffDistance(t.geom, o.geom) FROM osm_classe o
          ORDER BY t.geom <-> o.geom LIMIT 1) * 111320 AS hausdorff_m
  FROM troncons t
  WHERE t.\"deletedAt\" IS NULL AND t.geom IS NOT NULL
    AND EXISTS (SELECT 1 FROM osm_classe o WHERE ST_DWithin(t.geom::geography, o.geom::geography, 250))
)
SELECT classe, count(*) AS troncons_apparies,
       ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hausdorff_m)::numeric,0) AS hausdorff_median_m,
       ROUND(AVG(hausdorff_m)::numeric,0) AS hausdorff_moyen_m,
       ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY hausdorff_m)::numeric,0) AS hausdorff_p90_m
FROM app GROUP BY classe ORDER BY classe;"

printf '\nMesure terminee. Conteneur jetable detruit, production intacte.\n'
