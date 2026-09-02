#!/usr/bin/env bash
#
# P3-A — Éprouve la migration refresh tokens sur copie de production.
#
# Specificites P3-A par rapport au testeur P1 :
#   1. PREUVE DE SURVIE DES SESSIONS : avant migration, on preleve un token
#      clair existant ; apres migration, sa ligne doit exister sous forme
#      d'empreinte SHA-256 exacte — un utilisateur connecte garde sa session.
#   2. Le rollback est teste ET documente comme invalidant toutes les sessions
#      (la colonne claire ne peut pas etre reconstituee depuis les empreintes).
#   3. Perf (§18) : EXPLAIN des deux acces nouveaux (tokenHash unique,
#      familyId) — indexes demontres, pas supposes.
#
# NE TOUCHE JAMAIS LA PRODUCTION. La cle ne quitte pas le serveur.
#
# Usage : ./tester-migrations-p3a.sh [repertoire-migrations]
# Sortie : ~/phase5-resultats/p3a-integrity-check.txt

set -uo pipefail

REPERTOIRE="${1:-$HOME/phase5/migrations}"
SAUVEGARDES="${SAUVEGARDES:-$HOME/sauvegardes-bdri}"
CLE="${CLE:-$HOME/.bdri/cle-sauvegarde}"
IMAGE_POSTGIS="${IMAGE_POSTGRES:-postgis/postgis:17-3.5}"
CONTENEUR="test-migrations-p3a-$$"
BASE="verification"
RESULTATS="$HOME/phase5-resultats"
SORTIE="$RESULTATS/p3a-integrity-check.txt"

ECHECS=0
ok()    { printf '  \033[32mv\033[0m %s\n' "$*"; }
echec() { printf '  \033[31mX\033[0m %s\n' "$*"; ECHECS=$((ECHECS+1)); }
info()  { printf '    %s\n' "$*"; }
titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }
log()   { echo "$@" | tee -a "$SORTIE"; }

q() { docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -tAc "$1" 2>/dev/null | tr -d ' \r'; }

nettoyer() { docker rm -f "$CONTENEUR" >/dev/null 2>&1 || true; rm -f /tmp/dump-$$.dump; }
trap nettoyer EXIT INT TERM

mkdir -p "$RESULTATS"
: > "$SORTIE"
log "Test migration P3-A (refresh tokens) — $(date '+%Y-%m-%d %H:%M')"

MIGRATION="$REPERTOIRE/20260902150000_p3a_refresh_token_security/migration.sql"
[ -f "$MIGRATION" ] || { log "ERREUR : migration P3-A introuvable ($MIGRATION)"; exit 1; }

# ─────────────────────────────────────────────────────────────
titre "1. Sauvegarde verifiee et restauree"

DUMP=$(ls -1t "$SAUVEGARDES"/bdri_*.dump.enc 2>/dev/null | head -1)
[ -n "$DUMP" ] || { echec "aucune sauvegarde"; exit 1; }
log "sauvegarde (P1-09) : $(basename "$DUMP")"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$DUMP" -out /tmp/dump-$$.dump -pass file:"$CLE" 2>/dev/null || { echec "dechiffrement"; exit 1; }
docker run -d --name "$CONTENEUR" -e POSTGRES_PASSWORD=x -e POSTGRES_DB="$BASE" "$IMAGE_POSTGIS" >/dev/null 2>&1
for _ in $(seq 1 90); do docker logs "$CONTENEUR" 2>&1 | grep -q "init process complete" && break; sleep 2; done
for _ in $(seq 1 30); do q 'SELECT 1' | grep -q 1 && break; sleep 2; done
docker exec -i "$CONTENEUR" pg_restore -U postgres -d "$BASE" --no-owner --no-acl < /tmp/dump-$$.dump >/dev/null 2>&1 || true
rm -f /tmp/dump-$$.dump

TOKIES_AVANT=$(q "SELECT count(*) FROM refresh_tokens")
LOGINS_ACTIFS=$(q "SELECT count(*) FROM refresh_tokens WHERE revoked = false")
log "refresh_tokens avant : $TOKIES_AVANT (dont actifs : $LOGINS_ACTIFS)"
[ "$TOKIES_AVANT" -gt 0 ] || { echec "aucun refresh token en base : test non significatif"; exit 1; }

# Prelevement d'un token actif existant (jamais ecrit dans le rapport — seul son empreinte y figurerait)
TOKEN_PRELEVE=$(q "SELECT token FROM refresh_tokens WHERE revoked = false ORDER BY \"createdAt\" DESC LIMIT 1")
EMPREINTE_ATTENDUE=$(printf '%s' "$TOKEN_PRELEVE" | sha256sum | cut -d' ' -f1)
info "token temoin preleve (valeur non consignee) ; empreinte sha256 attendue apres migration"

declare -A AVANT
for t in troncons chantiers ouvrages users refresh_tokens; do AVANT[$t]=$(q "SELECT count(*) FROM $t"); log "  $t : ${AVANT[$t]}"; done

# ─────────────────────────────────────────────────────────────
titre "2. Application de la migration P3-A"

if docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -v ON_ERROR_STOP=1 < "$MIGRATION" >/dev/null 2>&1; then
  ok "migration appliquee"
  log "MIGRATION APPLIQUEE"
