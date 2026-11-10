# Complétude documentaire et formats d'ingénierie : contrat d'interface (lot D1)

Statut : contrat du 09/11/2026, écrit AVANT le code, commun au backend, au frontend (lot UI-C) et au lot X1 (export du dossier technique). Complète `CONTRAT.md` (socle), `CONTRAT-IMPORT.md` (lecture des fichiers, quarantaine, versions), `CONTRAT-TERRITOIRES.md` (référentiel `TYPE_DOCUMENT`), `CONTRAT-SOURCES.md` (deux sources d'un réseau), `CONTRAT-CONFLITS.md` et `CONTRAT-WORKFLOW.md` (décision de déplacement, récolement). Référence : `C:\ageroute-secours\mandat\DECISION-ARCHITECTURALE-2.md`, sections 6 et 7. Branche : `feat/completude-documentaire` (issue de `feat/vague3-integration`, `c8049df`). Migration : `20261104100000_completude_documentaire` (additive, descente, idempotente ; numérotée après S1 pour garder l'ordre des bases de développement).

## 1. Principe

Un dossier de projet se constitue de pièces qui arrivent dans le désordre, parfois jamais. Le module ne doit **jamais** attendre qu'un dossier soit complet pour rendre un service : chaque fonction a ses propres conditions, et seule l'absence de SES conditions la rend indisponible.

1. **Documents du projet** (`documents_projet_voirie`) : chaque pièce attendue ou reçue est un document typé (référentiel `TYPE_DOCUMENT` du lot T1), versionné, au statut contrôlé, avec son acteur, sa justification et ses dates ; historique en ajout seul écrit par la base.
2. **Ce que les documents permettent** (`GET /:id/completude`) : pour un projet, les fonctions disponibles avec ce qui est autorisé aujourd'hui, et les pièces manquantes avec la fonction que chacune débloquerait.
3. **Formats d'ingénierie** : LandXML lu par un lecteur XML dédié (axes en plan et points), dans le parcours d'import existant ; DWG conservé comme document non exploitable (aucun convertisseur) ; PDF conservé comme document de référence, jamais importé comme géométrie.

## 2. Règles non négociables

Celles de `CONTRAT.md` section 2 et de `CONTRAT-IMPORT.md` section 1, plus :

