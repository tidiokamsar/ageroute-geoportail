# Rapport du lot D1 : complétude documentaire et formats d'ingénierie

Date : 09 et 10/11/2026. Branche `feat/completude-documentaire` (issue de `feat/vague3-integration`, `c8049df`). Worktree `C:\ageroute-secours\w-d1`. Contrat : `docs/projets-voirie/CONTRAT-DOCUMENTS.md` (écrit et commité en premier, `b176bdb`). Migration : `20261104100000_completude_documentaire`. Un seul agent, aucun sous-agent. Aucun push, aucun déploiement, aucun frontend, lecteur F: jamais utilisé, production non touchée.

## 1. Ce qui est fait

- **Documents du projet** (`documents_projet_voirie`, une ligne par version, lignée `ligneeId`) : type du référentiel T1 `TYPE_DOCUMENT` (vérifié par la base), neuf statuts (`ATTENDU`, `RECU`, `EN_ANALYSE`, `EXPLOITABLE`, `INCOMPLET`, `A_CORRIGER`, `REMPLACE`, `VALIDE`, `REJETE`), pièce = référence et/ou empreinte SHA-256 d'un fichier téléversé (PDF, DWG reconnus par leur signature) ou jeu importé du même projet ; **aucun fichier stocké** (ni colonne binaire, ni disque : le contenu ne sert qu'à l'empreinte et au format) ; justification, acteur et dates par geste ; suppression logique (ligne figée) ; `DELETE` et `TRUNCATE` refusés.
- **Historique en ajout seul écrit par la base** (déclencheur `AFTER INSERT OR UPDATE`) : le service ne peut pas l'oublier ; une ligne par geste, égale au nombre de lignes d'audit (vérifié par le banc).
- **Transitions contrôlées deux fois** : noyau `documents/etats.noyau.ts` et fonction SQL `documents_projet_voirie_transition_admise` (un test compare les deux textes : 20 couples, identiques). Champs et pièce figés après dépôt, lignée de versions cohérente, jeu du même projet, remplacement vérifié par un **déclencheur différé** (fin de transaction).
- **Séparation des tâches** : le déposant d'une pièce ne la valide pas (service 409 `SEPARATION_DES_TACHES`, et contrainte `dpv_separation_validation` de la base), sans dérogation.
- **DWG** : conservé comme document `RECU`, jamais `EXPLOITABLE` ni `VALIDE` (service et contrainte `dpv_dwg_non_exploitable`), avertissement `DWG_NON_EXPLOITABLE` avec la marche à suivre pour exporter en DXF ; à l'import, 415 `FORMAT_NON_SUPPORTE` avec le même message. **PDF** : pièce de référence ; à l'import, 422 `CONTENU_NON_RECONNU` avec un message qui renvoie aux documents.
- **Ce que les documents permettent** (`GET /:id/completude`, lecture seule, délais côté base) : fonctions `ANALYSE_2D`, `CONFLITS` (plan d'axes et réseau `AUTORISE`), `COMPARAISON_SOURCES` (deux jeux `AUTORISE` d'un même réseau, identité du lot S1), `RECOLEMENT` (décision `DEPLACER_RESEAU` approuvée sur un dossier `TRAITEMENT_DECIDE` ou `CLOTURE` visible du compte), `EXPORT_DOSSIER` (`NON_LIVREE`, lot X1) ; pièces manquantes avec `fonctions` (celles qui l'exigent) et `suffiraitPour` (celles que cette seule pièce rendrait disponibles, calculé en rejouant le noyau), types obligatoires non fournis, documents en cours (décideurs).
- **LandXML** (`formats/landxml.noyau.ts`, valeur `LANDXML` de `FormatJeuProjet`) : lecteur XML du module (DTD et entités refusées, plafonds), `Alignments` (lignes, arcs discrétisés à une flèche au plus égale à la tolérance, `IrregularLine`), `CgPoints`, `pntRef` ; spirales et chaînes refusées (`LANDXML_SPIRALE_NON_PRISE_EN_CHARGE`), arc dégénéré refusé (`LANDXML_ARC_DEGENERE`), profils, surfaces et autres éléments ignorés et comptés ; ordre « Nord Est » ; unités en mètres exigées ; **CRS jamais déduit** (`epsgSource` obligatoire, liste blanche, projeté en mètres ; un `CoordinateSystem/@epsgCode` n'est qu'une information, comparée) ; sommets de la discrétisation comptés avant allocation (plafonds du socle). Intégré au parcours existant : inventaire, aperçu (aucune écriture), simulation, dépôt en quarantaine, versions.
- Référentiel `TYPE_DOCUMENT` : paramètre facultatif `roleJeu` (schéma zod du lot T1 étendu), posé par la migration sur `PLAN_AXES`, `RESEAU_CONCESSIONNAIRE`, `LIMITES_ROUTE` (version 2 système, historique `MIGRATION`) ; retirer un type porté par un document : 409 `VALEUR_UTILISEE`.

## 2. Fichiers

**Nouveaux** : `backend/src/projets-voirie/documents/` (`etats.noyau.ts`, `piece.noyau.ts`, `completude.noyau.ts`, `documents.service.ts`, `completude.service.ts`, `vues.ts`, deux fichiers de tests) ; `backend/src/projets-voirie/formats/landxml.noyau.ts` et son test ; `backend/src/api-v2/projets-voirie.documents.routes.ts` et son test ; migration `backend/prisma/migrations/20261104100000_completude_documentaire/migration.sql` et descente `backend/prisma/descentes/20261104100000_completude_documentaire.sql` ; banc `backend/tests-integration/documents-projet.integration.mts` ; `docs/projets-voirie/CONTRAT-DOCUMENTS.md` ; ce rapport.

**Fichiers partagés modifiés (à surveiller à la fusion)** :

| Fichier | Modification |
|---|---|
| `backend/prisma/schema.prisma` | valeur `LANDXML` de `FormatJeuProjet` ; **fin de fichier** : un enum, deux modèles sans relation Prisma |
| `backend/src/api-v2/projets-voirie.routes.ts` | un `import`, `monterRoutesDocuments` **en fin de fichier** |
| `backend/src/api-v2/projets-voirie.import.routes.ts` (+ test) | `LANDXML` dans les formats annoncés ; raison du DWG |
| `backend/src/projets-voirie/formats/lecture-import.noyau.ts` | détection, inventaire et lecture du LandXML ; contrôle du CRS projeté à la fin de la lecture ; `resume.import.landxml` |
| `formats/crs.noyau.ts`, `formats/puits.noyau.ts`, `formats/import.config.ts`, `lecture.types.ts`, `lecture.noyau.ts` | branche LandXML de `choisirCrs` ; noms de couches stables ; tolérance des arcs ; codes ; messages DWG et PDF |
| `territoires/referentiels.noyau.ts`, `territoires/referentiels.service.ts` | `roleJeu` ; usages d'un `TYPE_DOCUMENT` |
| `backend/src/lib/access.ts` | type d'entité d'audit `DocumentProjetVoirie` |
| `securite/inventaire-acces.test.ts`, `projets-voirie/isolation.test.ts` | 8 routes, 5 écritures, 2 tables, 2 délégués, fichier de routes |
| `tests-integration/run.sh`, `README.md` | banc D1 |
| `tests-integration/sources-comparaison.integration.mts` | enveloppe du territoire par défaut (voir 4) |
| `docs/projets-voirie/{API,CONTRAT-IMPORT}.md`, `docs/securite/{CONTROLE-ACCES,DERIVE-SCHEMA}.md` | **ajouts** seulement |

**Client Prisma** : `node_modules` du backend privé à ce worktree ; `npx prisma generate` lancé une fois depuis `w-d1/backend` après le changement de schéma (aucun autre worktree touché).

## 3. Tests exécutés (chiffres réels, 09 et 10/11/2026)

Conteneur jetable `d1-postgis` (`postgis/postgis:17-3.5`, port 5482), mot de passe aléatoire lu par `docker inspect`, jamais affiché ni écrit. Base `replay` fabriquée par une copie de `fabriquer-replay.sh` (racine remplacée) : 102 migrations d'abord, puis **103** (migration D1 comprise) pour la non-régression. `bdri-dev-db`, `e2e-c1-db`, `v3-postgis` non touchés. Conteneur supprimé à la fin.

| Test | Résultat |
|---|---|
| `npx tsc --noEmit` (backend) | **0 erreur** (après le dernier changement de code) |
| Suite backend complète `npx vitest run` | **327 fichiers, 6 723 tests réussis, 1 ignoré, 0 échec**, deux passages : avant le dernier changement de code (321 s) et sur l'état final de la branche |
| Noyau LandXML (`formats/landxml.noyau.test.ts`) | **21 tests** : ligne + arc + ligne (ordre Nord Est, extrémités exactes), arcs horaire et anti-horaire (points sur le cercle, flèche mesurée au plus égale à la tolérance pour 1, 10 et 100 mm), segments selon la tolérance, `IrregularLine` et discontinuités, `pntRef` résolu ou introuvable, CgPoints, **spirale et chaîne refusées**, **sept arcs dégénérés**, unités absentes, en pieds, en millimètres, **CRS absent** (même déclaré), conflit, hors liste blanche, EPSG:4326, CRS géographique de la liste blanche refusé à la fin de la lecture, inventaire, parcours complet, couche choisie, fichier vide, **XXE, « billion laughs », entité non définie, `<!ENTITY>` hors DTD**, **bombe de sommets** (un arc immense, 2 000 arcs refusés au plafond en moins de 1,5 s, plafond par axe), nombres démesurés |
| Noyaux des documents (`documents/*.noyau.test.ts`) | **22 tests** : matrice identique à la base (20 couples), terminaux, 81 couples (de, vers), gardes dans l'ordre (justification, DWG, jeu non autorisé, **séparation des tâches**), versions ; **indépendance prouvée par énumération** (30 états × 5 bruits documentaires × 2 rôles × 5 fonctions = 1 500 vérifications, et toutes les paires d'états qui ne diffèrent que par une condition), cas du contrat, pièces manquantes et `suffiraitPour`, types obligatoires, lecteur, versions rejetées puis remplacées, réseaux |
| Routes (`projets-voirie.documents.routes.test.ts`) | **12 tests** : 8 routes × (401, 403, lecteur, gestionnaire, ADMIN, 404 masqué identique avant toute validation et toute réception), multipart et JSON, 413, octet NUL, validations, erreurs typées |
| Inventaire des accès, isolation | **30 tests** verts (8 routes, rôles exacts des 5 écritures, garde territoriale à 404 masqué sur toutes ; 2 tables, 2 délégués) |
| Banc PostGIS `documents-projet` | **42/42** (premier passage 40/41, voir 4) : référentiel, complétude d'un projet vide, document attendu, historique écrit par la base, DWG (empreinte, aucun fichier conservé, jamais exploitable, refus en SQL direct), LandXML (inventaire, aperçu sans écriture, longueur de l'arc discrétisé 278,5 m à 0,3 % près, cinq refus, dépôt en quarantaine), version liée au jeu, exploitabilité liée à l'autorisation, séparation des tâches (service et base), **analyse 2D et conflits réellement lancés (200, 201) alors que des pièces sont attendues, incomplètes ou absentes**, seconde source puis comparaison disponible, décision de déplacement approuvée puis récolement disponible, lecteur, versions, type désactivé, 12 refus de la base en SQL direct, formats à l'import, retrait, 404 masqué, isolation (comptes de toutes les tables, md5 des tronçons), audit sans contenu, projet supprimé |
| Banc des descentes (`verifier.sh --seulement 20261104100000_completude_documentaire`, 103 migrations) | **6/6** : schéma identique après descente, aller-retour, garde avec dérogation, garde sans dérogation (jeu `LANDXML`) |
| Migration en SQL sur un clone | montée, seconde montée idempotente, descente (types de document rendus en version 1), remontée |
| Non-régression (replay à 103 migrations) | `projets-voirie` **141/141**, `conflits-projets-voirie` **169/169**, `import-formats` **89/89**, `territoires-referentiels` **78/78**, `sources-comparaison` **55/55** (après la correction de son enveloppe, voir 4) |
| Octets NUL | aucun dans les fichiers du lot |

