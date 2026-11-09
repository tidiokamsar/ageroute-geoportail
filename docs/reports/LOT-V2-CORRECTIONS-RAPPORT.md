# Lot V2-corrections : constats de la revue indépendante des lots B2 (GDAL asynchrone) et UI-B

Rapport du 09/11/2026. Branche `feat/vague2-corrections` (issue de `feat/vague2-integration`, `cfe8e4e`). Revue corrigée : `C:\ageroute-secours\REVUE-VAGUE2.md` (3 majeurs, 11 mineurs B2, u1, u2, observations). **Rien n'est activé ni déployé** : l'interrupteur `PROJETS_VOIRIE_GDAL` reste désactivé par défaut ; `docker-compose.yml`, nginx, `backend/Dockerfile` et `infra/deployer-console.sh` de production ne sont pas touchés ; seul le compose de **préproduction** `infra/geoconv/docker-compose.geoconv.yml` est modifié (commentaires et option tmpfs commentée). Aucune migration, aucun `prisma generate`, aucun push.

## A. Bilan par constat

| Constat | Statut | Ce qui a été fait | Preuve |
|---|---|---|---|
| **M1** FIFO plantée par le conteneur | **corrigé** | `spool.ts` : ouverture `O_RDONLY \| O_NOFOLLOW \| O_NONBLOCK` (`drapeauxLectureSure`), puis `fstat` sur le descripteur ouvert (tube, périphérique refusés et fermés). `delai.noyau.ts` : `avecDelai` et `BudgetTour` ; `traiteur.ts` : chaque accès au spool est borné (10 s par accès court, le reste du tour pour une validation, budget du tour `PROJETS_VOIRIE_GDAL_DELAI_TOUR_S`, 120 s par défaut) ; un accès qui ne répond pas est abandonné, compté en erreur, `tourEnCours` retombe | `spool.test.ts` (drapeaux réellement passés à `open`, descripteur devenu tube refusé et fermé) ; `delai.noyau.test.ts` (promesse qui ne se résout jamais) ; `traiteur.test.ts` : lecture du statut qui ne revient jamais, tour terminé en 1 s environ avec 1 erreur, tour suivant exécuté |
| **M2** aucune isolation entre jobs | **corrigé, limite résiduelle documentée** | Dépôt dans un dossier **privé** du backend `prive/<jobId>/` (0600, `PROJETS_VOIRIE_GDAL_PRIVE`, défaut `<spool>/prive`), copie dans `entree/<spoolId>/` **à la réclamation** seulement (`copierVersEntree`, idempotente), retrait de `entree/<id>` et du privé **dès TERMINE** (et à toute purge). Montage par job : impossible proprement avec Compose sans socket Docker (refusé) ; limite documentée (`CONTRAT-IMPORT.md` 13.5) : un GDAL compromis voit les `concurrence - 1` autres entrées en vol et peut écrire dans `sortie/` ; réglage `CONCURRENCE=1` pour l'annuler | `traiteur.test.ts` (rien dans `entree/` avant réclamation, copie puis demande, purge des trois dossiers) ; banc : 3 vérifications M2 ; `verifier_isolement.py` : nouveau contrôle « aucun dépôt privé monté, seuls des dossiers de job à la racine de l'entrée » (24/24 dans l'image 0.2.0) |
| **M3** erreur transitoire = ECHEC définitif | **corrigé** | `finalisation.noyau.ts` : `ECHEC` seulement pour `ErreurSortie`, `ErreurLecture` et fichier annoncé absent (`ENOENT`, `ENOTDIR` : le worker écrit `resultat.json` avant `statut.json`) ; tout le reste (`ServiceOccupe`, Prisma, `EMFILE`, `EIO`, `EACCES`, délai) est relancé à l'appelant, le job reste `EN_COURS` et est revalidé au tour suivant, borné par l'expiration | `finalisation.noyau.test.ts` ; `traiteur.test.ts` (EMFILE puis EACCES : job EN_COURS, aucun audit ECHEC) ; banc : limiteur saturé 15 s réel, job EN_COURS, puis TERMINE au tour suivant |
| m1 backend non root, famine des purges | **corrigé** | `disponibiliteSpool` exige `W_OK` sur `sortie/` ; une purge qui échoue est journalisée sans chemin et le job passe en queue (`updatedAt`) | `spool.test.ts`, `traiteur.test.ts` (purge en échec, l'autre job purgé au même tour) |
| m2 purge récursive d'un arbre du conteneur | **corrigé** | purge par **noms connus** (`statut.json`, `resultat.json`, `inventaire.json`, leurs `.tmp`, `couches/<slug>.geojson`) puis `rmdir`, sans suivre de lien (un dossier remplacé par un lien est retiré comme lien) ; un nom inattendu reste et l'erreur remonte | `spool.test.ts` (nom inattendu conservé, cible d'une jonction intacte) |
| m3 base de `verifierSousDossier` | **corrigé** | base = `realpath(sortie)/<spoolId>` ; le dossier du job doit être un vrai dossier (`lstat`) | `spool.test.ts` (dossier du job remplacé par une jonction : refusé) |
| m4 `resultat.json` relu non comparé | **corrigé** | `ecartsAvecResume` : empreintes, et pour chaque couche lue `crsSource`, `coordonnees`, `reprojete`, `nbObjets`, `slug`, plus versions GDAL/PROJ, source, inventaire DXF, codes d'avertissement du conteneur ; comparaison en forme canonique (jsonb réordonne les clés) | `conversion.noyau.test.ts` ; banc : `resultat.json` réécrit après validation : 409 `RESULTAT_ALTERE` |
| m5 chaînes du conteneur non plafonnées | **corrigé** | schémas : 200 clés au plus pour `dxf.lues` et `dxf.ignorees`, 50 pour `typesGeometrieReels`, aucun caractère de contrôle dans les noms (couche, CRS, calque, source), versions et pilotes sur un motif étroit, codes d'avertissement de couche en majuscules ; `resume.source.nom` = `job.nomFichier` | `sortie.noyau.test.ts`, `conversion.noyau.test.ts` |
| m6 plafonds entre projets, quota de spool | **corrigé en partie, documenté** | verrou consultatif global (`pg_advisory_xact_lock`) après celui du projet pour les compteurs globaux ; plafond des `TERMINE` non utilisés (`_RESULTATS_MAX`, 20, 503 `PLAFOND_RESULTATS_EN_ATTENTE`) ; entrée purgée dès TERMINE ; volume `geoconv_sortie` : borne par construction documentée et option tmpfs commentée dans le compose de préproduction (décision DSI) | banc : 503 `PLAFOND_RESULTATS_EN_ATTENTE` avec `Retry-After` ; la sérialisation par le verrou global n'est **pas** éprouvée en concurrence réelle (voir D) |
| m7 relance sans `peutPurger`, EEXIST | **corrigé** | la relance ne purge l'ancienne tentative que si le conteneur n'y écrit plus (sinon l'entrée seule) ; la copie se fait désormais à la réclamation depuis le privé, et un `EEXIST` avec le fichier présent est une transmission déjà faite | `traiteur.test.ts`, `spool.test.ts` |
| m8 EN_ATTENTE vers EN_COURS non auditée | **corrigé** | réclamation et audit (`userId` nul, tentative, instant) dans la même transaction | `traiteur.test.ts` ; banc (1 ligne d'audit, sans acteur) |
| m9 `choixObligatoire` faux pour un GPKG sans CRS | **corrigé** | vrai dès que l'aperçu refusera sans confirmation : CRS source nul, sans code EPSG, différent de 4326, ou coordonnées brutes | `pipeline.converti.test.ts` |
| m10 interface non adaptée à B2 | **documenté seulement** (lot UI-C) | `CONTRAT-IMPORT.md` 13.6 : l'écran de dépôt doit lire `formatsGdal` et les codes `FORMAT_GDAL_DESACTIVE`, `GDAL_DESACTIVE`, `PLAFOND_RESULTATS_EN_ATTENTE` | aucune (non fait, hors mandat) |
| m11 calques DXF avec les stats du fichier entier | **corrigé** | le validateur calcule par groupe (calque) `typesReels`, `sommets`, `emprise` ; l'assemblage les reprend | `sortie.noyau.test.ts`, `conversion.noyau.test.ts` |
| Obs. `COUCHE_INTROUVABLE` cite des noms du conteneur | **code aligné sur la doc** | message fixe : ni la valeur demandée, ni les identifiants de couche ; renvoi à l'inventaire du job | `conversion.noyau.test.ts` |
| Obs. interrupteur coupé après usage | **documenté** | `CONTRAT-IMPORT.md` 13.2, point 9 : jobs gelés, reprise au premier tour après réactivation (expiration, relance ou `JOB_PERDU`) | aucune (comportement inchangé, déjà testé : sondage inerte si coupé) |
| Obs. seccomp, scan, antivirus | inchangé | toujours une décision DSI | |
| **u1** saisie dans la query string, comptes sans clé | **corrigé** | `listerComptesLecteurs` charge une page de 200 lecteurs actifs **sans terme de recherche** ; `filtrerComptes` filtre côté client (nom ou courriel, sans accents ni casse) ; `lireComptes` lit `modulesAutorises` ; un compte sans la clé `projets-voirie` est montré, désactivé et expliqué ; au-delà de 200 comptes, la liste dit qu'elle est incomplète (total du serveur) | `projetsVoirieWorkflowApi.test.ts` (aucun `search` dans l'appel), `ProjetVoirieWorkflow.test.tsx` (un seul appel `/users`, filtre local, compte sans clé désactivé, liste incomplète) |
| **u2** entrées illisibles tues | **corrigé** | `lirePreuves` et `lireHistoriqueWorkflow` rendent `ignores` ; les fiches portent `preuvesIgnorees` et `historiqueIgnores`, affichés par `AvertissementIgnores` (même texte que les listes paginées) | `projetsVoirieWorkflowApi.test.ts`, `ProjetVoirieWorkflow.test.tsx` |

## B. Fichiers

Backend, nouveaux : `gdal/delai.noyau.ts`, `gdal/finalisation.noyau.ts`, `gdal/traiteur.test.ts`, `gdal/delai.noyau.test.ts`, `gdal/finalisation.noyau.test.ts`. Modifiés : `gdal/spool.ts`, `gdal/traiteur.ts`, `gdal/jobs.service.ts`, `gdal/config.ts`, `gdal/sortie.noyau.ts`, `gdal/conversion.noyau.ts`, `formats/lecture-import.noyau.ts` (une expression, m9), tests existants du dossier `gdal/`, banc `tests-integration/gdal-jobs.integration.mts`. Infra (préproduction) : `infra/geoconv/docker-compose.geoconv.yml` (commentaires, option tmpfs commentée), `infra/geoconv/tests/verifier_isolement.py` (un contrôle). Le **worker Python n'est pas modifié** : l'image reste `ageroute-geoconv:0.2.0`, aucune 0.2.1 construite. Docs : `CONTRAT-IMPORT.md` (13.2, 13.3, 13.4, 13.5 nouvelle, 13.6), `API.md` (codes, réglages), `CHAINE-GDAL.md` (section 7). Frontend : `lib/projetsVoirieWorkflowApi.ts`, `lib/projetsVoirieWorkflowHooks.ts`, `components/projets-voirie/workflow/{SectionReferents,PreuvesEtHistorique,SectionDemandes,SectionTaches,SectionRecolements}.tsx`, fixture `workflowSynthetiques.testutil.ts`, tests `projetsVoirieWorkflowApi.test.ts` et `pages/ProjetVoirieWorkflow.test.tsx`.

Aucune nouvelle route : l'inventaire des accès et `CONTROLE-ACCES.md` sont inchangés. Nouveaux réglages : `PROJETS_VOIRIE_GDAL_RESULTATS_MAX` (20, 1 à 500), `PROJETS_VOIRIE_GDAL_DELAI_TOUR_S` (120, 1 à 600), `PROJETS_VOIRIE_GDAL_PRIVE` (défaut `<spool>/prive`). Nouveau code : 503 `PLAFOND_RESULTATS_EN_ATTENTE`.

## C. Tests (chiffres réels, 09/11/2026, poste de développement)

| Contrôle | Résultat |
|---|---|
| `npx tsc --noEmit` backend | **0 erreur**, deux fois : avec le client Prisma partagé, puis avec un client **privé** généré depuis le schéma de ce worktree (voir D, incident du client partagé) |
| Suite backend complète `npx vitest run` | **314 fichiers sur 314, 6 561 tests passés, 1 ignoré** (lien symbolique de fichier, droit refusé sous Windows), 377 s |
| Tests du dossier `gdal/` | 10 fichiers, dont 3 nouveaux (`delai.noyau`, `finalisation.noyau`, `traiteur`) ; 120 tests avant ce lot (référence mesurée au départ), **139 passés et 1 ignoré** après (`spool.test.ts` 23, `traiteur.test.ts` 10, `sortie.noyau.test.ts` 27, `conversion.noyau.test.ts` 15, `pipeline.converti.test.ts` 23, `delai` 5, `finalisation` 4, et les fichiers inchangés) |
| Banc PostGIS et **conteneur réel** `gdal-jobs.integration.mts` (`postgis/postgis:17-3.5` jetable sur le port 5477, `replay` rejouée avec les 100 migrations et le pont de dérive, image `ageroute-geoconv:0.2.0`) | **100 vérifications sur 100** (92 au lot B2, 8 ajoutées : M2 ×3, M3 ×2, m4, m6, m8). Passages précédents de ce lot : 11/18 (comparaison au résumé sensible à l'ordre des clés jsonb : corrigé par une forme canonique), 19/22 (P2022 : client Prisma partagé régénéré par un autre worktree pendant le banc ; voir D) |
| Contrôle d'isolement `verifier_isolement.py` dans l'image 0.2.0, options du compose (réseau coupé, racine en lecture seule, UID 10001, sans capacité, 1 Go, 64 processus, ulimits) | **24 contrôles sur 24** dont le nouveau (aucun dépôt privé monté, seuls des dossiers de job à la racine de l'entrée) |
| Frontend : `npx tsc --noEmit` | **0 erreur** |
| Frontend : `eslint` des 10 fichiers touchés | **0 erreur, 0 avertissement** |
| Frontend : fichiers de tests touchés (`projetsVoirieWorkflowApi.test.ts`, `pages/ProjetVoirieWorkflow.test.tsx`) | **2 fichiers, 143 tests passés** (41 + 102) |
| Scan des octets NUL sur tous les fichiers modifiés ou créés | aucun |

« Échoue avant, passe après » : les tests nouveaux visent des fonctions et comportements qui n'existaient pas (dépôt privé, garde de délai, classement des erreurs, comparaison au résumé, comptes par calque, recherche locale, compteurs `ignores`) ou contredisent l'ancien comportement (drapeaux d'ouverture, `choixObligatoire`, message de `COUCHE_INTROUVABLE`, purge d'un nom inattendu, appel `/users` avec `search`). Ils n'ont **pas** été rejoués un par un sur le code de `cfe8e4e` (pas de mutation systématique dans ce lot).

## D. Non exécuté, limites

- **Incident du client Prisma partagé** (`node_modules` en jonction vers `w-pv`) : pendant ce lot, il a été régénéré deux fois par un autre worktree (`w-s1-sources`, schéma avec `methodeAcquisition` et `derniereAnalyseId` nullable), ce qui a donné un `tsc` en erreur dans `conflits/*.ts` (fichiers non touchés) et un 500 P2022 au dépôt du banc. Ce lot **n'a pas** lancé `prisma generate` sur le client partagé : pour le `tsc` et le banc, un client privé a été généré depuis le schéma de ce worktree dans un dossier temporaire du worktree (`backend/.prisma-v2fix`, via un `tsconfig` de `paths` temporaire), puis supprimé ; rien n'est commité. Le coordinateur doit savoir que le client partagé ne correspond pas forcément au schéma de cette branche.
- Montage par job dans le conteneur : non fait (exige le socket Docker ou un orchestrateur) ; limite résiduelle documentée (13.5).
- Le verrou consultatif global (m6) n'est pas éprouvé par une course réelle entre deux projets ; il est exercé à chaque création du banc.
- Un vrai tube nommé dans `sortie/` n'est pas testé (Windows, sans FIFO) : le test simule un descripteur devenu tube (fstat) et une lecture qui ne revient jamais ; à rejouer sous Linux (`mkfifo`).
- Le test du lien symbolique de **fichier** reste ignoré sous Windows (droit de création de lien) ; les tests de jonction (dossier) sont exécutés.
- Suite frontend complète, build, banc du worker `lancer-tests.sh` (le worker n'est pas modifié ; seul le contrôle d'isolement a été rejoué), bancs `import-formats`, `projets-voirie` et `conflits` (le pipeline commun n'est pas modifié hors `inventaireConverti`, couvert par `pipeline.converti.test.ts` et le banc GDAL), banc des descentes (aucune migration).
- Backend non root avec droits réels sur `geoconv_sortie` : non éprouvé (le banc tourne en root sous Docker Desktop).

## E. Décisions prises hors contrat (à relire)

1. Fichier annoncé absent à la finalisation (`ENOENT`) = `ECHEC SORTIE_INVALIDE` (contrat du worker rompu), et non transitoire.
2. La relecture compare au résumé des champs que la revue ne citait pas (`slug`, `nbObjets`, source, versions, inventaire DXF, codes d'avertissement) ; les deux avertissements calculés par le backend (`ATTRIBUTS_ADAPTES`, `COMPTE_DXF_DIVERGENT`) sont exclus car ils varient avec la sélection.
3. Recherche de comptes : page unique de 200 (maximum de `GET /users`) ; au-delà, l'écran le dit et renvoie à la page Utilisateurs. Un compte dont le serveur ne rend pas `modulesAutorises` reste proposable (le serveur tranche).
4. Purge par noms connus : un nom inattendu dans `sortie/<id>/` laisse le dossier en place (journalisé, rotation) jusqu'à la purge du worker à 72 h.

## F. Décisions pour le DSI

1. `PROJETS_VOIRIE_GDAL_CONCURRENCE=1` en production si l'on veut supprimer la fenêtre entre jobs en vol (au prix du débit).
2. Volume `geoconv_sortie` en tmpfs (borne dure, perdu au redémarrage de l'hôte) ou quota de système de fichiers.
3. Emplacement de `PROJETS_VOIRIE_GDAL_PRIVE` (volume du backend seul, jamais partagé avec le conteneur) et droits d'un backend non root sur `geoconv_sortie`.
4. Valeurs de `_RESULTATS_MAX` et `_DELAI_TOUR_S` (bornes de protection, pas des seuils métier).

## G. Commits

Branche `feat/vague2-corrections`, au-dessus de `cfe8e4e` (aucun push) :

- `1641c7a2ebc65bef28149086cb9618aa4e5bd1b4` fix(ui-workflow) : recherche de comptes locale, clé de module, entrées illisibles comptées (u1, u2)
- `d89317fb64946cf5e304b2c9bbdc4d9c250965dd` fix(gdal) : spool non bloquant, dépôt privé, erreurs transitoires, sortie bornée (M1 à M3, m1 à m9, m11)
- `b5d73c2d7cdf14c166ae7e4e2803d4d8a134658c` test(gdal) : banc PostGIS et conteneur réel pour M2, M3, m4, m6, m8
- `be1e29865950e5939d36662fcfc87e41cfd732eb` docs(gdal) : isolement entre jobs, limite résiduelle, purge, interrupteur coupé ; contrôle d'isolement
- ce rapport (commit suivant)

Le code backend est en un seul commit : les corrections partagent les mêmes fichiers (`spool.ts`, `traiteur.ts`, `jobs.service.ts`) et un découpage par constat aurait laissé des commits intermédiaires qui ne compilent pas.

Nettoyage : conteneur PostGIS jetable `v2fix-db` et son volume supprimés, clone `essai_gdal_jobs` détruit par le banc, conteneurs du banc et volumes du contrôle d'isolement supprimés, client Prisma privé supprimé. `bdri-dev-db` non touché.
