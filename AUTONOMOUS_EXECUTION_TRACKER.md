# Suivi d'exécution autonome

> Fichier de reprise exigé par l'instruction finale du 14/10/2026 (« exécution autonome totale »).
> **À lire en premier à chaque reprise**, avec `PROJECT_STATUS.md`, `BLOCKERS.md` et
> `DECISIONS_PENDING.md`, puis reprendre à la **prochaine action** du § 5.
>
> Statuts : `TODO` · `IN_PROGRESS` · `BLOCKED` · `DONE` (implémenté, tests passés) · `VERIFIED`
> (DONE + vérifié contre une base ou un parcours réel). **Rien de simulé ou de non testé n'est
> DONE.** Un `BLOCKED` porte sa cause et la condition de levée.
>
> Règles qui ne bougent pas, quelle que soit l'autonomie : aucun secret dans le dépôt ni dans ce
> fichier ; aucune norme, prix, règle ou interface tierce inventés ; aucune suppression de
> données ; aucune opération de production sans prérequis **vérifiés** (sauvegarde restaurable,
> rollback testé, espace disque, compteurs) — et jamais prétendre avoir déployé sans l'avoir fait.

**Dernière mise à jour : 14/10/2026, 23:45.** Branche `lot/03-map-matching`, dernier commit poussé
`0f4cce8`. Backend **1 246** tests, frontend **304** (3 échecs en cours d'analyse dans la suite
complète — voir L-00). Base de développement : conteneur `bdri-dev-db`, PostGIS 17-3.5, base
`replay`, 56 migrations.

---

## 1. État des lots

| Lot | Contenu | Statut | Preuve |
|---|---|---|---|
| **L-00 Vert permanent** | suites backend et frontend vertes, `tsc` propre des deux côtés, bancs SQL verts | `IN_PROGRESS` | backend 1 246 ✓ ; frontend 301/304 dans la suite complète, 10/10 isolé — cause à établir |
| **S Sécurité et état réel** | `SECURITY_REMEDIATION.md`, migrations réconciliées, matrice, décisions, ADR D1–D15 | `DONE` | commits du 14/10 ; 4 alertes de sécurité `BLOCKED` (production gelée) |
| **0 Phase 0** | quatre preuves du § F.1 | `VERIFIED` | rollback exécuté en aller-retour ; B-13 clos ; **B-16 ouvert** (chaîne non rejouable, D-10) |
| **1 Socle, SRID, CI** | CI sur `lot/**`, contrôle des migrations, secret scan | `DONE` | `.github/workflows/ci.yml` |
| **2 Référentiel linéaire** | bitemporalité, exclusion corrigée, sections fixes dérivées | `VERIFIED` | 32 + 14 assertions ; codification nationale `BLOCKED` (D-06) |
| **3 Map-matching** | noyau ponctuel 5 facteurs, trace HMM | `DONE` | A2 100 %, A18 130/130 sur jeu synthétique ; graphe réseau `TODO` |
| **4 Dégradations, métrés, ouvrages** | catalogue 13 types, métrés, fiche 360° | `DONE` | ≥ 21 types `TODO` ; inspection post-travaux typée `TODO` |
| **5 Validation, audit, qualité** | workflow, 9 familles d'anomalies | `DONE` | 75 + 37 tests |
| **6 Tâches internes (TI-01)** | table, 9 CHECK, garde-fou frontière | `VERIFIED` | 22 assertions, 17 tests, descente vérifiée |
| **7 Mobile Capacitor** | coque, plugins Kotlin, roulage | `BLOCKED` | **B-10** : ni `adb`, ni `gradle`, ni `java` sur ce poste ; noyau TS prêt |
| **8 Hors ligne, packs, roulage** | sync faite ; packs de mission, IRI, photo continue | `TODO` | dépend du lot 7 pour l'épreuve réelle |
| **9 Moteurs de décision** | catalogue traitements `DONE` ; cycle de vie gardé `DONE` ; RCI `EA` ; risque, coût, PPE/PAE | `IN_PROGRESS` | coût et programmation `BLOCKED` par **D-07** (millésime, largeur) ; estimation « refuse sans ligne » réalisable |
| **10 Tableau de bord, Géoportail d'excellence** | portions et qualité au tableau de bord ; benchmark D3 | `TODO` | benchmark `BLOCKED` : aucune donnée locale, production gelée |
| **11 Écosystème ONR / BDR / ANASUR** | 15 livrables `DONE` ; pivot CSV/GeoJSON `DONE` ; import étape 1 `DONE` ; écran lots `DONE` | `IN_PROGRESS` | étape 2 (application) `BLOCKED` : échantillon approuvé ; GeoPackage `TODO` (dépendance à choisir) |
| **12 Exploitation (§ 7.17)** | main courante append-only, patrouilles, P1–P4, Info Route | `TODO` | P1–P4 proposition en D-02 ; peuplement provisoire réalisable |
| **13 Intégrations DigitalRoad, SharePoint** | sortante en service ; entrante | `BLOCKED` | **B-11, B-12** : aucun accès de recette |
| **14 Observation de la Terre (partie E)** | palier 0 gratuit | `TODO` | aucune dépense ; conception « descendre, jamais téléverser » |
| **15 Publication** | build des deux applications, commits, push, déploiement | `IN_PROGRESS` | push continu ; **déploiement : prérequis à vérifier avant tout geste** (§ 4) |