else
  echec "migration en erreur"; log "ECHEC MIGRATION"; exit 1
fi

titre "3. Structure attendue"
verifier_colonne() {
  n=$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='$1' AND column_name='$2'")
  [ "$n" = "1" ] && ok "$1.$2" || echec "$1.$2 ABSENTE"
}
verifier_absente() {
  n=$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='$1' AND column_name='$2'")
  [ "$n" = "0" ] && ok "$1.$2 bien absente" || echec "$1.$2 ENCORE PRESENTE"
}
verifier_colonne refresh_tokens tokenHash
verifier_colonne refresh_tokens familyId
verifier_colonne refresh_tokens revokedAt
verifier_colonne refresh_tokens replacedById
verifier_colonne refresh_tokens reuseDetectedAt
verifier_absente refresh_tokens token
verifier_absente refresh_tokens revoked
n=$(q "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='AuditAction' AND e.enumlabel='SECURITY_EVENT'")
[ "$n" = "1" ] && ok "AuditAction.SECURITY_EVENT" || echec "enum SECURITY_EVENT ABSENTE"

titre "4. PREUVE DE SURVIE DES SESSIONS EXISTANTES"
n=$(q "SELECT count(*) FROM refresh_tokens WHERE \"tokenHash\" = '$EMPREINTE_ATTENDUE'")
if [ "$n" = "1" ]; then
  ok "le token temoin existe sous forme de son empreinte exacte — session conservee"
  log "SURVIE SESSION : OK (empreinte du temoin retrouvee)"
else
  echec "empreinte du temoin introuvable — les sessions existantes seraient cassees"
  log "SURVIE SESSION : ECHEC"
fi
EMPREINTES_INVALIDES=$(q "SELECT count(*) FROM refresh_tokens WHERE \"tokenHash\" !~ '^[0-9a-f]{64}$'")
[ "$EMPREINTES_INVALIDES" = "0" ] && ok "toutes les empreintes sont des sha256 valides" || echec "$EMPREINTES_INVALIDES empreintes invalides"
ACTIFS_APRES=$(q "SELECT count(*) FROM refresh_tokens WHERE \"revokedAt\" IS NULL")
log "actifs apres : $ACTIFS_APRES (attendu = actifs avant : $LOGINS_ACTIFS)"
[ "$ACTIFS_APRES" = "$LOGINS_ACTIFS" ] && ok "aucune session change d'etat" || echec "desactive/active incoherent"

titre "5. Integrite des donnees metier"
for t in troncons chantiers ouvrages users refresh_tokens; do
  APRES=$(q "SELECT count(*) FROM $t")
  [ "$APRES" = "${AVANT[$t]}" ] && ok "$t : $APRES (identique)" || { echec "$t : ${AVANT[$t]} -> $APRES"; log "ECHEC INTEGRITE $t"; }
done

titre "6. Perf (§18) : les nouveaux acces utilisent leurs index"
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "EXPLAIN ANALYZE SELECT * FROM refresh_tokens WHERE \"tokenHash\" = '$EMPREINTE_ATTENDUE'" 2>/dev/null | tee -a "$SORTIE" | grep -qE "Index Scan" && ok "lookup par tokenHash : Index Scan (unique)" || echec "lookup tokenHash sans index"
docker exec "$CONTENEUR" psql -U postgres -d "$BASE" -c "EXPLAIN ANALYZE SELECT count(*) FROM refresh_tokens WHERE \"familyId\" = (SELECT \"familyId\" FROM refresh_tokens LIMIT 1)" 2>/dev/null | tee -a "$SORTIE" | grep -qE "Index Scan|Bitmap" && ok "revocation de famille : parcours indexe" || echec "revocation famille sans index"

titre "7. Rollback documente — invalide les sessions (cout assume)"
ROLLBACK='
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "token" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "revoked" BOOLEAN NOT NULL DEFAULT false;
UPDATE "refresh_tokens" SET "revoked" = ("revokedAt" IS NOT NULL);
DROP INDEX IF EXISTS "refresh_tokens_tokenHash_key";
DROP INDEX IF EXISTS "refresh_tokens_familyId_idx";
ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "tokenHash";
ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "familyId";
ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "revokedAt";
ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "replacedById";
ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "reuseDetectedAt";
-- la valeur enum SECURITY_EVENT reste (PostgreSQL ne retire pas une valeur d enum) :
-- inerte et sans effet sur l ancien code, documente dans le rapport.
'
if echo "$ROLLBACK" | docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -v ON_ERROR_STOP=1 >/dev/null 2>&1; then
  ok "rollback execute (sessions invalidables : reconnexion generale requise)"
  log "ROLLBACK : OK — reconnexion generale requise (documente)"
else
  echec "rollback en erreur"; log "ROLLBACK : ECHEC"
fi
for t in troncons chantiers ouvrages users; do
  APRES_RB=$(q "SELECT count(*) FROM $t")
  [ "$APRES_RB" = "${AVANT[$t]}" ] && ok "rollback : $t intact ($APRES_RB)" || echec "rollback : $t modifie"
done

printf '\n'
if [ "$ECHECS" -eq 0 ]; then
  log "RESULTAT : SUCCES — migration P3-A eprouvee, sessions conservees, integrite et rollback verifies"
  exit 0
else
  log "RESULTAT : ECHECS=$ECHECS"
  exit 1
fi
