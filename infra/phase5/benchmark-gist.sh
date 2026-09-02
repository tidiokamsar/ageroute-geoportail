#!/usr/bin/env bash
#
# P1-03 — Benchmark des index spatiaux GiST sur copie de production.
#
# POURQUOI
#
# La revue a liste cinq tables a colonne geom. Mais un index ne se justifie pas
# parce qu'une colonne est geometrique : il se justifie par les REQUETES reelle-
# ment executees. Recensement du backend (greps <-/ST_DWithin/ST_Intersects) :
#
#   - UN SEUL predicat spatial a l'execution : l'itineraire (troncons.service:58),
#     ST_DWithin(geom::geography, corridor, 20000)
#   - listGeo / carte publique : rendu PLEINE TABLE (ST_AsGeoJSON de tout) —
#     un index n'y change rien, le seq scan est le bon plan
#   - les KNN (<->) ne vivent que dans les scripts d'import batch
#
# Ce script mesure donc la seule requete candidate, avant/apres index, sur une
# copie restauree PROPRE (sans les index de l'environnement d'analyse Phase 5).
# Les tables de points (ouvrages, points_noirs, postes, chantiers) n'ont aucun
# predicat spatial a l'execution : aucun index n'y est cree — la preuve est le
# recensement ci-dessus.
#
# Usage (sur le serveur) : ./benchmark-gist.sh
# Sortie : ~/phase5-resultats/gist-benchmark.txt

set -euo pipefail

CONTENEUR="phase5-gist-$$"
BASE="verification"
IMAGE_POSTGIS="${IMAGE_POSTGRES:-postgis/postgis:17-3.5}"
SAUVEGARDES="${SAUVEGARDES:-$HOME/sauvegardes-bdri}"
CLE="${CLE:-$HOME/.bdri/cle-sauvegarde}"
RESULTATS="$HOME/phase5-resultats"
SORTIE="$RESULTATS/gist-benchmark.txt"

q()  { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$1" 2>/dev/null; }
nettoyer() { docker rm -f "$CONTENEUR" >/dev/null 2>&1 || true; rm -f /tmp/dump-$$.dump; }
trap nettoyer EXIT INT TERM

mkdir -p "$RESULTATS"
: > "$SORTIE"
log() { echo "$@" | tee -a "$SORTIE"; }

log "Benchmark GiST — $(date '+%Y-%m-%d %H:%M') — copie de production restauree propre"

# ── Restauration (pattern Phase 4/5, la cle ne quitte pas le serveur) ──
DUMP=$(ls -1t "$SAUVEGARDES"/bdri_*.dump.enc 2>/dev/null | head -1)
if [ -z "$DUMP" ]; then
    # Pas de sauvegarde locale : rapatriement depuis le depot distant.
    HOTE_DEPOT="${HOTE_DEPOT:-agerdb@102.211.199.132}"
    REPERTOIRE_DEPOT="${REPERTOIRE_DEPOT:-~/ageroute-depots/bdri-sauvegardes}"
    DUMP_DISTANT=$(ssh -o ConnectTimeout=15 "$HOTE_DEPOT" "ls -1t $REPERTOIRE_DEPOT/bdri_*.dump.enc 2>/dev/null | head -1")
    [ -n "$DUMP_DISTANT" ] || { log "ERREUR: aucune sauvegarde nulle part"; exit 1; }
    scp -q "$HOTE_DEPOT:$DUMP_DISTANT" /tmp/bdri-bench-$$.dump.enc
    DUMP=/tmp/bdri-bench-$$.dump.enc
    nettoyer() { docker rm -f "$CONTENEUR" >/dev/null 2>&1 || true; rm -f /tmp/dump-$$.dump /tmp/bdri-bench-$$.dump.enc; }
    trap nettoyer EXIT INT TERM
fi
[ -n "$DUMP" ] || { log "ERREUR: aucune sauvegarde locale"; exit 1; }
log "sauvegarde : $(basename "$DUMP") (P1-09 : identifiant consigne dans le rapport)"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$DUMP" -out /tmp/dump-$$.dump -pass file:"$CLE" 2>/dev/null
docker run -d --name "$CONTENEUR" -e POSTGRES_PASSWORD=x -e POSTGRES_DB="$BASE" "$IMAGE_POSTGIS" >/dev/null
for _ in $(seq 1 90); do docker logs "$CONTENEUR" 2>&1 | grep -q "init process complete" && break; sleep 2; done
for _ in $(seq 1 30); do q 'SELECT 1' | grep -q 1 && break; sleep 2; done
docker exec -i "$CONTENEUR" pg_restore -U postgres -d "$BASE" --no-owner --no-acl < /tmp/dump-$$.dump >/dev/null 2>&1 || true
rm -f /tmp/dump-$$.dump
log "restaure : $(q "SELECT count(*) FROM troncons WHERE \"deletedAt\" IS NULL") troncons actifs"

