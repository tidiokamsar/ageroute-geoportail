# Rapport P1 — Sécurité / Intégrité

**Mission** : P1 Sécurité/Intégrité, travaux indépendants des décisions D1–D8
**Branche** : `phase5` · **Base de départ** : `5093da0`
**Production** : **NON TOUCHÉE** — toutes les mesures et tests sur copies restaurées
**Migrations** : PRÊTES, TESTÉES, RÉVERSIBLES, NON DÉPLOYÉES

---

## A. Corrections effectuées

### A.1 Suppression logique des décomptes et bailleurs (P1-01)

| Avant | Après |
|---|---|
| `DELETE` physique d'un décompte (donnée financière d'archive) | retrait logique `deletedAt` + audit ; l'agrégat décaissé (`sumByMarche`) et la liste excluent les retirés ; un décompte retiré n'est plus modifiable (figé) |
| bailleur : `DELETE` physique + **aucun audit** sur create/update/delete | retrait logique + audit sur les trois écritures ; garde-fou conservé (409 si un marché — archivé compris — y reste rattaché) ; liste opérationnelle filtrée |

Choix documenté : pas de colonnes `deletedBy`/`deleteReason` — le mécanisme
d'audit (`audit_logs` : action + userId + before) porte déjà cette information
pour toutes les autres entités ; créer une seconde convention ici aurait
fragilisé la cohérence. Les cascades `onDelete: Cascade` de `Decompte` restent
dans le schéma mais sont inatteignables (aucune suppression physique de marché
n'existe dans l'application).

### A.2 Chaîne d'autorisation des photos (P1-02)

| Avant | Après |
|---|---|
| `DELETE /ordres-travaux/:id/photos/:photoId` ignorait l'OT de l'URL : tout INSPECTEUR pouvait retirer une photo de **n'importe quel** OT en connaissant son identifiant | la photo doit appartenir à l'OT de l'URL et celui-ci être actif ; **404 uniforme** (pas de révélation d'existence) ; retrait logique + audit (preuve d'exécution conservée) |
| `GET /api/photos/:filename` : tout utilisateur authentifié obtenait n'importe quel fichier | le fichier n'est servi que si l'utilisateur a accès au **module de l'objet propriétaire** (OT → `ordres-travaux`, ouvrage → `ouvrages`, inspection → `inspections`) ; photo retirée, objet supprimé, module interdit et fichier absent → même 404 |
| retrait de photo ouvrage/inspection **sans aucune trace** | chaque ajout et retrait est audité (`{Entity}Photo`, avec acteur et nom de fichier) ; retrait d'un nom absent → 404 sans écriture |

### A.3 Propriété des inspections (P1-05, correctif)

Un `INSPECTEUR` ne peut plus modifier (`PUT`) que **ses** inspections (403
sinon, 404 si inexistante). `ADMIN` et `GESTIONNAIRE` conservent l'édition sur
tout le module. Aucune autre voie d'écriture n'était ouverte aux INSPECTEURS
sur les inspections d'autrui (photos déjà liées à l'objet parent contrôlé).

### A.4 Swagger derrière ADMIN (P1-05, correctif)

`/api/docs` exposait la cartographie de l'API à tout visiteur. Désormais
`requireAuth` + `requireRole("ADMIN")`.

## B. Corrections préparées mais non déployées

Tout A est **committé sur `phase5`** mais **non déployé**. Les migrations
(`20260902140000_p1_soft_delete_decomptes_bailleurs`,
`20260902141000_p1_ot_photos_soft_delete`) ne sont appliquées nulle part. La
procédure de déploiement attend une validation humaine (§K).

## C. Tests

**24 fichiers / 202 tests verts** (25 nouveaux, aucune régression des 177
existants) :

| Suite | Couverture |
|---|---|
| `decomptes.service.test.ts` | retrait logique (jamais de DELETE), 404 sur retiré, liste/agrégats filtrés, audit |
| `marches-bailleurs.service.test.ts` | garde-fou 409, retrait logique audité, audits create/update, liste filtrée |
| `ot.photos.test.ts` | **IDOR fermé** (photo d'un autre OT → 404 sans écriture), OT retiré → 404, retrait logique audité, ajout audité |
| `photos.access.test.ts` | résolution propriétaire→module pour OT/ouvrage/inspection, inconnu → null |
| `photos.shared.test.ts` | audit ajout/retrait, 404 sans écriture sur nom absent |
| `inspections.authorization.test.ts` | propriétaire ✓, autre inspecteur 403, gestionnaire ✓, admin ✓ (sans consultation préalable), inexistant 404 |

GIST : couvert par le benchmark mesuré (§E) — plan utilisé, temps mesurés,
résultat identique avant/après (comptage du corridor : 144 = 144).

## D. Migrations

| Migration | Contenu | Testée sur | Rollback |
|---|---|---|---|
| `20260902140000_p1_soft_delete_decomptes_bailleurs` | `deletedAt` + index sur `decomptes` et `bailleurs` (aucune ligne écrite) | copie production restaurée (`bdri_20260902_030001`) | ✓ exécuté et vérifié (retour exact) |
| `20260902141000_p1_ot_photos_soft_delete` | `deletedAt` + index sur `ot_photos` (aucune ligne écrite) | idem | ✓ |

Script : `infra/phase5/tester-migrations-p1.sh` — restaure, applique, vérifie
colonnes + intégrité (P1-07), rejoue le rollback, détruit le conteneur.
Sortie brute : `donnees/p1-integrity-check.txt`.

## E. Benchmark GIST

Résumé (détail dans `P1-GIST-BENCHMARK.md`) : **un seul prédicat spatial à
l'exécution** (itinéraire, `ST_DWithin` sur `troncons`) ; la production possède
déjà l'index exact pour cette requête (`troncons_geom_geography_idx`, plan
mesuré : Index Scan) ; un index candidat supplémentaire n'apporte **rien**
(~89 ms → ~89 ms) ; les quatre tables de points n'ont **aucun prédicat spatial**
à l'exécution → **aucune création**. La recommandation initiale « GiST ×5 » est
corrigée par la mesure. **Verdict : MESURÉ — NON CONCLUANT pour toute création.**