**Mutations** (une à la fois, fichier restauré par Git, arbre propre vérifié après chacune) :

| Mutation | Détectée par |
|---|---|
| M1 séparation des tâches retirée du noyau | noyau 1 échec ; banc 1 échec (la contrainte de la base bloque encore, la réponse n'est plus le 409 attendu) |
| M2 garde territoriale retirée de `GET /:id/documents` | routes 1 échec ; inventaire 2 échecs ; banc 1 échec (compte d'une autre région : 200 au lieu de 404) |
| M3 DTD acceptée par le lecteur XML (garde XXE) | 2 échecs (noyau LandXML, noyau d'import GPX/KMZ) |
| M4 l'analyse 2D exige aussi une décision (indépendance rompue) | noyau 2 échecs |
| M5 un lecteur voit tous les statuts de documents | banc 1 échec |

## 4. Écarts, défauts trouvés et corrigés, limites

- **Banc `sources-comparaison` du lot S1** : sur la branche d'intégration, il échouait dès sa première création de projet (400 `TERRITOIRE_REQUIS`, 0/1), parce qu'il n'avait pas reçu l'enveloppe du territoire par défaut que T1 a ajoutée aux autres bancs. Corrigé par deux lignes (`47f7fc0`) : 55/55. Défaut d'intégration préexistant, indépendant de D1.
- Premier passage du banc D1 : 40/41, attente erronée du banc (un LandXML qui déclare EPSG:32629 et reçoit `epsgSource=4326` répond `CRS_CONFLIT` avant `CRS_INCOMPATIBLE_FORMAT` : ordre voulu, le banc utilise désormais un fichier sans déclaration pour ce cas).
- Défaut trouvé par le banc et corrigé (`73faa76`) : une nouvelle version d'un document dont le type a été **désactivé** était refusée ; seule la création exige un type actif, une nouvelle version n'exige qu'un type non retiré. Après ce changement : `tsc` 0 erreur, suite complète 6 723 réussis, banc 42/42.
- Le test d'énumération de l'indépendance lit la table `CONDITIONS_PAR_FONCTION` : il prouve que le calcul ne dépend que de la table, et ce sont les tests des cas du contrat qui fixent la table (M4 le montre).
- La condition `DECISION_DEPLACEMENT` ne vérifie pas qu'une approbation est « en vigueur » après une reconfirmation du dossier (la création d'un récolement, lot B3, le vérifie) : la complétude peut annoncer le récolement disponible un peu plus largement que la route qui le crée.
- L'identité d'un réseau reprend celle du lot S1 (concessionnaire et famille), avec son défaut connu (revue T1/S1, M3 : `typeReseauCode` ignoré).
- Lectures de liste et de fiche des documents : requêtes Prisma indexées sans `statement_timeout` (comme `listerJeux` du socle) ; la complétude et toutes les écritures ont leurs délais côté base.
- Non exécuté : `tests-integration/run.sh` en entier (bancs hors du module), bancs `reseau-physique-logique`, `workflow-roles`, `gdal-jobs` (non demandés), volume (milliers de documents), LandXML réels (aucune donnée réelle, fixtures synthétiques seulement), interface.

## 5. Décisions prises (hors contrat initial, documentées dans le contrat)

1. **Une ligne par version** ; la précédente en cours passe `REMPLACE` au dépôt de la suivante, une `VALIDE` le reste jusqu'à la validation de la suivante, une `REJETE` reste `REJETE`.
2. **Les fonctions dépendent des jeux `AUTORISE` et des décisions, jamais des documents** (décision 2, section 6) ; les documents décrivent le dossier et les pièces attendues.
3. **Un format n'est pas un type** : aucun type de document ajouté ; `roleJeu` relie un type à une condition.
4. Fichier d'un document : PDF et DWG seulement ; un plan géographique s'importe comme jeu puis se lie par `jeuId`.
5. `EXPLOITABLE` d'une pièce liée à un jeu exige le jeu `AUTORISE` ; un PDF peut être `EXPLOITABLE` et `VALIDE` (pièce de référence).
6. Retrait d'une pièce `VALIDE` réservé à l'ADMIN ; un `VALIDE` ne revient jamais à un autre statut que `REMPLACE`.
7. LandXML : spirales refusées pour le fichier entier (pas d'axe tronqué en silence) ; ordre « Nord Est » de la norme ; unités en mètres exigées ; tolérance des arcs 10 mm par défaut ; `CRS_CONFLIT` avant `CRS_INCOMPATIBLE_FORMAT`.
8. **`infra/deployer-console.sh` n'est pas modifié** : `ATTENDUES_EN_ATTENTE=5` (première en attente `20261030100000`) date de la vague 1 ; le nombre exact dépend de l'état de la production au moment du déploiement (B2, T1, S1 et D1 en ajoutent quatre, sans compter le reste de la branche d'intégration). Le script l'exige par construction **à chaque déploiement** ; il doit être renseigné par l'opérateur après le relevé de la production, pas depuis ce lot.
9. `DERIVE-SCHEMA.md` : section 9 ajoutée pour D1 ; les lots T1 et S1 n'y avaient pas de section (signalé dans le document).

## 6. Décisions à prendre (DSI)

1. Tolérance de discrétisation des arcs LandXML (10 mm par défaut, `PROJETS_VOIRIE_LANDXML_TOLERANCE_ARC_MM`).
2. Spirales (clothoïdes) : rester refusées, ou approximation documentée et validée (hors périmètre de la décision 2).
3. Séparation des tâches de la validation : sans dérogation aujourd'hui ; une petite équipe à un seul gestionnaire ne peut pas valider ses propres pièces (un ADMIN ou un second compte doit le faire).
4. Faut-il exiger une pièce `VALIDE` (et pas seulement un jeu autorisé) pour annoncer une fonction disponible ? Choix actuel : non (décision 2).
5. Valeurs `obligatoire` et `fonctionsDebloquees` des types de document : celles du lot T1 (deux types obligatoires) ; à confirmer, et types à créer par administration (note de calcul, plan de récolement...).
6. Conservation des fichiers PDF et DWG : aucune aujourd'hui (empreinte seulement) ; le mécanisme du fichier d'origine (lot A1) n'existe que pour les jeux importés et sa décision de rétention reste ouverte.
7. Retour d'un document `VALIDE` (erreur constatée après validation) : seul le retrait ADMIN ou une nouvelle version existent.

## 7. Commits

Au-dessus de `c8049df` (`feat/vague3-integration`), dans l'ordre :

- `b176bdb` contrat du lot D1 (commité en premier)
- `f8cc264` migration 20261104100000 et sa descente, schéma Prisma
- `b18ed84` lecteur LandXML, CRS toujours choisi, spirales refusées ; messages DWG et PDF
- `9719695` documents du dossier et ce que les documents permettent (services, routes, tests, inventaire, isolation)
- `e957dfe` banc PostGIS `documents-projet`
- `21ef4c2` documentation (API, contrôle d'accès, dérive du schéma, contrat d'import)
- `73faa76` nouvelle version possible sur un type désactivé
- `47f7fc0` banc S1 : enveloppe du territoire par défaut
- ce rapport (commit suivant)

Aucun push.
