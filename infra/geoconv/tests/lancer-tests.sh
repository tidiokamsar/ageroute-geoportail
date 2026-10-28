#!/usr/bin/env bash
#
# Banc d'essai de la chaine de conversion GDAL isolee. LOCAL : Docker uniquement, aucune base,
# aucun reseau applicatif, aucune donnee reelle (tous les jeux sont fabriques par fabriquer_jeux.py).
#
#   bash infra/geoconv/tests/lancer-tests.sh                 # tout : construction, jeux, worker, isolement
#   bash infra/geoconv/tests/lancer-tests.sh --garder        # conserve les volumes de test
#
# Etapes : 1 construction de l'image ; 2 autotest de la liste blanche de pilotes ; 3 fabrication des
# jeux (dans l'image GDAL de base, sans reseau) ; 4 traitement par le worker, avec les options EXACTES
# du compose (reseau coupe, racine en lecture seule, non root, sans capacite...) et echantillonnage de
# la memoire par `docker stats` ; 5 verification des sorties ; 6 verification de l'isolement DEPUIS le
# conteneur ; 7 test d'arret propre (SIGTERM) ; 8 nettoyage des conteneurs et volumes jetables.
set -u
set -o pipefail

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RACINE_GEOCONV="$(dirname "$ICI")"
export MSYS_NO_PATHCONV=1   # Git Bash : ne pas reecrire les chemins passes a docker

# Chemin comprehensible par Docker Desktop (Windows) ou natif (Linux).
if (cd "$ICI" && pwd -W >/dev/null 2>&1); then HOTE_TESTS="$(cd "$ICI" && pwd -W)"; HOTE_GEOCONV="$(cd "$RACINE_GEOCONV" && pwd -W)"
else HOTE_TESTS="$ICI"; HOTE_GEOCONV="$RACINE_GEOCONV"; fi

PY=python; "$PY" -c "" 2>/dev/null || PY=python3
IMAGE="ageroute-geoconv:0.1.0"
BASE_GDAL="ghcr.io/osgeo/gdal:ubuntu-small-3.13.3@sha256:64250faf833c06d4b21afce4c27190039ba7ab58d70f0eebc87cf77d929c0b40"
ID="essai$$"
V_ENTREE="geoconv_${ID}_entree"
V_SORTIE="geoconv_${ID}_sortie"
CONT="geoconv-${ID}"
SORTIE_TESTS="${SORTIE_TESTS:-$(mktemp -d)}"
GARDER=0; [ "${1:-}" = "--garder" ] && GARDER=1
export GEOCONV_VOLUME_ENTREE="$V_ENTREE" GEOCONV_VOLUME_SORTIE="$V_SORTIE" GEOCONV_CONTENEUR="$CONT"
COMPOSE=(docker compose -f "$HOTE_GEOCONV/docker-compose.geoconv.yml" -p "geoconv-${ID}")
ECHECS=0

etape() { printf '\n== %s\n' "$*"; }
nettoyer() {
  [ "$GARDER" = 1 ] && { echo "volumes conserves : $V_ENTREE $V_SORTIE"; return; }
  docker rm -f "$CONT" "${CONT}-run" "${CONT}-term" >/dev/null 2>&1
  "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1
  docker volume rm -f "$V_ENTREE" "$V_SORTIE" >/dev/null 2>&1
}
trap nettoyer EXIT

