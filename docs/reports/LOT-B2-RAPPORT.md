# Lot B2 : branchement de la chaîne de conversion GDAL isolée (GeoPackage, Shapefile ZIP, DXF), asynchrone, derrière un interrupteur désactivé par défaut

Rapport du 08/11/2026. Branche `feat/gdal-branche` (issue de `feat/vague1-integration`, fusion de `feat/vague1-final`). Backend uniquement. **Préproduction seulement : rien n'est activé ni déployé en production** ; `docker-compose.yml`, nginx, `backend/Dockerfile` et `infra/deployer-console.sh` ne sont pas touchés. Documents : `docs/projets-voirie/CONTRAT-IMPORT.md` (sections 13 et 14), `API.md` (section « Conversion GDAL asynchrone »), `CHAINE-GDAL.md`, `MATRICE-FORMATS.md`, `docs/securite/CONTROLE-ACCES.md`.

## A. Agents et déroulement

Un agent principal, plus un fork pour le côté Python du worker (pré-filtre DXF, banc du worker, image 0.2.0). Le travail a été interrompu deux fois par des coupures réseau ; un commit WIP non vérifié (`fd516bc`) avait été fait entre-temps. Tout ce qui est décrit ici a été relu, complété et exécuté depuis ; le WIP est remplacé par de vrais commits (section K). Le client Prisma `node_modules` est partagé entre worktrees : `npx prisma generate` a été lancé depuis ce worktree (schéma changé) et **a dû être relancé plusieurs fois** parce qu'un autre worktree l'écrasait avec un schéma sans le modèle `JobImportProjet` ; à relancer avant tout `tsc` ou test si `JobImportProjet` manque dans `node_modules/.prisma/client/index.d.ts`.

## B. Écart entre l'existant et ce qu'il fallait (audit)

Existant à l'entrée : un conteneur GDAL testé en banc (71 jobs, 23 contrôles d'isolement), un protocole de spool par fichiers, aucun appel depuis le backend, GeoPackage, Shapefile et DXF répondant 415. Manquait : table de jobs et machine à états, dépôt dans le spool, sondage, validation de la sortie du conteneur, entrée de ce résultat dans le pipeline (quarantaine, CRS, mapping, delta, revue), interrupteur, plafonds et cadence, annulation, relance, expiration, nettoyage, routes, contrôle d'accès, preuves de bout en bout. Constat qui a changé la conception du DXF : le pilote GDAL expose tout dans une couche `entities` ; ARC, CIRCLE et blocs insérés ressortent en `LINESTRING`, TEXT en `POINT`, HATCH en `POLYGON`, et `SubClasses` n'existe que si le fichier porte des marqueurs 100 (mesuré). Les « entités supportées, le reste ignoré et compté » ne pouvaient donc pas être tenues en aval de GDAL : le tri est fait **dans le worker, avant GDAL** (fork, commit `1a7505a`).

## C. Ce qui est livré

| Chemin | Rôle |
|---|---|
| `backend/prisma/migrations/20261102200000_import_jobs_gdal/`, `descentes/20261102200000_import_jobs_gdal.sql`, `schema.prisma` | table `projets_voirie_import_jobs`, type `StatutJobImportProjet`, valeurs `GPKG`, `SHAPEFILE`, `DXF` de `FormatJeuProjet`, déclencheurs (machine à états, aucune suppression), contraintes, index unique partiel |
| `backend/src/projets-voirie/gdal/` (`config.ts`, `contrat.noyau.ts`, `format.noyau.ts`, `sortie.noyau.ts`, `conversion.noyau.ts`, `spool.ts`, `jobs.service.ts`, `traiteur.ts`, `formats.registre.ts`, `fixtures.gdal.ts` et sept fichiers de tests) | interrupteur et réglages, états et codes, détection par le contenu, validation stricte de la sortie, assemblage, protocole de spool, jobs, sondage, registre des formats |
| `backend/src/api-v2/projets-voirie.gdal.routes.ts` (+ test) | quatre routes de jobs |
| Modifications minimales de fichiers partagés | `lecture-import.noyau.ts` (entrée `detecterConvertie`, crochet synchrone, inventaire converti), `crs.noyau.ts` (`choisirCrsConverti`), `apercu.service.ts` et `import.service.ts` (champ `conversion`, crochet `apresDepot`), `projets-voirie.import.routes.ts` et `projets-voirie.routes.ts` (`jobId`, options, montage), `lecture.types.ts` (formats et codes), `server.ts` (démarrage du sondage seulement si actif) |
| `infra/geoconv/` (fork) | `worker/dxf.py` (pré-filtre), worker 0.2.0, image `ageroute-geoconv:0.2.0`, banc 85 jobs |
| `backend/tests-integration/gdal-jobs.integration.mts` (+ ligne du README) | banc PostGIS et conteneur réel |

