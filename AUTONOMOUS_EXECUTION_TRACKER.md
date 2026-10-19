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

**Dernière mise à jour : 19/10/2026.** Branche `lot/03-map-matching`. Backend **1 409** tests,
frontend **304**, `tsc` propre des deux côtés, **huit bancs SQL** verts. Base de développement :
conteneur `bdri-dev-db`, PostGIS 17-3.5 (GEOS 3.9), base `replay`, **62 migrations** (50 appliquées
en production, 12 en attente, chacune avec sa descente vérifiée en aller-retour).

---

## 1. État des lots

| Lot | Contenu | Statut | Preuve |
|---|---|---|---|
| **L-00 Vert permanent** | suites backend et frontend vertes, `tsc` propre des deux côtés, bancs SQL verts | `VERIFIED` | backend 1 287 ✓, frontend 304 ✓, cinq bancs SQL ✓ au commit `652d22d`. **Règle apprise le 15/10** : ne jamais lancer la suite frontend en même temps qu'une suite ou un `tsc` backend — sur ce poste, 10 tests sur 304 dépassent alors leur plafond (y compris des fichiers non modifiés) ; seuls, ils passent |
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
| **12 Exploitation (§ 7.17)** | main courante `DONE` ; P1–P4 provisoires `VERIFIED` ; patrouilles programmées `VERIFIED` ; Info Route et bulletin `VERIFIED` ; cellule de veille | `IN_PROGRESS` | EX-01, EX-02, EX-03, EX-05, EX-06 livrés ; EX-04, EX-08 `TODO` ; EX-07 (Waze/CIFS) et EX-09 (DATEX II) `BLOCKED` (aucun compte partenaire, aucune autorisation) ; diffusion du bulletin (radio, SMS, WhatsApp) `BLOCKED` (aucun canal raccordé ni autorisé) ; alerte capteur `BLOCKED` (aucun capteur raccordé, aucune interface approuvée) |
| **13 Intégrations DigitalRoad, SharePoint** | sortante en service ; entrante | `BLOCKED` | **B-11, B-12** : aucun accès de recette |
| **14 Observation de la Terre (partie E)** | palier 0 gratuit | `TODO` | aucune dépense ; conception « descendre, jamais téléverser » |
| **15 Publication** | build des deux applications, commits, push, déploiement | `IN_PROGRESS` | push continu ; **déploiement : prérequis à vérifier avant tout geste** (§ 4) |

## 2. Tâches en cours et prochaines, dans l'ordre

