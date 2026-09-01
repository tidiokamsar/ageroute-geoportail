#!/usr/bin/env bash
#
# Eprouve les migrations de la Phase 4 contre la STRUCTURE REELLE de production.
#
# Une migration qui n'a tourne que sur une base vide n'est pas eprouvee. Celle-ci part
# de la derniere sauvegarde chiffree, la restaure dans un conteneur jetable, applique
# les migrations, verifie que rien n'a bouge, PUIS applique le rollback documente et
# verifie qu'il rend bien la base a son etat d'origine.
#
# Le rollback est la moitie du test que l'on oublie. Une migration qu'on ne sait pas
# defaire n'est pas reversible, quoi qu'en dise sa documentation.
#
# NE TOUCHE JAMAIS LA PRODUCTION : tout se passe dans un conteneur ephemere, detruit
# a la sortie quel que soit le resultat.
#
# Usage : tester-migrations-phase4.sh [repertoire-migrations]

set -uo pipefail

REPERTOIRE_MIGRATIONS="${1:-$HOME/phase4-migrations}"
SAUVEGARDES="${SAUVEGARDES:-$HOME/sauvegardes-bdri}"
CLE="${CLE:-$HOME/.bdri/cle-sauvegarde}"
IMAGE_POSTGRES="${IMAGE_POSTGRES:-postgis/postgis:17-3.5}"
CONTENEUR="test-migrations-phase4-$$"
BASE="verification"

ECHECS=0
ok()      { printf '  \033[32mv\033[0m %s\n' "$*"; }
echec()   { printf '  \033[31mX\033[0m %s\n' "$*"; ECHECS=$((ECHECS+1)); }
info()    { printf '    %s\n' "$*"; }
titre()   { printf '\n\033[1m%s\033[0m\n' "$*"; }

nettoyer() {
    docker rm -f "$CONTENEUR" >/dev/null 2>&1 || true
    rm -f /tmp/dump-$$.dump
}
trap nettoyer EXIT INT TERM

q() { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$1" 2>/dev/null | tr -d ' \r'; }

printf '\033[1mTest des migrations Phase 4 sur structure de production\033[0m\n'

# ─────────────────────────────────────────────────────────────
titre "1. Restauration de la derniere sauvegarde"

DUMP=$(ls -1t "$SAUVEGARDES"/bdri_*.dump.enc 2>/dev/null | head -1)
[ -n "$DUMP" ] || { echec "aucune sauvegarde chiffree trouvee"; exit 1; }
info "archive : $(basename "$DUMP")"

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "$DUMP" -out /tmp/dump-$$.dump -pass file:"$CLE" 2>/dev/null \
    || { echec "dechiffrement impossible"; exit 1; }
ok "dechiffree ($(stat -c %s /tmp/dump-$$.dump) octets)"

# POSTGRES_DB doit valoir la base cible : l'image cree ses extensions au demarrage, et
# les creer ensuite a la main entre en conflit avec postgis_tiger_geocoder.
docker run -d --name "$CONTENEUR" \
    -e POSTGRES_PASSWORD=verification \
    -e POSTGRES_DB="$BASE" \
    "$IMAGE_POSTGRES" >/dev/null 2>&1 \
    || { echec "demarrage du conteneur impossible"; exit 1; }

# pg_isready repond avant que la base cible existe : attendre le message de fin
# d'initialisation, pas la disponibilite du serveur.
for _ in $(seq 1 90); do
    docker logs "$CONTENEUR" 2>&1 | grep -q "PostgreSQL init process complete" && break
    sleep 2
done
for _ in $(seq 1 30); do q 'SELECT 1' | grep -q 1 && break; sleep 2; done
q 'SELECT 1' | grep -q 1 || { echec "base indisponible"; exit 1; }
ok "conteneur jetable pret ($IMAGE_POSTGRES)"

docker exec -i "$CONTENEUR" pg_restore -U postgres -d "$BASE" --no-owner --no-acl \
    < /tmp/dump-$$.dump >/dev/null 2>&1 \
    || info "pg_restore a signale des avertissements (attendus : roles absents)"

TRONCONS_AVANT=$(q "SELECT count(*) FROM troncons WHERE \"deletedAt\" IS NULL")
CHANTIERS_AVANT=$(q "SELECT count(*) FROM chantiers WHERE \"deletedAt\" IS NULL")
OUVRAGES_AVANT=$(q "SELECT count(*) FROM ouvrages WHERE \"deletedAt\" IS NULL")
GEOM_AVANT=$(q "SELECT count(*) FROM troncons WHERE geom IS NOT NULL AND ST_IsValid(geom)")
SRID_AVANT=$(q "SELECT DISTINCT ST_SRID(geom) FROM troncons WHERE geom IS NOT NULL")
COLONNES_AVANT=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public'")

[ "$TRONCONS_AVANT" -gt 0 ] || { echec "restauration vide"; exit 1; }
ok "restauree : $TRONCONS_AVANT troncons, $CHANTIERS_AVANT chantiers, $OUVRAGES_AVANT ouvrages"
info "geometries valides : $GEOM_AVANT   SRID : $SRID_AVANT   colonnes : $COLONNES_AVANT"

# ─────────────────────────────────────────────────────────────
titre "2. Application des migrations"

APPLIQUEES=0
for m in $(ls -1d "$REPERTOIRE_MIGRATIONS"/2026090[2-9]_* "$REPERTOIRE_MIGRATIONS"/202609[0-9][0-9]* 2>/dev/null | sort -u); do
    [ -f "$m/migration.sql" ] || continue
    NOM=$(basename "$m")
    SORTIE=$(docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -v ON_ERROR_STOP=1 \
        < "$m/migration.sql" 2>&1)
    if [ $? -eq 0 ]; then
        ok "$NOM"
        APPLIQUEES=$((APPLIQUEES+1))
    else
        echec "$NOM"
        echo "$SORTIE" | grep -i "error" | head -3 | sed 's/^/       /'
    fi
done
[ "$APPLIQUEES" -gt 0 ] || echec "aucune migration appliquee — repertoire vide ?"

# ─────────────────────────────────────────────────────────────
titre "3. La structure attendue existe-t-elle ?"

verifier_colonne() {
    q "SELECT count(*) FROM information_schema.columns WHERE table_name='$1' AND column_name='$2'" \
        | grep -q '^1$' && ok "$1.$2" || echec "$1.$2 ABSENTE"
}
verifier_table() {
    q "SELECT count(*) FROM information_schema.tables WHERE table_name='$1'" \
        | grep -q '^1$' && ok "table $1" || echec "table $1 ABSENTE"
}
verifier_type() {
    q "SELECT count(*) FROM pg_type WHERE typname='$1'" \
        | grep -q '^1$' && ok "type $1" || echec "type $1 ABSENT"
}

verifier_colonne troncons sourceType
verifier_colonne troncons sourceReference
verifier_colonne troncons sourceConfidence
verifier_colonne troncons sourceDetectedAt
verifier_colonne chantiers statutLocalisation
verifier_colonne inspections clientInspectionId
verifier_colonne postes historicalRecovered
verifier_colonne postes recoveryStatus
verifier_table valeurs_qualite
verifier_table propositions_localisation
verifier_type SourceType
verifier_type StatutValeur
verifier_type StatutLocalisation
verifier_type NiveauConfiance
verifier_type StatutRecuperation

GEOM_PROP=$(q "SELECT count(*) FROM geometry_columns WHERE f_table_name='propositions_localisation' AND srid=4326")
[ "$GEOM_PROP" = "1" ] && ok "propositions_localisation.geom en SRID 4326" \
    || echec "geometrie de propositions_localisation absente ou mauvais SRID"

# ─────────────────────────────────────────────────────────────
titre "4. Les donnees ont-elles bouge ?"

TRONCONS_APRES=$(q "SELECT count(*) FROM troncons WHERE \"deletedAt\" IS NULL")
CHANTIERS_APRES=$(q "SELECT count(*) FROM chantiers WHERE \"deletedAt\" IS NULL")
OUVRAGES_APRES=$(q "SELECT count(*) FROM ouvrages WHERE \"deletedAt\" IS NULL")
GEOM_APRES=$(q "SELECT count(*) FROM troncons WHERE geom IS NOT NULL AND ST_IsValid(geom)")
SRID_APRES=$(q "SELECT DISTINCT ST_SRID(geom) FROM troncons WHERE geom IS NOT NULL")

[ "$TRONCONS_APRES" = "$TRONCONS_AVANT" ] && ok "troncons : $TRONCONS_APRES (inchange)" \
    || echec "troncons : $TRONCONS_AVANT -> $TRONCONS_APRES"
[ "$CHANTIERS_APRES" = "$CHANTIERS_AVANT" ] && ok "chantiers : $CHANTIERS_APRES (inchange)" \
    || echec "chantiers : $CHANTIERS_AVANT -> $CHANTIERS_APRES"
[ "$OUVRAGES_APRES" = "$OUVRAGES_AVANT" ] && ok "ouvrages : $OUVRAGES_APRES (inchange)" \
    || echec "ouvrages : $OUVRAGES_AVANT -> $OUVRAGES_APRES"
[ "$GEOM_APRES" = "$GEOM_AVANT" ] && ok "geometries valides : $GEOM_APRES (inchange)" \
    || echec "geometries : $GEOM_AVANT -> $GEOM_APRES"
[ "$SRID_APRES" = "$SRID_AVANT" ] && ok "SRID : $SRID_APRES (inchange)" \
    || echec "SRID : $SRID_AVANT -> $SRID_APRES"

# Aucune valeur metier ne doit avoir ete ecrite par une migration de structure.
VQ=$(q "SELECT count(*) FROM valeurs_qualite")
PROP=$(q "SELECT count(*) FROM propositions_localisation")
LOC_NON_NONE=$(q "SELECT count(*) FROM chantiers WHERE \"statutLocalisation\" <> 'NONE'")
SRC_NON_NULL=$(q "SELECT count(*) FROM troncons WHERE \"sourceType\" IS NOT NULL")

[ "$VQ" = "0" ] && ok "valeurs_qualite vide — la migration n'ecrit pas de donnee" \
    || echec "valeurs_qualite contient $VQ lignes"
[ "$PROP" = "0" ] && ok "propositions_localisation vide" || echec "$PROP propositions creees"
[ "$LOC_NON_NONE" = "0" ] && ok "aucun statut de localisation devine" \
    || echec "$LOC_NON_NONE chantiers ont recu un statut"
[ "$SRC_NON_NULL" = "0" ] && ok "aucune provenance devinee" \
    || echec "$SRC_NON_NULL troncons ont recu une provenance"

# ─────────────────────────────────────────────────────────────
titre "5. Idempotence : rejouer les migrations"

REJOUEES_OK=0
for m in $(ls -1d "$REPERTOIRE_MIGRATIONS"/202609[0-9][0-9]* 2>/dev/null | sort); do
    [ -f "$m/migration.sql" ] || continue
    docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -v ON_ERROR_STOP=1 \
        < "$m/migration.sql" >/dev/null 2>&1 && REJOUEES_OK=$((REJOUEES_OK+1))
done
[ "$REJOUEES_OK" = "$APPLIQUEES" ] \
    && ok "les $APPLIQUEES migrations se rejouent sans erreur" \
    || echec "seules $REJOUEES_OK/$APPLIQUEES migrations sont rejouables"

# ─────────────────────────────────────────────────────────────
titre "6. Rollback : sait-on defaire ?"

docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'ROLLBACK'
DROP TABLE IF EXISTS "propositions_localisation";
DROP TABLE IF EXISTS "valeurs_qualite";
ALTER TABLE "chantiers"   DROP COLUMN IF EXISTS "statutLocalisation";
ALTER TABLE "inspections" DROP COLUMN IF EXISTS "clientInspectionId";
ALTER TABLE "postes"      DROP COLUMN IF EXISTS "historicalRecovered",
                          DROP COLUMN IF EXISTS "recoveredFrom",
                          DROP COLUMN IF EXISTS "recoveryStatus";
ALTER TABLE "troncons"    DROP COLUMN IF EXISTS "sourceType",
                          DROP COLUMN IF EXISTS "sourceReference",
                          DROP COLUMN IF EXISTS "sourceConfidence",
                          DROP COLUMN IF EXISTS "sourceDetectedAt";
DROP TYPE IF EXISTS "StatutProposition";
DROP TYPE IF EXISTS "StatutLocalisation";
DROP TYPE IF EXISTS "StatutValeur";
DROP TYPE IF EXISTS "StatutRecuperation";
DROP TYPE IF EXISTS "SourceType";
DROP TYPE IF EXISTS "NiveauConfiance";
ROLLBACK
RC=$?
[ $RC -eq 0 ] && ok "rollback execute sans erreur" || echec "le rollback a echoue"

COLONNES_APRES_RB=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public'")
[ "$COLONNES_APRES_RB" = "$COLONNES_AVANT" ] \
    && ok "structure revenue a l'identique ($COLONNES_AVANT colonnes)" \
    || echec "colonnes : $COLONNES_AVANT avant, $COLONNES_APRES_RB apres rollback"

TRONCONS_RB=$(q "SELECT count(*) FROM troncons WHERE \"deletedAt\" IS NULL")
GEOM_RB=$(q "SELECT count(*) FROM troncons WHERE geom IS NOT NULL AND ST_IsValid(geom)")
[ "$TRONCONS_RB" = "$TRONCONS_AVANT" ] && ok "donnees intactes apres rollback : $TRONCONS_RB troncons" \
    || echec "le rollback a perdu des donnees : $TRONCONS_AVANT -> $TRONCONS_RB"
[ "$GEOM_RB" = "$GEOM_AVANT" ] && ok "geometries intactes apres rollback : $GEOM_RB" \
    || echec "geometries perdues : $GEOM_AVANT -> $GEOM_RB"

# ─────────────────────────────────────────────────────────────
printf '\n'
if [ "$ECHECS" -gt 0 ]; then
    printf '\033[31m%d verification(s) en echec\033[0m\n' "$ECHECS"
    exit 1
fi
printf '\033[32mMigrations eprouvees : appliquees, rejouables, reversibles, sans perte\033[0m\n'
