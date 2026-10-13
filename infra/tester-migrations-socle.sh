#!/usr/bin/env bash
#
# Eprouve les migrations en attente contre la structure REELLE de production, et
# tranche la question qui bloque le deploiement.
#
# Il y en a six et non cinq, et je l'ai appris en mesurant : `socle_terrain` est dans
# `main` et sur le serveur depuis le 7 octobre, mais n'a JAMAIS ete appliquee. Une liste
# etablie sur l'ecart avec `main` la manque, puisqu'elle y est deja. Etre dans `main` et
# etre applique sont deux questions differentes.
#
#   20261007140000_socle_terrain
#   20261007180000_audit_validation
#   20261007200000_gouvernance_defauts
#   20261013120000_delegation_validation
#   20261013140000_droit_de_deleguer
#   20261013160000_condition_engine
#   20261013180000_portions_homogenes
#
# Ecrit sur le modele de `tester-migrations-phase4.sh`, dont il reprend le dispositif :
# partir de la derniere sauvegarde chiffree, la restaurer dans un conteneur JETABLE,
# appliquer, verifier, defaire, verifier a nouveau.
#
# NE TOUCHE JAMAIS LA PRODUCTION. Tout se passe dans un conteneur ephemere, detruit a
# la sortie quel que soit le resultat.
#
# ────────────────────────────────────────────────────────────────────────────────
# CE QUE CE SCRIPT EXISTE POUR REPONDRE
# ────────────────────────────────────────────────────────────────────────────────
#
# `20261007200000_gouvernance_defauts` a ete AMENDEE apres avoir ete ecrite, en
# supposant qu'elle n'etait pas appliquee. Si elle l'est, l'amendement est invalide :
# Prisma stocke dans `_prisma_migrations` une somme de controle du fichier et refuse
# une migration « modified after it was applied ».
#
# Or la sauvegarde restauree CONTIENT `_prisma_migrations`. La question se tranche donc
# sur une copie, sans ouvrir la production. C'est l'etape 2, et un echec y arrete tout :
# les etapes suivantes n'auraient aucun sens sur une base dont l'historique de migration
# ne correspond pas aux fichiers du depot.
#
# ────────────────────────────────────────────────────────────────────────────────
# UNE MIGRATION N'EST PAS REVERSIBLE, ET IL FAUT LE DIRE
# ────────────────────────────────────────────────────────────────────────────────
#
# `audit_validation` ajoute trois valeurs a l'enum `AuditAction`. PostgreSQL ne sait pas
# retirer une valeur d'un type enum : il n'existe pas de `ALTER TYPE ... DROP VALUE`.
# Cette migration est donc DEFINITIVE.
#
# Ce n'est pas grave en soi — une valeur d'enum que personne n'ecrit ne coute rien — mais
# le rollback ne rend pas la base a son etat d'origine au sens strict, et promettre le
# contraire serait faux. L'etape 6 verifie donc le retour des TABLES, des COLONNES et des
# TYPES CREES, et declare separement les trois valeurs qui restent.
#
# ────────────────────────────────────────────────────────────────────────────────
# POURQUOI AUCUN TEST DE REJOUABILITE
# ────────────────────────────────────────────────────────────────────────────────
#
# `tester-migrations-phase4.sh` verifiait que ses migrations se rejouent sans erreur,
# parce qu'elles avaient ete ecrites idempotentes a la main. Celles-ci sont des migrations
# Prisma : elles font `CREATE TABLE` sans `IF NOT EXISTS`, et Prisma ne les rejoue jamais
# puisqu'il tient leur journal dans `_prisma_migrations`. Tester une rejouabilite qui n'est
# pas attendue ferait echouer le banc d'essai sur une exigence que personne ne porte.
#
# Usage : tester-migrations-socle.sh [repertoire-migrations]
#
# Variables : SAUVEGARDES, CLE, IMAGE_POSTGRES — memes valeurs par defaut que le
# script de la phase 4.

set -uo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPERTOIRE_MIGRATIONS="${1:-$RACINE/backend/prisma/migrations}"
SAUVEGARDES="${SAUVEGARDES:-$HOME/sauvegardes-bdri}"
CLE="${CLE:-$HOME/.bdri/cle-sauvegarde}"
IMAGE_POSTGRES="${IMAGE_POSTGRES:-postgis/postgis:17-3.5}"
CONTENEUR="test-migrations-socle-$$"
BASE="verification"