| # | Tâche | Lot | Statut | Critère de fin |
|---|---|---|---|---|
| T-1 | Échecs frontend de la suite complète | L-00 | `VERIFIED` | un seul test en cause, préexistant : `DefautTerrainPage` prenait 4,9–6,2 s seul pour 5 s de plafond. Cause : pauses `user-event` à chaque frappe → `delay: null` + marge 15 s. 3/3 seul, **304/304** en suite |
| T-2 | Commit + push garde-fou, écran des lots, suivi | 15 | `DONE` | `16d0b99`, balayage propre, aucun `dist/` |
| T-3 | Builds | 15 | `VERIFIED` | frontend 94 fichiers / 5,3 Mo en 2 min 27 ; backend 234 fichiers émis ; nouveaux modules présents dans `dist/` |
| T-4 | Estimation de coût qui **refuse** sans ligne de barème | 9 | `DONE` | `engines/cout.noyau.ts`, sans import, BigInt, 18 tests. Une prémisse fausse de mon test corrigée (7,4 × 10¹³ ne dépasse pas 2⁵³) ; l'exactitude au franc est prouvée là où un double perd |
| T-5 | P1–P4 **provisoires, non approuvés** | 12 | `VERIFIED` | migration `20261015000000`, source `mandat_v10_proposition`, `approuveeLe` nul, P4 seul non franchissable ; une portion peut porter P4 ; descente ciblée par source, aller-retour vérifié |
| T-6 | Main courante en ajout seul | 12 | `DONE` | migration `20261015010000` : chaîne d'entrées, **premier déclencheur du dépôt** (UPDATE/DELETE/antidatage refusés — banc SQL 14 assertions), vue `evenements_exploitation` avec délais EX-08, 10 types + 4 sources en tables. Noyau du cycle de vie (13 tests) + service transactionnel audité + route `/api/v2/exploitation/main-courante` sans PUT/PATCH/DELETE (10 tests). **Statut `DONE`** au commit `652d22d` |
| T-7a | Écran de décision : **retrait de deux barèmes inventés** (800/500/150 M GNF/km, criticité 90/70/50/30) qui contredisaient la base d'un facteur 4,4 ; estimation par le moteur de coût, `null` + motif quand il refuse ; criticité nulle (aucune source) | 10 | `DONE` | `engines/decision.estimation.ts` 11 tests ; `DecisionPage` adapté (null géré, poids redistribués, tronçon non estimé non finançable) ; frontend 304/304 seule, `tsc` propre des deux côtés |
| T-7b | Tableau de bord `/kpis` : portions validées (compte, km), répartition qualité par statut, **périmètre dit d'abord** (« réseau classé saisi », jamais « national ») | 10 | `DONE` | route étendue, `DashboardPage` affiche périmètre + deux cartes ; avertissement explicite quand zéro portion validée : « les états affichés sont des valeurs d'import » |
| T-8 | Catalogue des défauts ≥ 21 types, revêtu / non revêtu | 4 | `VERIFIED` | `c1312d9` : 31 types en module pur (22 tests), script idempotent éprouvé 31 → 0, colonne `applicabilite` avec contrainte vérifiée, descente aller-retour |
| T-9 | Inspection typée post-travaux | 4/9 | `DONE` | migration `20261015030000` : `type` (GENERALE / PERIODIQUE / VERIFICATION / POST_TRAVAUX, texte contraint), `interventionRef` (sans clé étrangère, la fiche d'intervention n'existe pas), `iriEstime` + `iriMethode` (D8). POST_TRAVAUX exige référence, état mesuré et photo **en base** (banc SQL 9 assertions, descente aller-retour) **et à l'API** avec un message par manque. En édition, les règles se jugent sur la **ligne fusionnée** — un défaut évité : sans cela, la contrainte aurait rendu un 500. Garde-fou : le modèle ne porte aucun champ de réception, réserve ni montant. Module 41 tests |
| T-10 | Vérification des prérequis de déploiement, puis déploiement si **tous** satisfaits | 15 | `BLOCKED` | § 4 ; CI jamais exécutée (compte GitHub verrouillé) et volume F: « dirty » : pas de déploiement tant que l'un ou l'autre tient |
| T-11 | Patrouilles programmées (EX-03) | 12 | `VERIFIED` | migration `20261019000000` : `programmes_patrouille` (périodicité 1–366 j et mois actifs **saisis, rien de semé** ; l'exemple du mandat n'est saisi que par le banc), itinéraire ordonné `programme_troncons`, `missions.programmeId` / `signalementId`, fonction `couverture_patrouille(mission, tolérance = 30 m)`. **Défaut trouvé par le banc** : `ST_Intersection` (GEOS 3.9) rendait une ligne vide pour un tronçon suivi exactement par la trace et couvert par le tampon ; remplacé par un échantillonnage géodésique (`ST_DWithin` en geography, pas ≤ 10 m), sans overlay. Banc SQL (A 100 %, B 52 %, C 0 %, écart 527 m mesuré), descente aller-retour. Noyau pur 31 tests (échéance saisonnière sans retard hors saison, saison à cheval sur l'année), routes 14 tests, service éprouvé contre `replay` en transaction annulée. Passages engendrés en BROUILLON : le cycle de vie reste celui des missions |
| T-12 | Info Route (EX-05) et bulletin quotidien (EX-06) | 12 | `VERIFIED` | migration `20261019010000` : `publications_info_route` **en ajout seul** (déclencheur : UPDATE/DELETE refusés, heure serveur, événement existant, séquence PUBLICATION → MISE_A_JOUR → RETRAIT tenue sous verrou), vue publique `info_route_courante`, `bulletins_routiers` figés avec **empreinte SHA-256 vérifiée par contrainte**. Règle : un événement OUVERT ne se publie pas (« validé par l'exploitant » = pris en compte) ; **un niveau P1–P4 non approuvé ne s'annonce pas au public** (consigne AGEROUTE du 13/10, refus en base). Flux public `/api/public/info-route` sans auteur, texte interne ni identifiant ; dernier bulletin en texte simple. Banc SQL 20 assertions, descente aller-retour, noyau 19 tests, routes 11 tests, épreuve contre `replay`. **Défaut trouvé dans EX-01 (non déployé)** : une déclaration localisée par un point seul ne pouvait pas s'enregistrer (contrainte jugée à l'INSERT, UPDATE refusé par le déclencheur) ; corrigé en une insertion unique, test réécrit. Le bulletin n'est envoyé nulle part |

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
5. `prisma migrate status` : 50 appliquées, 12 en attente, 0 orpheline ;
6. les douze descentes des migrations en attente présentes dans `backend/prisma/descentes/` ;
7. `git diff --name-status main...HEAD | grep ^D` vide ;
8. empreintes des deux `.env` relevées avant et après.

Puis `docker compose up -d --build`, `prisma:deploy` (**jamais** `prisma:migrate`), contrôles d'après
(compteurs identiques, `/api/health` à 0 échec d'audit, journal sans erreur, routes protégées en
401). Si un contrôle d'après échoue : descentes dans l'ordre inverse, image précédente.

**Ce déploiement est autorisé par l'instruction du 14/10 sous condition que ces prérequis soient
satisfaits.** S'ils ne le sont pas, il n'a pas lieu, et ce fichier dit pourquoi.

## 4 bis. État au 19/10/2026

- **CI** : le compte GitHub est **verrouillé pour facturation** ; aucun run n'a jamais exécuté une
  commande. La PR #2 est ouverte, rouge pour cette seule raison. Le vert local reste la seule preuve.
- **Volume F:** : bit « dirty » toujours posé ; `chkdsk F: /f` non lancé (accès exclusif, à
  l'utilisateur). Portable sur secteur au 19/10.
- **Docker** : relancé le 19/10 ; base `replay` intacte, les huit bancs SQL y passent.

## 5. Prochaine action

**EX-08 statistiques d'exploitation** (la vue `evenements_exploitation` porte déjà les délais), puis
**EX-04 cellule de veille** (astreintes, escalade à seuils saisis, vue temps réel). T-10 reste `BLOCKED` tant
que la CI n'a jamais tourné et que `chkdsk F: /f` n'a pas été lancé.

## 6. Instruction de reprise

Relire ce fichier, `PROJECT_STATUS.md` § 7 et `BLOCKERS.md`. Vérifier `git status` et le dernier
commit poussé. Reprendre à la tâche `IN_PROGRESS` du § 2, ou à la première `TODO` si aucune. Ne
pas refaire un audit déjà consigné : le mettre à jour.
