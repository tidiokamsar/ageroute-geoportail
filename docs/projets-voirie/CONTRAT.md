# Module « Projets de voirie et réseaux » : contrat d'interface

Statut : contrat commun au backend et au frontend. Version 2 du 28/10/2026 (alignée sur le « Cahier des charges Réseaux Concessionnaires v2 » du DSI : ce module en est le **socle** : import fondamental KML/GeoJSON, projet et axes, carte, analyse 2D indicative). Branche d'origine : `integration/depuis-vendredi` (commit `b0f17ca`, déployé en production le 28/10/2026, 94 migrations appliquées).

Historique : v1 (28/10, commit `69df17f`), v1.1 (`origineFichier` remplace `referenceConvention`), **v2 (ce fichier)** : quarantaine des jeux, delta de versions, confidentialité à 5 niveaux, qualité sans précision inventée, nature des objets, CRS explicite, lecture durcie, analyse « à vérifier ». Les noms de v1 qui changent sont listés en section 8.

## 1. Besoin

Un projet de voirie urbaine (exemple : voirie de Kissidougou) réunit : le **plan d'axes** de l'entreprise d'exécution (31 axes et tronçons de carrefour), les **réseaux de concessionnaires** (exemple : fibre Orange fournie en KML) et les **limites de route**. Le module permet de charger ces fichiers dans le géoportail, de les contrôler puis de les autoriser, de les afficher sur la carte du projet, et de sortir une analyse indicative : longueurs par type de réseau, par concessionnaire, et **proximités ou conflits potentiels** entre les réseaux et l'emprise des travaux.

Ce lot s'arrête à l'analyse indicative. La persistance en dossiers de conflit (statuts, responsable, échéance, preuves), les ordres, les décisions et les déplacements de réseau sont le lot suivant : **aucune route, aucun champ ne les crée ici**.

Référence visuelle : un panneau latéral (onglets Analyse / Couches, segmentation par secteur, objets, propriétaires), une grande carte (plan ou satellite) avec les réseaux colorés par secteur, une fiche au clic.

## 2. Règles non négociables (AGENTS.md et décisions du 28/10)

