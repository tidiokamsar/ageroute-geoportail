#!/usr/bin/env bash
# Lance les bancs d'integration PostGIS. Voir README.md.
#   DATABASE_URL=postgresql://utilisateur:motdepasse@127.0.0.1:5434/replay bash tests-integration/run.sh
# La garde (lib/garde.ts) refuse toute base qui n'est pas locale ET nommee replay ou essai_<nom>.
set -u
cd "$(dirname "$0")/.."

AVEC_VERDICT=(trace metadonnees geometries-invalides)
OBSERVATION=(deviation graphe info-route patrouilles teledetection veille)
echec=0
lignes=()

lancer() { # $1 = fichier, $2 = categorie
  if npx tsx "tests-integration/$1" > "/tmp/integration-$1.log" 2>&1; then
    lignes+=("$(printf '%-44s %-14s %s' "$1" "$2" "termine sans erreur")")
  else
    lignes+=("$(printf '%-44s %-14s %s' "$1" "$2" "ECHEC (voir /tmp/integration-$1.log)")")
    echec=1
  fi
}

for b in "${AVEC_VERDICT[@]}"; do lancer "$b.integration.ts" "verdict"; done
lancer "curseur.integration.mts" "verdict"
for b in "${OBSERVATION[@]}"; do lancer "$b.integration.ts" "observation"; done

printf '\n%s\n' "Resultat des bancs d'integration"
printf '%s\n' "${lignes[@]}"
echo
echo "Rappel : un banc « observation » imprime des valeurs et n'affirme rien ; son code de sortie 0 veut dire"
echo "« exécuté sans exception », pas « vérifié ». Lire la sortie dans /tmp/integration-<banc>.log."
exit $echec
