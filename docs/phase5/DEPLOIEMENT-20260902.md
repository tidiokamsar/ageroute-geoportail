# Déploiement production — 2026-09-02 12:33 UTC

**Opérateur** : déploiement assisté, sur validation explicite du propriétaire
**Répertoire** : `/opt/console-bdri` (serveur gec) · **Tag** : `prod/phase5-20260902` · **Commit** : `65673cf`
**Sauvegarde de référence (P1-09)** : `bdri_20260902_122325.dump.enc` — chiffrée, copiée hors serveur (ageroutedb), état vérifié avant toute écriture.

---

## Contenu déployé

| Lot | Contenu |
|---|---|
| Phase 4 (4 migrations + inspection_coordonnees) | provenance tronçons, valeurs qualité, localisation chantiers, idempotence inspections, coordonnées GPS, récupération postes — migrations déjà dans le dépôt, jamais appliquées à la prod |
| P1 Sécurité/Intégrité | soft delete décomptes/bailleurs/photos OT, chaîne d'autorisation photos (IDOR fermé), propriété des inspections, Swagger ADMIN |
| P2 Robustesse | entités archivées figées, tri contrôlé (400), échecs d'audit visibles (`/api/health`), conversion OT transactionnelle |
| P3-A Refresh tokens | SHA-256 au repos, familles, rotation atomique, détection de réutilisation, `SECURITY_EVENT`, logout-all |
| P3-B Transport | cookie HttpOnly/SameSite=Strict/Path=/api/auth, validation Origin, client sans localStorage, verrou multi-onglets |
| Cartographie | symboles par nature (ouvrages/points noirs/postes/chantiers) |

## Déroulé effectif

1. **Pré-vol** : divergence migrations réconciliée par mesure (prod = exactement l'état enregistré `20260901170000` ; les 6 migrations Phase 4 n'étaient PAS appliquées → 9 à appliquer, toutes éprouvées sur copie par `tester-migrations-phase4/p1/p3a.sh`).
2. **Sauvegarde immédiate** : `bdri_20260902_122325` (2,07 Mo chiffrés + uploads + manifeste), copie hors serveur.
3. **Source** : snapshot de l'ancienne source (`~/console-bdri-source-avant-phase5-20260902.tar.gz`), code `65673cf` monté, `backend/.env` de prod préservé. Un correctif de typage a été requis par le `tsc` de l'image (fixture de test incomplète) — commit `65673cf` avant build.
4. **Build** : `docker compose build backend frontend` — réussi.
5. **Migrations AVANT bascule** (ancien backend actif pendant l'opération) : `docker compose run --rm backend npm run prisma:deploy` → **9 migrations appliquées**.
6. **Vérifications post-migration** : 26 migrations enregistrées ; 0 empreinte invalide ; colonne `refresh_tokens.token` **supprimée** (plus aucun token brut en base) ; intégrité : 1 690 tronçons actifs, 496 chantiers, 126 ouvrages — **identiques**.
7. **Bascule** : `docker compose up -d backend frontend`.

## Check-list finale (7/7 verts, local + public via Traefik)

| Contrôle | Local | Public (carte.ageroute.gov.gn) |
|---|---|---|
| `GET /api/health` | ok — base 12 ms, stockage ok, **échecs d'audit : 0** | ok — base 3 ms |
| `GET /api/docs` sans session | **401** | **401** |
| `GET /api/photos/…` sans session | **401** | — |
| `POST /api/auth/refresh` sans cookie ni body | **401** | — |
| `POST /api/auth/refresh` Origin interdite | **403** | — |
| Frontend servi | 200 | 200 |
| Logs backend | aucune erreur | — |

## Sessions utilisateurs

Aucune reconnexion générale : preuve faite sur copie (49 sessions actives migrées par empreinte exacte). Les anciens clients (refresh en body) continuent de fonctionner et migrent en cookie à leur premier refresh.

## Rollback (si nécessaire)

- **Code** : images précédentes (source archivée) ; les colonnes P1/P3-A sont additives — l'ancien code fonctionne sur le nouveau schéma **sans** rollback de base.
- **Schéma** (dernier recours, testé) : DROP des colonnes ajoutées — invalide les sessions refresh (reconnexion générale), données métier intactes.
- Sauvegarde de référence restaurable (clé sur serveur, procédure `verifier-restauration-bdri.sh` hebdomadaire).

**Production : carte.ageroute.gov.gn — en service sur phase5 (`65673cf`).**
