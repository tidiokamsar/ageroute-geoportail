#!/usr/bin/env bash
#
# Verification de restauration de la Console BDRI.
#
# Une sauvegarde jamais restauree n'est pas une sauvegarde : c'est une intention.
# Ce script prend la derniere archive, la restaure dans un conteneur JETABLE, et
# compare ce qu'il y trouve au manifeste produit lors de la sauvegarde.
#
# Il ne touche JAMAIS la base de production : le conteneur de verification est
# isole, sans reseau applicatif, et detruit a la sortie quoi qu'il arrive.
#
# Particularite BDRI : la base porte des colonnes geometry, donc le conteneur de
# verification doit embarquer PostGIS. Une image postgres nue echouerait a la
# restauration sur le type geometry — et l'echec serait interprete a tort comme une
# sauvegarde corrompue.
#
# Usage : verifier-restauration-bdri.sh [repertoire_des_sauvegardes]

set -euo pipefail

REPERTOIRE="${1:-$HOME/sauvegardes-bdri}"
JOURNAL="$REPERTOIRE/verification-restauration.log"
IMAGE_POSTGRES="${IMAGE_POSTGRES:-postgis/postgis:17-3.5}"
CONTENEUR_JETABLE="verification-bdri-$$"

CHEMINS_CLE=(
    "/etc/bdri/cle-sauvegarde"
    "$HOME/.bdri/cle-sauvegarde"
    "$HOME/.config/bdri/cle-sauvegarde"
)

TRAVAIL="$(mktemp -d)"

tracer() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*" | tee -a "$JOURNAL"; }

nettoyer() {
    docker rm -f "$CONTENEUR_JETABLE" >/dev/null 2>&1 || true
    rm -rf "$TRAVAIL"
}
trap nettoyer EXIT

echouer() {
    tracer "ECHEC DE VERIFICATION : $*"
    tracer "  La derniere sauvegarde ne peut pas etre consideree comme restaurable."
    exit 1
}

tracer "=== Verification de restauration ==="

# ─────────────────────────────────────────────────────────────
# 1. Derniere archive
# ─────────────────────────────────────────────────────────────
ARCHIVE="$(ls -1t "$REPERTOIRE"/bdri_*.dump* 2>/dev/null | head -1 || true)"
[ -n "$ARCHIVE" ] || echouer "aucune archive de base dans $REPERTOIRE"
HORODATAGE="$(basename "$ARCHIVE" | sed -E 's/^bdri_([0-9_]+)\.dump.*/\1/')"
MANIFESTE="$REPERTOIRE/manifeste_${HORODATAGE}.txt"
tracer "Archive : $(basename "$ARCHIVE")"

# ─────────────────────────────────────────────────────────────
# 2. L'archive est-elle celle qu'annonce le manifeste ?
# ─────────────────────────────────────────────────────────────
if [ -r "$MANIFESTE" ]; then
    ATTENDUE="$(grep -oE "[0-9a-f]{64}  $(basename "$ARCHIVE")" "$MANIFESTE" | cut -d' ' -f1 || true)"
    if [ -n "$ATTENDUE" ]; then
        REELLE="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
        [ "$ATTENDUE" = "$REELLE" ] \
            || echouer "empreinte differente du manifeste — l'archive a change depuis sa creation"
        tracer "  empreinte conforme au manifeste"
    fi
else
    tracer "  AVERTISSEMENT : manifeste absent, comparaison impossible"
fi

# ─────────────────────────────────────────────────────────────
# 3. Dechiffrement si necessaire
# ─────────────────────────────────────────────────────────────
DUMP="$TRAVAIL/bdri.dump"
if [[ "$ARCHIVE" == *.enc ]]; then
    FICHIER_CLE=""
    for chemin in "${CHEMINS_CLE[@]}"; do
        if [ -r "$chemin" ]; then FICHIER_CLE="$chemin"; break; fi
    done
    [ -n "$FICHIER_CLE" ] || echouer "archive chiffree mais cle introuvable (${CHEMINS_CLE[*]})"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
        -in "$ARCHIVE" -out "$DUMP" -pass "file:$FICHIER_CLE" 2>>"$JOURNAL" \
        || echouer "dechiffrement impossible — la cle ne correspond pas a l'archive"
    tracer "  dechiffree"
