#!/usr/bin/env bash
#
# Etat des sauvegardes de la Console BDRI.
#
# Repond a une question simple, qui n'avait jusqu'ici aucune reponse :
#
#     La sauvegarde de cette nuit a-t-elle reussi ?
#
# Une sauvegarde qui echoue en silence est pire qu'une absence de sauvegarde : elle
# cree une fausse assurance. Ce rapport rend visible ce qui, sinon, ne se lit que dans
# un journal que personne n'ouvre.
#
# Lecture seule : ne modifie ni n'efface rien.
#
# Usage : etat-sauvegardes-bdri.sh [repertoire]

set -uo pipefail

REPERTOIRE="${1:-$HOME/sauvegardes-bdri}"
JOURNAL="$REPERTOIRE/sauvegarde.log"
JOURNAL_VERIF="$REPERTOIRE/verification-restauration.log"
JOURNAL_FICHIERS="$REPERTOIRE/controle-fichiers.log"

# Au-dela, la derniere sauvegarde est trop ancienne : la tache quotidienne ne tourne
# plus, ou echoue sans qu'on le sache.
AGE_MAX_HEURES="${AGE_MAX_HEURES:-30}"
# La verification de restauration est hebdomadaire ; on tolere un cycle manque.
AGE_MAX_VERIF_JOURS="${AGE_MAX_VERIF_JOURS:-14}"

ALERTES=0
alerte() { printf '  \033[31m!\033[0m %s\n' "$*"; ALERTES=$((ALERTES+1)); }
bon()    { printf '  \033[32mv\033[0m %s\n' "$*"; }
info()   { printf '    %s\n' "$*"; }

printf '\033[1mEtat des sauvegardes — Console BDRI\033[0m\n'
printf 'Repertoire : %s\n' "$REPERTOIRE"

if [ ! -d "$REPERTOIRE" ]; then
    alerte "repertoire de sauvegarde introuvable — aucune sauvegarde n'existe"
    exit 1
fi

# ─────────────────────────────────────────────────────────────
# 1. Derniere sauvegarde
# ─────────────────────────────────────────────────────────────
printf '\n\033[1mDerniere sauvegarde\033[0m\n'

DERNIERE=$(ls -1t "$REPERTOIRE"/bdri_*.dump* 2>/dev/null | head -1)
if [ -z "$DERNIERE" ]; then
    alerte "aucune archive de base trouvee"
else
    HORODATAGE=$(basename "$DERNIERE" | sed 's/^bdri_//; s/\.dump.*$//')
    AGE_S=$(( $(date +%s) - $(stat -c %Y "$DERNIERE") ))
    AGE_H=$(( AGE_S / 3600 ))
    TAILLE=$(stat -c %s "$DERNIERE")

    if [ "$AGE_H" -gt "$AGE_MAX_HEURES" ]; then
        alerte "derniere sauvegarde vieille de ${AGE_H} h (seuil : ${AGE_MAX_HEURES} h)"
    else
        bon "sauvegarde d'il y a ${AGE_H} h"
    fi
    info "horodatage : $HORODATAGE"
    info "taille     : $TAILLE octets"

    # Une archive en clair ne doit pas exister : la base porte des donnees
    # personnelles, et la copie hors serveur lui est refusee.
    case "$DERNIERE" in
        *.enc) bon "chiffree" ;;
        *)     alerte "NON CHIFFREE — la copie hors serveur lui sera refusee" ;;
    esac

    # Une sauvegarde qui n'existe qu'en un exemplaire ne protege pas d'une perte du
    # disque qui la porte.
    UPLOADS="${REPERTOIRE}/uploads_${HORODATAGE}.tar.gz"
    [ -f "$UPLOADS" ] || UPLOADS="${UPLOADS}.enc"
    if [ -f "$UPLOADS" ]; then
        bon "archive des fichiers presente ($(stat -c %s "$UPLOADS") octets)"
    else
        alerte "archive des fichiers manquante pour $HORODATAGE"
    fi
fi

