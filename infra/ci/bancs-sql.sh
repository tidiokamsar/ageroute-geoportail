#!/usr/bin/env bash
#
# Lance tous les bancs SQL (backend/prisma/tests/*.test.sql) contre une base qui porte la chaine
# de migrations complete -- en CI, la base de reference que laisse `verifier.sh --garder`.
#
# Chaque banc ouvre une transaction et l'ANNULE : la base n'est pas modifiee. Un banc echoue au
# premier RAISE EXCEPTION (ON_ERROR_STOP). Les bancs de PERFORMANCE (*.bench.sql) ne sont pas
# lances ici : leurs durees dependent de la machine et ils n'ont pas de seuil.
#
#   PGUSER=bdri_dev bash infra/ci/bancs-sql.sh <base>
#   bash infra/ci/bancs-sql.sh            # base de reference rt_*_base la plus recente

set -uo pipefail
TESTS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../backend/prisma/tests" && pwd)"
export PGUSER="${PGUSER:-bdri_dev}"

BASE="${1:-$(psql -X -At -d postgres -c "SELECT datname FROM pg_database WHERE datname LIKE 'rt\_%\_base' ORDER BY oid DESC LIMIT 1" < /dev/null)}"
if [ -z "$BASE" ]; then echo "Aucune base : lancer d'abord verifier.sh --garder, ou donner la base." >&2; exit 2; fi

echo "Bancs SQL contre $BASE"
echecs=0; total=0
for f in "$TESTS"/*.test.sql; do
  total=$((total + 1))
  nom="$(basename "$f")"
  if sortie="$(psql -X -q -v ON_ERROR_STOP=1 -d "$BASE" -f "$f" 2>&1)"; then
    echo "  ok     $nom ($(grep -c 'NOTICE' <<< "$sortie") notices)"
  else
    echecs=$((echecs + 1))
    echo "  ECHEC  $nom"
    grep -E 'ERROR|ERREUR' <<< "$sortie" | head -3 | sed 's/^/         /'
  fi
done
echo
echo "Bilan : $total banc(s), $echecs echec(s)"
[ "$echecs" -eq 0 ]
