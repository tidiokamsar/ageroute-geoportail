# Lot T1 : territoires hiérarchiques, référentiels configurables, configuration nationale

Rapport du 09/11/2026. Branche `feat/territoires-referentiels` (issue de `feat/vague2-integration`, `cfe8e4e`). Backend, documentation, graine de démonstration. **Aucun push, aucun déploiement, aucun fichier frontend.** Contrat : `docs/projets-voirie/CONTRAT-TERRITOIRES.md` (écrit et commité en premier, `d09ef87`). Migration : `20261103100000_territoires_referentiels`.

## A. Agents et déroulement

Un seul agent (deux reprises après une limite d'usage). Le client Prisma `node_modules` est **partagé** (jonction vers `w-pv`) : `npx prisma generate` a été lancé depuis ce worktree après chaque changement de schéma, et **le client a été écrasé au moins quatre fois** par un autre worktree pendant le lot (un schéma qui porte le lot S1 : colonne `methodeAcquisition`). Les bancs de non-régression ont donc été rejoués avec une régénération avant chaque banc et une comparaison de l'empreinte du client après (section F). **À relancer avant tout `tsc`, test ou banc de cette branche** si `TerritoireVoirie` manque dans `node_modules/.prisma/client/index.d.ts`.

## B. Ce qui est livré

| Chemin | Rôle |
|---|---|
| `backend/prisma/migrations/20261103100000_territoires_referentiels/`, `descentes/20261103100000_territoires_referentiels.sql`, `schema.prisma` | 3 tables + 3 historiques (ajout seul), 2 types, 4 colonnes du socle, déclencheurs (chemin matérialisé, profondeur, région effective calculée et propagée, parent/niveau/code immuables, cohérence des niveaux, codes de référentiel vérifiés, suppression physique et TRUNCATE refusés), données (nation, chaîne du pilote avec emprise approximative, territoire des projets existants, 19 valeurs de référentiel, 4 clés de configuration) |
| `backend/src/projets-voirie/territoires/` | noyaux purs (`hierarchie`, `referentiels`, `configuration`), cache de configuration, services (territoires, référentiels, configuration), contexte spatial du projet, vues |
| `backend/src/api-v2/projets-voirie.territoires.routes.ts` | 15 routes (`/territoires`, `/referentiels/:domaine`, `/configuration`) |
| Fichiers partagés modifiés (au minimum) | `projets-voirie.routes.ts` (montage, `territoireId` obligatoire, filtre de liste, `typeReseauCode`), `projets.service.ts`, `import.service.ts`, `formats/apercu.service.ts`, `formats/lecture-import.noyau.ts`, `formats/import.config.ts`, `config.ts`, `collecteur.noyau.ts`, `lecture.types.ts`, `analyse.service.ts`, `analyse.noyau.ts` (commentaire), `conflits/analyse-conflits.service.ts`, `reseaux/associations.service.ts`, `vues.ts`, `projets-voirie.import.routes.ts`, `lib/access.ts` (3 types d'entité d'audit) |
| `backend/scripts/graine-demo-territoires.ts` | graine de démonstration (7 villes DEMO), jamais en migration |
| Tests | 3 fichiers de noyaux, 1 de routes, inventaire des accès, isolation ; 4 tests existants adaptés (section E) |
| `backend/tests-integration/territoires-referentiels.integration.mts`, `lib/territoire-par-defaut.mts` | banc PostGIS du lot ; enveloppe des six bancs antérieurs (territoire par défaut) |
| Documentation | `CONTRAT-TERRITOIRES.md`, `API.md` (section T1), `docs/securite/CONTROLE-ACCES.md` (15 routes + routes du socle modifiées), README des bancs, `run.sh` ; section « Précisions T1 » ajoutée à `mandat/DECISION-ARCHITECTURALE-2.md` (ajout seul, hors worktree, autorisé par le mandat) |

**Aucun nom de ville dans la logique métier** : les seuls noms de lieux sont dans la migration (nation, Faranah, Kissidougou), la graine (`DEMO`) et les données synthétiques des tests. Les seules valeurs géographiques du code sont les **défauts** historiques (`BBOX_GUINEE`, bandes -12 / 32628 / 32629, liste blanche 4326/32628/32629), conservés pour que rien ne change tant que rien n'est administré.

## C. Décisions prises (hors contrat initial, documentées)

1. **Région effective** : calculée par la base (sa région, sinon celle du plus proche ancêtre), propagée aux descendants ; c'est elle qui décide de la visibilité. La nation (sans région) n'est visible que des comptes nationaux.
2. **Un niveau peut être sauté** (commune sous une région) ; parent de rang strictement inférieur ; parent, niveau et code **immuables** (on crée un autre territoire).
3. **Projet linéaire** (précision du coordinateur) : corridor de niveau `ZONE` sous la région, emprise couvrant plusieurs préfectures (sœurs dans l'arbre, pas filles) ; plusieurs projets de largeurs différentes dans le même corridor ; `commune`/`prefecture` restent nulles. Corridor interrégional : sous la nation, comptes nationaux seulement (**à confirmer**).
4. **Plausibilité à deux niveaux** : l'emprise **nationale** configurée écarte (codes historiques `ELEMENTS_HORS_GUINEE`/`HORS_GUINEE` conservés, messages génériques) ; l'emprise du **territoire** (approximative) ne fait que signaler (`ELEMENTS_HORS_TERRITOIRE`, objet conservé) et devient `zoneAttendue`.
5. **CRS** : le CRS imposé par le territoire (ou son plus proche ancêtre) l'emporte sur les bandes, s'il est dans la liste blanche effective (sinon ignoré ; l'écriture le refuse en amont). Les bandes et la liste blanche se contrôlent mutuellement (on ne retire pas de la liste un CRS utilisé par les bandes).
6. **Cache de configuration** : 30 s par processus (`PROJETS_VOIRIE_CONFIG_CACHE_MS`), invalidé à l'écriture dans le même processus ; les lecteurs synchrones de `config.ts` lisent la dernière valeur chargée, les services asynchrones rafraîchissent avant calcul. Une autre instance voit le changement au plus tard à l'expiration de sa fenêtre.
7. **Création d'un projet par un compte régional sans `regionId`** : la garde 403 vérifie la région effective du territoire ; une région du corps différente de celle du territoire est refusée (400) ; un déplacement de territoire ne change jamais la région du projet.
8. **Écriture des référentiels et de la configuration** : ADMIN seul, chaque écriture vaut approbation (version, `approuvePar`, historique, audit), **sans séparation des tâches à deux personnes** (à décider, section I).
9. **Migration des projets existants** : commune retrouvée par le nom (sans accents ni casse) ou créée (`MIG-COM-…`), sous la préfecture retrouvée ou créée (`MIG-PREF-…`, rattachée à la nation) ; sinon `NON_RENSEIGNE` (ZONE sous la nation). Au rejeu, la région du pilote est rattachée à la `Region` « Faranah » si elle est apparue entre-temps (seulement une ligne de la migration).
10. **Bancs antérieurs** : plutôt que réécrire des dizaines d'appels, une enveloppe (`lib/territoire-par-defaut.mts`) ajoute un territoire par défaut aux créations de projet ; deux listes d'isolation acceptent désormais `territoires_voirie` (table du module).

## D. Ce que la migration crée (vérifié sur base PostGIS)

Nation `GN` ; `GN-REG-FARANAH` > `GN-PREF-KISSIDOUGOU` > `GN-COM-KISSIDOUGOU` (emprise approximative, rectangle d'environ 13 km) ; rien d'autre hormis les territoires dérivés des projets existants. Essai sur trois projets fabriqués (commune et préfecture connues, inconnues, absentes) : rattachés respectivement au pilote, à `MIG-COM-VILLE-X` sous `MIG-PREF-PREF-Y`, et à `NON_RENSEIGNE`. Deux montées successives : idempotentes. Déclencheurs éprouvés en SQL : niveau incompatible, immuabilité, suppression physique, historique, code de catégorie inconnu, famille de type inconnue, largeurs incohérentes, propagation de la région.

## E. Tests existants modifiés, et pourquoi

- `api-v2/projets-voirie.routes.test.ts` : deux tests de création portent désormais un `territoireId` (sinon 400 `TERRITOIRE_REQUIS`, voulu) ; un cas `territoireId` mal formé ajouté ; aucune assertion retirée.
- `api-v2/projets-voirie.import.routes.test.ts` et `projets-voirie.gdal.routes.test.ts` : `GET /:id/import/options` lit le contexte spatial ; ces tests simulent la base, ils simulent aussi le contexte (national par défaut). 4 tests en échec dans la suite complète avant cette correction. Aucune assertion modifiée.
- `securite/inventaire-acces.test.ts` (15 routes, gardes ADMIN, 404 masqué sur `:tid`, exceptions territoriales motivées) ; `projets-voirie/isolation.test.ts` (6 tables, 6 délégués, routeur T1).
- Six bancs PostGIS : enveloppe du territoire par défaut ; `projets-voirie` et `import-formats` : `territoires_voirie` dans la liste d'isolation.

## F. Résultats mesurés (09/11/2026, poste partagé avec d'autres agents, Docker Desktop)

Base de test : conteneur jetable `t1-postgis` (`postgis/postgis:17-3.5`, port 5478), base `replay` reconstruite par les 101 migrations de la branche (pont de dérive appliqué après `20260702110000`) ; supprimé à la fin. `bdri-dev-db` n'a pas été touché.

| Contrôle | Résultat |
|---|---|
| `npx tsc --noEmit` | **0 erreur** (final, client régénéré juste avant et vérifié inchangé après) |
| Suite backend complète `npx vitest run` | **6 581 passés, 1 échec, 1 ignoré sur 6 583 ; 314 fichiers sur 315** (331 s). Le seul échec est un test de **durée** (`formats/charge.test.ts`, 40 000 lignes CSV en moins de 4 s : mesuré 4,9 s sur le poste saturé) ; **rejoué seul : 13/13, 1,49 s**. Un passage précédent (1 076 s) avait révélé 4 vrais échecs dus au lot (`GET /import/options` dans deux tests de routes), corrigés (`66500c0`) |
| Tests du lot | noyaux : hiérarchie 13, référentiels 11, configuration 18 ; routes T1 16 ; socle 51 ; inventaire des accès 21 ; isolation 9 (tous verts) |
| Banc PostGIS `territoires-referentiels` | **78/78** (premier passage, puis rejoué dans la non-régression : 78/78) |
| Descente `verifier.sh --seulement 20261103100000_territoires_referentiels` | **8/8** (schéma identique après descente, aller-retour, trois gardes : refus puis passage autorisé). Premier passage 6/7 : ma donnée de test de la garde 1 violait la contrainte « nation = racine » (corrigé, `ecc6e09`) |
| Migration en SQL (clone, projets fabriqués) | montée, seconde montée idempotente, descente, remontée ; 8 refus de déclencheurs vérifiés ; propagation de la région effective |
| Non-régression (migration T1 dans `replay`, enveloppe du territoire par défaut) | `projets-voirie` **141/141** ; `conflits-projets-voirie` **169/169** ; `reseau-physique-logique` **130/130** ; `workflow-roles` **132/132** ; `gdal-jobs` **92/92** (vrai conteneur `ageroute-geoconv:0.2.0`) ; `import-formats` **88/89** : seul échec, l'attente `415 FORMAT_NON_SUPPORTE` d'une archive de Shapefile, **préexistante** (le lot B2 rend `FORMAT_GDAL_DESACTIVE`, statut 415 inchangé) |
| Premiers passages de non-régression (non probants) | client Prisma écrasé par un autre worktree pendant les bancs (500 « colonne `methodeAcquisition` inexistante ») ; puis une analyse coupée à 20 s (504) sur poste saturé dans le banc des conflits ; puis deux défauts de mon enveloppe (région inexistante, listes d'isolation), corrigés (`5f891d7`) avant le rejeu ci-dessus |
| Graine de démonstration | refus sans `GRAINE_DEMO=OUI`, refus sous `NODE_ENV=production` ; 1er passage 20 territoires créés (7 communes avec emprise), 2e passage 0 (rejouable) ; région du pilote réutilisée |
| Mutations des gardes (8, une à la fois, fichier restauré par Git) | **8 sur 8 détectées** : M1 filtre de périmètre des territoires (banc 7 échecs) ; M2 cohérence région projet/territoire (8) ; M3 CRS imposé ignoré (6) ; M4 garde 404 de la fiche de territoire retirée (banc 7, unitaires 3) ; M5 protection en base ignorée par `config.ts` (banc 6, unitaires 1) ; M6 bandes remplacées par une constante (banc 6, unitaires 1) ; M7 écriture des territoires ouverte au GESTIONNAIRE (banc 6, unitaires 2) ; M8 emprise du territoire ignorée à la lecture (banc 6) |
| Durées | banc T1 47 à 75 s ; analyse 2D du corridor (axe de plus de 150 km, un réseau) sous la seconde ; rien de volumineux mesuré |

Le scénario « nouvelle ville sans code » est couvert par les sections 2 à 8 du banc ; le corridor linéaire (fixture synthétique) par la section 10 : ZONE sous la région couvrant trois préfectures (`ST_Covers`), deux projets de largeurs 40/21 et 30/14, axe de plus de 150 km, un croisement, EPSG:32629, liste filtrée par le corridor = ces deux projets, comptes du corridor = 2.

## G. Sécurité

- Lecture : clé de module ; territoires filtrés par la région effective (liste, comptes) ; 404 identique (inexistant, retiré, hors périmètre) sur un territoire désigné ; agrégats seulement dans les comptes, jeux non autorisés exclus pour un lecteur, jeu retiré jamais compté.
- Écriture : ADMIN seul (garde de route, prouvée par l'inventaire et par mutation M7), auditée dans la même transaction, historique en ajout seul (déclencheurs). L'emprise n'entre jamais dans l'audit ni l'historique (boîte englobante et MD5 ; vérifié par le banc).
- Entrées : corps `strict`, codes en majuscules par motif, emprise GeoJSON bornée (10 000 sommets, WGS 84, anneaux fermés) puis validée par PostGIS (422) ; CRS dans la liste blanche et connus de `spatial_ref_sys` ; valeur de configuration validée par schéma, valeur illisible en base = défaut (jamais une panne).
- Périmètre : la région d'un projet ne se contourne pas par un territoire (400), ni par un déplacement.

## H. Erreurs connues, limites, risques

1. **L'interface actuelle crée des projets sans `territoireId`** : elle recevra 400 `TERRITOIRE_REQUIS` tant que le lot UI-C n'est pas livré (exigence du mandat, conséquence assumée).
2. Les emprises sont **approximatives** (rectangles) : la plausibilité par territoire est un test de boîte englobante côté lecture ; `ST_Covers` n'est utilisé que pour l'avertissement de contenance.
3. La graine écrit sans audit (script sans compte, comme `prisma/seed.ts`) ; la descente ne protège pas ses lignes par sa garde.
4. Plusieurs instances : une configuration écrite sur une instance n'est vue des autres qu'à l'expiration de leur cache (30 s par défaut).
5. Constat hors lot : le banc `import-formats` attend encore `415 FORMAT_NON_SUPPORTE` pour une archive de Shapefile, alors que le lot B2 rend `415 FORMAT_GDAL_DESACTIVE` (commit `c58f7cf`) : échec préexistant, non corrigé ici (banc d'un autre lot).
6. Le client Prisma partagé rend toute mesure fragile tant que plusieurs worktrees régénèrent des schémas différents (section A).

## I. Décisions à prendre par le DSI

1. Corridor **interrégional** : sous la nation (comptes nationaux seulement, choix actuel) ou rattachement à plusieurs régions (exigerait un modèle de périmètre multi-régions).
2. Séparation des tâches pour les référentiels et la configuration (brouillon puis approbation par un second ADMIN, comme les règles de conflit) : non faite.
3. Règles de conflit par territoire (décision 2, section 1) : non faites dans T1.
4. Précision typique des méthodes d'acquisition, couleurs et libellés définitifs : à renseigner par l'administration (aucune valeur inventée).
5. Rapprochement des territoires avec `limites_administratives` (limites officielles) et import des territoires réels.
6. Validation des emprises du pilote et des corridors réels (aucune donnée réelle dans ce lot).

## J. Non exécuté

Lint, build, frontend (hors périmètre), déploiement, bancs d'intégration hors module, volumétrie (milliers de territoires), données réelles.

## K. Commits

Au-dessus de `cfe8e4e` (`feat/vague2-integration`), dans l'ordre :

- `d09ef87c8067060a720e69cc660af76023d7590d` contrat des territoires (commité en premier)
- `9761b4672ef5496162142e254ad1ad55c9de163d` migration, descente, schéma Prisma
- `98496cd73cf9a72299c063e92085078ec8ba0a0b` services et routes
- `d2aedfe83ec44ca6a5a1bb8c6387ad9fa0cdc527` tests des noyaux, routes, inventaire, isolation
- `ecc6e099d366c3f7c8279be3d01429160097c5ce` rattachement idempotent de la région du pilote, donnée de garde de la descente
- `f3e077d39a86e8a5edbe615d1f78f08d4320747c` banc PostGIS et enveloppe des bancs existants
- `5c7fabe2e79fc7458c281acdcc48abb990da8c11` graine de démonstration
- `991472e45fdc52e7c3fba6d877877256582da767` documentation (contrôle d'accès, API, contrat)
- `66500c0a4d6ec5b7ab0c7501136368483d74a417` contexte spatial simulé dans deux tests de routes
- `5f891d73992817ef72c45d3254f12b8a39b64ad6` enveloppe (région inexistante) et listes d'isolation
- ce rapport (commit suivant)

Aucun push.