# ─────────────────────────────────────────────────────────────
# 2. Le journal signale-t-il un echec ?
# ─────────────────────────────────────────────────────────────
printf '\n\033[1mDernier passage\033[0m\n'
if [ -f "$JOURNAL" ]; then
    DERNIER_DEBUT=$(grep -n "=== Debut de la sauvegarde" "$JOURNAL" | tail -1 | cut -d: -f1)
    if [ -n "$DERNIER_DEBUT" ]; then
        EXTRAIT=$(tail -n +"$DERNIER_DEBUT" "$JOURNAL")
        if echo "$EXTRAIT" | grep -q "ECHEC"; then
            alerte "le dernier passage a ECHOUE"
            echo "$EXTRAIT" | grep "ECHEC" | head -3 | sed 's/^/      /'
        elif echo "$EXTRAIT" | grep -q "terminee"; then
            bon "termine sans erreur"
        else
            alerte "passage interrompu — ni fin ni echec dans le journal"
        fi

        # Distinguer les deux avertissements qui comptent : une archive non chiffree,
        # et une sauvegarde qui n'est jamais sortie du serveur.
        echo "$EXTRAIT" | grep -q "cle de chiffrement absente" && alerte "cle de chiffrement absente"
        echo "$EXTRAIT" | grep -q "copie hors serveur effectuee" \
            && bon "copiee hors serveur" \
            || alerte "PAS de copie hors serveur — ne protege pas d'une perte de cette machine"
    fi
else
    alerte "journal de sauvegarde absent"
fi

# ─────────────────────────────────────────────────────────────
# 3. Derniere restauration verifiee
# ─────────────────────────────────────────────────────────────
printf '\n\033[1mDerniere restauration verifiee\033[0m\n'
if [ -f "$JOURNAL_VERIF" ]; then
    DERNIERE_OK=$(grep "Restauration VERIFIEE" "$JOURNAL_VERIF" | tail -1)
    if [ -n "$DERNIERE_OK" ]; then
        QUAND=$(echo "$DERNIERE_OK" | awk '{print $1}')
        AGE_J=$(( ( $(date +%s) - $(date -d "$QUAND" +%s 2>/dev/null || echo 0) ) / 86400 ))
        if [ "$AGE_J" -gt "$AGE_MAX_VERIF_JOURS" ]; then
            alerte "derniere verification il y a ${AGE_J} j (seuil : ${AGE_MAX_VERIF_JOURS} j)"
        else
            bon "verifiee il y a ${AGE_J} j"
        fi
        info "$QUAND"
    else
        # Une sauvegarde jamais restauree n'est pas une sauvegarde.
        alerte "AUCUNE restauration n'a jamais ete verifiee"
    fi
else
    alerte "journal de verification absent — la restauration n'a jamais ete testee"
fi

# ─────────────────────────────────────────────────────────────
# 4. Coherence base <-> fichiers
# ─────────────────────────────────────────────────────────────
printf '\n\033[1mCoherence base et fichiers\033[0m\n'
if [ -f "$JOURNAL_FICHIERS" ]; then
    DERNIER=$(grep -n "=== Controle de coherence" "$JOURNAL_FICHIERS" | tail -1 | cut -d: -f1)
    EXTRAIT=$(tail -n +"${DERNIER:-1}" "$JOURNAL_FICHIERS")
    if echo "$EXTRAIT" | grep -q "REFERENCES CASSEES"; then
        alerte "des references pointent vers un fichier absent"
        echo "$EXTRAIT" | grep -A3 "REFERENCES CASSEES" | head -4 | sed 's/^/      /'
    elif echo "$EXTRAIT" | grep -q "Controle OK"; then
        bon "toute reference pointe vers un fichier present"
    fi
else
    info "controle jamais execute"
fi

# ─────────────────────────────────────────────────────────────
printf '\n'
if [ "$ALERTES" -gt 0 ]; then
    printf '\033[31m%d point(s) demandent attention\033[0m\n' "$ALERTES"
    exit 1
fi
printf '\033[32mSauvegardes en bon etat\033[0m\n'