1. **Aucun fichier binaire n'est stocké** par ce lot. Un document garde une **référence** (texte libre court : numéro de courrier, cote de GED), et, pour un fichier téléversé, son **empreinte SHA-256**, sa taille, son nom et son format détecté par le contenu. Le seul mécanisme de conservation d'un fichier reste celui du fichier d'origine d'un jeu importé (`projets_voirie_fichiers_origine`, `CONTRAT-IMPORT.md` section 10), inchangé.
2. **Suppression logique seulement** (`deletedAt`) ; `DELETE` et `TRUNCATE` refusés par la base ; un document retiré est figé et n'est montré à personne.
3. **Historique en ajout seul**, écrit par un **déclencheur** à chaque insertion et à chaque changement (le service ne peut pas l'oublier) ; `UPDATE`, `DELETE`, `TRUNCATE` de l'historique refusés.
4. **Transitions de statut contrôlées** par le service ET par la base (même matrice, section 4).
5. **Séparation des tâches** : la personne qui a déposé la pièce d'une version ne la valide pas (`VALIDE`), sans dérogation possible dans ce lot ; contrainte de la base en plus du service.
6. **Lecteurs** : un compte qui ne décide pas (autre qu'ADMIN et GESTIONNAIRE) ne voit que les documents `VALIDE` ; le lien vers un jeu n'est rendu que si ce jeu lui est lisible (`AUTORISE` pour un lecteur, jamais `RETIRE`).
7. **Aucune pièce manquante ne bloque une fonction indépendante** (section 6, prouvé par des tests exhaustifs du noyau et par le banc).
8. **Aucun CRS, aucune unité ni aucune coordonnée n'est deviné** pour un LandXML : CRS déclaré par l'utilisateur (liste blanche), unités linéaires métriques exigées, ordre « Nord Est » de la norme.
9. Aucun nom de ville, de concessionnaire, de CRS ni de type de réseau dans le code : les types de document sont des données (référentiel T1), les fonctions et leurs conditions sont des constantes du contrat.

## 3. Modèle de données

### 3.1 `DocumentProjetVoirie` (`documents_projet_voirie`)

Une ligne = **une version** d'un document. Les versions d'un même document forment une **lignée** (`ligneeId` = identifiant de la version 1).

| Colonne | Règle |
|---|---|
| `id` | uuid |
| `projetId` | projet (clé étrangère) ; immuable |
| `ligneeId`, `version`, `remplaceId` | version 1 : `ligneeId = id`, `remplaceId` nul ; version n > 1 : `remplaceId` = la dernière version **non retirée** de la même lignée, et n = le plus grand numéro de la lignée (versions retirées comprises) + 1 (déclencheur ; revue D1, M1 : un retrait ne fige pas la lignée) ; immuables ; `(ligneeId, version)` unique |
| `typeCode` | code du domaine `TYPE_DOCUMENT` (existant et non retiré à l'écriture : `referentiels_voirie_exige`, lot T1 ; actif exigé par le service à la création, une nouvelle version d'un document existant n'exigeant qu'un type non retiré) ; immuable |
| `titre` (1 à 200), `description` (2 000 au plus), `dateDocument` (jour), `concessionnaireId` | immuables après la création (une erreur se corrige par une nouvelle version ou un retrait) |
| `statut` | enum `StatutDocumentProjetVoirie` (section 4) |
| `reference` (300 au plus), `nomFichier` (255), `format`, `sha256` (64 hexadécimaux), `tailleOctets` | la **pièce** ; fixée à la création ou au dépôt sur un document `ATTENDU`, ensuite immuable |
| `jeuId` | jeu de données du **même projet** (déclencheur), quand la pièce est un plan importé ; exclusif d'une empreinte de fichier |
| `creeParId`, `createdAt` | création |
| `deposeParId`, `deposeLe` | dépôt de la pièce (nuls pour `ATTENDU`) |
| `valideParId`, `valideLe` | validation ; `valideParId <> deposeParId` (contrainte) |
| `derniereActionParId`, `derniereActionLe`, `derniereJustification` | dernier geste (création, dépôt, statut, remplacement, retrait) : lus par le déclencheur d'historique |
| `updatedAt`, `deletedAt` | suppression logique |

`format` ∈ `PDF`, `DWG` (fichier téléversé, détecté par la signature), ou le format du jeu lié (`KML`, `KMZ`, `GEOJSON`, `GPX`, `CSV`, `GPKG`, `SHAPEFILE`, `DXF`, `LANDXML`) ; nul pour une pièce référencée sans fichier.

Contraintes `CHECK` : un document `ATTENDU` n'a aucune pièce, tout autre statut en a une (référence, empreinte ou jeu) ; un document non `ATTENDU` a un déposant et une date de dépôt ; empreinte et taille vont ensemble ; empreinte et jeu ne vont pas ensemble ; **un DWG n'est jamais `EXPLOITABLE` ni `VALIDE`** ; `VALIDE` exige un valideur différent du déposant ; `INCOMPLET`, `A_CORRIGER`, `VALIDE`, `REJETE` et le retrait exigent une justification de 10 caractères au moins.

Index uniques partiels : une seule version **en cours** (`ATTENDU`, `RECU`, `EN_ANALYSE`, `INCOMPLET`, `A_CORRIGER`, `EXPLOITABLE`) et une seule version `VALIDE` par lignée, parmi les lignes non retirées.

### 3.2 `DocumentProjetVoirieHistorique` (`documents_projet_voirie_historique`, ajout seul)

`id` (bigint), `documentId`, `projetId`, `ligneeId`, `version`, `action` (`CREATION`, `DEPOT`, `STATUT`, `REMPLACEMENT`, `RETRAIT`), `statutAvant`, `statutApres`, `acteurId`, `justification`, `details` (JSON : format, empreinte, taille, nom du fichier, référence, jeu lié ; **jamais de contenu de fichier ni de géométrie**), `createdAt`. Écrit par le déclencheur `AFTER INSERT OR UPDATE` de la table des documents.

### 3.3 Référentiel `TYPE_DOCUMENT` (lot T1) : paramètre ajouté

`parametres` reçoit un champ **facultatif** `roleJeu` ∈ `AXES_TRAVAUX`, `RESEAU_TIERS`, `LIMITES_ROUTE`, `AUTRE` : le rôle de jeu de données qui fournit cette pièce quand elle est importée. Il relie un type à une condition de fonction (section 6) sans coder de type en dur. La migration le pose sur les trois valeurs système qui l'appellent (`PLAN_AXES` : `AXES_TRAVAUX`, `RESEAU_CONCESSIONNAIRE` : `RESEAU_TIERS`, `LIMITES_ROUTE` : `LIMITES_ROUTE`), en version 2 système (sans acteur), avec une ligne d'historique `MIGRATION` ; la descente les rend en version 1. Aucun type n'est ajouté : **un format n'est pas un type** (un plan d'axes livré en DWG est un document de type `PLAN_AXES` au format `DWG`). Un type se crée par administration (`POST /referentiels/TYPE_DOCUMENT`). Retirer un type porté par un document non retiré : 409 `VALEUR_UTILISEE` (désactiver plutôt).

### 3.4 `FormatJeuProjet`

Valeur `LANDXML` ajoutée (section 7).

## 4. Statuts et transitions

| Statut | Sens |
|---|---|
| `ATTENDU` | pièce demandée, pas encore reçue |
| `RECU` | pièce reçue (référence, fichier ou jeu), pas encore examinée |
| `EN_ANALYSE` | en cours d'examen |
| `EXPLOITABLE` | lisible et utilisable pour ce à quoi elle sert ; un DWG ne l'est jamais ; une pièce liée à un jeu ne l'est que si le jeu est `AUTORISE` |
| `INCOMPLET` | il manque une partie (justification) |
| `A_CORRIGER` | erreur à corriger par le fournisseur (justification) |
| `VALIDE` | validée par une autre personne que le déposant (justification) |
| `REJETE` | refusée définitivement (justification) ; terminal |
| `REMPLACE` | une version plus récente l'a remplacée ; terminal ; posé par le serveur seulement |

Matrice (service `documents/etats.noyau.ts` et déclencheur `documents_projet_voirie_controle`, identiques) :

| De | Vers (route `statut`) | Vers (serveur seulement) |
|---|---|---|
| `ATTENDU` | aucune | `RECU` (route `depot`) |
| `RECU` | `EN_ANALYSE`, `REJETE` | `REMPLACE` (nouvelle version déposée) |
| `EN_ANALYSE` | `EXPLOITABLE`, `INCOMPLET`, `A_CORRIGER`, `REJETE` | `REMPLACE` (nouvelle version déposée) |
| `INCOMPLET` | `EN_ANALYSE`, `REJETE` | `REMPLACE` (nouvelle version déposée) |
| `A_CORRIGER` | `EN_ANALYSE`, `REJETE` | `REMPLACE` (nouvelle version déposée) |
| `EXPLOITABLE` | `VALIDE`, `A_CORRIGER`, `REJETE` | `REMPLACE` (nouvelle version déposée) |
| `VALIDE` | aucune | `REMPLACE` (une version plus récente devient `VALIDE`) |
| `REJETE`, `REMPLACE` | aucune | aucune |

Refus : transition hors matrice 409 `TRANSITION_INTERDITE` (avec `de`, `vers`, `possibles`) ; `EXPLOITABLE` ou `VALIDE` d'un DWG 409 `DOCUMENT_NON_EXPLOITABLE` (avec l'aide à l'export DXF) ; `EXPLOITABLE` ou `VALIDE` d'une pièce liée à un jeu qui n'est pas `AUTORISE` 409 `JEU_NON_AUTORISE` ; `VALIDE` par le déposant 409 `SEPARATION_DES_TACHES` ; justification absente ou courte 400 `JUSTIFICATION_INVALIDE`.

**Versions** : `POST .../versions` sur la dernière version **non retirée** d'une lignée crée la version suivante (`RECU`, numéro = plus grand numéro de la lignée + 1). La version précédente passe `REMPLACE` tout de suite si elle était en cours (`RECU`, `EN_ANALYSE`, `INCOMPLET`, `A_CORRIGER`, `EXPLOITABLE`) ; une version `VALIDE` le reste jusqu'à ce que la nouvelle devienne `VALIDE` (le dossier garde une pièce valide pendant l'examen de la suivante) ; une version `REJETE` reste `REJETE`. Sur un document `ATTENDU` : 409 `DOCUMENT_ATTENDU` (utiliser `depot`). Sur une version qui n'est pas la dernière non retirée : 409 `VERSION_NON_COURANTE` ; sur une version retirée : 404. **Retrait de la dernière version** (revue D1, M1) : la précédente redevient la dernière ; si elle est `REMPLACE` (sa remplaçante a été retirée), elle reste `REMPLACE` (terminal), reste visible dans la liste des versions courantes, compte comme pièce manquante, et la lignée repart d'elle par une nouvelle version.

## 5. API (préfixe `/api/v2/projets-voirie`, mêmes gardes que le socle, dans le même ordre)

Jeton, clé de module `projets-voirie`, compte référent confiné au workflow (403), octet NUL (400), identifiants d'URL en UUID (400 `IDENTIFIANT_INVALIDE`), rôle pour les écritures (403), **projet désigné : 404 masqué hors périmètre, 404 `PROJET_INTROUVABLE` à tous pour un projet inexistant ou retiré**, validation stricte (400), service. `Cache-Control: no-store`.

| Route | Rôle | Contenu |
|---|---|---|
| `GET /:id/documents` | lecture | `?statut=A,B&typeCode=&versions=courantes|toutes&limite=(1..100, 50)&curseur=` : `{ documents: [vue], curseurSuivant }` ; `courantes` (défaut) écarte les versions `REMPLACE` ; un lecteur ne reçoit que des `VALIDE` |
| `GET /:id/documents/:docId` | lecture | `{ document: vue, versions: [ { id, version, statut, createdAt } ], historique: [...] }` (historique et versions non `VALIDE` : décideurs seulement) ; 404 `DOCUMENT_INTROUVABLE` (inexistant, retiré, autre projet, ou non `VALIDE` pour un lecteur) |
| `POST /:id/documents` | ADMIN, GESTIONNAIRE | JSON ou multipart : `{ typeCode, titre, description?, dateDocument?, concessionnaireId?, reference?, jeuId? }` + `fichier?` (PDF ou DWG) : sans pièce, `ATTENDU` ; avec pièce, `RECU`. 201 `{ document, avertissements }` |
| `POST /:id/documents/:docId/depot` | ADMIN, GESTIONNAIRE | pièce (`reference?`, `jeuId?`, `fichier?`, au moins une) sur un document `ATTENDU` : `RECU`. `{ document, avertissements }` ; 409 `STATUT_INCOMPATIBLE` sinon |
| `POST /:id/documents/:docId/versions` | ADMIN, GESTIONNAIRE | pièce de la version suivante (`reference?`, `jeuId?`, `fichier?`, au moins une) : 201 `{ document, remplace: { id, statut }, avertissements }` |
| `POST /:id/documents/:docId/statut` | ADMIN, GESTIONNAIRE | `{ statut, justification? }` (section 4) : `{ document }` |
| `DELETE /:id/documents/:docId` | ADMIN, GESTIONNAIRE (version `VALIDE` : ADMIN seul, 403 `ROLE_INSUFFISANT`) | `{ justification }` : retrait logique `{ id, retire: true }` |
| `GET /:id/completude` | lecture | section 6 |

Fichier téléversé : multipart, champ `fichier`, 25 Mo au plus (413 `FICHIER_TROP_GROS`), même place de réception que le dépôt d'un jeu (503 `SERVICE_OCCUPE`). Le format est lu **par le contenu** : `%PDF-` donne `PDF`, `AC10xx` donne `DWG` ; tout autre contenu répond 415 `FORMAT_DOCUMENT_NON_PRIS_EN_CHARGE` (un plan géographique passe par l'import, puis se lie au document par `jeuId`). Le fichier est lu en mémoire pour l'empreinte et n'est **jamais écrit** : ni en base, ni sur disque.

Vue d'un document : `{ id, projetId, ligneeId, version, remplaceId, typeCode, type: { code, libelle, actif } | null, titre, description, dateDocument, concessionnaire: { id, nom } | null, statut, piece: { reference, nomFichier, format, sha256, tailleOctets }, jeu: { id, statut, role, version, format } | null, exploitable: { possible, raison }, aide: texte | null, creePar, createdAt, deposePar, deposeLe, validePar, valideLe, derniereAction: { par, le, justification }, transitionsPossibles: [statut] (décideurs) }`. `jeu` est nul si le jeu n'est pas lisible par le compte ; dans ce cas `exploitable` est nul aussi (il trahirait le statut du jeu), et `piece.jeuLie` est nul pour un compte qui ne décide pas (revue D1, m5). Fiche : `versionsTronquees`, `historiqueTronque` (les 200 versions et les 500 gestes les plus récents sont gardés, revue D1, m7) ; dans l'historique, `details.jeuId`, `nomFichier` et `format` d'un jeu illisible (jamais un jeu `RETIRE`) sont retirés (`jeuMasque: true`, m4) ; l'historique des versions retirées reste visible des décideurs (trace du retrait). Les lectures (liste, fiche, complétude) passent par une transaction `READ ONLY` à délais côté base (m8 ; 504 `DOCUMENTS_LECTURE_TROP_LONGUE`).

Avertissements de dépôt : `DWG_NON_EXPLOITABLE` (avec la marche à suivre pour exporter en DXF), `PDF_REFERENCE` (un PDF reste une pièce de référence, jamais une géométrie), `JEU_NON_AUTORISE` (la pièce est liée à un jeu en quarantaine).

Textes libres (revue D1, m11) : `titre` et `reference` sans caractère de contrôle C0 ; `description` et `justification` sans contrôle C0 hors tabulation et sauts de ligne ; aucun des quatre ne porte de surcharge de direction (U+200E, U+200F, U+202A à U+202E, U+2066 à U+2069) : 400 `CHAMPS_INVALIDES` ou `JUSTIFICATION_INVALIDE`. Le nom d'un fichier téléversé est nettoyé des mêmes caractères. Un export du journal des documents (lot X1) devra en plus neutraliser les préfixes de formule (`=`, `+`, `-`, `@`).

Erreurs ajoutées : 400 `CHAMPS_INVALIDES`, `JUSTIFICATION_INVALIDE`, `TYPE_DOCUMENT_INCONNU` (code inconnu, retiré ou inactif), `CONCESSIONNAIRE_INCONNU`, `PIECE_REQUISE`, `PIECE_EXCLUSIVE` (fichier et jeu ensemble) ; 403 `ROLE_INSUFFISANT` ; 404 `DOCUMENT_INTROUVABLE`, `JEU_INTROUVABLE` (jeu d'un autre projet ou retiré) ; 409 `TRANSITION_INTERDITE`, `STATUT_INCOMPATIBLE`, `DOCUMENT_ATTENDU`, `VERSION_NON_COURANTE`, `VERSION_EN_COURS`, `DOCUMENT_NON_EXPLOITABLE`, `JEU_NON_AUTORISE`, `SEPARATION_DES_TACHES`, `REFERENCE_INVALIDE` et `CONTRAINTE_DOCUMENT` (refus de la base traduits, revue D1 m9 : jamais un 500) ; 415 `FORMAT_DOCUMENT_NON_PRIS_EN_CHARGE` ; 504 `DOCUMENTS_LECTURE_TROP_LONGUE`.

**Audit** (`audit_logs`, type `DocumentProjetVoirie`) : `CREATE` (création), `UPDATE` (dépôt, statut, remplacement), `VALIDATE` (`VALIDE`), `REJECT` (`REJETE`), `DELETE` (retrait), dans la transaction de l'écriture ; valeurs avant et après = vue de la version sans contenu de fichier ni géométrie.

## 6. Ce que les documents permettent (`GET /:id/completude`)

Lecture seule (`READ ONLY`, `statement_timeout` de la carte), pour tout compte qui a la clé du module ; seuls les jeux **`AUTORISE`** comptent, pour tous les rôles.

### 6.1 Conditions et fonctions (constantes du contrat)

| Condition | Remplie quand |
|---|---|
| `PLAN_AXES_AUTORISE` | au moins un jeu `AXES_TRAVAUX` `AUTORISE` |
| `RESEAU_AUTORISE` | au moins un jeu `RESEAU_TIERS` `AUTORISE` |
| `DEUX_SOURCES_MEME_RESEAU` | au moins un réseau porte deux jeux `AUTORISE` ou plus ; deux jeux sont deux sources du même réseau **si et seulement si l'éligibilité du lot S1 l'accepte** (`evaluerEligibilité`, mode `SOURCES`), appelée par la complétude avec `typeReseauCode` (revue D1, M2) : aucune règle d'identité propre, la complétude suit la correction M3 de la revue T1+S1 (code `TYPE_RESEAU` dans l'identité) sans changement |
| `DECISION_DEPLACEMENT` | au moins une décision `DEPLACER_RESEAU` `APPROUVEE` sur un dossier `TRAITEMENT_DECIDE` ou `CLOTURE` du projet (dossier visible du compte : pour un lecteur, ses jeux liés sont `AUTORISE`) |

| Fonction | Conditions |
|---|---|
| `ANALYSE_2D` | `PLAN_AXES_AUTORISE`, `RESEAU_AUTORISE` |
| `CONFLITS` | `PLAN_AXES_AUTORISE`, `RESEAU_AUTORISE` |
| `COMPARAISON_SOURCES` | `DEUX_SOURCES_MEME_RESEAU` |
| `RECOLEMENT` | `DECISION_DEPLACEMENT` |
| `EXPORT_DOSSIER` | aucune : **fonction non livrée** (lot X1), état `NON_LIVREE` |

Une fonction est `DISPONIBLE` si et seulement si toutes SES conditions sont remplies. Aucune autre donnée (document attendu, type obligatoire non fourni, DWG reçu, pièce `INCOMPLET`, autre réseau, autre fonction) n'intervient : c'est l'invariant d'indépendance, testé par énumération de tous les états du noyau.

### 6.2 Pièces manquantes

Chaque pièce manquante porte `fonctions` (les fonctions indisponibles qui l'exigent) et `suffiraitPour` (celles qui deviendraient disponibles si cette seule pièce arrivait, calculé en rejouant le noyau) :

- `nature: "CONDITION"` : `PLAN_AXES_AUTORISE`, `RESEAU_AUTORISE`, `DECISION_DEPLACEMENT`, et `SECONDE_SOURCE` (une par réseau qui n'a qu'une source, avec son concessionnaire et sa famille ; une seule, générique, si le projet n'a aucun réseau) ; avec les `typesDocument` actifs dont `roleJeu` fournit la condition et, pour un décideur, les `documents` en cours de ces types (`ATTENDU`, `RECU`, `EN_ANALYSE`, `INCOMPLET`, `A_CORRIGER`, `EXPLOITABLE`) ;
- `nature: "TYPE_OBLIGATOIRE"` : un type actif `obligatoire` qui n'est pas **fourni** (fourni = un jeu `AUTORISE` de son `roleJeu`, ou un document `VALIDE` de ce type dont le jeu lié, s'il y en a un, n'est pas `RETIRE` : revue D1, m5) ; `fonctions` = ses `fonctionsDebloquees` encore indisponibles (vide si elles sont déjà disponibles : la pièce manque au dossier sans rien bloquer) ;
- `nature: "DOCUMENT"` (décideurs seulement) : un document en cours ou rejeté sans version plus récente, avec les fonctions de son type encore indisponibles.

Réponse : `{ projetId, calculeLe, fonctions: [ { code, etat: DISPONIBLE|INDISPONIBLE|NON_LIVREE, conditions: [ { code, remplie, nb } ], raison } ], reseaux: [ { concessionnaireId, concessionnaire, typeReseau, typeReseauCode, nbSources, comparable } ], piecesManquantes: [...], documents: { total, parStatut }, regle }` (`documents` : un lecteur ne compte que les `VALIDE` ; `documents.tronque` : plus de 5 000 documents, les plus récents sont lus, revue D1 m7).

## 7. Formats d'ingénierie

### 7.1 LandXML (`FormatJeuProjet.LANDXML`)

Détection par le contenu : document XML dont la racine est `LandXML` (lecteur `xml.noyau.ts` : DTD et entités refusées, `DTD_REFUSEE`, `ENTITE_REFUSEE`, aucune ressource externe, plafonds d'éléments, d'attributs et de profondeur ; 25 Mo ; sommets par objet et par fichier du socle). Il suit **le même parcours** que les autres formats : inventaire, aperçu (aucune écriture), simulation, dépôt en quarantaine `CONTROLE`, CRS, mapping, validation géométrique, delta, revue des suppressions, retour arrière.

| Élément | Traitement |
|---|---|
| `Alignments/Alignment/CoordGeom` | un objet `LIGNE` par axe (couche `alignements`), éléments mis bout à bout ; une discontinuité de plus d'1 mm ouvre une nouvelle partie (avertissement `LANDXML_DISCONTINUITES`) |
| `Line` | segment `Start` → `End` |
| `Curve` (arc de cercle) | **discrétisé** : `Start`, `Center`, `End`, `rot` (`cw` ou `ccw`) ; corde de flèche au plus égale à la **tolérance** (`PROJETS_VOIRIE_LANDXML_TOLERANCE_ARC_MM`, défaut **10 mm**, bornes 1 à 1 000 mm, valeur de protection à valider par le DSI) ; extrémités exactes ; 10 000 segments au plus par arc |
| `IrregularLine` | polyligne de `PntList2D` |
| `Line` ou `IrregularLine` dont une coordonnée est absente ou illisible (`Start`, `End`, `pntRef` vers un point illisible, `PntList2D` impaire ou de moins de deux points) | 422 `LANDXML_COORDONNEE_ILLISIBLE` (revue D1, M3 : l'axe est refusé, jamais déposé tronqué) |
| `Spiral`, `Chain` | **refusés** : 422 `LANDXML_SPIRALE_NON_PRISE_EN_CHARGE` (la clothoïde n'est pas approchée) ; l'inventaire les compte et prévient |
| arc dégénéré (rayon nul, rayons de départ et d'arrivée incohérents au-delà de la tolérance, départ égal à l'arrivée, sens absent, coordonnée illisible) | 422 `LANDXML_ARC_DEGENERE` (numéro de l'axe et de l'élément, jamais de coordonnée) |
| `pntRef` | résolu dans les `CgPoints` du fichier ; introuvable : 422 `LANDXML_POINT_INTROUVABLE` |
| `CgPoints/CgPoint` | un objet `POINT` par point (couche `cgpoints`), attributs `name`, `code`, `desc` ; altitude ignorée (avertissement du socle) |
| `Profile`, `Surfaces/Surface`, autres éléments (`Parcels`, `PipeNetworks`, `Roadways`...) | ignorés et **comptés** (`LANDXML_PROFILS_IGNORES`, `LANDXML_SURFACES_IGNOREES`, `LANDXML_ELEMENTS_IGNORES`) |

**Coordonnées** : la norme LandXML écrit « Nord Est [altitude] » ; le lecteur prend X = Est, Y = Nord. **Unités** : `Units/Metric` avec `linearUnit="meter"` exigé (422 `UNITES_REQUISES` sans unité, `LANDXML_UNITES_NON_SUPPORTEES` sinon, et aussi pour une déclaration ambiguë : plusieurs `Units`, ou `Metric` et `Imperial` ensemble, revue D1 m1) : aucune mise à l'échelle. **CRS jamais déduit** : `epsgSource` obligatoire (422 `CRS_REQUIS`), dans la liste blanche (`CRS_NON_AUTORISE`), projeté en mètres (`CRS_INCOMPATIBLE_FORMAT` pour EPSG:4326 ou un CRS géographique) ; un `CoordinateSystem/@epsgCode` présent (`32629`, `EPSG:32629` ou `urn:ogc:def:crs:EPSG::32629`) est montré par l'inventaire et doit concorder (`CRS_CONFLIT`), il ne vaut jamais confirmation ; une valeur non reconnue est montrée (« non reconnu : ... ») et refusée (422 `CRS_NON_SUPPORTE`, revue D1 m6). Les coordonnées sont transformées par PostGIS (`ST_Transform`) comme celles d'un CSV, puis contrôlées contre l'emprise nationale (un fichier aux axes inversés tombe hors zone : `HORS_GUINEE`). `resume.import.landxml` : `{ toleranceArcM, nbAlignements, nbLignes, nbArcs, nbIrreguliers, sommetsArcs, nbPoints, nbSurfacesIgnorees, nbProfilsIgnores, nbAutresIgnores, crsDeclare, unites }`.

### 7.2 DWG

Aucun convertisseur (décision 2, section 9). À l'import : 415 `FORMAT_NON_SUPPORTE` avec un message qui explique comment exporter en DXF et comment conserver le DWG comme document. Comme document : statut `RECU`, `exploitable.possible = false`, avertissement `DWG_NON_EXPLOITABLE` ; il ne peut devenir ni `EXPLOITABLE` ni `VALIDE` (service et contrainte de la base) ; la suite normale est une **nouvelle version** liée au jeu importé depuis le DXF (`jeuId`).

### 7.3 PDF

Pièce de référence (référence et empreinte) : jamais importé comme géométrie (à l'import : 422 `CONTENU_NON_RECONNU`, message qui renvoie aux documents). Il peut devenir `EXPLOITABLE` et `VALIDE` comme pièce du dossier.

## 8. Migration

`20261104100000_completude_documentaire` : type `StatutDocumentProjetVoirie`, valeur `LANDXML` de `FormatJeuProjet`, deux tables, contraintes `CHECK`, index uniques partiels, déclencheurs (contrôle d'écriture et matrice des transitions, historique écrit par la base, ajout seul, suppression et troncature refusées, code `TYPE_DOCUMENT` vérifié), paramètre `roleJeu` des trois types système. Descente `backend/prisma/descentes/20261104100000_completude_documentaire.sql` : refuse sans dérogation si un document existe (`bdri.perte_autorisee`), refuse même avec dérogation si un jeu porte `LANDXML` (aucune valeur de remplacement inventée) ; rend les trois types en version 1 sans `roleJeu`.

## 9. Tests exigés

Noyaux (Vitest) : matrice des transitions, séparation des tâches, DWG non exploitable, versions ; complétude (indépendance prouvée par énumération de tous les états, `suffiraitPour`, types obligatoires, lecteur) ; LandXML (lignes, arcs dans les deux sens et tolérance mesurée, spirale, arc dégénéré, CRS absent, unités, XXE, entités, bombe d'entités, bombe de sommets, `pntRef`, surfaces comptées). Routes (supertest, vrais gardes, services simulés). Banc PostGIS `documents-projet.integration.mts` (clone de `replay`) : parcours complet, séparation des tâches, transitions refusées par la base en SQL direct, historique écrit par la base, lecteur, 404 masqué, projet supprimé, LandXML déposé de bout en bout (aperçu, quarantaine, autorisation, analyse 2D), DWG et PDF, complétude et indépendance sur données réelles, isolation (comptes de toutes les tables) et audit sans contenu. Mutations sur au moins trois gardes.

## 10. Ce que ce lot ne fait pas (décidé)

Pas d'interface (UI-C) ; pas de stockage de fichier ; pas de convertisseur DWG ; pas de spirale ni de profil en long ; pas de dérogation à la séparation des tâches ; pas de retour d'un document `VALIDE` à un autre statut que `REMPLACE` ; pas d'export du dossier (X1) ; la condition `DECISION_DEPLACEMENT` ne vérifie pas qu'une approbation est « en vigueur » après une reconfirmation du dossier (la création d'un récolement, lot B3, le vérifie).
