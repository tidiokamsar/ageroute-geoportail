#!/usr/bin/env bash
#
# Sauvegarde de la Console BDRI.
#
# Reprend le dispositif eprouve du portail des opportunites et de l'ERP, en service
# sur ce meme serveur. Les lecons qui y sont documentees sont reprises telles quelles :
# la cle de chiffrement est CHERCHEE et non supposee, une archive non chiffree ne
# quitte pas le serveur, et un echec est bruyant.
#
# Couvre : base PostgreSQL/PostGIS, fichiers televerses, manifeste.
# Ne couvre PAS : les secrets (backend/.env), qui ne doivent jamais entrer dans une
# archive destinee a sortir du serveur.
#
# Usage : sauvegarde-bdri.sh [repertoire_de_destination]

set -euo pipefail

REPERTOIRE="${1:-$HOME/sauvegardes-bdri}"
HORODATAGE="$(date -u +%Y%m%d_%H%M%S)"
JOURNAL="$REPERTOIRE/sauvegarde.log"
RETENTION_JOURS="${RETENTION_JOURS:-14}"

CONTENEUR_DB="${CONTENEUR_DB:-console-bdri-db-1}"
DB_USER="${DB_USER:-bdri_app}"
DB_NAME="${DB_NAME:-console_bdri}"
VOLUME_UPLOADS="${VOLUME_UPLOADS:-console-bdri_bdri_uploads}"

HOTE_DISTANT="${HOTE_DISTANT:-agerdb@102.211.199.132}"
REPERTOIRE_DISTANT="${REPERTOIRE_DISTANT:-~/ageroute-depots/bdri-sauvegardes/}"
CLE_SSH="${CLE_SSH:-$HOME/.ssh/id_ed25519}"

# La cle est cherchee, jamais supposee. Le portail des opportunites a connu le cas
# le 19/08/2026 : la cle existait ailleurs que la ou le script la cherchait, et les
# sauvegardes sont restees en clair sans que personne le remarque.
CHEMINS_CLE=(
    "/etc/bdri/cle-sauvegarde"
    "$HOME/.bdri/cle-sauvegarde"
    "$HOME/.config/bdri/cle-sauvegarde"
)
if [ -z "${FICHIER_CLE:-}" ]; then
    for chemin in "${CHEMINS_CLE[@]}"; do
        if [ -r "$chemin" ]; then FICHIER_CLE="$chemin"; break; fi
    done
    FICHIER_CLE="${FICHIER_CLE:-${CHEMINS_CLE[0]}}"
fi

mkdir -p "$REPERTOIRE"
chmod 700 "$REPERTOIRE"

tracer() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*" | tee -a "$JOURNAL"; }
alerter() { tracer "ALERTE : $1"; }
echouer() {
    tracer "ECHEC : $*"
    # Un echec silencieux est pire qu'une absence de sauvegarde : il cree une fausse
    # assurance.
    alerter "Sauvegarde BDRI en echec : $*"
    exit 1
}

NON_CHIFFREE=0

tracer "=== Debut de la sauvegarde $HORODATAGE ==="

# ─────────────────────────────────────────────────────────────
# 1. Base de donnees
# ─────────────────────────────────────────────────────────────
FICHIER_DB="$REPERTOIRE/bdri_${HORODATAGE}.dump"

tracer "Extraction de la base…"
docker exec "$CONTENEUR_DB" pg_dump -U "$DB_USER" -d "$DB_NAME" \
    -Fc --no-owner --no-acl > "$FICHIER_DB" 2>>"$JOURNAL" \
    || echouer "pg_dump a echoue"

tracer "Verification de l'integrite de l'archive…"
docker exec -i "$CONTENEUR_DB" pg_restore --list < "$FICHIER_DB" > /dev/null 2>>"$JOURNAL" \
    || echouer "l'archive de base est illisible"
tracer "  base : $(stat -c%s "$FICHIER_DB") octets, integrite verifiee"

# ─────────────────────────────────────────────────────────────
# 2. Fichiers televerses
# ─────────────────────────────────────────────────────────────
FICHIER_UPLOADS="$REPERTOIRE/uploads_${HORODATAGE}.tar.gz"

tracer "Archivage des fichiers televerses…"
docker run --rm \
    -v "${VOLUME_UPLOADS}:/source:ro" \
    -v "$REPERTOIRE:/destination" \
    alpine tar czf "/destination/$(basename "$FICHIER_UPLOADS")" -C /source . 2>>"$JOURNAL" \
    || echouer "l'archivage des fichiers a echoue"

tar tzf "$FICHIER_UPLOADS" > /dev/null 2>>"$JOURNAL" \
    || echouer "l'archive des fichiers est illisible"
NB_FICHIERS=$(tar tzf "$FICHIER_UPLOADS" | grep -cv '/$' || true)
tracer "  fichiers : $(stat -c%s "$FICHIER_UPLOADS") octets, $NB_FICHIERS fichier(s), integrite verifiee"