## D. Décisions de conception (hors contrat, à relire)

- **Sondage borné et non `backend/src/jobs`** : ce dossier ne contient que deux planificateurs `setTimeout` périodiques (pas de file, de reprise ni de réclamation atomique). Le sondage est un `setInterval` unique, `unref`, créé seulement si `PROJETS_VOIRIE_GDAL` est actif, un tour à la fois, bornes par tour ; l'état est entièrement en base (`FOR UPDATE SKIP LOCKED`, comparaison et échange sur chaque transition).
- **Ordre de dépôt** : ligne en base d'abord, fichier dans le spool ensuite, sans `demande.json` ; le sondage publie `demande.json` en dernier quand une place se libère (le protocole du conteneur ne traite rien sans lui).
- **Un dossier de spool par tentative** (`<uuid>-t<n>`) ; une relance copie le fichier dans un nouveau dossier.
- **Le dossier de sortie d'un job n'est jamais supprimé tant que le conteneur y écrit encore** (statut `en_cours`), sauf échéance : lu dans le code du worker, retirer le répertoire sous un job en cours ferait échouer l'écriture du statut.
- **CRS** : Shapefile et DXF exigent `epsgSource` à la création (échec rapide, aucun job) ; GeoPackage suit la règle du GeoJSON (4326 déclaré admis, projeté déclaré à confirmer, identique) ; un CRS déclaré ne se surcharge pas (le worker n'est jamais appelé avec `autoriser_surcharge_crs`) ; conséquence assumée : un `.prj` sans code EPSG identifiable donne `CRS_CONFLIT` si l'utilisateur confirme un EPSG ; contournement : retirer le `.prj` de l'archive.
- **Unités DXF** : `metre` ou `degre`, contrôlées contre le CRS et `$INSUNITS` ; aucune mise à l'échelle (un DXF en millimètres est refusé, pas converti).
- **DXF binaire** : refusé (le pré-filtre ne le lit pas ; il était accepté par le worker 0.1.0, sur un seul fichier minimal).
- **Correction de ma propre règle après mesure** : j'exigeais un membre `crs` dans le GeoJSON d'un résultat WGS 84 ; le banc a montré que GDAL n'en écrit aucun quand la source est déjà EPSG:4326. La règle est : membre absent ou CRS84, jamais un autre ; le CRS explicite est celui de `resultat.json` (`crs`, `crsSource`).
- **Contrôle de cohérence avant toute lecture de couche** (le banc a montré que l'ordre inverse donnait `SORTIE_INVALIDE` au lieu de `SORTIE_INCOHERENTE` pour un conteneur qui a traité un autre fichier).
- Le fichier d'origine n'est jamais conservé pour un jeu issu d'une conversion (`EMPREINTE_SEULE`), même si `PROJETS_VOIRIE_CONSERVER_ORIGINAL=oui`.
- Tests existants modifiés parce que leur attente change : 3 attentes de `lecture-import.noyau.test.ts` (DXF et ZIP de Shapefile : `FORMAT_GDAL_DESACTIVE` au lieu de `FORMAT_NON_SUPPORTE`), 1 de `projets-voirie.import.routes.test.ts` (`nonSupportes` ne contient plus que DWG), `isolation.test.ts` et `inventaire-acces.test.ts` (nouvelles tables, routes et fichiers).

## E. Formats : ce qui est annoncé « supporté » et pourquoi

L'API annonce `SUPPORTE` seulement si l'interrupteur est actif, le dossier d'échange accessible **et** une preuve de bout en bout est citée (`TESTS_REELS`, vérifiée par un test unitaire qui relit le banc). Chaque preuve ci-dessous est une vérification du banc `gdal-jobs.integration.mts`, exécutée contre le **vrai conteneur** avec des fichiers synthétiques fabriqués par le banc :

- **GeoPackage** (`E2E GPKG`) : job, conteneur, aperçu, simulation, dépôt réel (jeu `CONTROLE` de format `GPKG`), coordonnées reprojetées comparées à `ST_Transform` de PostGIS à 2e-7 degré, longueur comparée à un oracle SQL géographique à 0,05 %, deux couches de CRS différents (`CRS_MULTIPLES`), GeoPackage en WGS 84, idempotence (`JEU_DEJA_CHARGE`), audit sans géométrie.
- **Shapefile ZIP** (`E2E SHAPEFILE`) : `epsgSource` obligatoire, `.prj` non confirmant, `CRS_CONFLIT`, sans `.prj`, archive incomplète, zip-slip, dépôt réel.
- **DXF** (`E2E DXF`) : CRS et unités obligatoires, conflits d'unités, DXF binaire refusé, HTML nommé `.dxf` refusé, entités retenues (LINE 2, LWPOLYLINE 1, POLYLINE 1, 3DPOLYLINE 1) et ignorées comptées (ARC, CIRCLE, HATCH, INSERT, MTEXT, POINT, TEXT : 1 chacune), 1 bloc, calques AXES et RESEAU comme couches, dépôt d'un calque.

**Non testé** : fichiers réels d'AutoCAD, Covadis, ArcGIS ou QGIS (aucun) ; DXF en d'autres encodages que cp1252 et UTF-8 par défaut ; splines ajustées ; Shapefile avec plusieurs jeux dans une archive, encodages `.cpg`, polygones, M et Z ; GeoPackage avec polygones, courbes, 3D ; volumétrie réelle (le banc va jusqu'à des fichiers de quelques centaines d'octets pour le chemin API ; le banc du worker, 60 000 objets). Reprojection vérifiée pour EPSG:32629 vers WGS 84 seulement.

## F. Résultats mesurés (08/11/2026, poste de développement, Docker Desktop)

| Contrôle | Résultat |
|---|---|
| `npx tsc --noEmit` | **0 erreur** (sortie 0 ; 81 min sur un poste saturé par les bancs et les suites lancés en parallèle) |
| Suite backend complète `npx vitest run` | **6 486 tests passés, 1 échec, 1 ignoré sur 6 488 ; 308 fichiers passés sur 311**. Les trois fichiers en échec sont des artefacts de charge (le passage a duré 5 119 s sur un poste saturé) : un test de durée (`csv.noyau.test.ts`, 100 000 sommets en moins de 3 s : mesuré à 5,2 s sous charge) et deux fichiers dont le worker vitest a expiré au chargement (`depot-sans-secret.test.ts`, `delegations.routes.test.ts`). **Relancés seuls : 3 fichiers sur 3, 67 tests sur 67 passés.** Aucun de ces fichiers ne touche au lot |
| Tests unitaires du lot (`src/projets-voirie/gdal/` et routes) | 105 tests sur 7 fichiers (1 ignoré : lien symbolique de fichier, droit refusé sous Windows ; le test de jonction couches/ est exécuté) + 15 tests de routes |
| Banc PostGIS et conteneur réel `gdal-jobs.integration.mts` | **92 vérifications sur 92** (clone `essai_gdal_jobs`, conteneur `ageroute-geoconv:0.2.0` avec les options du compose de préproduction, durée environ 6 minutes) ; passages précédents : 53/65, 58/65, 71/74 (défauts corrigés, voir D) |
| Banc du conteneur `infra/geoconv/tests/lancer-tests.sh` (fork) | 85 jobs conformes sur 85 (dont 14 DXF), 23 contrôles d'isolement sur 23, arrêt propre ; pic mémoire du conteneur 1 002 Mio (cas m29 déjà à la limite en 0.1.0) |
| Descente `verifier.sh --seulement 20261102200000_import_jobs_gdal` (base PostGIS `postgis/postgis:17-3.5`, port 5475, 100 migrations rejouées avec le pont de dérive) | **6 vérifications sur 6** : schéma identique après descente, aller-retour, garde des jobs (refuse, passe avec autorisation), garde des jeux `GPKG` (refuse même avec autorisation). Un premier passage a échoué (5/6) : la descente autorisée retirait le type avant la table des jobs ; ordre corrigé |
| Mutation des gardes (11) | **11 sur 11 tuées** : schéma de géométrie, cohérence empreinte et taille, CRS du `.prj`, chemin réel du spool, bornage des relances, machine à états, archive hostile, Shapefile incomplet, unités DXF, interrupteur, garde de rôle de la route de création (1 à 2 tests en échec chacune) |

Ce que le banc prouve en plus des formats : interrupteur coupé (3 formats `INDISPONIBLE`, 415 `FORMAT_GDAL_DESACTIVE`, 503 `GDAL_DESACTIVE`, le dossier d'échange inexistant n'est jamais créé ni lu, le sondage ne fait rien) ; plafonds (409 `JOB_DEJA_EN_COURS`, 429 `PLAFOND_JOBS_COMPTE` et `PLAFOND_JOBS_PROJET` avec `Retry-After`, cadence 3 par heure) ; concurrence 2 transmis puis 1 en attente ; annulation (EN_ATTENTE et EN_COURS, seconde annulation 409) ; relance contrôlée (nouveaux dossiers `-t2`, `-t3`, puis `JOB_PERDU`) ; expiration (fichiers retirés) ; reprise après arrêt du conteneur ; sortie hostile (autre fichier, géométrie hors contrat, clé inconnue avec chemin, code inconnu avec texte libre, statut illisible, fichier de couche modifié après validation : `RESULTAT_ALTERE`) ; versions et suppressions via le pipeline commun (delta, `SUPPRESSIONS_A_REVOIR`, retrait de la v1 refusé tant que la v2 attend (M1 de la revue de la vague 1), ACCEPTER après REFUSER refusé, revue acceptée puis autorisation, rien supprimé en base) ; accès (401, 403 sans clé et lecteur, 404 masqué hors région, projet supprimé 404 à tous, job d'un autre projet 404 identique) ; base (transitions, résultat figé, DELETE et TRUNCATE refusés, 6 contraintes, index unique des jobs actifs) ; comptes de toutes les autres tables inchangés ; audit sans coordonnée.

## G. Sécurité

- **Aucune lecture hostile dans l'API** : GeoPackage, Shapefile et DXF ne sont jamais lus dans le processus ; un fichier de ces formats envoyé aux routes synchrones donne 415 (coupé) ou 422 (actif).
- **Archive** : noyau ZIP du module (`inspecterZip`) à la création du job, avant tout dépôt dans le spool (zip-slip, bombe, taux, imbrication, liens, chiffrement, recouvrement), puis le contrôle du worker.
- **Sortie du conteneur non fiable** : voir `CONTRAT-IMPORT.md` 13.4 ; jamais un chemin, un nom de couche ou une ligne de fichier du conteneur dans une réponse ; lecture sans suivre de lien et chemin réel dans le dossier du job ; empreinte de chaque couche comparée à celle du résumé à chaque usage.
- **Contrôle d'accès** : `ADMIN` et `GESTIONNAIRE`, lectures comprises ; périmètre régional ; projet supprimé 404 ; job d'un autre projet 404 ; routes ajoutées à `inventaire-acces.test.ts` et à `docs/securite/CONTROLE-ACCES.md`. Isolation du module : table et délégué ajoutés à `isolation.test.ts`.
- **Audit** : création, transitions, annulation, consommation, dépôt : sans géométrie (vérifié par le banc).
- **Spool** : fichiers retirés après dépôt, annulation, échec, expiration ; non retirés tant que le conteneur écrit.
- **Dépôt réel** : le jeu garde l'empreinte, la taille et le nom du fichier d'origine ; un job ne sert qu'à un dépôt (comparaison et échange dans la transaction du dépôt).

## H. Erreurs connues, limites, risques

1. Le test du lien symbolique de **fichier** (`resultat.json`) est ignoré sous Windows sans droit de création de lien ; celui d'un dossier remplacé par une jonction est exécuté. À rejouer sous Linux.
2. Le banc n'éprouve pas le cas `INTERROMPU` réel du conteneur (arrêt en plein job) côté backend : seule la relance sur perte (conteneur arrêté) est mesurée ; la décision `INTERROMPU` vers relance est testée en unitaire.
3. Droit de purge : le backend doit pouvoir supprimer `sortie/<id>/` écrit par le conteneur (UID 10001). Le backend actuel tourne en root (LOT-RC-00) ; un backend non root exige un volume ou des droits adaptés (décision DSI). Sans cela, la purge échoue (journalisée, sans fuite) et le conteneur purge à 72 h (`GEOCONV_RETENTION_H`).
4. Les limites passées au conteneur ne font que **baisser** ses plafonds : si l'opérateur règle `GEOCONV_LIMITE_*` plus bas que les valeurs du backend (50 000 objets, 120 s, 25 Mo), le job échoue en `DEMANDE_INVALIDE` (message fixe).
5. Plusieurs instances du backend : la réclamation est atomique, mais le contrôle des orphelins du worker suppose une seule instance du conteneur.
6. Mémoire : un résultat de 80 Mo validé en mémoire est une charge ; limiteur de 2 chargements par processus ; non mesuré à pleine taille.
7. La précision d'une reprojection avec un datum local n'est pas garantie (PROJ sans grilles, `PROJ_NETWORK=OFF`).
8. Les réglages de production (plafonds, cadence, rétention) sont des valeurs de départ, pas des besoins mesurés.

## I. Non exécuté

Lint, build, suite frontend (hors périmètre, aucun fichier frontend touché), déploiement, bancs d'intégration autres que celui du lot et le banc des descentes pour cette migration, fichiers réels de fournisseurs, scan de vulnérabilités de l'image, test d'évasion de conteneur, charge à pleine taille.

## J. Décisions à prendre par le DSI (non tranchées ici)

1. **Plafonds de production** : 50 000 objets, 25 Mo en entrée, 80 Mo de sortie, 90 s, 2 jobs actifs par compte, 3 par projet, file de 20, 12 créations par heure : valeurs de départ.
2. **Hébergement et mise à jour de l'image** `ageroute-geoconv` (environ 600 Mo, base GDAL épinglée par empreinte) : registre interne ou construction sur le serveur de préproduction, cadence de mise à jour (tag **et** empreinte).
3. **Profil seccomp** dédié, **scan de vulnérabilités** de l'image, **antivirus** sur les fichiers déposés : non faits, à décider avant la préproduction.
4. **Rétention** du spool (24 h par défaut, 72 h au plus) et droit de purge du backend sur `geoconv_sortie`.
5. **Déploiement du conteneur** : aucune de ces conditions n'est remplie dans le déploiement actuel ; activer `PROJETS_VOIRIE_GDAL=1` sans le conteneur et ses volumes donne des formats `INDISPONIBLE` (dossier d'échange absent), pas une panne.
6. DWG, DXF binaire, GML, LandXML, raster : toujours hors lot.
7. Politique d'échec par objet (refuser le fichier entier si une géométrie est aberrante : comportement actuel du worker).

## K. Commits (branche `feat/gdal-branche`, au-dessus de `feat/vague1-final` `d7955d4`)

- `c86daa8` feat(geoconv) : pré-filtre DXF, worker 0.2.0, banc 85 jobs (fork)
- `761504e` migration des jobs et descente gardée
- `4130427` noyau et services de la conversion
- `c58f7cf` pipeline commun, routes, état des formats
- `445d71b` tests unitaires et de routes, inventaire des accès, isolation
- `fb5e800` banc PostGIS et conteneur réel
- `2a8175f` documentation et rapport

Le commit WIP `fd516bc` et la fusion intermédiaire ont été remplacés : l'historique a été reconstruit sur `feat/vague1-final` (arbre identique à celui qui a été testé, vérifié par `git diff`). Aucun push.
