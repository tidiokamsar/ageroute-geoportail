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
  développement, qui est **en avance sur la production** : 21 routes applicatives
  contre 13 déployées.
- **Non déployées à ce jour** : sync hors-ligne + PWA (`lib/offlineSync.ts`,
  `hooks/useOfflineSync.ts`, `public/sw.js`), API publique
  (`backend/src/modules/public/`), et les pages Marchés, Ordres de travaux,
  Décision, Sécurité, Administration, Rapport bailleur, Inspection terrain,
  Embed carte.
- Il n'existe **aucun historique Git antérieur** : le commit initial est un
  instantané, pas une reconstruction de l'historique réel.

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
