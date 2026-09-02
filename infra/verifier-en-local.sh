#!/usr/bin/env bash
#
# Monte un environnement de VERIFICATION LOCALE complet : base jetable, schema,
# jeu de demonstration, et un compte de test dont le mot de passe est genere ici.
#
# POURQUOI CE SCRIPT EXISTE
#
# Le geoportail ne peut pas etre verifie sans backend ni base. Faute d'environnement
# local, une modification visuelle partait sans avoir jamais ete vue fonctionner —
# et la seule alternative etait de pointer le developpement vers la production, ce
# que vite.config.ts interdit explicitement, a juste titre : l'interface porte des
# boutons qui ECRIVENT (creation d'ouvrage depuis un franchissement, par exemple).
# Une session de test aurait ecrit dans l'inventaire national.
#
# CE QU'IL NE FAIT PAS
#
# Il ne copie AUCUNE donnee de production, et ne demande AUCUN identifiant reel.
# Le compte de test est cree ici, son mot de passe est jetable, et la base entiere
# disparait avec le conteneur.
#
# Usage :
#     bash infra/verifier-en-local.sh          # monte
#     bash infra/verifier-en-local.sh --stop   # detruit

set -uo pipefail

CONTENEUR="bdri-verif-local"
PORT_DB=55432
IMAGE="postgis/postgis:17-3.5"
RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$RACINE/backend/.env"

# Mot de passe de test, jetable, jamais reutilise ailleurs.
MDP_DB="verif_local_only"
MDP_ADMIN="VerifLocale!2026#jetable"
MAIL_ADMIN="verif.locale@test.invalid"

ok()    { printf '  \033[32mv\033[0m %s\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ "${1:-}" = "--stop" ]; then
    docker rm -f "$CONTENEUR" >/dev/null 2>&1 && ok "conteneur $CONTENEUR detruit" \
        || info "aucun conteneur $CONTENEUR"
    exit 0
fi

titre "1. Base jetable"
docker rm -f "$CONTENEUR" >/dev/null 2>&1 || true
docker run -d --name "$CONTENEUR" \
    -e POSTGRES_PASSWORD="$MDP_DB" \
    -e POSTGRES_DB=console_bdri \
    -p "$PORT_DB":5432 "$IMAGE" >/dev/null \
    || { echo "demarrage impossible"; exit 1; }

# pg_isready repond avant que la base cible existe : attendre la fin de l'init.
for _ in $(seq 1 60); do
    docker logs "$CONTENEUR" 2>&1 | grep -q "PostgreSQL init process complete" && break
    sleep 2
done
ok "PostGIS sur le port $PORT_DB"

titre "2. Environnement backend"
cat > "$ENV_FILE" <<ENV
# VERIFICATION LOCALE uniquement. Genere par infra/verifier-en-local.sh.
# Base jetable, aucune donnee de production. Ce fichier est ignore par git.
DATABASE_URL="postgresql://postgres:${MDP_DB}@localhost:${PORT_DB}/console_bdri"
PORT=4000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
JWT_ACCESS_SECRET=verification-locale-acces-jetable-0123456789
JWT_REFRESH_SECRET=verification-locale-refresh-jetable-9876543210
JWT_ACCESS_EXPIRES_IN=1h
JWT_REFRESH_EXPIRES_IN=7d
SEED_ADMIN_EMAIL=${MAIL_ADMIN}
SEED_ADMIN_NAME="Compte de verification locale"
SEED_ADMIN_PASSWORD="${MDP_ADMIN}"
ENV
ok "backend/.env ecrit (ignore par git)"

titre "3. Schema"
cd "$RACINE/backend"
# db push et NON migrate deploy : la chaine de migrations ne rejoue pas sur une base
# vierge — 20260702140000_decomptes declare marcheId en UUID alors que
# 20260702110000 cree marches.id en TEXT. Defaut documente, non corrige ici.
if npx prisma db push --skip-generate >/dev/null 2>&1; then
    ok "schema construit depuis schema.prisma (db push)"
else
    echo "  echec de db push"; exit 1
fi

titre "4. Jeu de demonstration"
if npx tsx prisma/seed.ts >/dev/null 2>&1; then
    ok "8 regions, 8 troncons, ouvrages, points noirs, 1 chantier"
else
    echo "  echec du seed"; exit 1
fi

titre "Pret"
info "API      : cd backend && npm run dev        (port 4000)"
info "Interface: cd frontend && npm run dev       (port 5173)"
info "Compte   : $MAIL_ADMIN"
info "Mot de passe : $MDP_ADMIN"
printf '\n\033[33mCompte et base de TEST. Aucun identifiant de production n%s est requis.\033[0m\n' "'"
printf 'Destruction : bash infra/verifier-en-local.sh --stop\n'
