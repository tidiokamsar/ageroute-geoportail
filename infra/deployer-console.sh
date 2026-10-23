#!/usr/bin/env bash
# Deploiement de la Console BDRI depuis la CONSOLE du serveur applicatif.
#
# A lancer sur le serveur, dans /opt/console-bdri, avec les droits Docker :
#
#   sudo bash deployer-console.sh <commit-complet> <sha256-de-l-archive>
#
# Il reprend, DANS L'ORDRE, les prerequis du paragraphe 4 de AUTONOMOUS_EXECUTION_TRACKER.md,
# et S'ARRETE AU PREMIER QUI ECHOUE. Rien n'est modifie avant l'etape 9 ; tout ce qui precede
# lit, sauvegarde ou essaie sur une copie jetable.
#
#   1. projet Compose console-bdri dans /opt/console-bdri
#   2. sauvegarde du jour, et sa RESTAURABILITE (pg_restore -l)
#   3. espace disque > 15 % libre
#   4. compteurs de reference releves
#   5. historique des migrations : 0 inachevee, 0 orpheline, 17 en attente exactement
#   6. une descente pour chaque migration en attente
#   7. aucun index GiST deja present sur les colonnes que 20261020020000 indexe
#   8. empreintes des .env ; archive verifiee ; migrations ESSAYEES sur une copie restauree
#   9. confirmation humaine, puis extraction, construction, migrations
#  10. controles d'apres : compteurs, sante, audit, 401, .env inchanges
#
# AUCUN RETOUR ARRIERE AUTOMATIQUE : si un controle d'apres echoue, le script s'arrete et
# affiche la procedure ; la decision revient a l'humain. Aucun secret n'est affiche.

set -euo pipefail

COMMIT="${1:-}"
SHA_ATTENDU="${2:-}"
ARCHIVE_LOCALE="${3:-}"
ATTENDUES_EN_ATTENTE=2
PREMIERE_EN_ATTENTE="20261023200000_index_troncons_geom_planaire"
DEPOT="tidiokamsar/ageroute-geoportail"
HORODATAGE="$(date +%Y%m%d-%H%M%S)"
SAUVEGARDES="/var/backups/bdri-deploiement/${HORODATAGE}"
ESSAI="bdri-essai-migrations-${HORODATAGE}"

rouge() { printf '\033[31m%s\033[0m\n' "$*"; }
vert()  { printf '\033[32m%s\033[0m\n' "$*"; }
etape() { printf '\n== %s ==\n' "$*"; }
arret() { rouge "ARRET : $*"; rouge "Rien n'a ete modifie en production si l'arret precede l'etape 9."; exit 1; }

psql_prod() { docker compose exec -T db psql -U bdri_app -d console_bdri -v ON_ERROR_STOP=1 -tAc "$1"; }

[ -n "$COMMIT" ] && [ -n "$SHA_ATTENDU" ] || arret "usage : sudo bash deployer-console.sh <commit-complet> <sha256-de-l-archive> [archive-locale.tar.gz]"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || arret "le commit doit etre l'identifiant complet (40 caracteres hexadecimaux)"

# ---------------------------------------------------------------------------------------------
etape "1. Projet Compose"
[ "$(basename "$PWD")" = "console-bdri" ] || arret "lancez le script depuis /opt/console-bdri (le nom du projet Compose en depend : un autre nom donnerait des volumes VIDES)"
docker compose ps --services | grep -qx db || arret "service db introuvable dans ce projet Compose"
docker compose ps --services | grep -qx backend || arret "service backend introuvable"
vert "projet console-bdri, services db et backend presents"

# ---------------------------------------------------------------------------------------------
etape "2. Sauvegarde du jour, et sa restaurabilite"
mkdir -p "$SAUVEGARDES"
DUMP="${SAUVEGARDES}/console_bdri-avant-deploiement.dump"
docker compose exec -T db pg_dump -U bdri_app -Fc console_bdri > "$DUMP"
TAILLE=$(stat -c %s "$DUMP")
[ "$TAILLE" -gt 1000000 ] || arret "sauvegarde anormalement petite (${TAILLE} octets)"
ENTREES=$(docker compose exec -T db pg_restore -l < "$DUMP" | grep -c '^[0-9]' || true)
[ "$ENTREES" -gt 50 ] || arret "pg_restore -l ne lit que ${ENTREES} entrees : sauvegarde non restaurable"
sha256sum "$DUMP" > "${DUMP}.sha256"
vert "sauvegarde ${DUMP} : ${TAILLE} octets, ${ENTREES} entrees lisibles par pg_restore"

