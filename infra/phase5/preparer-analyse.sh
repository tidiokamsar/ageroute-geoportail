#!/usr/bin/env bash
#
# Phase 5 — Preparation de l'environnement d'analyse.
#
# POURQUOI
#
# La Phase 5 etablit ce que represente le reseau BDRI avant toute evolution
# fonctionnelle. Elle doit travailler sur une COPIE : aucune mesure ne s'execute
# contre la base de production. Ce script restaure la derniere sauvegarde
# chiffree dans un conteneur dedie, puis charge les deux couches OSM de
# reference (reseau classe + chemins), avec leurs index spatiaux.
#
# Contrairement au conteneur jetable de la Phase 4 (detruit a chaque mesure),
# celui-ci persiste le temps de la phase : plusieurs scripts d'analyse y
# enchainent leurs requetes. Il reste local au serveur, n'ecoute sur aucun port
# publie, et ne touche jamais console-bdri-db-1.
#
# La cle de dechiffrement ne quitte pas le serveur (cf. BACKUP-KEY-DECISION.md).
# Le dump dechiffre reste dans /tmp du serveur et en est efface en fin de script.
#
# Usage (sur le serveur, depuis infra/phase5/) :
#   ./preparer-analyse.sh [chemin/osm-classe.tsv] [chemin/osm-chemin.tsv]
#
# Prerequis : ~/osm-classe.tsv (Phase 4) et ~/phase5/osm-chemin.tsv (extraction
# CHEMIN de la meme archive OSM du 8 mars 2023).

set -euo pipefail

CONTENEUR="${CONTENEUR:-phase5-analyse}"
BASE="verification"
IMAGE_POSTGRES="${IMAGE_POSTGRES:-postgis/postgis:17-3.5}"
SAUVEGARDES_DISTANTES="${SAUVEGARDES_DISTANTES:-agerdb@102.211.199.132:~/ageroute-depots/bdri-sauvegardes}"
CLE="${CLE:-$HOME/.bdri/cle-sauvegarde}"
RESULTATS="$HOME/phase5-resultats"
OSM_CLASSE="${1:-$HOME/osm-classe.tsv}"
OSM_CHEMIN="${2:-$HOME/phase5/osm-chemin.tsv}"

titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }

mkdir -p "$RESULTATS"

q()  { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$1"; }
qt() { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "$1"; }

if docker ps --format '{{.Names}}' | grep -q "^${CONTENEUR}$"; then
    titre "Conteneur $CONTENEUR deja present"
    info "troncons : $(q "SELECT count(*) FROM troncons WHERE \"deletedAt\" IS NULL")"
    info "osm_classe : $(q "SELECT count(*) FROM osm_classe") / osm_chemin : $(q "SELECT count(*) FROM osm_chemin")"
    info "Pour repartir de zero : docker rm -f $CONTENEUR puis relancer."
    exit 0
fi

# ─────────────────────────────────────────────────────────────
titre "1. Derniere sauvegarde rapatriee depuis le depot distant"
HOTE_DEPOT="${SAUVEGARDES_DISTANTES%%:*}"
REPERTOIRE_DEPOT="${SAUVEGARDES_DISTANTES#*:}"
DUMP_DISTANT=$(ssh -o ConnectTimeout=15 "$HOTE_DEPOT" "ls -1t $REPERTOIRE_DEPOT/bdri_*.dump.enc 2>/dev/null | head -1")
[ -n "$DUMP_DISTANT" ] || { echo "aucune sauvegarde trouvee sur le depot"; exit 1; }
NOM_DUMP=$(basename "$DUMP_DISTANT")
scp -q "${SAUVEGARDES_DISTANTES%%:*}:$DUMP_DISTANT" "/tmp/$NOM_DUMP"
info "$NOM_DUMP ($(du -h "/tmp/$NOM_DUMP" | cut -f1))"

titre "2. Conteneur d'analyse demarre"
docker run -d --name "$CONTENEUR" -e POSTGRES_PASSWORD=x -e POSTGRES_DB="$BASE" "$IMAGE_POSTGRES" >/dev/null
for _ in $(seq 1 90); do docker logs "$CONTENEUR" 2>&1 | grep -q "init process complete" && break; sleep 2; done
for _ in $(seq 1 30); do q 'SELECT 1' | grep -q 1 && break; sleep 2; done

titre "3. Sauvegarde dechiffree et restauree (la cle ne quitte pas le serveur)"
[ -r "$CLE" ] || { echo "cle introuvable : $CLE"; exit 1; }
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "/tmp/$NOM_DUMP" -out /tmp/phase5.dump -pass file:"$CLE"
rm -f "/tmp/$NOM_DUMP"
docker exec -i "$CONTENEUR" pg_restore -U postgres -d "$BASE" --no-owner --no-acl < /tmp/phase5.dump >/dev/null 2>&1 || true
rm -f /tmp/phase5.dump
info "$(q "SELECT count(*) FROM troncons WHERE \"deletedAt\" IS NULL") troncons BDRI"

titre "4. Couche OSM classe (Phase 4) chargee"
q "CREATE TABLE osm_classe (id text, nature text, numero text, nom text, wkt text);"
docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -c "\copy osm_classe FROM STDIN WITH (FORMAT csv, DELIMITER E'\t')" < "$OSM_CLASSE" >/dev/null
q "SELECT AddGeometryColumn('public','osm_classe','geom',4326,'GEOMETRY',2);" >/dev/null
q "UPDATE osm_classe SET geom = ST_GeomFromText(wkt, 4326);" >/dev/null
q "CREATE INDEX osm_classe_geog ON osm_classe USING GIST ((geom::geography));" >/dev/null
q "CREATE INDEX osm_classe_geom ON osm_classe USING GIST (geom);" >/dev/null
info "$(q "SELECT count(*) FROM osm_classe") segments classes"

titre "5. Couche OSM chemins (extraction Phase 5) chargee"
q "CREATE TABLE osm_chemin (id text, nature text, source text, wkt text);"
docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -c "\copy osm_chemin FROM STDIN WITH (FORMAT csv, DELIMITER E'\t')" < "$OSM_CHEMIN" >/dev/null
q "SELECT AddGeometryColumn('public','osm_chemin','geom',4326,'GEOMETRY',2);" >/dev/null
q "UPDATE osm_chemin SET geom = ST_GeomFromText(wkt, 4326);" >/dev/null
q "CREATE INDEX osm_chemin_geog ON osm_chemin USING GIST ((geom::geography));" >/dev/null
# Index GEOMETRY necessaire pour les KNN (<->) de l'autopsie : sans lui, chaque
# recherche du plus proche voisin balaye les 171 570 chemins (mesure du 02/09/2026).
q "CREATE INDEX osm_chemin_geom ON osm_chemin USING GIST (geom);" >/dev/null
q "CREATE INDEX troncons_geog_p5 ON troncons USING GIST ((geom::geography));" >/dev/null
q "CREATE INDEX troncons_geom_p5 ON troncons USING GIST (geom);" >/dev/null
info "$(q "SELECT count(*) FROM osm_chemin") chemins"

titre "6. Verifications de coherence"
qt "SELECT classe, count(*) AS troncons, ROUND(SUM(ST_Length(geom::geography)/1000)::numeric,0) AS km
    FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL GROUP BY classe ORDER BY classe;"
qt "SELECT nature, count(*) AS segments, ROUND(SUM(ST_Length(geom::geography)/1000)::numeric,0) AS km
    FROM osm_classe GROUP BY nature ORDER BY km DESC;"

printf '\nConteneur %s pret. Resultats a ecrire dans %s\n' "$CONTENEUR" "$RESULTATS"
