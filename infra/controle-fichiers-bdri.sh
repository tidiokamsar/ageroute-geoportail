#!/usr/bin/env bash
#
# Controle de coherence entre la base et le stockage de fichiers.
#
# POURQUOI CE CONTROLE EXISTE
#
# Du 29 juin au 1er septembre 2026, deux fichiers ont ete inaccessibles — un document
# et une photo d'ouvrage — parce que le volume de stockage avait ete detache du
# service backend. La base continuait de les referencer ; les fichiers etaient la,
# mais hors d'atteinte de l'application. PERSONNE NE S'EN EST APERCU pendant deux
# mois. Rien ne le signalait : ni journal, ni alerte, et l'erreur n'apparaissait qu'a
# celui qui tentait d'ouvrir le document.
#
# Le controle va dans les deux sens, car les deux defauts n'ont pas la meme gravite :
#
#   reference sans fichier  -> GRAVE. L'utilisateur obtient une erreur.
#   fichier sans reference  -> BENIN. Occupe de la place, ne casse rien.
#
# Usage : controle-fichiers-bdri.sh

set -uo pipefail

CONTENEUR_DB="${CONTENEUR_DB:-console-bdri-db-1}"
DB_USER="${DB_USER:-bdri_app}"
DB_NAME="${DB_NAME:-console_bdri}"
VOLUME_UPLOADS="${VOLUME_UPLOADS:-console-bdri_bdri_uploads}"
JOURNAL="${JOURNAL:-$HOME/sauvegardes-bdri/controle-fichiers.log}"

mkdir -p "$(dirname "$JOURNAL")"

tracer() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*" | tee -a "$JOURNAL"; }
alerter() { tracer "ALERTE : $1"; }

TMP="$(mktemp -d)"
nettoyer() { rm -rf "$TMP"; }
trap nettoyer EXIT

tracer "=== Controle de coherence base <-> fichiers ==="

# ─────────────────────────────────────────────────────────────
# 1. Ce que la base reference
# ─────────────────────────────────────────────────────────────
# Quatre sources, verifiees dans le schema plutot que supposees :
#   Document.filePath      -> documents/
#   Ouvrage.photos[]       -> photos/
#   Inspection.photos[]    -> photos/
#   OtPhoto.fileName       -> photos/
requete_references() {
    docker exec "$CONTENEUR_DB" psql -U "$DB_USER" -d "$DB_NAME" -tAc "
        SELECT 'documents/' || \"filePath\" FROM documents WHERE \"filePath\" IS NOT NULL
        UNION
        SELECT 'photos/' || unnest(photos) FROM ouvrages WHERE \"deletedAt\" IS NULL
        UNION
        SELECT 'photos/' || unnest(photos) FROM inspections WHERE \"deletedAt\" IS NULL
        UNION
        SELECT 'photos/' || \"fileName\" FROM ot_photos WHERE \"fileName\" IS NOT NULL;
    " 2>/dev/null | sed '/^$/d' | sort -u
}

if ! requete_references > "$TMP/references.txt"; then
    tracer "ECHEC : base injoignable"
    alerter "controle impossible — base injoignable"
    exit 1
fi
NB_REFERENCES=$(wc -l < "$TMP/references.txt")
tracer "References en base : $NB_REFERENCES"

# ─────────────────────────────────────────────────────────────
# 2. Ce que le stockage contient
# ─────────────────────────────────────────────────────────────
if ! docker run --rm -v "${VOLUME_UPLOADS}:/v:ro" alpine \
        sh -c 'cd /v && find . -type f | sed "s|^\./||"' 2>/dev/null \
        | sed '/^$/d' | sort -u > "$TMP/fichiers.txt"; then
    tracer "ECHEC : volume $VOLUME_UPLOADS illisible"
    alerter "controle impossible — volume illisible"
    exit 1
fi
NB_FICHIERS=$(wc -l < "$TMP/fichiers.txt")
tracer "Fichiers presents      : $NB_FICHIERS"

# ─────────────────────────────────────────────────────────────
# 3. Comparaison dans les deux sens
# ─────────────────────────────────────────────────────────────
comm -23 "$TMP/references.txt" "$TMP/fichiers.txt" > "$TMP/references-cassees.txt"
comm -13 "$TMP/references.txt" "$TMP/fichiers.txt" > "$TMP/orphelins.txt"

NB_CASSEES=$(wc -l < "$TMP/references-cassees.txt")
NB_ORPHELINS=$(wc -l < "$TMP/orphelins.txt")

if [ "$NB_CASSEES" -gt 0 ]; then
    tracer "REFERENCES CASSEES : $NB_CASSEES — l'utilisateur obtiendra une erreur"
    sed 's/^/    /' "$TMP/references-cassees.txt" | tee -a "$JOURNAL"
    alerter "$NB_CASSEES reference(s) pointent vers un fichier absent"
else
    tracer "References cassees     : 0"
fi

if [ "$NB_ORPHELINS" -gt 0 ]; then
    # Benin : ces fichiers occupent de la place sans rien casser. On les signale sans
    # les supprimer — un fichier efface a tort ne se recupere pas, et l'ecart peut
    # venir d'un televersement en cours au moment du controle.
    tracer "Fichiers orphelins     : $NB_ORPHELINS (aucun impact utilisateur, non supprimes)"
    sed 's/^/    /' "$TMP/orphelins.txt" | tee -a "$JOURNAL"
else
    tracer "Fichiers orphelins     : 0"
fi

# ─────────────────────────────────────────────────────────────
# 4. Verdict
# ─────────────────────────────────────────────────────────────
if [ "$NB_CASSEES" -gt 0 ]; then
    tracer "=== Controle EN ECHEC ==="
    exit 1
fi

tracer "=== Controle OK — toute reference pointe vers un fichier present ==="