else
    cp "$ARCHIVE" "$DUMP"
fi

# ─────────────────────────────────────────────────────────────
# 4. Conteneur jetable
# ─────────────────────────────────────────────────────────────
tracer "Conteneur jetable ($IMAGE_POSTGRES)…"
docker run -d --name "$CONTENEUR_JETABLE" \
    --network none \
    -e POSTGRES_PASSWORD=verification-jetable \
    -e POSTGRES_DB=verification \
    "$IMAGE_POSTGRES" >/dev/null 2>>"$JOURNAL" \
    || echouer "le conteneur de verification n'a pas demarre"

# Attendre la FIN de l'initialisation, et pas seulement une reponse du serveur.
#
# L'image PostGIS demarre un serveur temporaire pendant qu'elle s'initialise :
# pg_isready repond favorablement, et meme un SELECT aboutit, alors que rien n'est
# pret. Interroger a ce moment produit deux echecs deroutants, tous deux constates :
# « database "verification" does not exist », puis — en creant l'extension pendant
# que l'image cree la sienne — un conflit sur postgis_tiger_geocoder qui TUE le
# conteneur en code 3, sans le moindre rapport avec l'archive testee.
#
# Le marqueur de fin d'initialisation est le seul signal fiable.
PRET=0
for _ in $(seq 1 120); do
    if docker logs "$CONTENEUR_JETABLE" 2>&1 | grep -q "PostgreSQL init process complete"; then
        PRET=1; break
    fi
    docker inspect "$CONTENEUR_JETABLE" --format '{{.State.Running}}' 2>/dev/null | grep -q true \
        || echouer "le conteneur de verification s'est arrete pendant son initialisation"
    sleep 1
done
[ "$PRET" -eq 1 ] || echouer "l'initialisation du conteneur de verification n'a pas abouti en 120 s"

for _ in $(seq 1 30); do
    docker exec "$CONTENEUR_JETABLE" psql -U postgres -d verification -c 'SELECT 1' >/dev/null 2>&1 && break
    sleep 1
done
docker exec "$CONTENEUR_JETABLE" psql -U postgres -d verification -c 'SELECT 1' >/dev/null 2>&1 \
    || echouer "la base de verification n'est pas interrogeable apres initialisation"

# ─────────────────────────────────────────────────────────────
# 5. Restauration
# ─────────────────────────────────────────────────────────────
tracer "Restauration…"
# PostGIS est deja installe par l'image : le recreer ici entrerait en conflit avec
# son propre script d'initialisation. On se contente de verifier sa presence.
docker exec "$CONTENEUR_JETABLE" psql -U postgres -d verification -tAc \
    "SELECT extversion FROM pg_extension WHERE extname='postgis'" 2>/dev/null | grep -q . \
    || echouer "PostGIS indisponible dans le conteneur de verification"

docker exec -i "$CONTENEUR_JETABLE" pg_restore -U postgres -d verification --no-owner --no-acl \
    < "$DUMP" >>"$JOURNAL" 2>&1 \
    || tracer "  pg_restore a signale des avertissements (attendus : roles absents)"

# ─────────────────────────────────────────────────────────────
# 6. Ce qui a ete restaure correspond-il a ce qui a ete sauvegarde ?
# ─────────────────────────────────────────────────────────────
# `|| echo ""` est indispensable : sous `set -o pipefail`, une requete en echec
# ferait sortir le script SANS message, par le jeu de `set -e`. Un comptage
# impossible doit produire une valeur vide que les controles ci-dessous rejettent
# bruyamment, jamais un arret muet.
compter() {
    docker exec "$CONTENEUR_JETABLE" psql -U postgres -d verification -tAc "$1" 2>/dev/null \
        | tr -d ' \r' || echo ""
}

