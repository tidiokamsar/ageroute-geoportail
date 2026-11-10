# Export du dossier technique et tableaux de bord : contrat d'interface (lot X1)

Statut : contrat du 10/11/2026, écrit AVANT le code, commun au backend et au frontend (lot UI-C). Complète `CONTRAT.md` (socle), `CONTRAT-CONFLITS.md` (dossiers de conflit et leur export CSV), `CONTRAT-DOCUMENTS.md` (documents, complétude), `CONTRAT-SOURCES.md` (sources multiples), `CONTRAT-TERRITOIRES.md` (territoires, `GET /territoires/comptes`) et `API.md`. Référence : `C:\ageroute-secours\mandat\DECISION-ARCHITECTURALE-2.md`, sections 8 et 10, et les précisions après la revue T1+S1. Branche : `feat/exports-tableaux-de-bord` (issue de `feat/vague3-integration`, `facba4e`). Migration : `20261104200000_exports_tableaux_de_bord` (additive, descente, idempotente). Les numéros `20261103400000` (correctifs de la revue T1+S1) et `20261104100000` (D1) sont pris.

## 1. Principe

Deux livrables, sans rien changer aux règles de lisibilité du socle :

1. **Export du dossier technique d'un projet** : une archive ZIP produite par le serveur, bornée, auditée AVANT la remise, réservée aux comptes qui décident, qui rassemble ce que ces comptes peuvent déjà lire par l'API (fiche, agrégats d'analyse, dossiers de conflit, journal des documents, complétude) et, seulement si la confidentialité le permet, le GeoJSON des jeux `AUTORISE`. Un manifeste donne l'empreinte SHA-256 de chaque fichier.
2. **Tableaux de bord national et par territoire** : des **agrégats seulement** (nombres), jamais de géométrie ni de nom d'objet, filtrés par le périmètre du compte, et pour un compte qui ne décide pas, calculés sur ce qu'il peut lire.

## 2. Règles non négociables

Celles de `CONTRAT.md` section 2, de `CONTRAT-CONFLITS.md` point 17 (lisibilité) et de `CONTRAT-DOCUMENTS.md`, plus :

1. **Mêmes gardes que le socle, dans le même ordre** : jeton, clé de module `projets-voirie`, compte référent confiné au workflow (403), octet NUL (400), identifiants d'URL en UUID (400), rôle, ressource désignée (projet ou territoire : 404 identique si inexistant, retiré ou hors périmètre), validation stricte (400), service. **Projet retiré : 404 `PROJET_INTROUVABLE` pour tous**, ADMIN national compris (contrôle du service).
2. **Décideurs** : l'export et son journal sont réservés à `ADMIN` et `GESTIONNAIRE` **du périmètre du projet** (garde territoriale à 404 masqué). La dérogation de confidentialité est réservée à l'`ADMIN`.
3. **Rien d'un jeu non lisible pour le compte** : un jeu `RETIRE` n'apparaît nulle part dans l'archive (ni fiche, ni GeoJSON, ni colonnes du CSV des dossiers, ni identifiant ou nom de fichier dans le journal des documents). Un jeu non `AUTORISE` (reçu, contrôlé, rejeté, remplacé) est décrit dans la fiche (le décideur le lit déjà) mais **n'est jamais exporté en GeoJSON** ni compté dans les agrégats d'analyse.
4. **GeoJSON selon la confidentialité** : seuls les jeux `AUTORISE` d'un niveau **exportable** (section 4.3). **Jamais** `CONFIDENTIEL_CONCESSIONNAIRE` ni `INFRASTRUCTURE_SENSIBLE`, sauf **dérogation ADMIN justifiée, tracée et à usage unique** (section 5). Aucun réglage ne rend ces deux niveaux exportables.
5. **Toute écriture est auditée sans géométrie** : la remise d'une archive (journal + audit `ExportDossierProjetVoirie`, écrits AVANT l'envoi : un échec d'audit = pas d'archive), la création et la consommation d'une dérogation (`DerogationExportProjetVoirie`). L'audit porte empreintes, nombres, identifiants, niveaux de confidentialité ; jamais une coordonnée.
6. **Tableaux de bord** : agrégats seulement ; aucun nom d'objet, de fichier, de concessionnaire ni de document ; un compte qui ne décide pas ne compte que les jeux `AUTORISE`, les dossiers de conflit qu'il voit (tous leurs jeux liés `AUTORISE`, jeu B d'une comparaison compris), aucun document en cours, aucun référent (section 6.3).
7. SQL brut à **valeurs liées** seulement ; délais **côté base** (`poserDelais`, `statement_timeout`, `lock_timeout`) sur toute lecture de ce lot ; cadence par compte et plafond de concurrence.
8. Aucun nom de ville, de concessionnaire, de CRS ni de type de réseau dans le code ; fixtures synthétiques.

## 3. Modèle de données (migration `20261104200000_exports_tableaux_de_bord`)

Deux tables, sans relation Prisma (clés étrangères en SQL seulement, comme les lots B3 et D1), en fin de `schema.prisma`.

### 3.1 `exports_dossier_projet_voirie` (journal des exports, ajout seul)

| Colonne | Type | Règle |
|---|---|---|
| `id` | texte | uuid de l'export (aussi dans le manifeste) |
| `projetId` | texte | clé étrangère `projets_voirie` |
| `acteurId` | texte | clé étrangère `users` (le compte qui a reçu l'archive) |
| `sha256` | texte | empreinte de l'archive remise (`^[0-9a-f]{64}$`) |
| `tailleOctets` | entier | > 0 |
| `nbFichiers` | entier | >= 1 |
| `nbJeuxGeojson` | entier | >= 0 |
| `manifeste` | JSON objet | le manifeste (chemins, tailles, empreintes, jeux exportés et écartés avec leur raison) ; **aucune géométrie** |
| `createdAt` | horodatage | |

`UPDATE`, `DELETE` et `TRUNCATE` refusés (déclencheurs). Index `(acteurId, createdAt)` (cadence) et `(projetId, createdAt)` (journal).

### 3.2 `derogations_export_projet_voirie` (dérogations de confidentialité)

| Colonne | Type | Règle |
|---|---|---|
| `id` | texte | uuid |
| `projetId` | texte | clé étrangère `projets_voirie` |
| `jeuxIds` | texte[] | 1 à 20 jeux du projet couverts |
| `beneficiaireId` | texte | clé étrangère `users` : le seul compte qui peut la consommer |
| `accordeeParId` | texte | clé étrangère `users` : l'ADMIN qui l'a accordée |
| `justification` | texte | 20 à 2 000 caractères |
| `createdAt`, `expireLe` | horodatages | `expireLe` après `createdAt`, au plus 7 jours après |
| `utiliseeLe`, `exportId` | nuls ensemble ou posés ensemble (CHECK) | `exportId` clé étrangère `exports_dossier_projet_voirie`, unique |

Déclencheur : toutes les colonnes sont **immuables**, sauf le couple (`utiliseeLe`, `exportId`) qui passe **une seule fois** de nul à renseigné, et seulement avant `expireLe` (usage unique garanti par la base, même en SQL direct). `DELETE` et `TRUNCATE` refusés.

## 4. Export du dossier technique

### 4.1 Routes (préfixe `/api/v2/projets-voirie`)

| Route | Rôle | Réponse |
|---|---|---|
| `GET /:id/export/dossier` | ADMIN, GESTIONNAIRE | `?geojson=true\|false` (défaut `true`) `&derogation=<uuid>` : 200 `application/zip`, `Content-Disposition: attachment; filename="dossier-<code>-<AAAA-MM-JJ>.zip"`, en-têtes `X-Export-Id`, `X-Empreinte-Sha256`, `X-Fichiers`, `X-Jeux-Geojson` |
| `GET /:id/export/journal` | ADMIN, GESTIONNAIRE | `?limite=(1..100, 50)` : `{ exports: [ { id, acteur: { id, nomComplet }, createdAt, sha256, tailleOctets, nbFichiers, nbJeuxGeojson, derogationId } ] }`, plus récents d'abord |
| `POST /:id/export/derogations` | ADMIN | `{ jeuxIds: uuid[1..20], justification (20..2000), beneficiaireId?: uuid (défaut : l'ADMIN), dureeHeures?: 1..168 (défaut `PROJETS_VOIRIE_EXPORT_DEROGATION_DUREE_H`) }` : 201 `{ derogation }` |
| `GET /:id/export/derogations` | ADMIN | `{ derogations: [vue] }`, 100 plus récentes |

Vue d'une dérogation : `{ id, projetId, jeuxIds, beneficiaire: { id, nomComplet }, accordeePar: { id, nomComplet }, justification, createdAt, expireLe, utiliseeLe, exportId, etat: DISPONIBLE|UTILISEE|EXPIREE }`.

### 4.2 Contenu de l'archive (racine `dossier-<code en minuscules>/`, ordre fixe)

| Fichier | Contenu |
|---|---|
| `LISEZMOI.txt` | ce qu'est le dossier, ce qu'il n'est pas (aide à la décision, aucun ordre), comment vérifier les empreintes |
| `fiche-projet.json` | projet (code, nom, territoire et ancêtres, commune, préfecture, région, catégorie, largeurs et leur statut, description), jeux **non retirés** (rôle, concessionnaire, type, fichier d'origine, format, empreinte, version, statut, confidentialité, nature, précision, méthode, dates, nombre d'objets, longueurs, décision : par, le) ; **ni `resume` ni avertissements du dépôt** |
| `fiche-projet.pdf` | la même fiche en PDF texte simple (police standard Helvetica, WinAnsi), suivie des agrégats principaux, des comptes de dossiers et de la complétude |
| `analyse/agregats.json` | analyse 2D indicative sur les seuls jeux `AUTORISE` (paramètres, totaux par type, par concessionnaire, par nature, totaux de conflits, par axe **sans liste d'objets**), **sans** couche de croisements ni zones (géométries) ; plus le résumé de la dernière analyse de conflits persistée. Si l'analyse est refusée (volume, délai, largeurs), `disponible: false` et le code : l'export continue |
| `conflits/dossiers.csv` | **le CSV existant** des dossiers de conflit (`GET /:id/conflits/export.csv`, mêmes colonnes, même règle de lisibilité, même neutralisation des formules), sans filtre |
| `documents/journal.json` et `documents/journal.csv` | documents non retirés, toutes versions (vue du lot D1 pour le compte), et historique de leurs lignées (écrit par la base) ; le jeu lié n'est désigné que s'il est lisible ; les détails d'historique qui désignent un jeu `RETIRE` sont masqués (`jeuId`, `nomFichier`, `format`) ; CSV neutralisé contre l'injection de formules |
| `documents/completude.json` | « ce que les documents permettent » (lot D1), vue du compte |
| `geojson/<role>-v<version>-<jeuId>.geojson` | un `FeatureCollection` RFC 7946 (WGS 84, 7 décimales) par jeu **exportable** (4.3) : propriétés `objetId`, `nom`, `typeGeom`, `longueurM`, `ordre` ; membre étranger `bdri: { jeuId, role, version, sha256Source, confidentialite, derogation }` ; **les attributs du fichier source ne sont pas exportés** |
| `manifeste.json` | `{ format: "BDRI-DOSSIER-1", exportId, projet: { id, code }, acteur: { id, role }, genereLe, geojson: { demande, niveauxExportables, inclus: [ { jeuId, version, confidentialite, nbObjets, derogation } ], ecartes: [ { jeuId, version, role, confidentialite, raison } ] }, derogationId, bornes, fichiers: [ { chemin, octets, sha256 } ], avertissements }` (tous les fichiers sauf lui-même et `manifeste.sha256`) |
| `manifeste.sha256` | une ligne `<sha256>  <chemin relatif>` par fichier, `manifeste.json` compris (vérifiable par `sha256sum -c`) |

Raisons d'écart d'un jeu (`ecartes[].raison`) : `NON_AUTORISE` (en contrôle, reçu, rejeté, remplacé), `CONFIDENTIALITE` (niveau non exportable sans dérogation), `NIVEAU_NON_EXPORTABLE` (niveau retiré de la liste par le réglage), `GEOJSON_NON_DEMANDE` (`geojson=false`). Un jeu `RETIRE` n'est pas listé.

**Archive** : ZIP sans ZIP64, entrées `deflate` (ou `stocke` si la compression n'apporte rien), noms UTF-8 ASCII, dates DOS de l'export (UTC), aucun attribut Unix, aucune archive imbriquée. Le producteur est **déterministe** : mêmes entrées, mêmes octets.

### 4.3 Niveaux exportables

Défaut : `PUBLIC`, `INTERNE`, `RESTREINT_PROJET` (le dossier est celui du projet). Le réglage `PROJETS_VOIRIE_EXPORT_GEOJSON_NIVEAUX` (liste séparée par des virgules) peut **restreindre** cette liste (une valeur hors de ces trois niveaux est ignorée ; une liste vide ou illisible redonne le défaut). `CONFIDENTIEL_CONCESSIONNAIRE` et `INFRASTRUCTURE_SENSIBLE` ne sont jamais exportables sans dérogation. **Valeur à confirmer par le DSI** (en particulier `RESTREINT_PROJET`).

### 4.4 Bornes, délai, cadence, concurrence (réglages bornés : une valeur illisible ou hors bornes redonne le défaut)

| Réglage | Défaut | Bornes | Effet |
|---|---|---|---|
| `PROJETS_VOIRIE_EXPORT_OBJETS_MAX` | 50 000 | 1 000 à 500 000 | objets au plus dans l'ensemble des GeoJSON (422 `EXPORT_TROP_VOLUMINEUX`, compté AVANT toute lecture de géométrie) |
| `PROJETS_VOIRIE_EXPORT_SOMMETS_MAX` | 1 000 000 | 10 000 à 10 000 000 | sommets au plus dans l'ensemble des GeoJSON (422 `EXPORT_TROP_VOLUMINEUX`, idem) |
| `PROJETS_VOIRIE_EXPORT_TAILLE_MAX_OCTETS` | 67 108 864 (64 Mo) | 1 Mo à 512 Mo | taille de l'archive (422 `EXPORT_TROP_VOLUMINEUX`) |
| `PROJETS_VOIRIE_EXPORT_DELAI_MS` | 120 000 | 10 000 à 600 000 | délai total de fabrication (504 `EXPORT_TROP_LONG`) ; chaque lecture a en plus son `statement_timeout` côté base |
| `PROJETS_VOIRIE_EXPORT_CADENCE_MAX` | 10 | 1 à 1 000 | archives remises au plus par compte sur la fenêtre (429 `EXPORT_TROP_FREQUENT`, `Retry-After`), compté en base (journal), vérifié avant ET sous verrou consultatif au moment de la remise |
| `PROJETS_VOIRIE_EXPORT_CADENCE_FENETRE_S` | 3 600 | 60 à 86 400 | fenêtre glissante de la cadence |
| `PROJETS_VOIRIE_EXPORT_DEROGATION_DUREE_H` | 24 | 1 à 168 | durée de validité par défaut d'une dérogation |

Concurrence (processus) : **2 exports simultanés** au plus (attente 5 s, puis 503 `SERVICE_OCCUPE`), **1 par compte** (503 `SERVICE_OCCUPE` immédiat). Les défauts sont des **valeurs de protection**, à valider par le DSI ; ce ne sont pas des seuils métier.

### 4.5 Déroulement (ordre)

1. gardes de la route ; 2. projet actif (404) ; 3. place du compte puis place globale (503) ; 4. cadence (429) ; 5. dérogation citée : existe pour ce projet et ce compte, non utilisée, non expirée (409) ; 6. jeux et niveaux, puis comptage des objets et des sommets des jeux exportables (422) ; 7. fiche, agrégats, CSV, journal, complétude, GeoJSON (délais côté base ; 504 au-delà du délai total) ; 8. archive et taille (422) ; 9. transaction de remise : projet toujours actif (404), cadence sous verrou consultatif du compte (429), insertion du journal, consommation conditionnelle de la dérogation (409 `DEROGATION_INDISPONIBLE` si une autre requête l'a consommée entre-temps : aucune archive), audits ; 10. envoi.

### 4.6 Codes d'erreur ajoutés

400 `PARAMETRES_INVALIDES`, `CHAMPS_INVALIDES`, `JUSTIFICATION_INVALIDE` ; 404 `PROJET_INTROUVABLE`, `JEU_INTROUVABLE`, `DEROGATION_INTROUVABLE` ; 409 `DEROGATION_INDISPONIBLE` (`etat` : `UTILISEE` ou `EXPIREE`), `DEROGATION_INUTILE` (jeu exportable sans dérogation), `JEU_NON_AUTORISE` ; 422 `EXPORT_TROP_VOLUMINEUX` (`objets`, `sommets`, `octets` et leurs plafonds), `BENEFICIAIRE_NON_HABILITE`, `BENEFICIAIRE_HORS_PERIMETRE` ; 429 `EXPORT_TROP_FREQUENT` (`retryAfterS`) ; 503 `SERVICE_OCCUPE` ; 504 `EXPORT_TROP_LONG`.

## 5. Dérogation de confidentialité

- Accordée par un **ADMIN** (route `POST /:id/export/derogations`), pour **des jeux nommés** du projet (1 à 20), tous `AUTORISE` (409 `JEU_NON_AUTORISE`), du projet et non retirés (404 `JEU_INTROUVABLE`), et d'un niveau **non exportable** (409 `DEROGATION_INUTILE` sinon : une dérogation ne sert qu'à ce qu'elle dit).
- **Bénéficiaire** : un compte actif, `ADMIN` ou `GESTIONNAIRE`, qui porte la clé de module (422 `BENEFICIAIRE_NON_HABILITE`), dont le périmètre couvre la région du projet (422 `BENEFICIAIRE_HORS_PERIMETRE`) ; défaut : l'ADMIN lui-même.
- **Justification** de 20 caractères au moins ; **durée** bornée (défaut 24 h, 7 jours au plus).
- **Usage unique** : citée par `?derogation=<id>` dans UN export du bénéficiaire, sur CE projet ; elle est consommée dans la transaction de remise (journal, audit, dérogation : tout ou rien). Les jeux couverts sont exportés en GeoJSON même `CONFIDENTIEL_CONCESSIONNAIRE` ou `INFRASTRUCTURE_SENSIBLE`, s'ils sont toujours `AUTORISE` ; le manifeste et l'audit le disent (`derogation: true`). Elle est consommée même si un jeu couvert a été remplacé entre-temps (le manifeste le dit) : un export = une consommation.
- Une dérogation citée par un autre compte, pour un autre projet, ou inconnue : 404 `DEROGATION_INTROUVABLE` (même réponse) ; utilisée ou expirée : 409 `DEROGATION_INDISPONIBLE`.
- Aucune dérogation ne se modifie, ne se supprime ni ne se réutilise (déclencheur). Pas de révocation dans ce lot : elle expire.

## 6. Tableaux de bord

### 6.1 Routes

| Route | Rôle | Réponse |
|---|---|---|
| `GET /tableau-de-bord` | lecture | tableau **national** du compte : tous les projets de son périmètre (comptes nationaux : tout le pays, projets sans territoire compris ; comptes régionaux : leurs régions) ; `total` et `parRegion` |
| `GET /tableau-de-bord/territoires/:tid` | lecture | tableau du territoire **et de ses descendants** ; 404 `TERRITOIRE_INTROUVABLE` masqué (inexistant, retiré, hors périmètre) ; `total`, `rattachesDirectement` (projets du territoire lui-même), `enfants` (un agrégat par enfant visible, descendants compris, 500 au plus : `tronque`), `nonVentiles` (projets du sous-arbre placés sous un enfant que le compte ne voit pas) |

Aucune requête, aucun paramètre (400 `PARAMETRES_INVALIDES` pour tout paramètre). Réponse commune : `{ portee: NATIONAL|TERRITOIRE, territoire?: { id, code, nom, niveau, ancetres }, perimetre: { national, regions }, lisibilite: { jeux: TOUS_SAUF_RETIRE|AUTORISE_SEULEMENT, conflits: TOUS|DOSSIERS_VISIBLES, documentsEnCours: bool, referents: bool }, total, parRegion?|enfants?, rattachesDirectement?, nonVentiles?, tronque, calculeLe, regle }`.

### 6.2 Agrégat

`{ projets, jeux: { <statut>: n }, conflits: { <statut>: n }, documentsManquants: { typesObligatoiresNonFournis, projetsIncomplets, piecesEnAttente, piecesEnAttenteParStatut }, referentsActifs: { comptes, rattachements } }`.

- `projets` : projets non retirés du périmètre (et du sous-arbre).
- `jeux` : jeux non retirés, par statut.
- `conflits` : dossiers de conflit par statut.
- `typesObligatoiresNonFournis` : pour chaque projet et chaque type `TYPE_DOCUMENT` actif et obligatoire, le type n'est fourni ni par un jeu `AUTORISE` de son `roleJeu`, ni par un document `VALIDE` non retiré (même règle que les pièces `TYPE_OBLIGATOIRE` de la complétude) ; `projetsIncomplets` : projets qui en ont au moins un.
- `piecesEnAttente` : dernières versions de lignées non retirées dans un statut de pièce manquante (`ATTENDU`, `RECU`, `EN_ANALYSE`, `INCOMPLET`, `A_CORRIGER`, `REJETE`), avec leur répartition.
- `referentsActifs` : rattachements de référents non révoqués des projets, et comptes distincts (actifs) qui les portent.

### 6.3 Lisibilité

| Agrégat | ADMIN, GESTIONNAIRE | Autres comptes (lecteur, inspecteur...) |
|---|---|---|
| `jeux` | tous les statuts sauf `RETIRE` | `AUTORISE` seulement (**aucun comptage de quarantaine**) |
| `conflits` | tous les dossiers (archive des verdicts, comme la liste) | dossiers dont chaque jeu lié est `AUTORISE` : jeu de réseau, plan d'axes, et **jeu B de la comparaison** d'un dossier `DIVERGENCE_SOURCES` |
| `typesObligatoiresNonFournis`, `projetsIncomplets` | oui | oui (jeux `AUTORISE` et documents `VALIDE` seulement : ce qu'il lit déjà) |
| `piecesEnAttente` et répartition | oui | `null` (un lecteur ne voit ni les pièces en cours ni leur nombre) |
| `referentsActifs` | oui | `null` (la lecture des référents est réservée aux décideurs par la matrice du workflow) |

`parRegion` porte `regionId` et le nom de la région administrative ; `enfants` le code, le nom et le niveau des territoires : ce sont des données de référence que le compte lit déjà, pas des noms d'objet.

### 6.4 Délais et cadence

Une transaction `READ ONLY` par requête, budget côté base `PROJETS_VOIRIE_DELAI_CARTE_MS` partagé par toutes ses requêtes (504 `TABLEAU_DE_BORD_TROP_LONG`) ; 4 calculs simultanés par processus (503 `SERVICE_OCCUPE` après 5 s) ; cadence par compte `PROJETS_VOIRIE_TABLEAU_CADENCE_MAX` (défaut 30, bornes 1 à 1 000) requêtes par `PROJETS_VOIRIE_TABLEAU_CADENCE_FENETRE_S` (défaut 60 s, bornes 10 à 3 600), portée processus (429 `TABLEAU_DE_BORD_TROP_FREQUENT`, `Retry-After`). Aucune écriture, aucun audit.

### 6.5 Rapport avec `GET /territoires/comptes` (lot T1)

Le tableau par territoire **ne réutilise pas** la requête de `GET /territoires/comptes` : celle-ci n'a ni délai côté base ni cadence (revue T1+S1, m1), compte pour un lecteur les dossiers dont le plan d'axes ou le jeu B n'est pas `AUTORISE`, et fait une sous-requête corrélée par territoire. Le tableau calcule par projet puis regroupe en une passe (`GROUPING SETS`). `GET /territoires/comptes` n'est pas modifié par ce lot (son correctif relève de la branche des correctifs).

## 7. Tests exigés

Unitaires (noyaux purs) : producteur ZIP (relu par le lecteur borné du module, CRC, tailles, noms, déterminisme, stocke et deflate, archive vide refusée), producteur PDF (structure, table de renvois exacte, pages, coupure des lignes, échappement, caractères accentués et non représentables, déterminisme), manifeste et `manifeste.sha256`, filtrage par confidentialité (matrice statut x niveau x dérogation x demande), verdicts de dérogation, injection de formules dans le CSV, cadence, regroupement des agrégats. Routes (supertest, vrais gardes, services simulés) : matrice des rôles, 404 masqué identique avant toute validation, validations, en-têtes, codes. Banc PostGIS `backend/tests-integration/exports-tableaux.integration.mts` sur clone jetable : archive réelle relue et vérifiée (manifeste, empreintes), confidentialité, dérogation à usage unique (y compris deux consommations concurrentes et en SQL direct), cadence, projet supprimé, hors périmètre, isolation, audit sans géométrie, tableaux national et par territoire pour un décideur et un lecteur (aucun comptage de quarantaine), délais. Mutations sur au moins trois gardes : confidentialité de l'export, filtre lecteur des agrégats, dérogation à usage unique.

## 8. Ce que ce lot ne fait pas (décidé)

Pas d'interface (UI-C) ; pas de rapport PDF mis en page (texte simple) ; pas d'export des attributs source des objets ni des géométries de conflit, des zones ou des croisements ; pas de révocation de dérogation (expiration) ; pas de file d'attente ni d'export asynchrone (synchrone borné) ; pas de signature cryptographique de l'archive (empreintes seulement : l'authenticité repose sur le journal et l'audit) ; `GET /territoires/comptes` inchangé ; `EXPORT_DOSSIER` de la complétude (lot D1) devient `DISPONIBLE` sans condition (la fonction ne dépend d'aucune pièce : elle exporte ce qui existe).