# ---------------------------------------------------------------------------------------------
etape "3. Espace disque"
OCCUPE=$(df -P / | awk 'NR==2 { gsub("%", "", $5); print $5 }')
LIBRE=$((100 - OCCUPE))
[ "$LIBRE" -gt 15 ] || arret "${LIBRE} % libres seulement : lancer d'abord 'docker builder prune' (JAMAIS 'docker volume prune')"
vert "${LIBRE} % libres"

# ---------------------------------------------------------------------------------------------
etape "4. Compteurs de reference"
compteurs() {
  psql_prod "SELECT (SELECT count(*) FROM troncons) || ' ' || (SELECT count(*) FROM ouvrages) || ' ' || (SELECT count(*) FROM valeurs_qualite) || ' ' || (SELECT count(*) FROM audit_logs) || ' ' || (SELECT count(*) FROM users)"
}
AVANT=$(compteurs)
echo "$AVANT" > "${SAUVEGARDES}/compteurs-avant.txt"
vert "troncons ouvrages valeurs_qualite audit_logs users : ${AVANT}"

# ---------------------------------------------------------------------------------------------
etape "8a. Archive du commit ${COMMIT:0:7}, verifiee"
STAGING="${SAUVEGARDES}/code"
mkdir -p "$STAGING"
ARCHIVE="${SAUVEGARDES}/bdri-${COMMIT:0:7}.tar.gz"
# Constate le 21/10 : deux telechargements codeload du MEME commit rendent des gzip
# differents (contenu identique, compression seule varie) — une empreinte d archive
# codeload n est pas stable. L operateur peut livrer une archive produite par
# « git archive » (deterministe) ; l empreinte est exigee dans tous les cas.
if [ -n "$ARCHIVE_LOCALE" ]; then
  cp "${ARCHIVE_LOCALE}" "${ARCHIVE}" || arret "archive locale introuvable : ${ARCHIVE_LOCALE}"
else
  curl -fsSL "https://codeload.github.com/${DEPOT}/tar.gz/${COMMIT}" -o "$ARCHIVE" || arret "telechargement de l'archive impossible"
fi
SHA_RECU=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
[ "$SHA_RECU" = "$SHA_ATTENDU" ] || arret "empreinte de l'archive ${SHA_RECU} differente de l'attendue ${SHA_ATTENDU}"
tar -xzf "$ARCHIVE" -C "$STAGING" --strip-components=1
if tar -tzf "$ARCHIVE" | grep -q '/\.env$'; then arret "l'archive contient un .env : refus"; fi
vert "archive ${SHA_RECU} conforme, extraite dans un repertoire de preparation"

# ---------------------------------------------------------------------------------------------
etape "5. Historique des migrations"
INACHEVEES=$(psql_prod "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")
[ "$INACHEVEES" = "0" ] || arret "${INACHEVEES} migration(s) inachevee(s) dans _prisma_migrations : migrate deploy refuserait"
psql_prod "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1" > "${SAUVEGARDES}/appliquees.txt"
ls -1 "${STAGING}/backend/prisma/migrations" | grep -E '^[0-9]{14}_' | sort > "${SAUVEGARDES}/locales.txt"
ORPHELINES=$(comm -23 "${SAUVEGARDES}/appliquees.txt" "${SAUVEGARDES}/locales.txt" | wc -l)
comm -13 "${SAUVEGARDES}/appliquees.txt" "${SAUVEGARDES}/locales.txt" > "${SAUVEGARDES}/en-attente.txt"
EN_ATTENTE=$(wc -l < "${SAUVEGARDES}/en-attente.txt")
[ "$ORPHELINES" -eq 0 ] || arret "${ORPHELINES} migration(s) appliquee(s) sans dossier dans l'archive (voir ${SAUVEGARDES})"
[ "$EN_ATTENTE" -eq "$ATTENDUES_EN_ATTENTE" ] || arret "${EN_ATTENTE} migrations en attente au lieu de ${ATTENDUES_EN_ATTENTE} (voir ${SAUVEGARDES}/en-attente.txt)"
[ "$(head -1 "${SAUVEGARDES}/en-attente.txt")" = "$PREMIERE_EN_ATTENTE" ] || arret "la premiere migration en attente n'est pas ${PREMIERE_EN_ATTENTE}"
vert "$(wc -l < "${SAUVEGARDES}/appliquees.txt") appliquees, ${EN_ATTENTE} en attente, 0 orpheline, 0 inachevee"