1. Aucun secret, aucune donnée de concessionnaire dans le dépôt : les fixtures de test sont **synthétiques** (jamais le KML d'Orange, jamais le plan réel).
2. Suppression logique uniquement (`deletedAt`) ; une version remplacée reste en base. **Aucune suppression n'est jamais appliquée automatiquement** : un delta de versions est informatif.
3. Toute écriture est auditée dans `audit_logs` (création, import, autorisation, rejet, retrait, changement de paramètres, export).
4. Migration Prisma versionnée, additive, **avec descente** dans `backend/prisma/descentes/` ; horodatage `20261030100000_projets_voirie_reseaux` ; jamais `db push`.
5. **Confidentialité** : les données de concessionnaires sont sensibles (tracé d'infrastructure critique). Cinq niveaux (section 3). Le module est entièrement derrière la clé de module `projets-voirie`. Jamais dans l'API publique ni dans les exports publics de la carte. **Aucune route n'exporte les géométries d'un jeu** (ni GeoJSON, ni KML, ni Shapefile) ; l'export CSV de l'analyse ne contient que des agrégats, sans géométrie.
6. Le calcul de conflit est une **aide à la décision**, jamais un verdict : tout résultat porte le statut `A_VERIFIER`, les hypothèses (largeurs « théoriques » tant qu'elles ne sont pas validées) et les limites (précision de position, profondeur et altitude inconnues).
7. **Un lot reçu n'est pas un lot importé** : un dépôt réel crée un jeu en `CONTROLE` (quarantaine). Il n'entre dans l'analyse et n'est affiché normalement qu'une fois `AUTORISE` par une personne identifiée, avec justification.
8. **Aucun réseau n'est présenté comme un nombre de câbles physiques** : `nbObjets` = « circuits ou objets du fichier » ; `longueurTraceFusionneM` = longueur de l'union des tracés, pas un nombre de câbles.
9. **Aucune transformation de coordonnées silencieuse** : le résumé d'import dit la source, la cible, la méthode et la justification (section 4.3).
10. Aucune écriture dans les tables du référentiel officiel (tronçons, ouvrages, portions, chantiers, etc.).
11. Pas de déploiement : le déploiement se fait par `infra/deployer-console.sh`, validation humaine à l'étape 9.

Précision du DSI (28/10/2026) : les fichiers des concessionnaires sont reçus directement de l'opérateur, l'autorisation d'exploitation est considérée acquise, sans écrit. `origineFichier` (texte libre, ex. « reçu d'Orange le 24/10/2026 par … ») est **facultatif** et ne bloque jamais un dépôt (ni simulation, ni écriture, ni avertissement bloquant).

## 3. Modèle de données (Prisma, base PostGIS 17)

Noms de tables en `snake_case` via `@@map`, colonnes en camelCase comme le reste du schéma. Identifiants texte (`uuid`, convention du dépôt). Géométries en `Unsupported("geometry(...,4326)")`, requêtes en SQL brut paramétré.

Enums : `TypeReseauTiers` (`TELECOM`, `EAU_POTABLE`, `ELECTRICITE`, `ASSAINISSEMENT`, `GAZ_HYDROCARBURES`, `AUTRE`) ; `RoleJeuProjet` (`AXES_TRAVAUX`, `RESEAU_TIERS`, `LIMITES_ROUTE`, `AUTRE`) ; `StatutJeuProjet` (`RECU`, `CONTROLE`, `AUTORISE`, `REJETE`, `REMPLACE`, `RETIRE`) ; `NiveauConfidentialite` (`PUBLIC`, `INTERNE`, `RESTREINT_PROJET`, `CONFIDENTIEL_CONCESSIONNAIRE`, `INFRASTRUCTURE_SENSIBLE`) ; `ClassePrecision` (`A`, `B`, `C`, `D`, `E`) ; `NatureObjetReseau` (`ACTIF_PHYSIQUE`, `CIRCUIT_LOGIQUE`, `EQUIPEMENT`, `AXE`, `EMPRISE`, `INCONNUE`) ; `FormatJeuProjet` (`KML`, `GEOJSON`) ; `TypeGeomObjet` (`LIGNE`, `POINT`, `POLYGONE`) ; `StatutParametresProjet` (`THEORIQUE`, `VALIDE`).

- `ProjetVoirie` (`projets_voirie`) : `id`, `code` (unique, majuscules, ex. `KISSI-VOIRIE-2026`, motif `^[A-Z0-9][A-Z0-9_-]{1,63}$`), `nom`, `commune?`, `prefecture?`, `regionId?`, `description?`, `largeurEmpriseM` (Decimal(6,2), défaut 15), `largeurChausseeM` (Decimal(6,2), défaut 7 ; 0 < chaussée ≤ emprise ≤ 200), `statutParametres` (`THEORIQUE` par défaut | `VALIDE`), `creeParId`, `createdAt`, `updatedAt`, `deletedAt?`.
- `ConcessionnaireReseau` (`concessionnaires_reseau`) : `id`, `nom` (unique, insensible à la casse), `typeReseau`, `contact?`, `createdAt`, `updatedAt`, `deletedAt?`.
- `JeuDonneesProjet` (`projets_voirie_jeux`) :
  - identité : `id`, `projetId`, `role`, `concessionnaireId?` (obligatoire si et seulement si `RESEAU_TIERS`), `typeReseau?` (renseigné si et seulement si `RESEAU_TIERS`, par défaut celui du concessionnaire), `nomFichier`, `format`, `sha256`, `tailleOctets` ;
  - mesures : `nbObjets` (« circuits ou objets du fichier »), `longueurTotaleM` (somme des longueurs des objets linéaires), `longueurTraceFusionneM` (longueur de l'union des tracés : un même tracé répété compte une fois), `resume` (JSON : `nbObjets`, `parTypeGeom`, `bbox`, `attributsDetectes`, `crs`, `delta?`), `avertissements` (JSON) ;
  - origine : `dateDonnees?` (date de levé ou de fourniture), `origineFichier?` (texte libre, facultatif) ;
  - qualité (jamais de précision inventée : tout est nul tant que le fournisseur ne l'a pas dit) : `classePrecision?` (A à E ; nul = inconnue), `precisionHorizontaleM?`, `precisionVerticaleM?` (Decimal(8,2) > 0), `methode?` (texte libre, 200 caractères au plus), `dateConstat?` ;
  - nature : `natureObjets` (défaut `INCONNUE` ; `AXES_TRAVAUX` => `AXE`, `LIMITES_ROUTE` => `EMPRISE`, imposés ; `RESEAU_TIERS` et `AUTRE` : `ACTIF_PHYSIQUE`, `CIRCUIT_LOGIQUE`, `EQUIPEMENT` ou `INCONNUE`, `INCONNUE` tant que l'utilisateur ne la renseigne pas) ;
  - confidentialité : `confidentialite` (`NiveauConfidentialite`). Défauts : `RESEAU_TIERS` => `CONFIDENTIEL_CONCESSIONNAIRE` ; `AXES_TRAVAUX`, `LIMITES_ROUTE` et `AUTRE` => `RESTREINT_PROJET`. Les niveaux `PUBLIC` et `INTERNE` ne rendent rien public dans ce lot ;
  - cycle de vie : `statut`, `version` (entier : 1 + plus grand numéro déjà attribué à la même clé projet/rôle/concessionnaire), `remplaceId?` (le jeu `AUTORISE` que ce dépôt remplacera), `decideParId?`, `decideLe?`, `justificationDecision?` (renseignés à l'autorisation ou au rejet ; justification de 10 caractères au moins), `creeParId`, `createdAt`, `deletedAt?` (renseigné si et seulement si `RETIRE`).
- `ObjetProjet` (`projets_voirie_objets`) : `id` (bigint auto), `jeuId`, `nom?`, `typeGeom`, `geom` (`geometry(Geometry,4326)`, index GiST), `longueurM?` (`ST_Length(geom::geography)`, lignes seulement), `attributs` (JSONB : tous les champs d'origine, tels quels, **à afficher comme du texte, jamais comme du HTML**), `empreinte` (SHA-1 de la géométrie normalisée et du nom, pour le delta), `ordre`. Un objet ne se modifie ni ne se supprime.

### Cycle de vie d'un jeu

```
dépôt réel ──► CONTROLE ──autoriser──► AUTORISE ──nouvelle version autorisée──► REMPLACE
                  │                        │
                  └──rejeter──► REJETE     └──retirer──► RETIRE   (RETIRE possible depuis tout état)
```

- Un dépôt réel (hors simulation) crée le jeu directement en `CONTROLE` : la lecture, les contrôles et les statistiques sont déjà faits (staging synchrone). `RECU` est un état réservé (un futur dépôt asynchrone) : le serveur n'y place aucun jeu dans ce lot.
- Une nouvelle version (même projet, rôle, concessionnaire, contenu différent) arrive en `CONTROLE` avec `remplaceId` = le jeu `AUTORISE` courant. **L'ancien reste `AUTORISE` (donc dans l'analyse) jusqu'à l'autorisation du nouveau**, qui le passe en `REMPLACE`. Le rejet du nouveau laisse l'ancien intact.
- Au plus un jeu `AUTORISE` et au plus un dépôt en attente (`RECU` ou `CONTROLE`) par clé projet/rôle/concessionnaire (hors rôle `AUTRE`, qui admet plusieurs fichiers). Un second dépôt pendant qu'un premier attend : 409 `DEPOT_EN_ATTENTE` (avec `jeuId`) ; rejetez ou retirez le premier.
- Idempotence : le même `sha256` déjà présent dans le projet à l'état `RECU`, `CONTROLE` ou `AUTORISE` => 409 `JEU_DEJA_CHARGE` avec le `jeuId` existant (aucun objet en double). Un fichier dont la version est `REMPLACE`, `REJETE` ou `RETIRE` peut être redéposé (retour à une version antérieure).
- **Delta de versions** (information seulement, jamais appliqué) : à un remplacement, la simulation et le résultat portent `delta: { ajoutes, retires, identiques }`, comparaison par empreinte de géométrie normalisée + nom, objets de la nouvelle version contre ceux du jeu remplacé. Nul pour une première version.
- Autorisation et rejet : `ADMIN` ou `GESTIONNAIRE`, justification obligatoire, audités. Si l'auteur du dépôt est la même personne que celle qui décide, l'audit le note (`memePersonne: true`) sans bloquer.

## 4. API (préfixe `/api/v2/projets-voirie`, `requireAuth`, `requireModuleAccess("projets-voirie")`)

Écritures : rôles `ADMIN` et `GESTIONNAIRE`. Lecture : toute personne ayant la clé de module. Chaque route est déclarée dans l'inventaire des accès (`backend/src/securite/inventaire-acces.test.ts`). Erreurs au format `{ error, code, ... }`, codes en majuscules. Contrôle territorial : si le projet a une région, un compte à périmètre régional hors de cette région reçoit **404** (même réponse qu'un identifiant inconnu) ; un projet sans région n'est visible que des comptes nationaux.

| Route | Rôle | Contenu |
|---|---|---|
| `GET /` | lecture | liste des projets (filtre `q`, `limite`, `curseur`) avec compteurs de jeux par statut |
| `POST /` | écriture | crée un projet (`code`, `nom`, `commune?`, `prefecture?`, `regionId?`, `description?`, `largeurEmpriseM?`, `largeurChausseeM?`) |
| `GET /:id` | lecture | fiche du projet, jeux (sans géométrie), paramètres, emprise englobante (`bbox` WGS84, jeux autorisés) |
| `PATCH /:id` | écriture | `nom`, `commune`, `prefecture`, `description`, largeurs (remet `statutParametres` à `THEORIQUE` sauf si `statutParametres: "VALIDE"` est envoyé par un `ADMIN`) |
| `DELETE /:id` | `ADMIN` | retrait logique |
| `GET /concessionnaires` | lecture | liste |
| `POST /concessionnaires` | écriture | crée (`nom`, `typeReseau`, `contact?`) ; 409 `CONCESSIONNAIRE_DEJA_CONNU` |
| `POST /:id/jeux` | écriture | multipart : `fichier` (+ champs `role`, `concessionnaireId`, `typeReseau`, `dateDonnees`, `origineFichier`, `confidentialite`, `natureObjets`, `classePrecision`, `precisionHorizontaleM`, `precisionVerticaleM`, `methode`, `dateConstat`). Avec `?simuler=true` : lit, valide et renvoie le résumé **sans rien écrire** (aucune ligne conservée, aucun audit). Réponse 201 (dépôt) ou 200 (simulation) : `{ simulation, jeu, resume, avertissements, delta, remplace }` (4.2) |
| `GET /:id/jeux` | lecture | jeux du projet (sans géométrie), tous statuts sauf `RETIRE`, du plus récent au plus ancien |
| `DELETE /:id/jeux/:jeuId` | écriture | retrait logique (`statut: RETIRE`) |
| `POST /:id/jeux/:jeuId/autoriser` | écriture | corps `{ justification }` (10 caractères au moins) ; `CONTROLE` (ou `RECU`) => `AUTORISE` ; le jeu remplacé passe en `REMPLACE` ; 409 `STATUT_INCOMPATIBLE` sinon |
| `POST /:id/jeux/:jeuId/rejeter` | écriture | corps `{ justification }` ; `CONTROLE` (ou `RECU`) => `REJETE` |
| `GET /:id/carte` | lecture | `?jeux=id1,id2&bbox=ouest,sud,est,nord&zoom=z&inclureNonAutorises=true` (4.4) |
| `GET /:id/analyse` | lecture | analyse indicative (section 5), `?largeurEmpriseM=&largeurChausseeM=&inclureNonAutorises=` |
| `GET /:id/analyse/export.csv` | `ADMIN`, `GESTIONNAIRE`, audité | un couple axe x objet par ligne, agrégats uniquement, sans géométrie |

### 4.1 Limites et lecture des fichiers

Fichier 25 Mo (aligné sur nginx), 50 000 objets, coordonnées dans l'emprise de la Guinée (longitude -15,2 à -7,5 ; latitude 7,1 à 12,8), altitude ignorée, formats `KML` et `GeoJSON` seulement. Détection **par le contenu**, jamais par l'extension seule :

- HTML, PDF, exécutable, binaire, octets NUL : 422 `CONTENU_NON_RECONNU` ;
- archives (KMZ, ZIP), Shapefile, DXF, DWG, GPX : 415 `FORMAT_NON_SUPPORTE` avec le message « prévu au lot suivant » (aucune décompression dans ce lot : pas de zip-bomb possible) ;
- XML : aucune résolution d'entité, aucune DTD (`DTD_REFUSEE`, `ENTITE_REFUSEE`), imbrication bornée (`XML_TROP_PROFOND`) ; JSON : imbrication bornée (`JSON_TROP_PROFOND`) ;
- fichier vide : 422 `FICHIER_VIDE` ; plus de 50 000 objets : 422 `TROP_D_OBJETS` ; plus de 25 Mo : 413 `FICHIER_TROP_GROS` ; géométries inexploitables : 422 `GEOMETRIE_INVALIDE` ; tout hors Guinée (y compris longitude et latitude inversées) : 422 `HORS_GUINEE` ; encodage inconnu : 422 `ENCODAGE_NON_SUPPORTE` ; XML/JSON mal formé : 422 `XML_INVALIDE` / `JSON_INVALIDE`.

Requête mal formée : 400 `FICHIER_MANQUANT`, `CHAMPS_INVALIDES`, `TELEVERSEMENT_INVALIDE`. Autres : 404 (projet, jeu, concessionnaire inconnus), 409 (`JEU_DEJA_CHARGE`, `DEPOT_EN_ATTENTE`, `STATUT_INCOMPATIBLE`, `CODE_DEJA_UTILISE`), 503 `SERVICE_OCCUPE` avec `Retry-After`.

Avertissements typés `{ code, message, nb? }` : `ALTITUDE_IGNOREE`, `ELEMENTS_HORS_GUINEE`, `GEOMETRIES_INVALIDES_IGNOREES`, `GEOMETRIES_REPAREES`, `ANNEAUX_FERMES`, `POINTS_REPETES_RETIRES`, `TRACES_DOUBLES`, `ELEMENTS_KML_IGNORES`, `OBJETS_SANS_GEOMETRIE`, `OBJETS_SANS_NOM`.

### 4.2 Réponse de dépôt et de simulation

```
{
  "simulation": true|false,
  "jeu": { ...jeu sans géométrie... },        // en simulation : "id": null
  "resume": {
    "nbObjets", "libelleNbObjets": "circuits ou objets du fichier",
    "parTypeGeom": { "LIGNE", "POINT", "POLYGONE" },
    "longueurTotaleM", "longueurTraceFusionneM",
    "bbox": [ouest, sud, est, nord], "attributsDetectes": [ { "nom", "nb" } ],
    "crs": { "source": "WGS84 (EPSG:4326)", "cible": "EPSG:4326", "methode": "aucune transformation", "justification": "…KML 2.2…ou…RFC 7946…" },
    "delta": { "ajoutes", "retires", "identiques" } | null
  },
  "avertissements": [ { "code", "message", "nb?" } ],
  "delta": { "ajoutes", "retires", "identiques" } | null,   // même valeur que resume.delta
  "remplace": { "jeuId", "version" } | null      // le jeu AUTORISE que ce dépôt remplacera à son autorisation
}
```

### 4.3 CRS

Aucune transformation silencieuse. KML : WGS 84 par la norme KML 2.2. GeoJSON : WGS 84 par la RFC 7946 ; un membre `crs` autre que CRS84 / EPSG:4326 est refusé (422 `CRS_NON_SUPPORTE`, message : les CRS projetés, avec EPSG choisi par l'utilisateur ou points de contrôle, viendront au lot suivant). Le résumé dit ce qui a été fait (`crs`).

### 4.4 Carte

`GET /:id/carte` : réponse `{ projetId, zoom, bbox, plafond: 20000, tronque, jeux: [ … ] }`. Chaque entrée de `jeux` est une `FeatureCollection` portant `jeuId`, `role`, `concessionnaire` (`{ id, nom }` ou null), `typeReseau`, `statut`, `nonAutorise`, `version`, `confidentialite`, `natureObjets`, `classePrecision`, `nbFeatures`, `tronque`. Par défaut seulement les jeux `AUTORISE` ; avec `inclureNonAutorises=true`, les jeux `CONTROLE` s'ajoutent, marqués `nonAutorise: true`. Une `Feature` porte `properties: { objetId, jeuId, nom, typeGeom, longueurM, attributs }`. Simplification de la géométrie selon le zoom (sans effet à partir du zoom 17), plafond de 20 000 objets par réponse (`tronque: true` au-delà, nombre exact dans `total`).

## 5. Analyse (`GET /:id/analyse`)

Calcul métrique en projection UTM choisie selon la longitude du centre du projet (axes autorisés, sinon réseaux) : EPSG 32628 si longitude < -12, sinon 32629. Largeurs : `largeurChausseeM` et `largeurEmpriseM` du projet (ou surchargées par la requête sans les enregistrer), appliquées de part et d'autre de chaque axe (demi-largeurs). Par défaut, seuls les jeux `AUTORISE` entrent dans le calcul ; `inclureNonAutorises=true` y ajoute les jeux `CONTROLE`, marqués `nonAutorise: true`.

Chaque élément de résultat (racine, chaque entrée de `parAxe`, de `parConcessionnaire` et de `parQualification`, chaque croisement) porte `statut: "A_VERIFIER"`. La racine porte `versionAlgorithme` et `regle: { version: "RC-2D-0.1", chausseeM, empriseM, projection }`.

```
{
  "projet": { "id", "code", "nom" },
  "statut": "A_VERIFIER", "versionAlgorithme": "2D-UTM-1",
  "regle": { "version": "RC-2D-0.1", "chausseeM", "empriseM", "projection": "EPSG:32629" },
  "inclureNonAutorises": false,
  "parametres": { "largeurEmpriseM", "largeurChausseeM", "statut": "THEORIQUE|VALIDE", "projection", "surcharge": false },
  "libelles": { "nbObjets": "circuits ou objets du fichier", "longueurTraceFusionneM": "longueur des tracés fusionnés (union des tracés, pas un nombre de câbles)" },
  "axes": { "nb", "longueurM", "jeuxIds": [] },
  "jeux": [ { "jeuId", "role", "concessionnaire", "typeReseau", "statut", "nonAutorise", "version", "classePrecision", "qualification", "confidentialite", "natureObjets", "nbObjets", "longueurTotaleM", "longueurTraceFusionneM", "dateDonnees" } ],
  "reseaux": {
    "parType":           [ { "typeReseau", "longueurTraceFusionneM", "nbObjets" } ],
    "parConcessionnaire":[ { "concessionnaireId", "nom", "typeReseau", "longueurTraceFusionneM", "longueurSommeM", "nbObjets", "jeuxIds": [], "statut" } ]
  },
  "conflits": {
    "total": { "chausseeM", "empriseM", "empriseHorsChausseeM", "horsEmpriseM", "croisements", "axesTouches", "objetsTouches",
               "parQualification": { "CONFLIT_POTENTIEL": { "chausseeM", "empriseM", "croisements", "statut" }, "PROXIMITE_A_VERIFIER": { … } }, "statut" },
    "parAxe": [ { "axe", "longueurM", "chausseeM", "empriseM", "empriseHorsChausseeM", "croisements", "concessionnaires": [], "objets": [ { "jeuId", "objetId", "nom", "qualification", "chausseeM", "empriseM", "croisements" } ], "objetsTronques": false, "statut" } ],
    "parConcessionnaire": [ { "concessionnaireId", "nom", "classePrecision", "qualification", "chausseeM", "empriseM", "empriseHorsChausseeM", "horsEmpriseM", "croisements", "statut", "nonAutorise" } ],
    "croisements": { "type": "FeatureCollection", "features": [], "nbTotal", "tronque": false },
    "zones": { "chaussee": "MultiLineString|null", "emprise": "MultiLineString|null", "hors": "MultiLineString|null" }
  },
  "hypotheses": [ "…" ],
  "limites": [ "…" ]
}
```

Définitions : `longueurTraceFusionneM` = longueur de l'union des tracés d'un jeu (un même tracé répété par plusieurs circuits compte une fois) ; `longueurSommeM` = somme des longueurs des objets ; `chausseeM` = longueur du réseau (fusionné) dans la bande axe ± `largeurChausseeM / 2` ; `empriseM` = longueur dans la bande axe ± `largeurEmpriseM / 2`, **chaussée comprise** ; `empriseHorsChausseeM` = `empriseM - chausseeM` ; `horsEmpriseM` = le reste ; `croisements` = points d'intersection réseau x axe. Les totaux et les lignes par concessionnaire utilisent l'union de toutes les bandes (un réseau dans l'emprise de deux axes voisins est compté une fois) ; la ligne d'un axe utilise la bande de cet axe seul (un carrefour apparaît dans la ligne de chaque axe concerné). `zones` : `chaussee` = réseau dans la bande de chaussée ; `emprise` = réseau dans la bande d'emprise **hors** chaussée ; `hors` = réseau hors emprise (zones disjointes, simplifiées).

**Qualification** : pour un jeu de classe de précision `A`, `B` ou `C`, le résultat est un `CONFLIT_POTENTIEL` ; pour une classe `D`, `E` ou **inconnue**, c'est une `PROXIMITE_A_VERIFIER`, jamais un « conflit ». Les classes présentes sont citées dans `hypotheses`. Les seuils des classes sont ceux du cahier du DSI : le serveur ne les interprète pas, il stocke la classe déclarée.

**`limites` contient TOUJOURS** : « Conflit vertical non évalué : profondeur et altitude absentes. », « Aucun conflit détecté ne prouve l'absence de réseau. », « Résultat indicatif : aucune décision de déplacement n'en découle. »

Une analyse sans axes autorisés ou sans réseau autorisé répond 200 avec des totaux à zéro et une phrase dans `limites`, jamais une erreur. Rien dans cette réponse ni dans ce module ne crée d'ordre, de décision ou de déplacement.

## 6. Interface (frontend)

- Entrée de menu et clé de module `projets-voirie` (libellé « Projets de voirie »), route `/projets-voirie` (liste, création) et `/projets-voirie/:id` (carte).
- Page projet : carte Leaflet plein cadre (fond plan OpenStreetMap et satellite Esri), panneau latéral à deux onglets : **Analyse** (longueur des tracés fusionnés et par type de réseau avec barre colorée, « circuits ou objets du fichier », propriétaires, conflits potentiels et proximités à vérifier, hypothèses et limites toujours visibles) et **Couches** (une ligne par jeu : case, couleur, concessionnaire, version, **statut**, date, boutons autoriser / rejeter / retirer ; couches de conflit : chaussée, emprise, hors emprise, croisements). Bouton « Ajouter des données » : dialogue de dépôt avec **simulation avant écriture** (résumé, CRS, avertissements, delta), puis confirmation ; le jeu déposé apparaît « en contrôle » jusqu'à son autorisation. Fiche au clic sur un objet (attributs d'origine, en texte). Paramètres de largeur modifiables avec la mention « théorique ». Export CSV des conflits (ADMIN et GESTIONNAIRE). Centrer sur le projet.
- Couleur par secteur : télécom orange `#ff7900`, eau bleu `#1e66f5`, électricité rouge `#d32f2f`, assainissement vert `#2e7d32`, gaz jaune `#f9a825`, autre gris `#6b7f99` ; axes de travaux bleu marine `#0b2545`. Conflits : chaussée rouge, emprise orange foncé, hors emprise violet, croisements noirs.
- Aucun texte ne présente N lignes comme N câbles physiques.
- Accessibilité : contrastes conformes au projet (voir `docs/accessibilite/CONTRASTE.md`), navigation clavier (aucun piège), test `axe-core` sur les écrans ; pas d'information portée par la seule couleur (légende textuelle, motifs de trait).
- Aucun réseau de concessionnaire n'est mis en cache hors ligne (pas de service worker, pas de stockage local de géométries).

## 7. Tests exigés

Backend : lecteurs KML et GeoJSON (altitude `0`, extension Google Earth, entités XML refusées, géométrie vide, hors Guinée, fichier trop gros, doublons de tracé, contenu HTML / PDF / binaire / NUL, archives, imbrication JSON), routes (permissions, simulation sans écriture, 409 doublon, quarantaine puis autorisation et rejet, retrait logique, audit, 404 hors périmètre), analyse avec **cas synthétique de résultat connu** (un tracé à 2 m de l'axe est en chaussée, à 6 m en emprise hors chaussée, à 9 m hors emprise ; croisement perpendiculaire = 1 point ; deux circuits superposés comptés une fois en longueur fusionnée) en test unitaire du noyau et en banc PostGIS (`backend/tests-integration/`), absence d'écriture dans le référentiel officiel, descente de migration rejouée, `inventaire-acces` à jour, `depot-sans-secret` vert.
Frontend : page liste, page projet, panneau d'analyse, dialogue de dépôt (simulation puis confirmation, erreurs), couches et statuts, accessibilité (`axe`), rien de stocké hors ligne.

## 8. Changements de noms depuis la v1

| v1 | v2 |
|---|---|
| `longueurPhysiqueM` | `longueurTraceFusionneM` |
| `referenceConvention` | `origineFichier` |
| `precisionDeclareeM` | `precisionHorizontaleM` (+ `precisionVerticaleM`, `classePrecision`, `methode`, `dateConstat`) |
| `confidentialite` : `RESTREINT` / `INTERNE` | `NiveauConfidentialite` à 5 niveaux |
| `statut` : `ACTIF` / `REMPLACE` / `RETIRE` | `RECU`, `CONTROLE`, `AUTORISE`, `REJETE`, `REMPLACE`, `RETIRE` |
| unicité du `sha256` « parmi les jeux non retirés » | parmi les jeux `RECU`, `CONTROLE` ou `AUTORISE` (409 `JEU_DEJA_CHARGE` avec `jeuId`) |
| export CSV en lecture | `ADMIN` et `GESTIONNAIRE`, audité |