# Dans l'ordre d'application. L'ordre compte : `gouvernance_defauts` cree `defauts`, qui
# reference `observations` et `missions` du socle terrain, et `condition_engine` reference
# `troncons` et `users`.
MIGRATIONS=(
    20261007140000_socle_terrain
    20261007180000_audit_validation
    20261007200000_gouvernance_defauts
    20261013120000_delegation_validation
    20261013140000_droit_de_deleguer
    20261013160000_condition_engine
    20261013180000_portions_homogenes
)

ECHECS=0
ok()      { printf '  \033[32mv\033[0m %s\n' "$*"; }
echec()   { printf '  \033[31mX\033[0m %s\n' "$*"; ECHECS=$((ECHECS+1)); }
alerte()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
info()    { printf '    %s\n' "$*"; }
titre()   { printf '\n\033[1m%s\033[0m\n' "$*"; }

nettoyer() { docker rm -f "$CONTENEUR" >/dev/null 2>&1 || true; }
trap nettoyer EXIT

q() { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$1" 2>/dev/null | tr -d ' \r'; }

printf '\033[1mBanc d'\''essai des migrations du socle terrain\033[0m\n'

# ─────────────────────────────────────────────────────────────
titre "0. Preconditions"

if ! docker info >/dev/null 2>&1; then
    echec "le demon Docker ne repond pas — rien ne peut etre eprouve"
    info "ce n'est pas un echec des migrations : c'est l'impossibilite de les tester"
    exit 1
fi
ok "Docker repond"

for m in "${MIGRATIONS[@]}"; do
    [ -f "$REPERTOIRE_MIGRATIONS/$m/migration.sql" ] \
        || { echec "$m/migration.sql introuvable sous $REPERTOIRE_MIGRATIONS"; exit 1; }
done
ok "les ${#MIGRATIONS[@]} fichiers de migration sont presents"

# Meme convention de nom que `sauvegarde-bdri.sh` : bdri_<horodatage>.dump, suffixe .enc
# quand la cle etait disponible au moment de la sauvegarde.
ARCHIVE=$(ls -1t "$SAUVEGARDES"/bdri_*.dump* 2>/dev/null | head -1)
[ -n "$ARCHIVE" ] || { echec "aucune archive bdri_*.dump* dans $SAUVEGARDES"; exit 1; }
ok "archive : $(basename "$ARCHIVE")"

if [[ "$ARCHIVE" == *.enc ]]; then
    [ -r "$CLE" ] || { echec "archive chiffree mais cle illisible : $CLE"; exit 1; }
    ok "cle de dechiffrement lisible"
else
    alerte "archive NON chiffree — a ne pas laisser quitter le serveur"
fi

# ─────────────────────────────────────────────────────────────
titre "1. Restauration dans un conteneur jetable"

docker run -d --name "$CONTENEUR" \
    -e POSTGRES_PASSWORD=verification -e POSTGRES_DB="$BASE" \
    "$IMAGE_POSTGRES" >/dev/null 2>&1 \
    || { echec "demarrage du conteneur impossible"; exit 1; }

for _ in $(seq 60); do
    docker logs "$CONTENEUR" 2>&1 | grep -q "PostgreSQL init process complete" && break
    sleep 1
done
docker exec "$CONTENEUR" pg_isready -U postgres >/dev/null 2>&1 \
    || { echec "PostgreSQL ne repond pas dans le conteneur"; exit 1; }
ok "conteneur pret ($IMAGE_POSTGRES)"

# `pg_dump -Fc` : format personnalise, donc `pg_restore` et non `psql`. Les parametres de
# dechiffrement doivent correspondre EXACTEMENT a ceux de la sauvegarde, `-iter 200000`
# compris — sans quoi openssl echoue sans dire pourquoi.
TRAVAIL=$(mktemp -d)
trap 'nettoyer; rm -rf "$TRAVAIL"' EXIT
DUMP="$TRAVAIL/bdri.dump"

if [[ "$ARCHIVE" == *.enc ]]; then
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
        -in "$ARCHIVE" -out "$DUMP" -pass "file:$CLE" 2>/dev/null \
        || { echec "dechiffrement impossible — la cle ne correspond pas a l'archive"; exit 1; }
else
    cp "$ARCHIVE" "$DUMP"
fi

# PostGIS est indispensable : une image postgres nue echoue sur le type geometry, et
# l'echec serait pris a tort pour une sauvegarde corrompue.
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" \
    -c 'CREATE EXTENSION IF NOT EXISTS postgis' >/dev/null 2>&1 \
    || { echec "PostGIS indisponible dans le conteneur de verification"; exit 1; }

# pg_restore signale des avertissements attendus (roles absents) : ils ne sont pas des
# echecs, et s'arreter dessus rendrait le banc d'essai inutilisable.
docker exec -i "$CONTENEUR" pg_restore -U postgres -d "$BASE" --no-owner --no-acl \
    < "$DUMP" >/dev/null 2>&1 || true

TRONCONS_AVANT=$(q "SELECT count(*) FROM troncons WHERE \"deletedAt\" IS NULL")
[ -n "$TRONCONS_AVANT" ] && [ "$TRONCONS_AVANT" -gt 0 ] 2>/dev/null \
    || { echec "restauration vide — archive ou cle incorrecte"; exit 1; }

OUVRAGES_AVANT=$(q "SELECT count(*) FROM ouvrages WHERE \"deletedAt\" IS NULL")
GEOM_AVANT=$(q "SELECT count(*) FROM troncons WHERE geom IS NOT NULL AND ST_IsValid(geom)")
COLONNES_AVANT=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public'")
TABLES_AVANT=$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
TYPES_AVANT=$(q "SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'")
AUDIT_AVANT=$(q "SELECT count(*) FROM audit_logs")

ok "restauree : $TRONCONS_AVANT troncons, $OUVRAGES_AVANT ouvrages, $AUDIT_AVANT lignes d'audit"
info "geometries valides : $GEOM_AVANT   tables : $TABLES_AVANT   colonnes : $COLONNES_AVANT   enums : $TYPES_AVANT"

# ─────────────────────────────────────────────────────────────
titre "2. L'HISTORIQUE DE MIGRATION CORRESPOND-IL AUX FICHIERS ?"

# L'etape qui decide. Un desaccord ici invalide tout le reste.
A_TABLE=$(q "SELECT count(*) FROM information_schema.tables WHERE table_name='_prisma_migrations'")
if [ "$A_TABLE" != "1" ]; then
    echec "_prisma_migrations absente de la sauvegarde"
    info "la base n'a jamais ete geree par 'prisma migrate deploy' : a eclaircir AVANT tout"
    exit 1
fi

APPLIQUEES_EN_PROD=$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")
ok "_prisma_migrations presente : $APPLIQUEES_EN_PROD migration(s) appliquee(s)"

DERNIERE=$(q "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1")
info "derniere appliquee : ${DERNIERE:-aucune}"

# Une migration en echec laisse une ligne sans finished_at. Elle bloque `migrate deploy`,
# qui refuse d'avancer sur un historique interrompu.
ECHOUEES=$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")
if [ "${ECHOUEES:-0}" != "0" ]; then
    echec "$ECHOUEES migration(s) ni terminee(s) ni annulee(s) dans l'historique"
    q "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL" \
        | sed 's/^/       /'
    info "'migrate deploy' refusera d'avancer tant que cet historique est interrompu"
fi

# Le socle terrain est dans `main` ; est-il APPLIQUE ? Les deux questions sont
# distinctes, et `gouvernance_defauts` cree `defauts` qui reference ses tables.
SOCLE=$(q "SELECT count(*) FROM _prisma_migrations WHERE migration_name='20261007140000_socle_terrain' AND finished_at IS NOT NULL")
if [ "${SOCLE:-0}" = "1" ]; then
    ok "20261007140000_socle_terrain applique — les dependances de 'defauts' existent"
else
    alerte "20261007140000_socle_terrain N'EST PAS applique"
    info "il est dans 'main' mais pas dans cette base : les deux ne sont pas la meme question"
    info "ce banc d'essai l'applique donc en premier, et le deploiement devra faire de meme"
fi

DEJA=0
for m in "${MIGRATIONS[@]}"; do
    PRESENTE=$(q "SELECT count(*) FROM _prisma_migrations WHERE migration_name='$m'")
    if [ "${PRESENTE:-0}" = "0" ]; then
        ok "$m : absente de l'historique, sera appliquee"
        continue
    fi

    DEJA=$((DEJA+1))
    STOCKEE=$(q "SELECT checksum FROM _prisma_migrations WHERE migration_name='$m'")
    LOCALE=$(sha256sum "$REPERTOIRE_MIGRATIONS/$m/migration.sql" | cut -d' ' -f1)

    if [ "$STOCKEE" = "$LOCALE" ]; then
        alerte "$m : DEJA APPLIQUEE, fichier inchange depuis"
        info "elle ne sera pas rejouee ; rien a corriger"
    else
        echec "$m : DEJA APPLIQUEE et le fichier a CHANGE depuis"
        info "stockee : $STOCKEE"
        info "locale  : $LOCALE"
        info "'migrate deploy' la refusera — « modified after it was applied »"
        info "il faut une migration SEPAREE qui porte l'amendement, pas une retouche"
    fi
done

if [ "$DEJA" = "0" ]; then
    ok "aucune des ${#MIGRATIONS[@]} migrations n'est appliquee : le chemin est net"
fi

# Prisma compare le fichier a l'octet. Les sommes ci-dessus sont donc sensibles aux fins
# de ligne : un depot clone avec autocrlf=true donnera un digest different sans qu'aucun
# caractere ait change. La reponse qui fait foi reste `prisma migrate status`.
info "verdict qui fait foi : 'npx prisma migrate status' sur la base visee (lecture seule)"

if [ "$ECHECS" -gt 0 ]; then
    printf '\n\033[31mArret a l'\''etape 2 : l'\''historique de migration ne correspond pas aux fichiers.\033[0m\n'
    printf 'Les etapes suivantes n'\''auraient aucun sens sur cette base.\n'
    exit 1
fi

# ─────────────────────────────────────────────────────────────
titre "3. Application, dans l'ordre"

APPLIQUEES=0
for m in "${MIGRATIONS[@]}"; do
    PRESENTE=$(q "SELECT count(*) FROM _prisma_migrations WHERE migration_name='$m'")
    [ "${PRESENTE:-0}" = "0" ] || { info "$m : deja appliquee, ignoree"; continue; }

    SORTIE=$(docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -v ON_ERROR_STOP=1 \
        < "$REPERTOIRE_MIGRATIONS/$m/migration.sql" 2>&1)
    if [ $? -eq 0 ]; then
        ok "$m"
        APPLIQUEES=$((APPLIQUEES+1))
    else
        echec "$m"
        echo "$SORTIE" | grep -iE "error|ERREUR" | head -3 | sed 's/^/       /'
    fi
done

# ─────────────────────────────────────────────────────────────
titre "4. La structure attendue existe-t-elle ?"

verifier_table()   { q "SELECT count(*) FROM information_schema.tables WHERE table_name='$1'" | grep -q '^1$' && ok "table $1" || echec "table $1 ABSENTE"; }
verifier_colonne() { q "SELECT count(*) FROM information_schema.columns WHERE table_name='$1' AND column_name='$2'" | grep -q '^1$' && ok "$1.$2" || echec "$1.$2 ABSENTE"; }
verifier_type()    { q "SELECT count(*) FROM pg_type WHERE typname='$1'" | grep -q '^1$' && ok "type $1" || echec "type $1 ABSENT"; }
verifier_valeur()  { q "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='$1' AND e.enumlabel='$2'" | grep -q '^1$' && ok "$1.$2" || echec "$1.$2 ABSENTE"; }

verifier_valeur AuditAction VALIDATE
verifier_valeur AuditAction REJECT
verifier_valeur AuditAction SYNC_CONFLICT

verifier_table validations
verifier_table catalogue_defauts
verifier_table defauts
verifier_table medias_defaut
verifier_table delegations_validation
verifier_table regles_condition
verifier_table evaluations_condition
verifier_table composantes_evaluation

verifier_colonne troncons     statutValidation
verifier_colonne troncons     perimetre
verifier_colonne troncons     paysTerritoire
verifier_colonne troncons     motifPerimetre
verifier_colonne troncons     perimetreClasseA
verifier_colonne ouvrages     statutValidation
verifier_colonne points_noirs statutValidation
verifier_colonne postes       statutValidation
verifier_colonne chantiers    statutValidation
verifier_colonne users        peutDeleguerValidation

verifier_type StatutValidation
verifier_type PerimetreReseau
verifier_type DomaineValidation
verifier_type ComposanteRci
verifier_type MotifExclusionRci
verifier_type OriginePortion

verifier_table portions
verifier_table portions_lignage
verifier_colonne portions debutM
verifier_colonne portions finM
verifier_colonne portions praticabilite
verifier_colonne portions remplaceeLe
verifier_colonne portions deletedAt

# L'index spatial que Prisma ne sait pas declarer : son absence ne casserait rien tout de
# suite, elle ferait seulement balayer la table a chaque affichage de carte.
q "SELECT count(*) FROM pg_indexes WHERE indexname='portions_geom_gist'" | grep -q '^1$'     && ok "index spatial portions_geom_gist" || echec "portions_geom_gist ABSENT"

# La contrainte d'exclusion, et ce qu'elle doit laisser passer.
q "SELECT count(*) FROM pg_constraint WHERE conname='portion_validee_sans_chevauchement'"     | grep -q '^1$' && ok "contrainte d'exclusion posee"     || echec "portion_validee_sans_chevauchement ABSENTE"

# ─────────────────────────────────────────────────────────────
titre "5. Les donnees sont-elles intactes ?"

# Les cinq migrations sont additives : aucune ne doit toucher une ligne existante.
TRONCONS_APRES=$(q "SELECT count(*) FROM troncons WHERE \"deletedAt\" IS NULL")
GEOM_APRES=$(q "SELECT count(*) FROM troncons WHERE geom IS NOT NULL AND ST_IsValid(geom)")
AUDIT_APRES=$(q "SELECT count(*) FROM audit_logs")

[ "$TRONCONS_APRES" = "$TRONCONS_AVANT" ] && ok "troncons : $TRONCONS_APRES, inchange" \
    || echec "troncons : $TRONCONS_AVANT -> $TRONCONS_APRES"
[ "$GEOM_APRES" = "$GEOM_AVANT" ] && ok "geometries valides : $GEOM_APRES, inchange" \
    || echec "geometries : $GEOM_AVANT -> $GEOM_APRES"
[ "$AUDIT_APRES" = "$AUDIT_AVANT" ] && ok "journal d'audit : $AUDIT_APRES, inchange" \
    || echec "audit : $AUDIT_AVANT -> $AUDIT_APRES"

# Les nouvelles colonnes sortent NULLES partout : c'est voulu. Pour `perimetre`, NUL vaut
# NATIONAL — l'omission est une absence de classement, pas une absence de decision, et
# exclure par defaut effacerait le reseau entier des statistiques.
NON_NULS=$(q "SELECT count(*) FROM troncons WHERE \"statutValidation\" IS NOT NULL OR \"perimetre\" IS NOT NULL")
[ "${NON_NULS:-0}" = "0" ] && ok "aucun troncon n'a recu de statut ni de perimetre" \
    || echec "$NON_NULS troncons ont recu une valeur : une migration additive n'ecrit rien"

DROITS=$(q "SELECT count(*) FROM users WHERE \"peutDeleguerValidation\" = true")
[ "${DROITS:-0}" = "0" ] && ok "aucun compte n'a recu le droit de deleguer" \
    || echec "$DROITS comptes portent le droit de deleguer : le defaut est false"

# ─────────────────────────────────────────────────────────────
titre "6. Rollback : sait-on defaire ?"

docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'ROLLBACK'
-- Dependants d'abord : une table referencee ne se supprime pas avant ses references.
DROP TABLE IF EXISTS "portions_lignage";
DROP TABLE IF EXISTS "portions";
DROP TABLE IF EXISTS "composantes_evaluation";
DROP TABLE IF EXISTS "evaluations_condition";
DROP TABLE IF EXISTS "regles_condition";
DROP TABLE IF EXISTS "medias_defaut";
DROP TABLE IF EXISTS "defauts";
DROP TABLE IF EXISTS "catalogue_defauts";
DROP TABLE IF EXISTS "validations";
DROP TABLE IF EXISTS "delegations_validation";

-- Socle terrain. `defauts` vient d'etre supprimee ci-dessus : elle referencait
-- `observations` et `missions`, donc l'ordre compte.
DROP TABLE IF EXISTS "points_trace";
DROP TABLE IF EXISTS "medias_observation";
DROP TABLE IF EXISTS "conflits_sync";
DROP TABLE IF EXISTS "operations_sync";
DROP TABLE IF EXISTS "traces";
DROP TABLE IF EXISTS "observations";
DROP TABLE IF EXISTS "missions";
DROP TABLE IF EXISTS "appareils";

ALTER TABLE "users"        DROP COLUMN IF EXISTS "peutDeleguerValidation";
ALTER TABLE "troncons"     DROP COLUMN IF EXISTS "statutValidation",
                           DROP COLUMN IF EXISTS "perimetre",
                           DROP COLUMN IF EXISTS "paysTerritoire",
                           DROP COLUMN IF EXISTS "motifPerimetre",
                           DROP COLUMN IF EXISTS "perimetreClasseA";
ALTER TABLE "ouvrages"     DROP COLUMN IF EXISTS "statutValidation";
ALTER TABLE "points_noirs" DROP COLUMN IF EXISTS "statutValidation";
ALTER TABLE "postes"       DROP COLUMN IF EXISTS "statutValidation";
ALTER TABLE "chantiers"    DROP COLUMN IF EXISTS "statutValidation";

DROP TYPE IF EXISTS "OriginePortion";
DROP TYPE IF EXISTS "MotifExclusionRci";
DROP TYPE IF EXISTS "ComposanteRci";
DROP TYPE IF EXISTS "DomaineValidation";
DROP TYPE IF EXISTS "EtatDefaut";
DROP TYPE IF EXISTS "EtendueDefaut";
DROP TYPE IF EXISTS "MethodeQuantite";
DROP TYPE IF EXISTS "FamilleDefaut";
DROP TYPE IF EXISTS "MesureDefaut";
DROP TYPE IF EXISTS "UniteDefaut";
DROP TYPE IF EXISTS "PerimetreReseau";
DROP TYPE IF EXISTS "StatutValidation";
DROP TYPE IF EXISTS "TypeObservation";
DROP TYPE IF EXISTS "TypeMission";
DROP TYPE IF EXISTS "StatutSync";
DROP TYPE IF EXISTS "StatutObservation";
DROP TYPE IF EXISTS "StatutMission";

-- PAS de retrait des trois valeurs de `AuditAction` : PostgreSQL n'a pas de
-- `ALTER TYPE ... DROP VALUE`. Voir l'en-tete de ce fichier.
--
-- PAS de DROP EXTENSION btree_gist non plus. Une extension est une ressource de la BASE,
-- pas de cette migration : une autre table peut en dependre, et la retirer casserait ce
-- qui n'a rien demande. Elle reste, et ne coute rien.
ROLLBACK
RC=$?
[ $RC -eq 0 ] && ok "rollback execute sans erreur" || echec "le rollback a echoue"

TABLES_RB=$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
COLONNES_RB=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public'")
TRONCONS_RB=$(q "SELECT count(*) FROM troncons WHERE \"deletedAt\" IS NULL")
GEOM_RB=$(q "SELECT count(*) FROM troncons WHERE geom IS NOT NULL AND ST_IsValid(geom)")
AUDIT_RB=$(q "SELECT count(*) FROM audit_logs")

[ "$TABLES_RB" = "$TABLES_AVANT" ] && ok "tables revenues a l'identique ($TABLES_AVANT)" \
    || echec "tables : $TABLES_AVANT avant, $TABLES_RB apres rollback"
[ "$COLONNES_RB" = "$COLONNES_AVANT" ] && ok "colonnes revenues a l'identique ($COLONNES_AVANT)" \
    || echec "colonnes : $COLONNES_AVANT avant, $COLONNES_RB apres rollback"
[ "$TRONCONS_RB" = "$TRONCONS_AVANT" ] && ok "donnees intactes : $TRONCONS_RB troncons" \
    || echec "le rollback a perdu des donnees : $TRONCONS_AVANT -> $TRONCONS_RB"
[ "$GEOM_RB" = "$GEOM_AVANT" ] && ok "geometries intactes : $GEOM_RB" \
    || echec "geometries perdues : $GEOM_AVANT -> $GEOM_RB"
[ "$AUDIT_RB" = "$AUDIT_AVANT" ] && ok "journal d'audit intact : $AUDIT_RB" \
    || echec "audit : $AUDIT_AVANT -> $AUDIT_RB"

RESTANTES=$(q "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='AuditAction' AND e.enumlabel IN ('VALIDATE','REJECT','SYNC_CONFLICT')")
alerte "AuditAction conserve ${RESTANTES:-0} valeur(s) ajoutee(s) : PostgreSQL ne sait pas les retirer"
info "attendu, et sans effet : une valeur d'enum que personne n'ecrit ne coute rien"

# ─────────────────────────────────────────────────────────────
printf '\n'
if [ "$ECHECS" -gt 0 ]; then
    printf '\033[31m%d verification(s) en echec — NE PAS DEPLOYER\033[0m\n' "$ECHECS"
    exit 1
fi
printf '\033[32mMigrations eprouvees : appliquees, additives, reversibles sauf l'\''enum, sans perte\033[0m\n'
printf 'Le banc d'\''essai ne vaut pas autorisation : la decision reste humaine.\n'
