# AGENTS.md — Consignes pour agents IA

Guide de reprise pour tout agent (Claude, Codex, Gemini…) intervenant sur ce dépôt.

## Ce qu'est le projet

**Console BDRI** — outil interne AGEROUTE Guinée de gestion du patrimoine routier
(tronçons, ouvrages d'art, points noirs, péages/pesages, chantiers, inspections),
avec un géoportail cartographique Leaflet.

En production sur **https://carte.ageroute.gov.gn** (serveur serveur applicatif interne,
Docker + Traefik). Voir `README.md` pour la stack et l'installation.

## État du dépôt

- Ce dépôt a été créé le **1er septembre 2026** à partir de la copie de
  développement. Il n'existe **aucun historique Git antérieur** : le commit initial
  est un instantané, pas une reconstruction de l'historique réel.
- **Ce que l'on sait déployé** (la production n'est pas vérifiable depuis ce dépôt) :
  - deux déploiements consignés dans `AUTONOMOUS_EXECUTION_TRACKER.md` (T-10) : le
    21/10/2026 (commit `7411664`) et le 22/10/2026 à 11 h 46 (commit `0703c6a`, 72
    migrations au total après lui) ;
  - le relevé de production du 23/10/2026 donnait **79 migrations appliquées**
    (tracker, T-41) ; le dépôt (`HEAD`) en porte 82 et le script
    `infra/deployer-console.sh` a ensuite été réglé à zéro migration en attente
    (commit `970e17b`, 23/10) : cela suppose que les trois dernières ont été
    appliquées, mais **aucun document daté ne consigne ce déploiement**, ni son
    commit ;
  - `docker-compose.yml` dit que les pages Base documentaire, Inspection terrain et
    Ordres de travaux sont en production ; `PROJECT_STATUS.md` (14/10) relevait déjà
    la PWA (`/sw.js`) et l'API publique (`/api/public/carte/geo`) en production.
- **Ce que l'on sait non déployé** (derniers constats de `TEST_EVIDENCE.md` du
  25/10/2026 et de `docs/pilotage/`) : la route entre deux villes, l'APK servi
  derrière l'authentification (exige de modifier `docker-compose.yml` et `nginx.conf`
  sur le serveur), les phases SMART FIELD récentes (observation rapide, photo
  d'observation, historique par section) et tout ce qui a été commité après le dernier
  déploiement consigné. Cette liste n'est pas exhaustive.
- **Branche d'intégration `integration/depuis-vendredi`** (27/10/2026, locale, non
  poussée) : elle réunit en une seule branche testable les lignes de travail parallèles
  ouvertes depuis le 23/10 : `lot/03-map-matching` (Lots 0 et 1 : session hors ligne,
  sécurité serveur, imports, e2e), `fusion/observation-terre` (Aide à la décision,
  Observation de la Terre, relevés envoyés), `origin/lot/17-consignes-dt`,
  `origin/lot/18-bdri-troncons` (page Tronçons, registre d'anomalies, chantiers
  multi-tronçons, fiche d'inspection) et `origin/fix/geoportail-tabulation-traces`
  (qui porte l'autre lignée de l'Aide à la décision, lot 6, et la tabulation des
  cartes). Le dépôt y compte **94 migrations**. Relevé de production du 28/10/2026
  (après le déploiement du commit `747ac38`) : 84 appliquées, toutes présentes dans
  cette branche, donc **10 migrations en attente**
  (voir le commentaire de `ATTENDUES_EN_ATTENTE` dans `infra/deployer-console.sh`) ;
  le script refuse tout autre nombre. Deux couples d'horodatages sont identiques
  (`20261027100000`, `20261027110000`) : ils se rejouent dans l'ordre du nom de dossier.
  Rien n'est déployé depuis cette branche.
- **L'état exact de la production se vérifie au moment du déploiement**, jamais depuis
  ce fichier : `infra/deployer-console.sh` relève les migrations appliquées, les
  compteurs et l'état de santé avant tout geste. Ne rien déduire d'une ancienne
  mention « déployé » ou « non déployé ».

## Règles impératives

1. **Aucun secret dans le dépôt.** `backend/.env.example` ne contient que des
   valeurs `changeme`. Ne jamais y écrire de vraie valeur, ne jamais commiter de
   `.env`, de mot de passe, de jeton ni d'adresse IP de serveur de production.
2. **Suppression logique uniquement** sur les entités patrimoniales (`deletedAt`).
   Aucune suppression physique — le patrimoine routier est une donnée d'archive.
3. **Toute écriture est auditée** dans `audit_logs`. Ne pas contourner ce
   mécanisme en ajoutant des accès direct base.
4. **Migrations Prisma versionnées.** Modifier le schéma passe par une migration,
   jamais par `db push --accept-data-loss`.
5. **Ne pas déployer depuis ce dépôt** sans validation humaine explicite : la
   production sert des données réelles et la copie déployée diverge de `main`.

## Points d'attention connus

- PostgreSQL 17 + **PostGIS** requis : les géométries (`geometry`) ne sont pas
  gérées nativement par Prisma, certaines requêtes passent en SQL brut.
- `frontend/public/osm-routes.geojson` (~2 Mo) est un fond de carte statique
  utilisé par le géoportail.
- Auth : JWT access 15 min + refresh rotatif 7 j révocable, mots de passe Argon2id.
