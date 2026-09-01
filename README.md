# Console BDRI — AGEROUTE Guinée

Outil interne de gestion du patrimoine routier (tronçons, ouvrages d'art, points noirs,
péages/pesages, chantiers, inspections) avec Géoportail cartographique.

## Stack

- **Frontend** : React 18 + Vite + TypeScript, React Router, TanStack Query/Table, Tailwind CSS, Recharts, React Hook Form + Zod, Leaflet.
- **Backend** : Node.js + Express + TypeScript, REST + OpenAPI (`/api/docs`).
- **Base de données** : PostgreSQL 17 + PostGIS, Prisma ORM (migrations versionnées).
- **Auth** : JWT (access 15 min) + refresh token rotatif (7 j, révocable), mots de passe Argon2id.
- **Audit** : toutes les écritures (create/update/delete/restore) sont journalisées dans `audit_logs` (qui, quoi, quand).
- **Suppression logique** : aucune suppression physique sur les entités patrimoniales (`deletedAt`).

## Arborescence

```
console-bdri/
  backend/      API Express + Prisma
  frontend/     Application React (Console BDRI)
  docker-compose.yml
```

## Développement local (sans Docker)

### 1. Base de données

Installer PostgreSQL 17 avec l'extension PostGIS, puis créer la base :

```bash
createdb console_bdri
```

### 2. Backend

```bash
cd backend
cp .env.example .env        # adapter DATABASE_URL, secrets JWT, etc.
npm install
npm run prisma:migrate      # cree les tables (prisma migrate dev)
npm run prisma:seed         # admin + 8 regions + donnees de demo
npm run dev                 # http://localhost:4000, doc API : /api/docs
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173 (proxy /api -> :4000)
```

Compte administrateur initial : voir `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` dans `backend/.env`.

### 4. (Optionnel) Migration des données réelles

Pour reprendre les données de l'ancienne base `sig_routier` (PostGIS/PostgREST) :

```bash
cd backend
LEGACY_DATABASE_URL="postgresql://agergec:***@db-legacy.interne:5432/sig_routier" npm run migrate:legacy
```

## Tests

```bash
cd backend
npm test          # vitest — hash de mot de passe, CRUD factory (soft delete + audit)
```

## Production (Docker)

```bash
cp backend/.env.example backend/.env   # renseigner les vraies valeurs (secrets, mots de passe)
docker compose up -d --build
```

Services exposés :
- `frontend` (Nginx) : http://localhost:8080
- `backend` (API) : http://localhost:4000/api
- `db` (Postgres/PostGIS) : 5432

Au premier démarrage, exécuter dans le conteneur backend :

```bash
docker compose exec backend npm run prisma:deploy
docker compose exec backend npm run prisma:seed
```

## Modules

| Module | Endpoint | Rôles en écriture |
|---|---|---|
| Tronçons routiers | `/api/troncons` | ADMIN, GESTIONNAIRE |
| Ouvrages d'art | `/api/ouvrages` | ADMIN, GESTIONNAIRE |
| Points noirs | `/api/points-noirs` | ADMIN, GESTIONNAIRE |
| Péages / Pesages | `/api/postes` | ADMIN, GESTIONNAIRE |
| Chantiers | `/api/chantiers` | ADMIN, GESTIONNAIRE |
| Inspections | `/api/inspections` | ADMIN, GESTIONNAIRE, INSPECTEUR |
| Tableau de bord | `/api/dashboard/kpis` | lecture seule |

Toutes les listes supportent pagination (`page`, `pageSize`), tri (`sortBy`, `sortDir`) et
filtres serveur (`search`, `region`, `etat`/`type` selon le module).