# ---------------------------------------------------------------------------------------------
etape "6. Une descente par migration en attente"
while read -r m; do
  [ -f "${STAGING}/backend/prisma/descentes/${m}.sql" ] || arret "pas de descente pour ${m}"
done < "${SAUVEGARDES}/en-attente.txt"
vert "${EN_ATTENTE} descentes presentes"

# ---------------------------------------------------------------------------------------------
etape "7. Index GiST deja presents ?"
# La garde ne concerne QUE la migration qui poserait les index. Depuis le deploiement du
# 21/10, 20261020020000 est appliquee en production et les six index y vivent : garder la
# verification inconditionnelle arretait tout deploiement ulterieur (constate le 22/10).
# Elle ne parle donc que si la migration est VRAIMENT dans la liste des en attente.
if grep -qx "20261020020000_index_gist_complets" "${SAUVEGARDES}/en-attente.txt"; then
  DOUBLONS=$(psql_prod "SELECT string_agg(tablename || '.' || indexname, ', ') FROM pg_indexes WHERE schemaname = 'public' AND indexdef ILIKE '%gist%' AND ((tablename IN ('chantiers','ouvrages','points_noirs','postes','propositions_localisation') AND indexdef ~ '\mgeom\M') OR (tablename = 'missions' AND indexdef ~ '\mitineraire\M'))")
  [ -z "$DOUBLONS" ] || arret "index GiST deja presents (${DOUBLONS}) : la migration 20261020020000 creerait un doublon, a examiner avant de deployer"
  vert "aucun : la migration 20261020020000 ne cree pas de doublon"
else
  vert "20261020020000 n est pas en attente : ses index vivent deja (deploiement precedent), la garde ne la concerne plus"
fi

# ---------------------------------------------------------------------------------------------
etape "7b. Garde-fous des migrations de performance (index planaire, recherche trigramme)"
# 20261023200000 pose un index GiST PLANAIRE sur troncons.geom ; 20261023210000 cree l'extension pg_trgm et
# deux index GIN. Ces trois index se construisent SANS CONCURRENCE : l'ecriture sur `troncons` est bloquee le
# temps de la construction (secondes, sur environ 261 000 lignes). Les gardes ne parlent que si la migration
# correspondante est vraiment en attente.
if grep -qx "20261023200000_index_troncons_geom_planaire" "${SAUVEGARDES}/en-attente.txt"; then
  PLANAIRE=$(psql_prod "SELECT string_agg(indexname, ', ') FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'troncons' AND indexname <> 'troncons_geom_gist' AND indexdef ILIKE '%USING gist (geom)%'")
  [ -z "$PLANAIRE" ] || arret "un index GiST planaire existe deja sur troncons.geom (${PLANAIRE}) : la migration 20261023200000 creerait un doublon, a examiner avant de deployer"
  vert "aucun index GiST planaire prealable sur troncons.geom"
fi
if grep -qx "20261023210000_recherche_troncons_trigramme" "${SAUVEGARDES}/en-attente.txt"; then
  TRGM=$(psql_prod "SELECT count(*) FROM pg_available_extensions WHERE name = 'pg_trgm'")
  [ "$TRGM" = "1" ] || arret "l'extension pg_trgm n'est pas disponible dans cette base : 20261023210000 echouerait"
  vert "extension pg_trgm disponible"
fi

# ---------------------------------------------------------------------------------------------
etape "8b. Empreintes des .env (avant)"
ENVS=""
for f in .env backend/.env; do [ -f "$f" ] && ENVS="$ENVS $f"; done
[ -n "$ENVS" ] || arret "aucun .env trouve : rien ne doit etre deploye sans configuration"
# shellcheck disable=SC2086
sha256sum $ENVS > "${SAUVEGARDES}/env-avant.sha256"
vert "empreintes relevees pour :${ENVS} (les contenus ne sont pas affiches)"