## 2. Tâches en cours et prochaines, dans l'ordre

| # | Tâche | Lot | Statut | Critère de fin |
|---|---|---|---|---|
| T-1 | Identifier et corriger les 3 échecs frontend de la suite complète | L-00 | `IN_PROGRESS` | 304/304, cause documentée |
| T-2 | Commit + push du garde-fou, de l'écran des lots, du suivi | 15 | `TODO` | balayage propre, poussé |
| T-3 | Build frontend (`tsc && vite build`) et backend (`tsc`), artefacts vérifiés | 15 | `TODO` | `dist/` produit, taille notée |
| T-4 | Estimation de coût qui **refuse** sans ligne de barème (classe de précision affichée, résultat « provisoire ») | 9 | `TODO` | tests ; aucun montant pour BETON/AUTRE |
| T-5 | Peupler `referentiel_praticabilites` avec P1–P4 **provisoires, non approuvés** (migration) | 12 | `TODO` | rollback testé ; `approuveLe` nul |
| T-6 | Main courante d'exploitation append-only (table, horodatage serveur, aucune mise à jour ni suppression — par absence de route) | 12 | `TODO` | banc SQL + tests route |
| T-7 | Tableau de bord : couverture par portions et qualité, périmètre affiché partout | 10 | `TODO` | tests ; « réseau classé saisi », jamais « national » |
| T-8 | Catalogue des défauts ≥ 21 types, revêtu / non revêtu, par **table** (migration) | 4 | `TODO` | A11 inchangé |
| T-9 | Inspection typée post-travaux (rattachée au cycle de vie, origine `INSPECTION_POST_TRAVAUX`) | 4/9 | `TODO` | garde-fou inchangé |
| T-10 | Vérification des prérequis de déploiement, puis déploiement si **tous** satisfaits | 15 | `TODO` | § 4 |

## 3. Blocages actifs

| Réf. | Cause | Levée par |
|---|---|---|
| B-10 | aucun outil Android sur ce poste | installer JDK + SDK Android, ou une CI de build |
| B-11 / B-12 | aucun accès DigitalRoad ni SharePoint de recette | AGEROUTE / DSI |
| B-16 | chaîne de migrations non rejouable sur base vierge (D-10) | arbitrage D-10 : acter `pg_dump`, corriger au prochain déploiement autorisé |
| D-06 | nomenclature officielle, codification | ONR / décret D/2017/331 |
| D-07 | millésime et largeur des barèmes | AGEROUTE, et l'ONR comme dépositaire des prix unitaires |
| D-09 | ERP et IdP de référence | AGEROUTE / DSI |
| `.env` local absent | les écrans ne sont pas vérifiables dans un navigateur sur ce poste | créer un `.env` de développement à valeurs jetables, jamais commité |
| Volume F: « dirty » | `chkdsk F: /f` recommandé, non lancé (accès exclusif requis) | l'utilisateur |

## 4. Prérequis de déploiement — aucun n'est présumé

À vérifier **dans cet ordre**, et le premier qui échoue arrête tout :

1. accès `ssh gec` fonctionnel, projet Compose `console-bdri` dans `/opt/console-bdri` (le nom ne change pas : des volumes neufs seraient une base vide) ;
2. **sauvegarde du jour** : `pg_dump -Fc` puis `pg_restore -l` — pas seulement l'existence du fichier ;
3. espace disque > 15 % libre, sinon `docker builder prune` d'abord ;
4. compteurs de référence relevés (`troncons`, `ouvrages`, `valeurs_qualite`, `audit_logs`, `users`) ;
5. `prisma migrate status` : 50 appliquées, 6 en attente, 0 orpheline ;
6. les six descentes présentes dans `backend/prisma/descentes/` ;
7. `git diff --name-status main...HEAD | grep ^D` vide ;
8. empreintes des deux `.env` relevées avant et après.

Puis `docker compose up -d --build`, `prisma:deploy` (**jamais** `prisma:migrate`), contrôles d'après
(compteurs identiques, `/api/health` à 0 échec d'audit, journal sans erreur, routes protégées en
401). Si un contrôle d'après échoue : descentes dans l'ordre inverse, image précédente.

**Ce déploiement est autorisé par l'instruction du 14/10 sous condition que ces prérequis soient
satisfaits.** S'ils ne le sont pas, il n'a pas lieu, et ce fichier dit pourquoi.

## 5. Prochaine action

**T-1** : lire la sortie de la suite frontend complète, nommer les trois tests en échec, corriger
la cause (pas le symptôme), relancer jusqu'à 304/304. Puis T-2.

## 6. Instruction de reprise

Relire ce fichier, `PROJECT_STATUS.md` § 7 et `BLOCKERS.md`. Vérifier `git status` et le dernier
commit poussé. Reprendre à la tâche `IN_PROGRESS` du § 2, ou à la première `TODO` si aucune. Ne
pas refaire un audit déjà consigné : le mettre à jour.