# Deux RN avec geom pour la requete d'itineraire (les plus longues : corridor realiste)
FROM_ID=$(q "SELECT id FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL AND classe='RN' ORDER BY ST_Length(geom::geography) DESC LIMIT 1")
TO_ID=$(q "SELECT id FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL AND classe='RN' AND id <> '$FROM_ID' ORDER BY ST_Length(geom::geography) DESC OFFSET 1 LIMIT 1")
log "corridor test : troncons les plus longs ($FROM_ID -> $TO_ID)"

REQUETE="WITH a AS (SELECT ST_Centroid(geom) AS g FROM troncons WHERE id = '$FROM_ID'),
     b AS (SELECT ST_Centroid(geom) AS g FROM troncons WHERE id = '$TO_ID'),
     ligne AS (SELECT ST_MakeLine((SELECT g FROM a), (SELECT g FROM b)) AS g)
SELECT count(*) FROM troncons t
WHERE t.\"deletedAt\" IS NULL AND t.geom IS NOT NULL
  AND ST_DWithin(t.geom::geography, (SELECT g FROM ligne)::geography, 20000)"

# ── AVANT : trois passes, on garde le plan de la derniere et les 3 temps ──
log ""
log "== AVANT index =="
for i in 1 2 3; do
  TEMPS=$(docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) $REQUETE" 2>/dev/null | grep "Execution Time" | grep -oE "[0-9]+\.[0-9]+")
  log "  passe $i : ${TEMPS} ms"
done
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "EXPLAIN (ANALYZE, BUFFERS) $REQUETE" 2>/dev/null | tee -a "$SORTIE" | grep -E "Seq Scan|Index Scan|Filter" | head -3

# ── Index candidat : GIST sur l'expression geographique exactement utilisee ──
log ""
log "== Creation de l'index candidat =="
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c \
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS troncons_geog_gist_idx ON troncons USING GIST ((geom::geography));" >/dev/null 2>&1 || \
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c \
  "CREATE INDEX IF NOT EXISTS troncons_geog_gist_idx ON troncons USING GIST ((geom::geography));" >/dev/null
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "ANALYZE troncons;" >/dev/null
log "index cree : troncons USING GIST ((geom::geography)) — $(q "SELECT pg_size_pretty(pg_relation_size('troncons_geog_gist_idx'))")"

# ── APRES ──
log ""
log "== APRES index =="
for i in 1 2 3; do
  TEMPS=$(docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) $REQUETE" 2>/dev/null | grep "Execution Time" | grep -oE "[0-9]+\.[0-9]+")
  log "  passe $i : ${TEMPS} ms"
done
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "EXPLAIN (ANALYZE, BUFFERS) $REQUETE" 2>/dev/null | tee -a "$SORTIE" | grep -E "Seq Scan|Index Scan|Bitmap|Filter" | head -4

# Verite des resultats : le compte doit etre identique avant/apres
log "nb troncons dans le corridor : $(q "$REQUETE")"

log ""
log "Contre-temoin : rendu pleine table (listGeo) — l'index ne doit rien changer"
FULL="EXPLAIN (ANALYZE) SELECT ST_AsGeoJSON(geom) FROM troncons WHERE \"deletedAt\" IS NULL AND geom IS NOT NULL"
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "$FULL" 2>/dev/null | grep -E "Seq Scan|Index Scan|Execution Time" | tee -a "$SORTIE"

log ""
log "Benchmark termine. Conteneur detruit, production non touchee."