TABLES=$(compter "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
TRONCONS=$(compter "SELECT count(*) FROM troncons")
GEOMS=$(compter "SELECT count(geom) FROM troncons")
GEOMS_VALIDES=$(compter "SELECT count(*) FROM troncons WHERE geom IS NOT NULL AND ST_IsValid(geom)")
OUVRAGES=$(compter "SELECT count(*) FROM ouvrages")
CHANTIERS=$(compter "SELECT count(*) FROM chantiers")
USERS=$(compter "SELECT count(*) FROM users")
DOCUMENTS=$(compter "SELECT count(*) FROM documents")
MIGRATIONS=$(compter "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
FK=$(compter "SELECT count(*) FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY' AND table_schema='public'")

tracer "  tables restaurees      : $TABLES"
tracer "  troncons               : $TRONCONS (dont $GEOMS avec geometrie, $GEOMS_VALIDES valides)"
tracer "  ouvrages               : $OUVRAGES"
tracer "  chantiers              : $CHANTIERS"
tracer "  comptes utilisateurs   : $USERS"
tracer "  documents              : $DOCUMENTS"
tracer "  migrations enregistrees: $MIGRATIONS"
tracer "  cles etrangeres        : $FK"

# Une restauration qui rend une base vide est un echec silencieux : elle "reussit"
# techniquement sans rien rendre. On exige donc du contenu, pas seulement l'absence
# d'erreur.
[ "${TABLES:-0}" -gt 20 ]     || echouer "seulement ${TABLES:-0} tables restaurees"
[ "${TRONCONS:-0}" -gt 0 ]    || echouer "aucun troncon restaure"
[ "${GEOMS:-0}" -gt 0 ]       || echouer "aucune geometrie restauree — la couche SIG serait perdue"
[ "${USERS:-0}" -gt 0 ]       || echouer "aucun compte restaure — personne ne pourrait se connecter"
[ "${MIGRATIONS:-0}" -gt 0 ]  || echouer "historique des migrations absent"
[ "${FK:-0}" -gt 0 ]          || echouer "aucune cle etrangere — les relations seraient perdues"

# Les geometries doivent etre non seulement presentes mais valides : une geometrie
# corrompue par la restauration passerait le comptage tout en etant inexploitable.
[ "${GEOMS_VALIDES:-0}" -eq "${GEOMS:-0}" ] \
    || echouer "$((GEOMS - GEOMS_VALIDES)) geometrie(s) invalide(s) apres restauration"

# ─────────────────────────────────────────────────────────────
# 7. Coherence avec le manifeste
# ─────────────────────────────────────────────────────────────
if [ -r "$MANIFESTE" ]; then
    ATTENDU_TRONCONS="$(grep -oE 'troncons [0-9]+' "$MANIFESTE" | head -1 | awk '{print $2}' || true)"
    if [ -n "$ATTENDU_TRONCONS" ] && [ "$ATTENDU_TRONCONS" != "$TRONCONS" ]; then
        echouer "le manifeste annonce $ATTENDU_TRONCONS troncons, la restauration en rend $TRONCONS"
    fi
    tracer "  volumetrie conforme au manifeste"
fi

# ─────────────────────────────────────────────────────────────
# 8. Archive des fichiers televerses
# ─────────────────────────────────────────────────────────────
ARCHIVE_UP="$(ls -1t "$REPERTOIRE"/uploads_${HORODATAGE}.tar.gz* 2>/dev/null | head -1 || true)"
if [ -n "$ARCHIVE_UP" ]; then
    if [[ "$ARCHIVE_UP" == *.enc ]]; then
        tracer "  archive des fichiers presente et chiffree"
    else
        tar tzf "$ARCHIVE_UP" >/dev/null 2>&1 \
            && tracer "  archive des fichiers lisible : $(tar tzf "$ARCHIVE_UP" | grep -cv '/$' || true) fichier(s)" \
            || echouer "l'archive des fichiers televerses est illisible"
    fi
else
    tracer "  AVERTISSEMENT : aucune archive de fichiers pour cet horodatage"
fi

tracer "=== Restauration VERIFIEE — l'archive $HORODATAGE est exploitable ==="
