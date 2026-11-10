# Rapport du lot X1 : export du dossier technique, tableaux de bord national et par territoire

Date : 10/11/2026. Branche `feat/exports-tableaux-de-bord` (issue de `feat/vague3-integration`, `facba4e`). Worktree `C:\ageroute-secours\w-x1`. Contrat : `docs/projets-voirie/CONTRAT-EXPORTS.md` (écrit et commité en premier, `1601651`). Migration : `20261104200000_exports_tableaux_de_bord`. Un seul agent, aucun sous-agent. Aucun push, aucun déploiement, aucun frontend, lecteur F: jamais utilisé, production non touchée. Deux coupures réseau pendant le lot : l'état du worktree a été vérifié après chacune (rien de perdu, rien de rejoué deux fois).

## 1. Ce qui est fait

- **Export du dossier technique** `GET /:id/export/dossier` (ADMIN et GESTIONNAIRE du périmètre ; 404 masqué hors périmètre ; projet retiré : 404 pour tous) : archive ZIP produite par le serveur, sous une racine `dossier-<code>/` : `LISEZMOI.txt`, `fiche-projet.json`, `fiche-projet.pdf` (PDF texte simple), `analyse/agregats.json` (analyse 2D sur les jeux `AUTORISE`, sans croisements, zones ni listes d'objets, et résumé de la dernière analyse de conflits), `conflits/dossiers.csv` (**le CSV existant**, même fonction, même neutralisation des formules), `documents/journal.json` et `journal.csv` (documents et historique de leurs lignées), `documents/completude.json`, GeoJSON des jeux exportables, `manifeste.json` (empreinte SHA-256 et taille de chaque fichier, jeux inclus et écartés avec leur raison) et `manifeste.sha256` (vérifiable par `sha256sum -c`). En-têtes `X-Export-Id`, `X-Empreinte-Sha256`, `X-Fichiers`, `X-Jeux-Geojson`.
- **Confidentialité** : GeoJSON des seuls jeux `AUTORISE` d'un niveau exportable (`PUBLIC`, `INTERNE`, `RESTREINT_PROJET` par défaut ; réglage qui ne peut que restreindre) ; **jamais** `CONFIDENTIEL_CONCESSIONNAIRE` ni `INFRASTRUCTURE_SENSIBLE` sans dérogation ; niveau inconnu refusé (échec fermé) ; attributs des fichiers source jamais exportés ; **rien d'un jeu `RETIRE`** nulle part (fiche, GeoJSON, CSV, journal des documents : les détails d'historique qui désignent un jeu non lisible sont masqués).
- **Dérogation ADMIN** `POST|GET /:id/export/derogations` : nominative (bénéficiaire ADMIN ou GESTIONNAIRE actif, avec la clé, dont le périmètre couvre la région du projet), justifiée (20 caractères), bornée (24 h par défaut, 7 jours au plus), pour des jeux nommés `AUTORISE` d'un niveau sensible (sinon 409 `DEROGATION_INUTILE`), **à usage unique** : vérifiée avant la fabrication, consommée sous condition dans la transaction de remise (journal, dérogation, audits : tout ou rien), et garantie par un déclencheur (immuable, consommée une seule fois, avant expiration).
- **Bornes et protections** : objets et sommets comptés en base avant toute lecture de géométrie (422), taille de l'archive (422), délai total (504) et `statement_timeout` sur chaque lecture (une transaction `READ ONLY` pour la fiche, les jeux, les documents et l'historique ; celles de l'analyse, du CSV et de la complétude ont les leurs) ; 1 export par compte et 2 par processus (503) ; cadence par compte **comptée en base** (journal) et revérifiée sous verrou consultatif au moment de la remise (429 + `Retry-After`).
- **Journal et audit** : table `exports_dossier_projet_voirie` en ajout seul (empreinte de l'archive, taille, manifeste sans géométrie) ; audits `ExportDossierProjetVoirie` (avant la remise) et `DerogationExportProjetVoirie` (création, consommation) ; `GET /:id/export/journal`.
- **Tableaux de bord** `GET /tableau-de-bord` (national du compte, `parRegion`) et `GET /tableau-de-bord/territoires/:tid` (territoire et descendants : `total`, `rattachesDirectement`, `enfants`, `nonVentiles`) : projets, jeux par statut, dossiers par statut, documents manquants (types obligatoires non fournis, projets incomplets, pièces en attente), référents actifs ; **agrégats seulement** ; filtrés par périmètre ; un compte qui ne décide pas ne compte que les jeux `AUTORISE`, les dossiers dont **chaque** jeu lié est `AUTORISE` (réseau, plan d'axes **et jeu B d'une comparaison** : le défaut B1 de la revue T1+S1 n'est pas reproduit), et reçoit `null` pour les pièces en cours et les référents ; une transaction `READ ONLY` à budget côté base, 4 calculs par processus, cadence par compte. `GET /territoires/comptes` (T1) n'est **pas** réutilisé (constat m1 : ni délai, ni cadence, sous-requêtes corrélées) ni modifié.
- **Producteurs sans dépendance** (aucune bibliothèque ZIP ni PDF dans `backend/package.json`, aucune ajoutée) : ZIP déterministe (deflate de `node:zlib` ou stocké, CRC du module, sans ZIP64, noms sûrs, hôte MS-DOS sans attribut Unix), relu par le lecteur ZIP borné du module ; PDF 1.4 déterministe (Helvetica et Helvetica-Bold standard, WinAnsi, chaînes entièrement échappées, coupure des lignes, pages numérotées, table de renvois exacte).
- `EXPORT_DOSSIER` de la complétude (lot D1) passe `DISPONIBLE` sans condition.

## 2. Fichiers

**Nouveaux** : `backend/src/projets-voirie/exports/` (`zip-ecriture.noyau.ts`, `pdf.noyau.ts`, `manifeste.noyau.ts`, `confidentialite.noyau.ts`, `cadence.noyau.ts`, `fiche.noyau.ts`, `journal-documents.noyau.ts`, `config.ts`, `limiteurs.ts`, `lecture-dossier.ts`, `dossier.service.ts`, `derogations.service.ts`, deux fichiers de tests) ; `backend/src/projets-voirie/tableaux/` (`tableau.noyau.ts`, `tableau.service.ts`, un test) ; `backend/src/api-v2/projets-voirie.dossier-technique.routes.ts` (nommé sans « export » : le test d'isolation refuse ce mot dans la liste blanche, pour protéger l'export de la carte) et son test ; `backend/src/api-v2/projets-voirie.tableaux.routes.ts` ; migration et descente `20261104200000_exports_tableaux_de_bord` ; banc `backend/tests-integration/exports-tableaux.integration.mts` ; `docs/projets-voirie/CONTRAT-EXPORTS.md` ; ce rapport.

**Fichiers partagés modifiés (à surveiller à la fusion)** :

| Fichier | Modification |
|---|---|
| `backend/prisma/schema.prisma` | **fin de fichier** : deux modèles sans relation Prisma |
| `backend/src/api-v2/projets-voirie.routes.ts` | deux `import`, `monterRoutesTableaux` juste après `monterRoutesTerritoires` (routes littérales avant `/:id`), `monterRoutesExports` **en fin de fichier**, commentaire d'en-tête (l'exception X1 à « aucune route n'exporte de géométrie ») |
| `backend/src/projets-voirie/conflits/dossiers.service.ts` | `produireCsvConflits` extrait d'`exporterConflitsCsv` (contenu sans audit) ; l'export CSV existant inchangé (même contenu, même audit) |
| `backend/src/projets-voirie/documents/completude.noyau.ts` (+ test, + banc D1 ligne 140) | `EXPORT_DOSSIER: []` |
| `backend/src/lib/access.ts` | types d'entité d'audit `ExportDossierProjetVoirie`, `DerogationExportProjetVoirie` |
| `securite/inventaire-acces.test.ts`, `projets-voirie/isolation.test.ts` | 6 routes, 4 gardes de rôle, une exception territoriale documentée (`GET /tableau-de-bord`, filtrée dans le service), 2 tables, 2 délégués, 2 fichiers de routes |
| `tests-integration/run.sh`, `README.md` | banc X1 |
| `docs/projets-voirie/{API,CONTRAT-DOCUMENTS}.md`, `docs/securite/{CONTROLE-ACCES,DERIVE-SCHEMA}.md` | **ajouts** seulement (section 10 de `DERIVE-SCHEMA.md`) |

**Client Prisma** : `node_modules` du backend privé à ce worktree ; `npx prisma generate` lancé une fois depuis `w-x1/backend` après le changement de schéma.

## 3. Tests exécutés (chiffres réels, 10/11/2026)

Conteneur jetable `x1-postgis` (`postgis/postgis:17-3.5`, port 5484), mot de passe aléatoire lu par `docker inspect`, jamais affiché ni écrit. Base `replay` fabriquée par une copie de `fabriquer-replay.sh` (racine remplacée) : **104 migrations** (migration X1 comprise). Un premier démarrage du conteneur s'est arrêté pendant son initialisation (fabrication lancée trop tôt) ; il a été relancé et la fabrication refaite. `bdri-dev-db`, `e2e-c1-db`, `v3-postgis`, `fix-postgis` non touchés.

| Test | Résultat |
|---|---|
| `npx tsc --noEmit` (backend) | **0 erreur** (après le dernier changement de code) |
| Suite backend complète `npx vitest run` | **331 fichiers, 6 767 tests réussis, 1 ignoré, 0 échec** (551 s) |
| Noyaux X1 (`exports/producteurs.noyau.test.ts`, `exports/regles.noyau.test.ts`, `tableaux/tableau.noyau.test.ts`) | **34 tests** : ZIP relu par le lecteur strict (noms, contenus, CRC, tailles, deflate et stocké, drapeaux), déterminisme, date DOS, 12 noms refusés, doublon, archive vide ; PDF (structure, table de renvois et `/Length` exacts, texte retrouvé avec accents, euro, œ, tirets, guillemets, chaîne hostile qui ne ferme rien, caractères non représentables, NFD, coupure, pages, déterminisme) ; manifeste et `sha256sum` (altération détectée) ; **matrice complète** statut x niveau x dérogation x demande (120 cas), dérogation nommée seulement, niveau sensible jamais ouvert par un réglage, niveau inconnu refusé, réglage restrictif ; dérogation citée (404 identique, usage unique, expiration), création (11 refus typés), bénéficiaire ; cadence (fenêtre, horloge future, mémoire bornée), réglages bornés ; **injection de formules** (7 préfixes, journal des documents), masquage d'un jeu non lisible ; agrégats sans géométrie ; rangement des agrégats, lisibilité du lecteur |
| Routes (`projets-voirie.dossier-technique.routes.test.ts`) | **10 tests** : 6 routes x (401, 403 sans module, matrice ADMIN, GESTIONNAIRE, LECTEUR, INSPECTEUR), 404 masqué identique avant toute validation (projet et territoire), en-têtes et corps binaires, validations, erreurs typées (404, 409, 422, 429 et 503 avec `Retry-After`, 504) |
| Inventaire des accès, isolation | **21 + 9 tests** verts |
| Banc PostGIS `exports-tableaux` | **43/43** (premiers passages 27/30 puis 42/43 : défauts du banc, voir 4) |
| Banc des descentes (`verifier.sh --seulement 20261104200000_exports_tableaux_de_bord`) | **6/6** : schéma identique après descente, aller-retour, deux gardes avec et sans autorisation |
| Non-régression (replay à 104 migrations) | `projets-voirie` **141/141**, `conflits-projets-voirie` **169/169**, `documents-projet` **42/42**, `territoires-referentiels` **78/78**, `sources-comparaison` **55/55** (un premier passage 0/1 pendant la coupure réseau : transaction de 5 s expirée après 108 s, poste saturé ; relancé seul : 55/55) |
| Octets NUL | aucun dans les 39 fichiers du lot |

Ce que le banc X1 prouve contre PostGIS : gardes (lecteur, inspecteur, sans module, sans jeton, autre région) sans journal ni audit ; archive relue et **toutes ses empreintes vérifiées** ; empreinte de l'en-tête = SHA-256 des octets = journal ; GeoJSON des seuls jeux `INTERNE` et `RESTREINT_PROJET`, géométrie identique à la base, sans attribut source ; **le jeu retiré absent de toute l'archive** alors qu'il est lié à un document ; aucun nom ni géométrie des jeux écartés ; CSV existant (en-tête, une ligne par dossier, nom de concessionnaire hostile neutralisé) ; journal des documents neutralisé ; PDF ; audit sans coordonnée ; dérogation (cinq refus typés, création auditée, autre compte et autre projet : même 404, **deux exports simultanés : une seule archive, consommation unique**, GeoJSON sensibles marqués, réutilisation 409, huit refus de la base en SQL direct, expirée 409 et non consommable en base) ; cadence en base (429, aucune ligne en plus) ; `geojson=false` ; volume compté avant lecture (422, 12 000 sommets pour 10 000) ; **délai côté base** (table des objets verrouillée par une autre connexion : 504 en quelques secondes) ; tableaux national décideur (égaux aux comptes de la base), lecteur (**aucun comptage de quarantaine**, égal à la liste des jeux ; dossiers égaux à la liste **moins** le dossier dont le jeu B est en quarantaine, que la liste actuelle compte encore), types obligatoires égaux à la complétude D1, lecteur sans pièces ni référents, aucune géométrie ni nom, compte régional limité à sa région, territoire avec descendants, 404 masqué, ancêtres hors périmètre non nommés, cadence (429), délai côté base (504) ; projet supprimé 404 ; une ligne d'audit par archive remise ; tronçons du référentiel inchangés.

**Mutations** (une à la fois, fichier restauré par Git, arbre propre vérifié après chacune) :

| Mutation | Détectée par |
|---|---|
| M1 confidentialité : un jeu `CONFIDENTIEL_CONCESSIONNAIRE` ou `INFRASTRUCTURE_SENSIBLE` exporté sans dérogation (`selectionGeojson`) | noyau **3 échecs** sur 15 ; banc **2 échecs** (41/43 : GeoJSON du télécom et de l'eau dans l'archive, noms d'objets écartés présents) |
| M2 filtre lecteur des agrégats : les jeux de tous statuts comptés pour un lecteur (`tableau.service.ts`) | banc **1 échec** (42/43 : quarantaine comptée pour le lecteur) ; non visible des tests unitaires (SQL) |
| M3 filtre lecteur, jeu B : la condition sur le jeu B d'une comparaison retirée | banc **1 échec** (42/43 : le dossier dont le jeu B est en quarantaine compté pour le lecteur) |
| M4 usage unique, première couche : une dérogation déjà utilisée acceptée à la vérification préalable (`verifierDerogationCitee`) | noyau **1 échec** ; banc **1 échec** (42/43) : la réutilisation reste refusée en 409 par la deuxième couche (consommation conditionnelle à la remise), mais avec `etat: UTILISEE_OU_EXPIREE` au lieu de `UTILISEE` ; aucune archive remise |
| M5 usage unique, deuxième couche : la condition `utiliseeLe: null` retirée de la consommation | **non détectée** (43/43) : mutant équivalent tant que les couches 1 (vérification préalable) et 3 (déclencheur de la base, prouvé en SQL direct par le banc) tiennent, et que la place unique par compte empêche deux exports concurrents du bénéficiaire. Défense en profondeur assumée, pas une garde orpheline |

Après la campagne : arbre propre (0 fichier modifié), tests ciblés rejoués **84/84** (7 fichiers).

## 4. Écarts, défauts trouvés et corrigés, limites

- Banc X1, premiers passages : rattachement d'un référent demandé par un gestionnaire (la matrice du workflow le réserve à l'ADMIN : corrigé dans le banc) ; clé synthétique d'un dossier de conflit hors du format de la base (`cp_cle_format`) ; paramètre SQL mal numéroté dans une vérification ; connexion de verrou sans gestionnaire d'erreur. Défauts du banc, aucun du code.
- Défaut de conception corrigé pendant le lot : la fiche était d'abord lue par `ficheProjet` du socle, sans `statement_timeout` ; une table verrouillée aurait suspendu l'export. Les lectures sont passées dans une transaction `READ ONLY` à délais côté base (`lecture-dossier.ts`), ce que le banc prouve (504).
- `GET /:id/conflits` (liste RC-3) compte encore, pour un lecteur, un dossier `DIVERGENCE_SOURCES` dont le jeu B n'est pas `AUTORISE` (revue T1+S1, B1 ; correctif sur la branche des correctifs) : le tableau de bord, lui, l'exclut. Après fusion des correctifs, l'égalité « liste moins un » du banc deviendra « liste » : la vérification 7 du banc sera à ajuster.
- Le CSV des dossiers dans l'archive suit la règle des décideurs de RC-3 (dossiers d'un jeu en quarantaine compris, données d'un jeu `RETIRE` masquées) ; il ne porte aucune donnée du jeu B d'une comparaison.
- Non éprouvés en banc : la borne de taille de l'archive (le plancher du réglage, 1 Mo, n'est pas atteint par des fixtures raisonnables : vérifiée par lecture du code seulement) et le délai total de fabrication (`PROJETS_VOIRIE_EXPORT_DELAI_MS`, plancher 10 s) ; le délai côté base, lui, est prouvé. Volume réel (milliers de jeux, dizaines de Mo) non mesuré.
- La cadence des tableaux et les plafonds de concurrence sont par processus (plusieurs instances les multiplient) ; la cadence des exports est en base.
- La fiche, l'analyse, le CSV, la complétude et le GeoJSON sont lus dans des transactions distinctes : un jeu autorisé ou remplacé pendant la fabrication peut donner une archive légèrement incohérente (le GeoJSON revérifie le statut du jeu et l'écarte s'il n'est plus `AUTORISE`).
- La dérogation est consommée par l'export qui la cite, même si un jeu couvert a été remplacé entre-temps (le manifeste le dit). Pas de révocation : elle expire.
- Non exécutés : `run.sh` en entier, bancs `import-formats`, `workflow-roles`, `reseau-physique-logique`, `gdal-jobs` (non demandés), interface, lecture de l'archive par d'autres outils (unzip, lecteurs PDF) : l'archive a été relue par le lecteur strict du module et le PDF vérifié structurellement, aucun outil externe n'est installé sur le poste.

## 5. Décisions prises (hors contrat initial, documentées dans le contrat)

1. Décideurs = ADMIN et GESTIONNAIRE du périmètre du projet ; dérogation : ADMIN seul ; le journal des exports est réservé aux décideurs.
2. Niveaux exportables par défaut : `PUBLIC`, `INTERNE`, `RESTREINT_PROJET` (le dossier est celui du projet) ; le réglage ne peut que restreindre ; aucun réglage n'ouvre les deux niveaux sensibles.
3. Un jeu non `AUTORISE` est décrit dans la fiche (le décideur le lit déjà) mais jamais exporté en GeoJSON ni compté dans les agrégats d'analyse.
4. Export synchrone borné (pas de file asynchrone) ; refus explicite (422) plutôt qu'une archive tronquée.
5. L'analyse 2D refusée (volume, délai, largeurs) n'arrête pas l'export : `disponible: false` et le code.
6. Dérogation consommée par un export, sans révocation ; une dérogation sans GeoJSON est refusée (400).
7. Tableau national : par région administrative (l'unité du contrôle d'accès) ; par territoire : par enfant visible, plus « rattachés directement » et « non ventilés ».
8. `EXPORT_DOSSIER` disponible sans condition dans la complétude.
9. Aucune signature cryptographique de l'archive : l'authenticité repose sur le journal et l'audit (empreinte de l'archive remise).

## 6. Décisions à prendre (DSI)

1. `RESTREINT_PROJET` exportable sans dérogation ? C'est le niveau **par défaut** des plans d'axes et des limites de route : le le retirer (`PROJETS_VOIRIE_EXPORT_GEOJSON_NIVEAUX=PUBLIC,INTERNE`) rend leur GeoJSON inexportable, sans autre voie (la dérogation ne vise que les deux niveaux sensibles).
2. Valeurs de protection : 50 000 objets, 1 000 000 de sommets, 64 Mo, 120 s, 10 exports par heure et par compte, 30 tableaux par minute, dérogation de 24 h (7 jours au plus).
3. Un GESTIONNAIRE peut-il être bénéficiaire d'une dérogation (choix actuel : oui, nommément, par un ADMIN), et faut-il une révocation explicite ?
4. Faut-il signer l'archive (clé de l'organisme) pour un dossier transmis hors d'AGEROUTE ?
5. Rétention du journal des exports et des dérogations (aujourd'hui : illimitée, ajout seul).
6. Les attributs des fichiers source doivent-ils un jour sortir dans le GeoJSON (aujourd'hui : jamais) ?

## 7. Commits

Au-dessus de `facba4e` (`feat/vague3-integration`), dans l'ordre :

- `1601651` contrat du lot X1 (commité en premier)
- `5064e85` migration 20261104200000 et sa descente, schéma Prisma
- `be2bac2` CSV des dossiers produit sans audit (fonction partagée)
- `7898a1a` `EXPORT_DOSSIER` disponible
- `92f5f2d` producteurs ZIP et PDF, manifeste
- `3f44ffb` export, dérogation, tableaux de bord (services, routes, tests, inventaire, isolation)
- `5c908be` documentation (API, contrôle d'accès, dérive du schéma, précision D1)
- `aa9ff40` banc PostGIS `exports-tableaux`, `run.sh`, README
- ce rapport (commit suivant)

Aucun push.