# Etape 7 : un job long (vue SQLite sans fin) est en cours ; docker stop envoie SIGTERM.
# Attendu : arret en moins de 15 s, code 0, statut.json = echec/INTERROMPU, aucune sortie partielle ;
# puis un statut 'en_cours' laisse par un arret brutal est transforme en echec au redemarrage.
essai_arret() {
  local E2="${V_ENTREE}_arret" S2="${V_SORTIE}_arret" ok=0
  docker volume create "$E2" >/dev/null; docker volume create "$S2" >/dev/null
  docker run --rm --network none -v "$V_ENTREE:/entree:ro" -v "$E2:/e2" -v "$S2:/s2" "$BASE_GDAL" python3 -W ignore -c "
import os, shutil, json
os.makedirs('/e2/t-arret-boucle')
shutil.copy('/entree/t-m21-gpkg-vue-boucle-infinie/fichier.gpkg', '/e2/t-arret-boucle/fichier.gpkg')
json.dump({'version': 1, 'limites': {'delai_s': 100}}, open('/e2/t-arret-boucle/demande.json', 'w'))
os.makedirs('/s2/t-orphelin-00')
json.dump({'statut': 'en_cours', 'etape': 'conversion', 'jobId': 't-orphelin-00'}, open('/s2/t-orphelin-00/statut.json', 'w'))
os.makedirs('/s2/t-orphelin-00/couches'); open('/s2/t-orphelin-00/couches/partiel.geojson', 'w').write('{}')
os.chown('/s2', 10001, 10001); os.chmod('/s2', 0o755)
" || return 1
  GEOCONV_VOLUME_ENTREE="$E2" GEOCONV_VOLUME_SORTIE="$S2" "${COMPOSE[@]}" run -d --no-deps --name "${CONT}-term" -T geoconv >/dev/null || return 1
  local i
  for i in $(seq 1 30); do
    if docker exec "${CONT}-term" python3 -E -s -c "import json,sys; sys.exit(0 if json.load(open('/spool/sortie/t-arret-boucle/statut.json'))['statut']=='en_cours' else 1)" 2>/dev/null; then ok=1; break; fi
    sleep 1
  done
  [ "$ok" = 1 ] || { echo "KO le job long n'a pas demarre"; return 1; }
  local t0=$(date +%s)
  docker stop -t 15 "${CONT}-term" >/dev/null
  local duree=$(( $(date +%s) - t0 )) code
  code=$(docker inspect "${CONT}-term" --format '{{.State.ExitCode}}')
  echo "docker stop : $duree s, code de sortie $code"
  docker run --rm --network none -v "$S2:/s2:ro" "$BASE_GDAL" python3 -W ignore -c "
import json, os, sys
s = json.load(open('/s2/t-arret-boucle/statut.json'))
print('statut apres SIGTERM :', s['statut'], s['code'])
assert s['statut'] == 'echec' and s['code'] == 'INTERROMPU', s
assert not os.path.exists('/s2/t-arret-boucle/couches')
" || return 1
  [ "$duree" -lt 15 ] && [ "$code" = 0 ] || { echo "KO arret non gracieux"; return 1; }
  # redemarrage : l'orphelin est recupere
  GEOCONV_VOLUME_ENTREE="$E2" GEOCONV_VOLUME_SORTIE="$S2" "${COMPOSE[@]}" run --rm --no-deps -T geoconv --une-fois >/dev/null 2>&1
  docker run --rm --network none -v "$S2:/s2:ro" "$BASE_GDAL" python3 -W ignore -c "
import json, os
s = json.load(open('/s2/t-orphelin-00/statut.json'))
print('orphelin apres redemarrage :', s['statut'], s['code'])
assert s['statut'] == 'echec' and s['code'] == 'INTERROMPU'
assert not os.path.exists('/s2/t-orphelin-00/couches'), 'sortie partielle conservee'
print('OK arret propre et recuperation')
"; local r=$?
  docker rm -f "${CONT}-term" >/dev/null 2>&1; docker volume rm -f "$E2" "$S2" >/dev/null 2>&1
  return $r
}


etape "1. Construction de l'image $IMAGE"
docker build -q -t "$IMAGE" "$HOTE_GEOCONV" >/dev/null || { echo "ECHEC construction"; exit 1; }
docker image inspect "$IMAGE" --format 'image {{.Id}} {{.Size}} octets, utilisateur={{.Config.User}}'