# ─────────────────────────────────────────────────────────────
# 3. Chiffrement
# ─────────────────────────────────────────────────────────────
# La base porte des donnees personnelles : comptes, courriels, noms complets.
if [ -r "$FICHIER_CLE" ]; then
    tracer "Chiffrement…"
    for fichier in "$FICHIER_DB" "$FICHIER_UPLOADS"; do
        openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
            -in "$fichier" -out "${fichier}.enc" -pass "file:$FICHIER_CLE" 2>>"$JOURNAL" \
            || echouer "le chiffrement de $(basename "$fichier") a echoue"
        shred -u "$fichier" 2>/dev/null || rm -f "$fichier"
        tracer "  chiffre : $(basename "${fichier}.enc")"
    done
    SUFFIXE=".enc"
else
    tracer "AVERTISSEMENT : cle de chiffrement absente ($FICHIER_CLE)."
    tracer "  Cherchee dans : ${CHEMINS_CLE[*]}"
    tracer "  Les sauvegardes contiennent des donnees personnelles NON CHIFFREES."
    alerter "Sauvegarde BDRI non chiffree : cle absente"
    SUFFIXE=""
    NON_CHIFFREE=1
fi

# ─────────────────────────────────────────────────────────────
# 4. Manifeste
# ─────────────────────────────────────────────────────────────
MANIFESTE="$REPERTOIRE/manifeste_${HORODATAGE}.txt"
{
    echo "Sauvegarde de la Console BDRI"
    echo "Horodatage UTC : $HORODATAGE"
    echo "Chiffree       : $([ -n "$SUFFIXE" ] && echo oui || echo NON)"
    echo
    echo "Dernieres migrations appliquees :"
    docker exec "$CONTENEUR_DB" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 3;" \
        2>/dev/null | sed 's/^/  /'
    echo
    echo "Volumetrie au moment de la sauvegarde :"
    docker exec "$CONTENEUR_DB" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT 'troncons ' || count(*) FROM troncons
         UNION ALL SELECT 'ouvrages ' || count(*) FROM ouvrages
         UNION ALL SELECT 'chantiers ' || count(*) FROM chantiers
         UNION ALL SELECT 'users ' || count(*) FROM users
         UNION ALL SELECT 'documents ' || count(*) FROM documents
         UNION ALL SELECT 'geometries_troncons ' || count(geom) FROM troncons;" \
        2>/dev/null | sed 's/^/  /'
    echo
    echo "Fichiers televerses : $NB_FICHIERS"
    echo
    echo "Empreintes SHA-256 :"
    (cd "$REPERTOIRE" && sha256sum "bdri_${HORODATAGE}.dump${SUFFIXE}" \
        "uploads_${HORODATAGE}.tar.gz${SUFFIXE}" 2>/dev/null) | sed 's/^/  /'
} > "$MANIFESTE"
tracer "Manifeste : $(basename "$MANIFESTE")"

# ─────────────────────────────────────────────────────────────
# 5. Rotation locale
# ─────────────────────────────────────────────────────────────
find "$REPERTOIRE" -name 'bdri_*.dump*'      -mtime "+$RETENTION_JOURS" -delete
find "$REPERTOIRE" -name 'uploads_*.tar.gz*' -mtime "+$RETENTION_JOURS" -delete
find "$REPERTOIRE" -name 'manifeste_*.txt'   -mtime "+$RETENTION_JOURS" -delete
tracer "Rotation locale : au-dela de $RETENTION_JOURS jours"

# ─────────────────────────────────────────────────────────────
# 6. Copie hors serveur
# ─────────────────────────────────────────────────────────────
# Une archive non chiffree ne quitte PAS le serveur : la sortir multiplierait
# l'exposition au lieu de la contenir. La sauvegarde locale demeure.
if [ "$NON_CHIFFREE" -eq 1 ]; then
    tracer "Copie hors serveur REFUSEE : l'archive n'est pas chiffree."
    alerter "copie hors serveur refusee — archive non chiffree"
else
    tracer "Copie vers $HOTE_DISTANT…"
    if scp -i "$CLE_SSH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
            "$REPERTOIRE/bdri_${HORODATAGE}.dump${SUFFIXE}" \
            "$REPERTOIRE/uploads_${HORODATAGE}.tar.gz${SUFFIXE}" \
            "$MANIFESTE" \
            "$HOTE_DISTANT:$REPERTOIRE_DISTANT" 2>>"$JOURNAL"; then
        tracer "  copie hors serveur effectuee"
    else
        # Une sauvegarde qui ne sort jamais du serveur ne protege pas de la perte
        # de ce serveur — c'est-a-dire du scenario qu'elle est censee couvrir.
        tracer "AVERTISSEMENT : copie hors serveur echouee, sauvegarde locale seule"
        alerter "copie hors serveur echouee — la sauvegarde ne protege pas d'une perte du serveur"
    fi
fi

tracer "=== Sauvegarde $HORODATAGE terminee ==="
