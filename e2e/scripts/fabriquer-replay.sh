#!/usr/bin/env bash
# Fabrique la base modele `replay` (schema complet, sans donnee) dans un conteneur PostGIS JETABLE, pour le harnais e2e.
#
# Le harnais (lib/donnees.ts) clone `replay` en `essai_e2e` ; il ne la fabrique pas. Ce script rejoue les migrations Prisma
# une a une (psql, une transaction par migration), dans l'ordre de leur nom, avec le « pont de derive » de
# backend/prisma/descentes/ponts/ intercale apres 20260702110000 (la chaine ne se rejoue pas depuis une base vide sans lui :
# voir backend/prisma/descentes/README.md). Il ne touche qu'a la base `replay` du conteneur designe.
#
# Usage (Git Bash, depuis la racine du depot) :
#   bash e2e/scripts/fabriquer-replay.sh <conteneur> <utilisateur>
# Exemple : bash e2e/scripts/fabriquer-replay.sh e2e-c1-db e2e_c1
# Le conteneur doit etre un PostGIS local, a part du conteneur de developpement `bdri-dev-db` (refuse ici).
set -euo pipefail

CONTENEUR="${1:?conteneur manquant}"
UTILISATEUR="${2:?utilisateur manquant}"
if [ "$CONTENEUR" = "bdri-dev-db" ]; then echo "Refuse : bdri-dev-db est le conteneur de developpement." >&2; exit 2; fi

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export MSYS_NO_PATHCONV=1
DEST="/tmp/prisma-e2e"

docker exec "$CONTENEUR" rm -rf "$DEST"
SOURCE="$RACINE/backend/prisma"
# docker.exe (Windows) ne comprend pas /c/... : chemin mixte C:/... quand cygpath existe (Git Bash).
if command -v cygpath >/dev/null 2>&1; then SOURCE="$(cygpath -m "$SOURCE")"; fi
docker cp "$SOURCE" "$CONTENEUR:$DEST"

docker exec -i "$CONTENEUR" bash -s -- "$UTILISATEUR" "$DEST" <<'INTERIEUR'
set -euo pipefail
U="$1"; D="$2"
psql_adm() { psql -X -q -v ON_ERROR_STOP=1 -U "$U" -d postgres "$@" < /dev/null; }
psql_adm -c 'DROP DATABASE IF EXISTS replay WITH (FORCE)'
psql_adm -c 'CREATE DATABASE replay TEMPLATE template0'
n=0
for m in $(ls -1 "$D/migrations" | grep -E '^[0-9]{14}_' | sort); do
  n=$((n + 1))
  psql -X -q -v ON_ERROR_STOP=1 -1 -U "$U" -d replay -f "$D/migrations/$m/migration.sql" > /tmp/mig.log 2>&1 < /dev/null \
    || { echo "ECHEC migration $m"; head -20 /tmp/mig.log; exit 1; }
  if [ "$m" = "20260702110000_marches_bailleurs_avancement" ]; then
    psql -X -q -v ON_ERROR_STOP=1 -1 -U "$U" -d replay -f "$D/descentes/ponts/$m.sql" < /dev/null
  fi
done
echo "replay : $n migrations appliquees"
INTERIEUR