etape "2. Autotest de la liste blanche (conteneur durci)"
"${COMPOSE[@]}" run --rm --no-deps -T geoconv --autotest | tail -1 | "$PY" -c "import sys,json; d=json.loads(sys.stdin.read()); print('GDAL', d['gdal'], 'PROJ', d['proj'], 'pilotes actifs :', d['pilotesActifs'])" || ECHECS=$((ECHECS+1))

etape "3. Fabrication des jeux de test (image GDAL de base, sans reseau)"
docker volume create "$V_ENTREE" >/dev/null; docker volume create "$V_SORTIE" >/dev/null
docker run --rm --network none -v "$V_ENTREE:/entree" -v "$V_SORTIE:/sortie" -v "$HOTE_TESTS:/tests:ro" \
  "$BASE_GDAL" python3 -W ignore /tests/fabriquer_jeux.py /entree /sortie || { echo "ECHEC fabrication"; exit 1; }

etape "4. Traitement par le worker (options du compose) avec echantillonnage de la memoire"
( while :; do docker stats --no-stream --format '{{.MemUsage}}|{{.CPUPerc}}|{{.PIDs}}' "${CONT}-run" 2>/dev/null; sleep 1; done ) > "$SORTIE_TESTS/stats.txt" &
STATS_PID=$!
DEBUT=$(date +%s)
"${COMPOSE[@]}" run --name "${CONT}-run" --no-deps -T geoconv --une-fois > "$SORTIE_TESTS/worker.log" 2>&1
CODE_WORKER=$?
FIN=$(date +%s)
kill $STATS_PID 2>/dev/null; wait $STATS_PID 2>/dev/null
OOM=$(docker inspect "${CONT}-run" --format '{{.State.OOMKilled}}' 2>/dev/null)
echo "code de sortie du worker : $CODE_WORKER ; OOMKilled : $OOM ; duree totale : $((FIN-DEBUT)) s"
(cd "$SORTIE_TESTS" && "$PY" - stats.txt) <<'PYEOF'
import re, sys
pic = 0; pids = 0
for l in open(sys.argv[1], encoding="utf-8", errors="replace"):
    m = re.match(r"([\d.]+)(\w+) / ", l)
    if m:
        v = float(m.group(1)); u = m.group(2)
        v *= {"B": 1/1048576, "KiB": 1/1024, "MiB": 1, "GiB": 1024, "kB": 1/1024, "MB": 1}.get(u, 1)
        pic = max(pic, v)
    m = re.search(r"\|(\d+)$", l.strip())
    if m: pids = max(pids, int(m.group(1)))
print(f"pic de memoire du conteneur (docker stats, echantillon 1 s) : {pic:.0f} Mio ; processus max : {pids}")
PYEOF
[ "$CODE_WORKER" = 0 ] && [ "$OOM" = "false" ] || ECHECS=$((ECHECS+1))
docker rm -f "${CONT}-run" >/dev/null 2>&1

etape "5. Verification des sorties"
docker run --rm --network none -v "$V_ENTREE:/entree:ro" -v "$V_SORTIE:/sortie:ro" -v "$HOTE_TESTS:/tests:ro" \
  "$BASE_GDAL" python3 -W ignore /tests/verifier_resultats.py /entree /sortie /dev/stdout | tee "$SORTIE_TESTS/verification.txt" | grep -v '^job'
[ "${PIPESTATUS[0]}" = 0 ] || ECHECS=$((ECHECS+1))

etape "6. Isolement, verifie depuis le conteneur"
"${COMPOSE[@]}" run --rm --no-deps -T --entrypoint python3 -v "$HOTE_TESTS:/tests:ro" geoconv -E -s /tests/verifier_isolement.py || ECHECS=$((ECHECS+1))

etape "7. Arret propre (SIGTERM en cours de traitement) et recuperation d'un job orphelin"
essai_arret || ECHECS=$((ECHECS+1))

etape "Bilan"
if [ "$ECHECS" = 0 ]; then echo "TOUS LES CONTROLES SONT CONFORMES"; else echo "$ECHECS etape(s) en echec"; fi
exit "$ECHECS"
