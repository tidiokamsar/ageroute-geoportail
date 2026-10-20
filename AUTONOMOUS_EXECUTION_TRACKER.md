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

**Dernière mise à jour : 20/10/2026 (soir).** Branche `lot/03-map-matching`. Backend **1 490/1 490** (20/10), `tsc` propre des deux côtés, **douze bancs SQL** verts. Frontend : **suite complète du 20/10 entièrement verte, 328/328** ; **lint 0 erreur** (B-29 levé) ; accessibilité axe-core 0 violation sur 8 écrans. Base de développement :
conteneur `bdri-dev-db`, PostGIS 17-3.5 (GEOS 3.9), base `replay`, **67 migrations** (50 appliquées
en production, 17 en attente, chacune avec sa descente vérifiée en aller-retour).

---

## 1. État des lots

| Lot | Contenu | Statut | Preuve |
|---|---|---|---|
| **L-00 Vert permanent** | suites backend et frontend vertes, `tsc` propre des deux côtés, bancs SQL verts | `VERIFIED` | backend 1 287 ✓, frontend 304 ✓, cinq bancs SQL ✓ au commit `652d22d`. **Règle apprise le 15/10** : ne jamais lancer la suite frontend en même temps qu'une suite ou un `tsc` backend — sur ce poste, 10 tests sur 304 dépassent alors leur plafond (y compris des fichiers non modifiés) ; seuls, ils passent |
| **S Sécurité et état réel** | `SECURITY_REMEDIATION.md`, migrations réconciliées, matrice, décisions, ADR D1–D15 | `DONE` | commits du 14/10 ; 4 alertes de sécurité `BLOCKED` (production gelée) |
| **0 Phase 0** | quatre preuves du § F.1 | `VERIFIED` | rollback exécuté en aller-retour ; B-13 clos ; **B-16 ouvert** (chaîne non rejouable, D-10) |
| **1 Socle, SRID, CI** | CI sur `lot/**`, contrôle des migrations, secret scan | `DONE` | `.github/workflows/ci.yml` |
| **2 Référentiel linéaire** | bitemporalité, exclusion corrigée, sections fixes dérivées | `VERIFIED` | 32 + 14 assertions ; codification nationale `BLOCKED` (D-06) |
| **3 Map-matching** | noyau ponctuel 5 facteurs, trace HMM, graphe du réseau | `VERIFIED` | A2 100 %, A18 130/130 sur jeu synthétique, **avec des distances calculées par le graphe** (T-20) ; aucune route n'expose l'appariement de trace (attend le mobile, B-10) |
| **4 Dégradations, métrés, ouvrages** | catalogue 31 types revêtu / non revêtu, métrés, métré UTM, fiche 360°, inspection post-travaux typée | `VERIFIED` | T-8, T-9, T-18 ; photos de référence par gravité absentes |
| **5 Validation, audit, qualité** | workflow, 9 familles d'anomalies | `DONE` | 75 + 37 tests |
| **6 Tâches internes (TI-01)** | table, 9 CHECK, garde-fou frontière | `VERIFIED` | 22 assertions, 17 tests, descente vérifiée |
| **7 Mobile Capacitor** | coque, plugins Kotlin, roulage | `BLOCKED` | **B-10** : ni `adb`, ni `gradle`, ni `java` sur ce poste ; noyau TS prêt |
| **8 Hors ligne, packs, roulage** | sync faite ; packs de mission, IRI, photo continue | `TODO` | dépend du lot 7 pour l'épreuve réelle |
| **9 Moteurs de décision** | catalogue traitements `DONE` ; cycle de vie gardé `DONE` ; RCI `EA` ; risque, coût, PPE/PAE | `IN_PROGRESS` | coût et programmation `BLOCKED` par **D-07** (millésime, largeur) ; estimation « refuse sans ligne » réalisable |
| **10 Tableau de bord, Géoportail d'excellence** | portions et qualité au tableau de bord `DONE` ; lint et accessibilité `VERIFIED` ; étalon Logiroad écrit ; permaliens, OGC, curseur temporel, déviation routée | `IN_PROGRESS` | T-7b, T-21, `LOGIROAD_BENCHMARK.md` ; benchmark cartographique D3 `BLOCKED` (aucune donnée locale, production gelée) |
| **11 Écosystème ONR / BDR / ANASUR** | 15 livrables `DONE` ; pivot CSV/GeoJSON `DONE` ; import étape 1 `DONE` ; écran lots `DONE` | `IN_PROGRESS` | étape 2 (application) `BLOCKED` : échantillon approuvé ; GeoPackage `TODO` (dépendance à choisir) |
| **12 Exploitation (§ 7.17)** | main courante `DONE` ; P1–P4 provisoires `VERIFIED` ; patrouilles programmées `VERIFIED` ; Info Route et bulletin `VERIFIED` ; cellule de veille `VERIFIED` | `DONE` pour tout ce qui est exécutable | EX-01 à EX-06 et EX-08 livrés ; notifications d'escalade `BLOCKED` (canal à choisir par AGEROUTE) ; EX-07 (Waze/CIFS) et EX-09 (DATEX II) `BLOCKED` (aucun compte partenaire, aucune autorisation) ; diffusion du bulletin (radio, SMS, WhatsApp) `BLOCKED` (aucun canal raccordé ni autorisé) ; alerte capteur `BLOCKED` (aucun capteur raccordé, aucune interface approuvée) |
| **13 Intégrations DigitalRoad, SharePoint** | sortante en service ; entrante | `BLOCKED` | **B-11, B-12** : aucun accès de recette |
| **14 Observation de la Terre (partie E)** | registre, propositions, verdict du terrain, précision `VERIFIED` ; moteur de changement absent | `IN_PROGRESS` | aucune dépense, rien téléchargé ; choix des sources et hébergement du traitement : décision AGEROUTE / DSI |
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
| T-10 | Vérification des prérequis de déploiement, puis déploiement si **tous** satisfaits | 15 | `BLOCKED` | **Demandé explicitement le 20/10.** Prérequis 1 **échoué** : `ssh gec` refusé. Le rebond `glpi` répond, mais depuis lui le **port 22 du serveur applicatif est fermé ou filtré** et le serveur ne répond pas au ping ; le site, lui, répond (`/api/health` 200, port 443 ouvert). Aucune voie d'accès de contournement tentée. **Rien n'a été modifié en production.** **Diagnostic affiné le 20/10 au soir** : port 22 « closed » (RST, `nmap --reason`), pas « filtered » — le pare-feu laisse passer le 22, c'est **sshd qui n'écoute plus** (ni ban fail2ban ni règle à corriger). Balayage TCP complet depuis `glpi` : seuls 80/443 ouverts, aucun canal de gestion (pas d'API Docker, Cockpit, VNC ni port SSH alternatif), aucune connexion établie avec le serveur. Le serveur est sain : `/api/health` 200 et la sauvegarde nocturne (292 Mo) a été poussée à 03 h 01 le 20/10 — sshd s'est arrêté **entre 03 h 01 et 14 h 27** (piste : mise à jour automatique apt dans cette fenêtre). **Levée impossible depuis `glpi` : intervention console requise** (écran/clavier sur site ou panneau de l'hébergeur) : `systemctl status ssh ssh.socket`, `journalctl -u ssh -u ssh.socket --since "2026-10-20 03:00"`, puis `systemctl restart ssh.socket ssh` ; recontrôler depuis `glpi`. Restent ouverts : CI jamais exécutée (facturation), `chkdsk F:`, choix déployer la branche ou fusionner d'abord |
| T-11 | Patrouilles programmées (EX-03) | 12 | `VERIFIED` | migration `20261019000000` : `programmes_patrouille` (périodicité 1–366 j et mois actifs **saisis, rien de semé** ; l'exemple du mandat n'est saisi que par le banc), itinéraire ordonné `programme_troncons`, `missions.programmeId` / `signalementId`, fonction `couverture_patrouille(mission, tolérance = 30 m)`. **Défaut trouvé par le banc** : `ST_Intersection` (GEOS 3.9) rendait une ligne vide pour un tronçon suivi exactement par la trace et couvert par le tampon ; remplacé par un échantillonnage géodésique (`ST_DWithin` en geography, pas ≤ 10 m), sans overlay. Banc SQL (A 100 %, B 52 %, C 0 %, écart 527 m mesuré), descente aller-retour. Noyau pur 31 tests (échéance saisonnière sans retard hors saison, saison à cheval sur l'année), routes 14 tests, service éprouvé contre `replay` en transaction annulée. Passages engendrés en BROUILLON : le cycle de vie reste celui des missions |
| T-12 | Info Route (EX-05) et bulletin quotidien (EX-06) | 12 | `VERIFIED` | migration `20261019010000` : `publications_info_route` **en ajout seul** (déclencheur : UPDATE/DELETE refusés, heure serveur, événement existant, séquence PUBLICATION → MISE_A_JOUR → RETRAIT tenue sous verrou), vue publique `info_route_courante`, `bulletins_routiers` figés avec **empreinte SHA-256 vérifiée par contrainte**. Règle : un événement OUVERT ne se publie pas (« validé par l'exploitant » = pris en compte) ; **un niveau P1–P4 non approuvé ne s'annonce pas au public** (consigne AGEROUTE du 13/10, refus en base). Flux public `/api/public/info-route` sans auteur, texte interne ni identifiant ; dernier bulletin en texte simple. Banc SQL 20 assertions, descente aller-retour, noyau 19 tests, routes 11 tests, épreuve contre `replay`. **Défaut trouvé dans EX-01 (non déployé)** : une déclaration localisée par un point seul ne pouvait pas s'enregistrer (contrainte jugée à l'INSERT, UPDATE refusé par le déclencheur) ; corrigé en une insertion unique, test réécrit. Le bulletin n'est envoyé nulle part |
| T-13 | Statistiques d'exploitation (EX-08) | 12 | `DONE` | sans migration : `GET /api/v2/exploitation/statistiques?du=&au=` (période **exigée**), noyau pur 10 tests : délai de prise en compte et durée des coupures en médiane / 90e centile **par rang le plus proche** (valeur observée, jamais interpolée), événements jamais pris en compte comptés à part, tronçons **classés** sans étiquette « récurrent » ni cible de délai (aucune fixée par AGEROUTE). Requête exécutée contre la vue réelle ; route 2 tests |
| T-14 | Cellule de veille (EX-04) | 12 | `VERIFIED` | migration `20261019020000` : `astreintes` (niveau, région ou national, période), `regles_escalade` **aucune semée** (une seule active par type × mode × niveau, index partiel), `escalades` et `modes_veille` **en ajout seul**, une escalade par (événement, niveau). Mode SAISON_PLUIES **déclaré**, jamais calculé d'un calendrier. Noyau 15 tests (règle la plus précise, seul OUVERT monte, astreinte régionale puis nationale, trou de permanence = null), routes 9 tests, page `/veille` murale et mobile (rafraîchie toutes les 30 s, évalue puis lit), 5 tests. Banc SQL 17 assertions, descente aller-retour, épreuve contre `replay`. **Aucune notification envoyée** ; pas d'ordonnanceur serveur : l'évaluation, idempotente, est déclenchée par la vue |
| T-16 | Écrans de saisie de l'exploitation | 12 | `DONE` | `/exploitation/patrouilles` (programmes, échéances, passage engendré en brouillon, itinéraire ordonné par recherche de tronçons), `/exploitation/info-route` (publication, mise à jour, retrait depuis un événement pris en compte, journal, génération et téléchargement des bulletins), `/veille/configuration` (mode motivé, règles d'escalade, astreintes ; ADMIN et GESTIONNAIRE). **Aucune valeur préremplie** : périodicité et délai vides, boutons inactifs tant qu'ils ne sont pas saisis ; aucun champ de niveau P1–P4. Deux routes de lecture ajoutées : `GET /exploitation/referentiels` (types, sources) et `GET /exploitation/veille/personnes` (nom et rôle, jamais le courriel ; ADMIN/GESTIONNAIRE). Tests : 7 écrans + 2 routes, `tsc` propre des deux côtés. Suites complètes **non relancées** sous la charge du poste ; vérification navigateur impossible (pas de `.env` local) |
| T-17 | Observation de la Terre, palier 0 : registre et propositions (partie E, A30) | 14 | `VERIFIED` | migration `20261020000000` : `earth_observation_products` (licence, provenance, incertitude, version de traitement **obligatoires en base** ; couverture nuageuse pour l'optique ; référence d'autorisation de dépense pour les paliers 1 à 3), `propositions_teledetection` **figées à l'insertion** (déclencheur), verdict du terrain unique citant son constat, vue `precision_teledetection` **nulle sans verdict**. Rattachement au tronçon le plus proche **seulement si une tolérance est donnée**. Banc SQL 15 assertions (un défaut de **mon** banc trouvé : la base de rejeu n'a aucun tronçon, l'essai passait pour une contre-épreuve), descente aller-retour, aucun écart schéma/base. Noyau 19 tests, routes 12 tests, écran `/teledetection` 3 tests, compteur « alertes satellite » sur la vue murale. Épreuve contre `replay` : point à 11,1 m rattaché à 50 m, point à ~555 m non. `EARTH_OBSERVATION_PLAN.md` écrit. **Rien téléchargé, aucun traitement, aucune dépense** ; licences non écrites de mémoire, à relever à la source ; moteur de changement absent |
| T-18 | Métré en projection UTM (§ 7.1, A5) | 2 | `VERIFIED` | migration `20261020010000` : `epsg_utm(geom)` (28N à l'ouest de 12° O, 29N au-delà, au point intérieur ; sud en 327xx) et `metre_utm(geom)` (longueur, surface, contrôle géodésique, écart relatif). Banc 12 assertions sur géométries **connues** : carrés de 100 m construits en 28N et 29N → 10 000,000 m², ligne de 1 km → 1 000,000 m, écart à l'ellipsoïde 0,04–0,18 %. `POST /api/v2/geo/metre` (4 tests) : invalide refusée avec sa raison, illisible en 400. Descente aller-retour |
| T-19 | Index GiST sur toutes les colonnes géométriques (§ 7.1) | 1 | `VERIFIED` | constat : **6 colonnes sans aucun index GiST** (chantiers, missions.itineraire, ouvrages, points_noirs, postes, propositions_localisation). Migration `20261020020000` : index sur `(geom::geography)`, la forme que le dépôt interroge — la mesure du 14/10 sur `troncons` avait montré qu'un index planaire y est ignoré (151 ms contre 19,6 ms). Emploi par le planificateur **vérifié** (`Index Scan using ouvrages_geom_geography_gist`). Garde-fou `index_gist.test.sql` : échoue avant (nomme les 6), passe après (21/21). Gain **non mesuré** (aucune donnée locale) ; vérifier avant déploiement qu'aucun index équivalent n'existe déjà en production sous un autre nom |
| T-20 | Graphe du réseau pour le HMM de trace (§ 7.3.7) | 3 | `VERIFIED` | `geo/graphe.noyau.ts`, pur : fusion des extrémités à **tolérance obligatoire** (aucune supposée), **jonctions en T** (une extrémité sur l'intérieur d'un autre tronçon le coupe), arcs pondérés par la longueur mesurée, Dijkstra borné avec cache par nœud ; non orienté (aucun sens unique au référentiel) ; un croisement sans jonction n'est pas un carrefour. 13 tests, dont **l'épreuve décisive** : les distances écrites à la main du jeu annoté remplacées par le graphe construit depuis la géométrie → **130/130 et 8 ruptures sur 8, 0 transition non vérifiée**. `geo/graphe.depot.ts` charge l'emprise en `geography` ; éprouvé contre `replay` (jonction à 548,4 m, distance 1 048,4 m exacte, tronçon supprimé et route isolée → `null`). **Reste** : aucune route n'expose encore l'appariement de trace (il attend le mobile, B-10) ; la tolérance de fusion réelle se mesurera sur le référentiel |
| T-21 | Lint et accessibilité (B-29, § 7.11) | 10 | `VERIFIED` | **autorisation du 20/10** d'ajouter des dépendances de développement. Versions vérifiées sur npm, installées exactes : eslint 9.39.5 (pas 10 : jsx-a11y 6.10.2 ne l'accepte pas), typescript-eslint 8.72.0, react-hooks 7.1.1, jsx-a11y 6.10.2, axe-core 4.14.0 (MPL-2.0, tests seulement), globals 17.13.0 ; **aucune dépendance existante modifiée** (contrôle du fichier de verrouillage). Lint : 60 erreurs → 0 — 45 libellés associés à leur champ (`htmlFor`/`id`, unicité contrôlée), tiroir mobile fermable au clavier (Échap), code 2FA pourvu d'un nom accessible, `case` délimités, deux ternaires réécrits ; 4 avertissements `exhaustive-deps` **laissés à dessein** (changer les dépendances change le comportement). Lint ajouté à la CI. Mesure axe-core WCAG 2.1 A/AA sur 8 écrans : **0 violation**, contre-épreuve qui détecte `image-alt`, `label`, `button-name`. Contraste **non mesuré** (jsdom) |
| T-15 | **Défaut d'EX-01 trouvé par T-14** : ordre du journal à heure égale | 12 | `VERIFIED` | la vue retenait le dernier statut par heure puis **uuid aléatoire** : à heure serveur égale, une déclaration OUVERT pouvait passer pour plus récente que son PRIS_EN_COMPTE (un événement pris en compte a été escaladé). Migration `20261019030000` : `rang BIGSERIAL` sur `main_courante`, vue et service ordonnés par lui. Banc : **7 événements sur 20 faux avant, 20 sur 20 après**. Descente aller-retour. Écarts schéma/base préexistants d'EX-01 relevés (comportement `ON DELETE` de quatre clés, index GiST, un nom d'index) : sans effet sur `migrate deploy`, non corrigés |

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
5. `prisma migrate status` : 50 appliquées, 17 en attente, 0 orpheline ;
6. les dix-sept descentes des migrations en attente présentes dans `backend/prisma/descentes/` ;
7. `git diff --name-status main...HEAD | grep ^D` vide ;
8. empreintes des deux `.env` relevées avant et après.
9. `\di+` sur chantiers, missions, ouvrages, points_noirs, postes, propositions_localisation : aucun index GiST équivalent sous un autre nom (sinon, doublon créé par `20261020020000`).

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
- **Docker** : relancé le 19/10 ; base `replay` intacte, les neuf bancs SQL y passent.
- **Charge du poste** : une autre session Claude (projet `F:\BTP-project…`) fait tourner ses suites
  en parallèle ; 730 Mo libres observés, `tsc` backend à 454 s au lieu de moins d'une minute. Ses
  processus n'ont pas été touchés.

## 5. Prochaine action

Exécutables sans accès externe, dans cet ordre : **calcul d'itinéraire de déviation** sur le graphe
(T-20), **permaliens** de la carte, **curseur temporel** sur la bitemporalité, puis **scripts de
descente** des 50 migrations déjà appliquées (A26). Décisions attendues : D-11 (validation du
patrimoine existant), sources d'imagerie (partie E), GeoPackage (attendre, choix du 20/10).

**T-10 reste `BLOCKED`** : `sshd` ne répond plus sur le serveur applicatif (intervention console
requise, voir T-10). Ensuite : CI jamais exécutée (facturation GitHub), `chkdsk F: /f`, et le choix
de déployer la branche telle quelle ou de fusionner d'abord.

## 6. Instruction de reprise

Relire ce fichier, `PROJECT_STATUS.md` § 7 et `BLOCKERS.md`. Vérifier `git status` et le dernier
commit poussé. Reprendre à la tâche `IN_PROGRESS` du § 2, ou à la première `TODO` si aucune. Ne
pas refaire un audit déjà consigné : le mettre à jour.