# ---------------------------------------------------------------------------------------------
etape "8c. Migrations ESSAYEES sur une copie restauree (conteneur jetable)"
docker run -d --name "$ESSAI" -e POSTGRES_PASSWORD=essai-jetable postgis/postgis:17-3.5 > /dev/null
trap 'docker rm -f -v "$ESSAI" > /dev/null 2>&1 || true' EXIT
# Deux defauts de jeunesse pris au premier deploiement reel (21/10) : pg_isready ET
# psql repondent des le serveur TEMPORAIRE d initdb, qui s arrete avant le definitif —
# toute commande peut tomber dans ce trou (« the database system is shutting down »).
# Le discriminant stable : /proc/1/comm ne vaut « postgres » que lorsque le script
# d entree a fini l initdb et exec le serveur definitif (avant, c est « bash »).
# (comm, pas exe : /proc/1/exe est illisible depuis un docker exec, droits ptrace.)
ESSAI_PRET=""
for _ in $(seq 1 120); do
  if docker exec "$ESSAI" sh -c '[ "$(cat /proc/1/comm 2>/dev/null)" = postgres ]' > /dev/null 2>&1; then ESSAI_PRET=1; break; fi
  sleep 2
done
[ -n "$ESSAI_PRET" ] || arret "conteneur d essai jamais pret (initdb n aboutit pas)"
docker exec "$ESSAI" psql -U postgres -qc "CREATE DATABASE essai" > /dev/null
docker exec -i "$ESSAI" pg_restore -U postgres -d essai --no-owner --no-privileges < "$DUMP" 2> "${SAUVEGARDES}/essai-restauration.log" || true
COPIE=$(docker exec "$ESSAI" psql -U postgres -d essai -tAc "SELECT (SELECT count(*) FROM troncons) || ' ' || (SELECT count(*) FROM ouvrages) || ' ' || (SELECT count(*) FROM valeurs_qualite) || ' ' || (SELECT count(*) FROM audit_logs) || ' ' || (SELECT count(*) FROM users)")
[ "$COPIE" = "$AVANT" ] || arret "la copie restauree ne donne pas les memes compteurs (${COPIE} contre ${AVANT}) : sauvegarde douteuse"
while read -r m; do
  docker exec -i "$ESSAI" psql -U postgres -d essai -v ON_ERROR_STOP=1 -q < "${STAGING}/backend/prisma/migrations/${m}/migration.sql" > /dev/null 2>> "${SAUVEGARDES}/essai-migrations.log" \
    || arret "la migration ${m} ECHOUE sur la copie (voir ${SAUVEGARDES}/essai-migrations.log)"