## F. Audit IDOR photos

Chaîne exigée : `Utilisateur → Autorisation → Objet parent → Permission module → Photo → Fichier`.

| Élément de la chaîne | État avant | État après |
|---|---|---|
| Suppression photo OT | **rompue** (photoId seul) | parent vérifié (otId + OT actif) |
| Lecture du fichier photo | **rompue** (auth seule) | module du propriétaire requis |
| Suppression photo ouvrage/inspection | liée à l'objet parent ✓ mais **inaudité** | inchangée + audit |
| Cas testés | — | utilisateur A → photo objet B : 404 ; sans permission : 404 ; avec permission : servi ; admin : servi ; objet supprimé : 404 ; photo inexistante : 404 ; non autorisée : même 404 (uniformité) |
| Documents (téléchargement) | contrôlé par objet + auth (lecture ouverte aux authentifiés, politique documentée) | inchangé — noté au §J (politique assumée d'outil interne) |

## G. Audit des suppressions (P1-04)

Recensement exhaustif des `delete`/`deleteMany` Prisma du backend :

| Localisation | Nature | Classification | Décision |
|---|---|---|---|
| `crud-factory.remove/bulkRemove` (10+ entités) | soft delete + audit | BUSINESS_DATA | conforme — inchangé |
| `decomptes.service.remove` | **DELETE physique** | BUSINESS_DATA (financier) | **corrigé → soft delete** (A.1) |
| `marches.service.deleteBailleur` | **DELETE physique**, sans audit | REFERENCE_DATA | **corrigé → soft delete + audit** (A.1) |
| `ot.service.removePhoto` | **DELETE physique**, sans contrôle parent, sans audit | BUSINESS_DATA (preuve d'exécution) | **corrigé → contrôle parent + soft delete + audit** (A.2) |
| `marches.service.detachChantier` (`marcheChantier.delete`) | ligne de liaison, recréable, auditée | SYSTEM_DATA (lien) | **SAFE_HARD_DELETE** — inchangé |
| `auth.service` `twoFaFailedAttempts.delete` | Map en mémoire (compteur 2FA) | SYSTEM_DATA (mémoire) | **SAFE_HARD_DELETE** — inchangé |
| `documents` (`remove`) | soft delete via crud-factory, fichier conservé sur disque | BUSINESS_DATA | conforme — inchangé |
| `users` | pas de suppression : désactivation (`actif`) + révocation des jetons | USER_DATA | conforme — inchangé |
| `audit_logs` | **aucune** route de suppression/modification | ARCHIVE | conforme — inchangé |
| fichiers photo/document sur disque | jamais supprimés (déréférencés) | — | noté au §J (purger un jour, avec politique de rétention) |

## H. Audit des autorisations (P1-05)

Matrice par module (toutes les routes ont été passées en revue) :

| Module (préfixe) | Auth | Lecture | Écriture | Module | Constat |
|---|---|---|---|---|---|
| auth | rate-limit login + 2FA | /me | — | — | conforme (P0 appliqué) |
| troncons / ouvrages / points-noirs / postes / chantiers / inspections / documents / marches | `use(requireAuth)` | auth seule (politique interne documentée) | ADMIN+GESTIONNAIRE (+INSPECTEUR inspections) | ✓ sur chaque écriture | conforme |
| ordres-travaux | `use(requireAuth, requireModuleAccess)` | auth+module | rôles selon action | ✓ router-level | conforme |
| users, admin/settings | `use(requireAuth, requireRole("ADMIN"))` | ADMIN | ADMIN | — | conforme |
| **photos** (fichiers) | `use(requireAuth)` | **auth seule → IDOR** | — | **corrigé** : module propriétaire requis, 404 uniforme | **corrigé (A.2)** |
| **inspections PUT** | rôles ok | — | INSPECTEUR = **n'importe quelle** inspection | **corrigé** : propriétaire seul | **corrigé (A.3)** |
| **/api/docs** | **aucune** | publique | — | — | **corrigé** : ADMIN (A.4) |
| public (carte/geo) | rate-limit 60/min, sans auth | géométries, champs réduits | — | — | décision documentée Phase 4 — inchangé |
| qualite, propositions, search, audit, dashboard, regions | auth + module (ou ADMIN pour audit/users via `MODULE_PAR_ENTITE`) | filtrées par droits | — | ✓ | conforme |

Revue spécifique demandée : `isAuthenticated` n'a jamais été traité comme
équivalent de `hasPermission` — chaque écriture porte rôle **et** module.

## I. Contrôle d'intégrité des données

Voir `P1-DATA-INTEGRITY-CHECK.md` : **tous les comptages identiques avant/après**
(1 690 tronçons dont 1 690 actifs et 1 690 géométries valides ; 496 chantiers —
cf. note sur le « 488 » actifs ; 126 ouvrages ; tables modifiées vides ou
inchangées). Rollback re-vérifié : retour exact. **Aucune donnée métier
disparue.**

## J. Risques résiduels

1. **Fichiers orphelins** : les fichiers photo/document retirés logiquement
   restent sur disque (recherche par nom toujours possible pour un admin via
   l'objet restauré). Politique de rétention à décider — pas en P1.
2. **`logAudit` fail-silently** (constaté en revue) : un échec d'audit n'alerte
   pas. Recommandation : compteur d'échec + alerte — chantier P2.
3. **Lecture patrimoine ouverte aux authentifiés** (listes, documents en
   lecture) : politique assumée d'outil interne ; à re-soucrire formellement si
   le périmètre d'utilisateurs s'élargit.
4. **`crud-factory.update`** modifie encore une entité archivée (`findUnique`
   sans filtre `deletedAt`) : écart au reste du pattern, non exploitable en
   écriture financière (décomptes corrigés séparément) — à homogénéiser en P2
   avec des tests de non-régression sur les flows d'administration.
5. **KNN/bbox futurs** : si des requêtes par fenêtre apparaissent, rejouer
   `benchmark-gist.sh` avant toute création d'index.

## K. Procédure de déploiement (quand la validation sera donnée)

```bash
# 1. Sauvegarde immédiate et vérifiée (sur le serveur applicatif)
~/console-bdri/infra/backup/sauvegarde-bdri.sh   # consigner l'identifiant produit
# 2. Statut des migrations (backend local, DATABASE_URL pointant la cible)
npx prisma migrate status
# 3. Appliquer UNIQUEMENT les migrations P1 (aucun db push)
npx prisma migrate deploy
# 4. Déployer le backend corrigé (image Docker reconstruite depuis la branche validée)
# 5. Vérifications post-déploiement :
#    - GET /api/health
#    - un retrait de décompte laisse la ligne (deletedAt) et écrit audit_logs
#    - GET /api/photos/<fichier d'un module interdit> → 404
#    - PUT /inspections/:id d'autrui en INSPECTEUR → 403
#    - GET /api/docs sans session → 401/403
```

## L. Procédure de rollback

1. **Code** : redéployer l'image précédente.
2. **Schéma** : les colonnes P1 sont additives et nullable — le code précédent
   fonctionne **sans** rollback de schéma. Si un retour complet est exigé :
   ```sql
   ALTER TABLE "decomptes" DROP COLUMN IF EXISTS "deletedAt";
   ALTER TABLE "bailleurs" DROP COLUMN IF EXISTS "deletedAt";
   ALTER TABLE "ot_photos"  DROP COLUMN IF EXISTS "deletedAt";
   ```
   (testé : retour exact aux comptages d'origine — §I).
3. **Données** : aucune ligne métier n'est modifiée par les migrations ; en cas
   de retraits logiques effectués entre-temps, ils survivent au rollback de
   code (le `deletedAt` resterait en base, invisible pour l'ancien code dans le
   cas de decomptes/bailleurs ? non — l'ancien code ne filtre pas `deletedAt`
   sur ces tables : ils réapparaîtraient en liste. D'où l'ordre : rollback
   code d'abord, schéma ensuite, et purge éventuelle des `deletedAt` si des
   retraits ont eu lieu — la liste `audit_logs` action DELETE les recense).

---

## Tableau de sortie

| Élément | État |
|---|---|
| Soft delete | **PRÊT** (décomptes, bailleurs, photos OT — testé, non déployé) |
| IDOR photos | **PRÊT** (chaîne parent+module, 404 uniforme — testé, non déployé) |
| GIST | **MESURÉ — NON CONCLUANT** (aucune création justifiée, preuve au dossier) |
| Permissions | **AUDITÉ** (+ 2 correctifs : inspections, Swagger) |
| Suppressions | **AUDITÉ** (classification complète, 3 correctifs) |
| Tests | **202/202** (25 nouveaux) |
| Migrations | **2** (prêtes, testées, réversibles, non déployées) |
| Production | **NON TOUCHÉE** |
| Rollback | **VALIDÉ** (exécuté et mesuré) |

> **P1 SÉCURITÉ/INTÉGRITÉ PRÊT POUR VALIDATION — PRODUCTION NON TOUCHÉE**
