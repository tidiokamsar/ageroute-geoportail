#!/usr/bin/env bash
# Lance les bancs d'integration PostGIS. Voir README.md.
#   DATABASE_URL=postgresql://utilisateur:motdepasse@127.0.0.1:5434/replay bash tests-integration/run.sh
# La garde (lib/garde.ts) refuse toute base qui n'est pas locale ET nommee replay ou essai_<nom>.
set -u
cd "$(dirname "$0")/.."

BANCS=(trace metadonnees geometries-invalides contour deviation graphe info-route patrouilles teledetection veille chemin historique photos-observation qualite-detecteurs)
echec=0
lignes=()

lancer() { # $1 = fichier
  if npx tsx "tests-integration/$1" > "/tmp/integration-$1.log" 2>&1; then
    lignes+=("$(printf '%-44s %s' "$1" "$(grep -E 'verifications reussies' "/tmp/integration-$1.log" | tail -1 || true)")")
  else
    lignes+=("$(printf '%-44s %s' "$1" "ECHEC (voir /tmp/integration-$1.log)")")
    echec=1
  fi
}

for b in "${BANCS[@]}"; do lancer "$b.integration.ts"; done
lancer "curseur.integration.mts"
lancer "programmation.integration.mts"
lancer "ppe.integration.mts"
lancer "outbox.integration.mts"
lancer "tableau-de-bord.integration.mts"
lancer "roulage.integration.mts"
lancer "roulage-consultation.integration.mts"
lancer "sync.integration.mts"
lancer "conflits-sync.integration.mts"
lancer "import.integration.mts"
lancer "imports-api.integration.mts"
lancer "metre-defaut.integration.mts"
lancer "contour-terrain.integration.mts"
lancer "taches-internes.integration.mts"
lancer "extension-unaccent.integration.mts"
lancer "qualite-geometries.integration.mts"
lancer "territoire.integration.mts"
lancer "controle-acces.integration.mts"
lancer "session-appareil.integration.mts"
lancer "info-route-delai.integration.mts"
lancer "incident-hors-ligne.integration.mts"
lancer "correspondances.integration.mts"
# Exige les migrations 20261028* sur la base cible (voir README : « Bancs qui exigent des migrations recentes »).
lancer "eo-workflow.integration.ts"
# Crée et détruit son propre clone `essai_eo_api` (DATABASE_URL pointe sur replay) ; applique lui-même les migrations 20261028*.
lancer "eo-api.integration.mts"

printf '\n%s\n' "Resultat des bancs d'integration"
printf '%s\n' "${lignes[@]}"
echo "Chaque banc nomme ses verifications et sort en code 1 si une seule est fausse (lib/verdict.ts fait aussi echouer un banc qui n'en fait aucune ; curseur tient son propre decompte). Detail : /tmp/integration-<banc>.log."
exit $echec