done < "${SAUVEGARDES}/en-attente.txt"
APRES_ESSAI=$(docker exec "$ESSAI" psql -U postgres -d essai -tAc "SELECT (SELECT count(*) FROM troncons) || ' ' || (SELECT count(*) FROM ouvrages) || ' ' || (SELECT count(*) FROM valeurs_qualite) || ' ' || (SELECT count(*) FROM audit_logs) || ' ' || (SELECT count(*) FROM users)")
[ "$APRES_ESSAI" = "$AVANT" ] || arret "sur la copie, les migrations ont change les compteurs (${APRES_ESSAI} contre ${AVANT})"
if [ "${SANS_BANCS:-0}" != "1" ]; then
  for b in "${STAGING}"/backend/prisma/tests/*.test.sql; do
    docker exec -i "$ESSAI" psql -U postgres -d essai -v ON_ERROR_STOP=1 < "$b" > "${SAUVEGARDES}/banc-$(basename "$b").log" 2>&1 \
      || arret "banc $(basename "$b") en echec sur la copie (voir ${SAUVEGARDES}) ; relancer avec SANS_BANCS=1 seulement apres examen"
  done
  vert "les bancs SQL passent sur la copie des donnees reelles (transactions annulees)"
fi
docker rm -f -v "$ESSAI" > /dev/null; trap - EXIT
vert "les ${EN_ATTENTE} migrations passent sur la copie, sans changer aucun compteur"

# ---------------------------------------------------------------------------------------------
etape "9. Confirmation"
cat <<'AVERTISSEMENT'
Tous les prerequis techniques sont tenus. Avant de continuer, la session GLPI (20/10) a pose
trois conditions qu'aucun script ne peut verifier :
  (a) le serveur de rebond compromis a ete remedie ;
  (b) la cause de l'arret de sshd est etablie (journalctl -u ssh -u ssh.socket) ;
  (c) les secrets ont ete renouveles, et les nouvelles cles deposees pour les sauvegardes.
Tapez DEPLOYER pour confirmer qu'elles sont remplies, ou autre chose pour arreter.
AVERTISSEMENT
# En execution a distance (stdin partage avec docker compose exec -T, qui le vide),
# la confirmation peut etre portee par DEPLOY_OUI=1 : decision aussi explicite, mais
# ecrite, de l operateur.
if [ "${DEPLOY_OUI:-0}" = "1" ]; then
  REPONSE="DEPLOYER"
  echo "-- confirmation portee par DEPLOY_OUI=1 (operateur)"
else
  read -r REPONSE
fi
[ "$REPONSE" = "DEPLOYER" ] || arret "deploiement non confirme"

# Ce qu'il faudra pour revenir en arriere : le code et les images d'avant.
tar --exclude='./node_modules' --exclude='./*/node_modules' -czf "${SAUVEGARDES}/code-avant.tar.gz" .
for s in backend frontend; do
  ID=$(docker compose images -q "$s" | head -1 || true)
  [ -n "$ID" ] && docker tag "$ID" "console-bdri-${s}:avant-${HORODATAGE}"
done
vert "code et images d'avant conserves (console-bdri-*:avant-${HORODATAGE})"

etape "9b. Extraction en place, construction, migrations"
tar -xzf "$ARCHIVE" -C . --strip-components=1
docker compose up -d --build
for _ in $(seq 1 60); do docker compose exec -T backend node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break; sleep 3; done
docker compose exec -T backend npm run prisma:deploy

# ---------------------------------------------------------------------------------------------
etape "10. Controles d'apres"
echec=0
APRES=$(compteurs)
[ "$APRES" = "$AVANT" ] || { rouge "compteurs CHANGES : ${AVANT} -> ${APRES}"; echec=1; }
RESTANTES=$(docker compose exec -T backend npx prisma migrate status 2>&1 | grep -c 'have not yet been applied' || true)
[ "$RESTANTES" = "0" ] || { rouge "des migrations restent non appliquees"; echec=1; }
ECHECS=$(docker compose exec -T backend node -e "fetch('http://localhost:4000/api/health').then(r=>r.json()).then(j=>console.log(j?.checks?.audit?.echecsDepuisDemarrage ?? j?.audit?.echecsDepuisDemarrage ?? 'absent'))")
[ "$ECHECS" = "0" ] || { rouge "audit.echecsDepuisDemarrage = ${ECHECS}"; echec=1; }
CODE=$(docker compose exec -T backend node -e "fetch('http://localhost:4000/api/troncons').then(r=>console.log(r.status))")
[ "$CODE" = "401" ] || { rouge "/api/troncons sans jeton repond ${CODE}, 401 attendu"; echec=1; }
sha256sum -c --quiet "${SAUVEGARDES}/env-avant.sha256" || { rouge "un .env a CHANGE"; echec=1; }
if [ "$echec" -ne 0 ]; then
  rouge "UN CONTROLE D'APRES A ECHOUE. Aucun retour arriere automatique. Procedure :"
  rouge "  1. descentes dans l'ordre INVERSE : backend/prisma/descentes/<migration>.sql (voir ${SAUVEGARDES}/en-attente.txt)"
  rouge "  2. code d'avant : tar -xzf ${SAUVEGARDES}/code-avant.tar.gz -C /opt/console-bdri"
  rouge "  3. images d'avant : console-bdri-*:avant-${HORODATAGE}, puis docker compose up -d"
  rouge "  4. en dernier recours : restaurer ${DUMP}"
  exit 2
fi
vert "DEPLOIEMENT TERMINE : commit ${COMMIT:0:7}, compteurs identiques, 0 echec d'audit, 401 sur route protegee, .env inchanges."
vert "Traces : ${SAUVEGARDES}"
