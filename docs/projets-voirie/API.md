# API Projets de voirie et réseaux : référence

Préfixe : `/api/v2/projets-voirie`. Contrat : `docs/projets-voirie/CONTRAT.md` (v2, fait foi pour le modèle et les règles) ; dossiers de conflit : `CONTRAT-CONFLITS.md` et la section « Dossiers de conflit (lot RC-3) » de ce document ; réseaux physiques et circuits logiques : `CONTRAT-RESEAUX.md` et la section « Réseaux physiques et circuits logiques (lot B1) ». Ce document décrit les routes **telles qu'elles répondent**. Les exemples sont des réponses réelles, relevées par le banc `backend/tests-integration/projets-voirie.integration.mts` sur des données 100 % synthétiques (identifiants raccourcis, listes tronquées).

Toutes les routes : jeton d'accès (`Authorization: Bearer ...`), clé de module `projets-voirie` (un `ADMIN` passe sans clé), réponses `Cache-Control: no-store` et `X-Content-Type-Options: nosniff`. Erreurs : `{ "error": "texte", "code": "CODE", ... }`.

## Gardes, dans l'ordre

1. Authentification : 401 sans jeton valide.
2. Module : 403 `{ error }` sans la clé `projets-voirie`. Juste après : tout **octet NUL** dans la requête (paramètres, corps JSON, champs multipart, nom de fichier) donne 400 `PARAMETRES_INVALIDES` ; un identifiant de projet ou de jeu de l'URL qui n'est pas un **UUID** (`%00`, texte, chaîne démesurée) donne 400 `IDENTIFIANT_INVALIDE`, jamais un 500 (le format ne dit rien de l'existence : même réponse pour tous les comptes).
3. Rôle (écritures) : 403 sans `ADMIN` ou `GESTIONNAIRE` (`DELETE` d'un projet : `ADMIN`). L'export CSV de l'analyse est réservé aux mêmes rôles, bien que ce soit un `GET`.
4. Projet désigné : **404 `PROJET_INTROUVABLE`** identique si le projet n'existe pas, est retiré, est hors du périmètre régional du compte ou n'a pas de région (un projet sans région n'est visible que des comptes nationaux). Cette garde précède la validation du corps.
5. Validation des entrées : 400 avec `code`, jamais 500.

Contrôle territorial : repose sur `perimetres_comptes` comme les autres routes (`requireTerritoireMasque` en lecture et en écriture ; `requireTerritoire`, 403, à la création : un compte régional ne crée que dans sa région).

## Routes

| Route | Rôle | Réponse |
|---|---|---|
| `GET /` | lecture | `{ projets: [ { ...projet, jeux: { CONTROLE: 1, AUTORISE: 2 } } ], curseurSuivant }` (les compteurs `jeux` ne comptent, pour un lecteur, que les jeux `AUTORISE`) ; paramètres `q`, `limite` (1 à 100, défaut 25), `curseur` |
| `POST /` | écriture | 201 `{ projet }` |
| `GET /:id` | lecture | `{ projet: { ...champs, parametres, bbox, jeux: [ jeu ] } }` ; `bbox` = union des emprises des jeux autorisés, nul sans jeu autorisé |
| `PATCH /:id` | écriture | `{ projet }` |
| `DELETE /:id` | `ADMIN` | `{ id, retire: true }` (retrait logique) |
| `GET /concessionnaires` | lecture | `{ concessionnaires: [ { id, nom, typeReseau, contact, createdAt } ] }` triés par nom |
| `POST /concessionnaires` | écriture | 201 `{ concessionnaire }` |
| `POST /:id/jeux` | écriture | 201 (dépôt) ou 200 (`?simuler=true`) `{ simulation, jeu, resume, avertissements, delta, remplace }` |
| `GET /:id/jeux` | lecture | `{ jeux: [ jeu ] }`, du plus récent au plus ancien : tous statuts sauf `RETIRE` pour `ADMIN` et `GESTIONNAIRE`, **seulement `AUTORISE` pour un lecteur** |
| `DELETE /:id/jeux/:jeuId` | écriture | `{ jeu }` (statut `RETIRE`, les objets restent en base) ; 409 `DEPOT_EN_ATTENTE` si le jeu est `AUTORISE` et qu'une nouvelle version de même clé l'attend (CONTRAT-IMPORT.md 14.1) |
| `POST /:id/jeux/:jeuId/autoriser` | écriture | `{ jeu, remplaces: [ids] }` |
| `POST /:id/jeux/:jeuId/rejeter` | écriture | `{ jeu, remplaces: [] }` |
| `GET /:id/carte` | lecture | couches d'affichage (section Carte) |
| `GET /:id/analyse` | lecture | analyse indicative (section Analyse) |
| `GET /:id/analyse/export.csv` | `ADMIN`, `GESTIONNAIRE` | `text/csv`, audité |

Il n'existe **aucune** route d'export des géométries d'un jeu (ni GeoJSON, ni KML) ; un test de l'inventaire des accès fige la liste des routes (15 du socle ; les 16 routes des dossiers de conflit sont décrites dans la section « Dossiers de conflit (lot RC-3) » ; les 6 routes d'import du lot A1, dans la section « Import des formats ouverts, CRS, mapping et versions (lot A1) »).

### Créer un projet

`POST /` corps (champs inconnus refusés) :

```json
{ "code": "kissi-voirie-2026", "nom": "Voirie de Kissidougou", "commune": "Kissidougou", "prefecture": "Kissidougou", "regionId": 1 }
```

`code` : mis en majuscules, `^[A-Z0-9][A-Z0-9_-]{1,63}$`, unique y compris pour un projet retiré. `largeurEmpriseM` (défaut 15) et `largeurChausseeM` (défaut 7) : 0 < chaussée ≤ emprise ≤ 200. Erreurs : 400 `CHAMPS_INVALIDES`, 400 `LARGEURS_INCOHERENTES`, 400 `REGION_INCONNUE`, 409 `CODE_DEJA_UTILISE`, 403 (compte régional hors de sa région ou sans région).

`PATCH /:id` : `nom`, `commune`, `prefecture`, `description`, `largeurEmpriseM`, `largeurChausseeM`, `statutParametres`. Modifier une largeur remet `statutParametres` à `THEORIQUE`. `statutParametres: "VALIDE"` est réservé aux `ADMIN` (403 `ROLE_INSUFFISANT` sinon).

### Déposer un fichier (multipart)

`POST /:id/jeux[?simuler=true]`, champ fichier `fichier` (25 Mo au plus, un seul), champs texte :

| Champ | Obligatoire | Contenu |
|---|---|---|
| `role` | oui | `AXES_TRAVAUX`, `RESEAU_TIERS`, `LIMITES_ROUTE`, `AUTRE` |
| `concessionnaireId` | si `RESEAU_TIERS` | refusé pour les autres rôles |
| `typeReseau` | non | `RESEAU_TIERS` seulement ; par défaut celui du concessionnaire |
| `dateDonnees`, `dateConstat` | non | `AAAA-MM-JJ` |
| `origineFichier` | **non, jamais bloquant** | texte libre (ex. « reçu de l'opérateur le 24/10/2026 par ... ») |
| `confidentialite` | non | `PUBLIC`, `INTERNE`, `RESTREINT_PROJET`, `CONFIDENTIEL_CONCESSIONNAIRE`, `INFRASTRUCTURE_SENSIBLE` ; défaut `CONFIDENTIEL_CONCESSIONNAIRE` pour un réseau, `RESTREINT_PROJET` sinon |
| `natureObjets` | non | `ACTIF_PHYSIQUE`, `CIRCUIT_LOGIQUE`, `EQUIPEMENT`, `INCONNUE` (réseaux) ; imposée `AXE` / `EMPRISE` pour axes / limites |
| `classePrecision` | non | `A` à `E` ; absent = inconnue (jamais inventée) |
| `precisionHorizontaleM`, `precisionVerticaleM` | non | nombre > 0 |
| `methode` | non | texte libre, 200 caractères au plus |

Le dépôt réel crée un jeu `CONTROLE` (quarantaine). **Simulation** : exécute le dépôt complet dans une transaction annulée ; rien n'est conservé (ni jeu, ni objet, ni audit). Les 409 sont annoncés dès la simulation.

Réponse de simulation d'un plan d'axes (extrait réel) :

```json
{
  "simulation": true,
  "jeu": { "id": null, "role": "AXES_TRAVAUX", "nomFichier": "axes.kml", "format": "KML", "nbObjets": 2,
           "libelleNbObjets": "circuits ou objets du fichier", "longueurTotaleM": 350.08, "longueurTraceFusionneM": 350.08,
           "natureObjets": "AXE", "confidentialite": "RESTREINT_PROJET", "classePrecision": null,
           "precisionHorizontaleM": null, "statut": "CONTROLE", "nonAutorise": true, "version": 1, "remplaceId": null, "...": "..." },
  "resume": {
    "nbObjets": 2, "libelleNbObjets": "circuits ou objets du fichier",
    "parTypeGeom": { "LIGNE": 2, "POINT": 0, "POLYGONE": 0 },
    "longueurTotaleM": 350.08, "longueurTraceFusionneM": 350.08,
    "bbox": [-10.0922467, 9.1805872, -10.0904265, 9.1819492],
    "attributsDetectes": [ { "nom": "name", "nb": 2 } ],
    "crs": { "source": "WGS84 (EPSG:4326)", "cible": "EPSG:4326", "methode": "aucune transformation",
             "justification": "La norme KML 2.2 (OGC 07-147r2) impose WGS 84 en longitude, latitude : les coordonnees sont lues telles quelles, sans reprojection." },
    "delta": null
  },
  "avertissements": [],
  "delta": null,
  "remplace": null
}
```

Nouvelle version d'un jeu déjà autorisé (extrait réel) : `"delta": { "ajoutes": 1, "retires": 1, "identiques": 6 }`, `"remplace": { "jeuId": "df87fea5-...", "version": 1 }`, `"jeu": { "version": 2, ... }`. Le delta compare les empreintes (géométrie normalisée, sens d'une ligne indifférent, + nom) ; il est **informatif**, jamais appliqué.

Avertissements (`{ code, message, nb? }`) : `ALTITUDE_IGNOREE`, `ELEMENTS_HORS_GUINEE`, `GEOMETRIES_INVALIDES_IGNOREES`, `GEOMETRIES_REPAREES`, `GEOMETRIES_VIDES_IGNOREES`, `ANNEAUX_FERMES`, `POINTS_REPETES_RETIRES`, `TRACES_DOUBLES`, `ELEMENTS_KML_IGNORES`, `OBJETS_SANS_GEOMETRIE`, `OBJETS_SANS_NOM`.

### Autoriser, rejeter

Corps `{ "justification": "10 caractères au moins" }` (champ inconnu refusé).

```json
{ "jeu": { "id": "059ac187-...", "statut": "AUTORISE", "nonAutorise": false, "version": 1,
           "decision": { "par": { "id": "145ad147-...", "nomComplet": "Sekou Gestionnaire" }, "le": "2026-10-28T21:30:46.509Z", "justification": "Controle effectue avec le chef de projet" },
           "...": "..." },
  "remplaces": [] }
```

Autoriser une nouvelle version passe le jeu autorisé de même clé en `REMPLACE` (`remplaces` porte son identifiant). Si l'auteur du dépôt est aussi celui qui décide, l'audit porte `memePersonne: true`. L'historique d'un jeu est lisible par `GET /api/audit?entityType=JeuDonneesProjet&entityId=...` pour un compte qui a le module.

### Carte

`GET /:id/carte?jeux=id1,id2&bbox=ouest,sud,est,nord&zoom=12&inclureNonAutorises=true`

Paramètres : `jeux` (1 à 50 identifiants), `bbox` (degrés, ouest < est, sud < nord), `zoom` (0 à 22 ; simplification de la géométrie, aucune à partir de 17), `inclureNonAutorises` (**`ADMIN` et `GESTIONNAIRE` seulement** : un lecteur reçoit 403 `QUARANTAINE_RESERVEE`). Plafond : **20 000 objets avec `bbox`, 5 000 sans `bbox`** (la réponse porte `plafond`), `tronque: true` au-delà (`total` donne le nombre exact par jeu) ; sans `bbox` ni `zoom`, la géométrie est simplifiée comme au zoom 12. La base coupe la requête au bout de 10 s (504 `CARTE_TROP_LONGUE`) ; 6 cartes simultanées au plus par processus (503 `SERVICE_OCCUPE`). La consultation des jeux de niveau `CONFIDENTIEL_CONCESSIONNAIRE` et `INFRASTRUCTURE_SENSIBLE` est **tracée** (voir « Traçabilité des consultations »).

```json
{ "projetId": "b2ddd95e-...", "zoom": null, "bbox": null, "plafond": 20000, "tronque": false,
  "jeux": [ { "type": "FeatureCollection", "jeuId": "480a8154-...", "role": "RESEAU_TIERS",
              "concessionnaire": { "id": "bbd8e7a3-...", "nom": "Societe des Eaux Synthetique" }, "typeReseau": "EAU_POTABLE",
              "statut": "AUTORISE", "nonAutorise": false, "version": 1, "confidentialite": "CONFIDENTIEL_CONCESSIONNAIRE",
              "natureObjets": "INCONNUE", "classePrecision": null, "nbFeatures": 1, "total": 1, "tronque": false,
              "features": [ { "type": "Feature", "id": "20", "geometry": { "type": "LineString", "coordinates": [] },
                              "properties": { "objetId": "20", "jeuId": "480a8154-...", "nom": "Eau-Marqueur W", "typeGeom": "LIGNE", "longueurM": 60.02, "attributs": { "name": "Eau-Marqueur W" } } } ] } ] }
```

Les `attributs` sont les champs d'origine du fichier : **à afficher comme du texte** (un champ `description` KML peut contenir du HTML : ne jamais l'injecter dans le DOM).

### Analyse

`GET /:id/analyse?largeurEmpriseM=&largeurChausseeM=&inclureNonAutorises=` : la forme complète est au contrat (section 5). Points à connaître :

- `largeurEmpriseM` / `largeurChausseeM` surchargent les paramètres du projet **sans les enregistrer** (`parametres.surcharge: true`) ; 400 si incohérents.
- Par défaut, seuls les jeux `AUTORISE` comptent. Avec `inclureNonAutorises=true` (`ADMIN` et `GESTIONNAIRE` seulement, sinon 403 `QUARANTAINE_RESERVEE`), un jeu en contrôle **remplace**, pour ce calcul, le jeu autorisé de même rôle et de même concessionnaire (jamais les deux), et l'hypothèse « INCLUS » le dit.
- **Coût borné** : tracés simplifiés avant calcul (axes 0,1 m, réseaux 0,05 m), tampons à 8 segments par quart de cercle, calcul par objet limité aux morceaux d'axe voisins ; coupée par la base au bout de 20 s (504 `ANALYSE_TROP_LONGUE`) ; refusée en amont au-delà de 500 000 sommets d'axes ou 3 000 000 de réseaux autorisés (422 `ANALYSE_TROP_VOLUMINEUSE`, avec `sommetsAxes` et `sommetsReseau`) ; 3 analyses simultanées au plus par processus (503 `SERVICE_OCCUPE`). Mesures du banc de charge (axe de 100 000 sommets, réseau de 20 000 lignes) : voir `backend/tests-integration/README.md`.
- Les entrées de `parAxe` portent aussi `axeId` ; `objets` est limité à 100 par axe (`objetsTronques`).
- `zones` : `chaussee`, `emprise` (hors chaussée), `hors` : géométries GeoJSON `MultiLineString` ou `null` ; `tronque: true` si une couche dépasse 8 Mo.
- Chaque résultat porte `"statut": "A_VERIFIER"` ; la racine porte `regle: { version: "RC-2D-0.1", chausseeM, empriseM, projection }` et `versionAlgorithme: "2D-UTM-1"`.

Extrait réel (cas synthétique : axes A et B de 200 m et 150 m, réseau 1 de classe B, réseau 2 de classe inconnue) :

```json
{ "statut": "A_VERIFIER", "versionAlgorithme": "2D-UTM-1",
  "regle": { "version": "RC-2D-0.1", "chausseeM": 7, "empriseM": 15, "projection": "EPSG:32629" },
  "conflits": {
    "total": { "chausseeM": 134.03, "empriseM": 205.04, "empriseHorsChausseeM": 71.01, "horsEmpriseM": 85.01, "croisements": 2, "axesTouches": 2, "objetsTouches": 7,
               "parQualification": { "CONFLIT_POTENTIEL": { "chausseeM": 74.01, "empriseM": 145.02, "croisements": 2, "statut": "A_VERIFIER" },
                                     "PROXIMITE_A_VERIFIER": { "chausseeM": 60.02, "empriseM": 60.02, "croisements": 0, "statut": "A_VERIFIER" } }, "statut": "A_VERIFIER" },
    "parConcessionnaire": [ { "nom": "Operateur Telecom Synthetique", "classePrecision": "B", "qualification": "CONFLIT_POTENTIEL",
                              "chausseeM": 74.01, "empriseM": 145.02, "empriseHorsChausseeM": 71.01, "horsEmpriseM": 85.01, "croisements": 2, "statut": "A_VERIFIER", "nonAutorise": false } ],
    "parAxe": [ { "axe": "Axe B", "axeId": "4", "longueurM": 150.03, "chausseeM": 7, "empriseM": 10, "empriseHorsChausseeM": 3, "croisements": 1,
                  "concessionnaires": ["Operateur Telecom Synthetique"], "objetsTronques": false, "statut": "A_VERIFIER",
                  "objets": [ { "objetId": "18", "nom": "Fibre-Marqueur K", "qualification": "CONFLIT_POTENTIEL", "chausseeM": 7, "empriseM": 10, "croisements": 1 } ] } ],
    "croisements": { "type": "FeatureCollection", "nbTotal": 2, "tronque": false,
                     "features": [ { "type": "Feature", "geometry": { "type": "Point", "coordinates": [-10.0908815, 9.1805913] },
                                     "properties": { "concessionnaire": "Operateur Telecom Synthetique", "axe": "Axe A", "qualification": "CONFLIT_POTENTIEL", "statut": "A_VERIFIER" } } ] } },
  "limites": [ "...", "Conflit vertical non évalué : profondeur et altitude absentes.", "Aucun conflit détecté ne prouve l'absence de réseau.", "Résultat indicatif : aucune décision de déplacement n'en découle." ] }
```

Lecture : le carrefour (tracé `K`) compte pour 10 m dans la ligne de l'axe A **et** de l'axe B (sommes des axes : 215 m) mais une seule fois dans le total (205 m).

### Export CSV

`GET /:id/analyse/export.csv` (mêmes paramètres que l'analyse). `text/csv; charset=utf-8`, BOM UTF-8, séparateur `;`, virgule décimale, `Content-Disposition: attachment`, `X-Lignes-Exportees`. Un couple axe x objet **brut** du fichier par ligne (non fusionné : deux circuits superposés y figurent chacun), 100 000 lignes au plus. Aucune géométrie. Les cellules qui commencent par `=`, `+`, `-` ou `@` sont neutralisées. L'export est audité (`ExportProjetVoirie`) **avant** la remise du fichier.

```
axe;concessionnaire;typeReseau;fichier;versionJeu;statutJeu;classePrecision;qualification;objetId;nomObjet;chausseeM;empriseM;empriseHorsChausseeM;croisements;statut;regle;projection;largeurChausseeM;largeurEmpriseM;statutParametres
Axe A;Societe des Eaux Synthetique;EAU_POTABLE;r2.kml;1;AUTORISE;inconnue;PROXIMITE_A_VERIFIER;20;Eau-Marqueur W;60,02;60,02;0;0;A_VERIFIER;RC-2D-0.1;EPSG:32629;7;15;THEORIQUE
```

## Codes d'erreur

| Statut | Code | Cas |
|---|---|---|
| 400 | `CHAMPS_INVALIDES`, `PARAMETRES_INVALIDES`, `JUSTIFICATION_INVALIDE`, `CURSEUR_INVALIDE` | entrée mal formée (le détail est dans `details`) |
| 400 | `FICHIER_MANQUANT`, `TELEVERSEMENT_INVALIDE` | dépôt sans fichier ou multipart invalide |
| 400 | `CONCESSIONNAIRE_REQUIS`, `NATURE_INCOMPATIBLE`, `LARGEURS_INCOHERENTES`, `REGION_INCONNUE` | combinaison refusée |
| 401 | | pas de jeton valide |
| 403 | | module absent, rôle insuffisant (`ROLE_INSUFFISANT` pour `VALIDE`), création hors région |
| 404 | `PROJET_INTROUVABLE`, `JEU_INTROUVABLE`, `CONCESSIONNAIRE_INTROUVABLE` | inexistant, retiré ou hors périmètre |
| 409 | `JEU_DEJA_CHARGE` (avec `jeuId`, `statut`, `version`) | même SHA-256 déjà `RECU`, `CONTROLE` ou `AUTORISE` dans le projet |
| 409 | `DEPOT_EN_ATTENTE` (avec `jeuId`) | un dépôt de même rôle et même concessionnaire attend son autorisation |
| 409 | `STATUT_INCOMPATIBLE` | autoriser / rejeter un jeu qui n'est pas en contrôle, retirer un jeu déjà retiré |
| 409 | `CODE_DEJA_UTILISE`, `CONCESSIONNAIRE_DEJA_CONNU` | unicité |
| 413 | `FICHIER_TROP_GROS` | plus de 25 Mo |
| 415 | `FORMAT_NON_SUPPORTE` | DWG, contenu texte qui n'est ni du KML, du GeoJSON, du GPX ni un tableau délimité. KMZ, GPX et CSV sont lus (`CONTRAT-IMPORT.md`, sections 4 à 6). GeoPackage, Shapefile ZIP et DXF : voir la section « Conversion GDAL asynchrone » (415 `FORMAT_GDAL_DESACTIVE` quand l'interrupteur est coupé, ce qui est le défaut) |
| 422 | `CONTENU_NON_RECONNU` | HTML, PDF, exécutable, image, binaire, octets NUL |
| 422 | `FICHIER_VIDE`, `TROP_D_OBJETS` (> 50 000), `GEOMETRIE_INVALIDE`, `HORS_GUINEE` | contenu refusé |
| 422 | `XML_INVALIDE`, `DTD_REFUSEE`, `ENTITE_REFUSEE`, `XML_TROP_PROFOND`, `XML_TROP_VOLUMINEUX`, `JSON_INVALIDE`, `JSON_TROP_PROFOND`, `ENCODAGE_NON_SUPPORTE`, `CRS_NON_SUPPORTE` | document illisible ou dangereux |
| 400 | `IDENTIFIANT_INVALIDE` | identifiant de projet, de jeu ou `concessionnaireId` qui n'est pas un UUID (`%00` compris) |
| 400 | `PARAMETRES_INVALIDES` | dont tout octet NUL dans un texte |
| 403 | `QUARANTAINE_RESERVEE` | `inclureNonAutorises=true` demandé par un compte qui n'est ni ADMIN ni GESTIONNAIRE |
| 422 | `TROP_DE_SOMMETS` | plus de 100 000 sommets dans un objet, ou 2 000 000 dans le fichier |
| 422 | `ANALYSE_TROP_VOLUMINEUSE` | trop de sommets autorisés pour calculer l'analyse |
| 503 | `SERVICE_OCCUPE` (+ `Retry-After`) | plus de 2 dépôts, 4 téléversements (2 par compte), 3 analyses ou 6 cartes simultanés dans le processus |
| 503 | `PROJET_OCCUPE` | le verrou du projet n'a pas été obtenu en 5 s (autre dépôt, autorisation ou retrait en cours ; vaut aussi pour les écritures du workflow et de B1, qui attendent un dépôt ou une proposition en cours). Rien n'a été écrit : **réessayer** après quelques secondes (`CONTRAT-WORKFLOW.md`, 9 bis) |
| 504 | `ANALYSE_TROP_LONGUE`, `CARTE_TROP_LONGUE`, `DEPOT_TROP_LONG` | la base a coupé la requête (délais ci-dessous) ; jamais un 500 |
| 500 | | erreur interne, message générique sans détail |

Exemples réels :

```json
{ "error": "Ce fichier est déjà chargé dans ce projet (même empreinte SHA-256).", "code": "JEU_DEJA_CHARGE", "jeuId": "059ac187-...", "statut": "CONTROLE", "version": 1 }
{ "error": "tous les objets sont hors de la Guinee (longitude -15,2 a -7,5 ; latitude 7,1 a 12,8) : verifiez l'ordre longitude, latitude et le systeme de coordonnees (WGS 84)", "code": "HORS_GUINEE" }
{ "error": "declaration de type de document (DTD, DOCTYPE, ENTITY) refusee", "code": "DTD_REFUSEE" }
{ "error": "Projet introuvable", "code": "PROJET_INTROUVABLE" }
```

## Lecture des fichiers

- Format reconnu **par le contenu**, pas par l'extension. KML : `Placemark` (dans `Document` et `Folder`), `Point`, `LineString`, `LinearRing`, `Polygon`, `MultiGeometry`, extension Google Earth `gx:Track` / `gx:MultiTrack`, `ExtendedData/Data`, `SchemaData/SimpleData`, en-têtes `Schema` tolérés, `name`, `description`, chemin des dossiers (`dossier`). GeoJSON : `FeatureCollection`, `Feature`, géométrie nue, `GeometryCollection`.
- Altitude toujours ignorée (signalée si elle est non nulle). Objets hors de la Guinée écartés et comptés ; fichier entièrement hors Guinée refusé.
- Géométrie invalide au sens PostGIS (anneau qui se croise) : **réparée** (`ST_MakeValid`) et signalée.
- Un `Placemark` à géométries de familles différentes donne un objet par famille.
- XML lu par un lecteur minimal sans dépendance : ni DTD, ni entité hors des cinq prédéfinies, imbrication limitée à 100 niveaux ; JSON limité à 64 niveaux.
- CRS : KML, KMZ et GPX sont en WGS 84 par définition du format ; un GeoJSON déclarant un autre CRS, et tout CSV, exigent un `epsgSource` choisi par l'utilisateur dans une liste blanche (`PROJETS_VOIRIE_CRS_SOURCE_AUTORISES`, défaut 4326, 32628, 32629), transformé par PostGIS ; aucune transformation silencieuse (`CONTRAT-IMPORT.md`, section 5).

## Réglages serveur (variables d'environnement)

Toute valeur absente, illisible ou hors bornes redonne le défaut.

| Variable | Défaut | Bornes | Rôle |
|---|---|---|---|
| `PROJETS_VOIRIE_DELAI_ANALYSE_MS` | 20 000 | 1 000 à 300 000 | `statement_timeout` partagé par les requêtes d'une analyse ou d'un export CSV |
| `PROJETS_VOIRIE_DELAI_CARTE_MS` | 10 000 | 1 000 à 120 000 | idem, carte |
| `PROJETS_VOIRIE_DELAI_DEPOT_MS` | 60 000 | 5 000 à 600 000 | `statement_timeout` de chaque requête d'un dépôt, d'une décision ou d'un retrait |
| `PROJETS_VOIRIE_VERROU_MS` | 5 000 | 500 à 60 000 | `lock_timeout` (attente du verrou du projet) |
| `PROJETS_VOIRIE_SOMMETS_PAR_OBJET` | 100 000 | 1 000 à 1 000 000 | plafond de sommets par objet |
| `PROJETS_VOIRIE_SOMMETS_PAR_FICHIER` | 2 000 000 | 10 000 à 10 000 000 | plafond de sommets par fichier |
| `PROJETS_VOIRIE_CONFLITS_MAX` | 20 000 | 100 à 100 000 | conflits au plus par analyse persistée (422 `ANALYSE_TROP_VOLUMINEUSE`, avec `conflitsMax`) |
| `PROJETS_VOIRIE_ANALYSE_INTERVALLE_S` | 60 | 0 à 3 600 | délai minimal entre deux analyses persistées **terminées** d'un même projet (429 `ANALYSE_TROP_FREQUENTE`) ; 0 le supprime (bancs d'essai, jamais en production) ; une analyse en échec ne compte pas |

Le délai de transaction de Prisma est un délai CLIENT : il ne coupe pas la requête dans PostgreSQL. Les délais ci-dessus sont posés côté base (`set_config('statement_timeout', ..., true)`) et prouvés par le banc (une requête `pg_sleep(8)` sous un délai de 1 s est coupée en moins de 3 s ; l'analyse du banc de charge sous un délai de 1 s répond 504 en 1,6 s et plus aucune requête n'est active ensuite). Une requête coupée au milieu d'un calcul GEOS ressort en erreur `XX000 ... InterruptedException` : le serveur la traite comme un délai dépassé.

## Traçabilité des consultations

Lire la géométrie d'un réseau de tiers (carte, couche de conflits et croisements de l'analyse) **fait partie de la mission d'un compte qui a la clé de module** `projets-voirie` : ce n'est pas un export de fichier, mais c'est une capacité d'extraction, donc elle est tracée plutôt qu'interdite. Pour chaque jeu `CONFIDENTIEL_CONCESSIONNAIRE` ou `INFRASTRUCTURE_SENSIBLE` rendu, une ligne `audit_logs` `ConsultationJeuProjet` (action `SECURITY_EVENT`) est écrite **avant** la remise des données, au plus une par compte, par jeu et par fenêtre de 15 minutes. Elle porte `route`, `nbObjets`, `bbox`, `zoom`, `confidentialite`, aucune géométrie ni contenu. Les niveaux `RESTREINT_PROJET`, `INTERNE` et `PUBLIC` ne sont pas tracés. Aucun niveau de confidentialité ne restreint encore l'accès : c'est une étiquette, la clé de module et le périmètre territorial décident.

## Décisions à prendre (non traitées par ce lot)

| Point de la revue | Constat | Décision attendue |
|---|---|---|
| m2 | L'historique d'audit (`GET /api/audit`) ne filtre par périmètre territorial aucun type d'entité (la règle n'existe nulle part ailleurs) : un compte régional qui connaît l'UUID d'un jeu d'une autre région lit ses lignes d'audit (nom de fichier, empreinte, comptes, justification, jamais de géométrie). | Étendre le filtre territorial de l'audit à tous les types, ou seulement à `ProjetVoirie`, `JeuDonneesProjet`, `ExportProjetVoirie`, `ConsultationJeuProjet`. Non fait ici : `modules/audit/audit.routes.ts` est partagé par tous les modules. |
| m5 | Le déposant peut autoriser son propre jeu (l'audit note `memePersonne`, sans bloquer : choix du contrat). | Exiger un second compte pour les jeux `RESEAU_TIERS`, ou une alerte. |
| m6 | Les objets des jeux rejetés, remplacés ou retirés restent en base et en sauvegarde (suppression logique, AGENTS.md règle 2) ; chaîne GDAL en préproduction : sorties conservées 72 h. | Politique de conservation et voie de purge pour un tiers qui retire son accord ; purge des sorties GDAL avant tout branchement. |
| m7 | Pas de CSP sur la page HTML de l'application (`frontend/nginx.conf`, `location = /index.html`), ancien et hors module. | À traiter par le lot frontend / infra, après test dans Teams. |
| m8 | Les paramètres `bbox` et `jeux` apparaissent dans les journaux d'accès (morgan, nginx) ; les tuiles OSM et Esri révèlent la zone consultée. | Filtrer ces paramètres des journaux ; décision de fond sur les fonds de carte. |
| m9 | `docs/reports/LOT-RC-00-RAPPORT.md` (hors module) nomme l'opérateur, le fournisseur du plan et des agrégats du pilote. | Relecture DSI avant toute publication hors équipe. |

## Sécurité et audit

- **Visibilité des statuts** : `ADMIN` et `GESTIONNAIRE` voient tous les jeux sauf `RETIRE` ; tout autre compte (lecteur) ne voit que les jeux `AUTORISE`, et le serveur filtre dans la requête (liste, fiche, compteurs de `GET /`). Les jeux en contrôle, rejetés ou remplacés n'apparaissent pas pour un lecteur ; `remplaceId` lui est rendu à `null` (l'identifiant d'une version qu'il ne peut pas lire). Décision prise le 01/11/2026 sur demande du coordinateur (ex-point « quarantaine visible des lecteurs dans la liste des jeux »).

- Données RESTREINT par défaut, jamais dans l'API publique ni les tuiles (test statique `isolation.test.ts` + banc : aucune réponse publique ne contient les noms des objets).
- Aucune écriture hors des tables du module et d'`audit_logs` (test statique + banc : comptes de toutes les tables avant et après).
- Entités auditées : `ProjetVoirie`, `JeuDonneesProjet`, `ConcessionnaireReseau`, `ExportProjetVoirie`, `ConsultationJeuProjet` (lecture de la géométrie d'un jeu sensible, voir plus haut) ; lot RC-3 : `AnalyseConflitProjet` (une ligne par analyse, y compris en échec), `RegleConflit` (création, approbation, dérogation), `ConflitProjet` (une ligne par écriture humaine : attribution, transition, preuve, décision proposée, approuvée ou refusée, dérogation), `ExportConflitsProjetVoirie`. Aucune ligne ne porte de géométrie. Actions : `CREATE` (projet, concessionnaire, dépôt, export), `UPDATE` (projet), `VALIDATE` (autorisation), `REJECT` (rejet), `DELETE` (retrait). Les valeurs auditées ne portent aucune géométrie.
- La base refuse : suppression physique, modification d'un objet, objet vide / invalide / hors Guinée / de type incohérent, jeu dont rôle, concessionnaire, nature, version, retrait ou décision sont incohérents, deux jeux autorisés de même clé.

## Dossiers de conflit (lot RC-3)

Contrat : `docs/projets-voirie/CONTRAT-CONFLITS.md` (modèle, machine à états, règles). Les exemples ci-dessous sont des réponses réelles du banc `backend/tests-integration/conflits-projets-voirie.integration.mts` (données 100 % synthétiques, identifiants raccourcis, listes tronquées).

**Principe.** Le socle calcule une analyse 2D à la demande ; ce lot la **persiste** : une analyse est reproductible (versions et empreintes des jeux, versions des règles, largeurs, version de l'algorithme) et chaque résultat devient un **dossier de conflit** suivi dans le temps. Un conflit est un **signal de vérification, jamais un ordre** : aucune route, aucun champ ne crée d'ordre, de déplacement ni de décision automatique. L'absence de conflit détecté ne prouve pas l'absence de réseau.

Mêmes gardes, dans le même ordre, que le socle (voir « Gardes, dans l'ordre ») : jeton, clé de module, octet NUL, UUID (`IDENTIFIANT_INVALIDE` pour `:cid`, `:aid`, `:did`, `:regleId` et le paramètre `avec`), rôle, **projet désigné (404 identique hors périmètre)**, validation du corps. Les 16 routes figurent à l'inventaire des accès (`inventaire-acces.test.ts`, 31 routes au total pour le module).

### Routes

| Route | Rôle | Réponse |
|---|---|---|
| `GET /:id/regles` | lecture | `{ regles, effectives }` : règles du projet et générales (dont la règle par défaut), et la règle **effective** de chacune des six familles |
| `POST /:id/regles` | ADMIN, GESTIONNAIRE | 201 `{ regle }` (`BROUILLON`, version suivante) |
| `POST /:id/regles/:regleId/approuver` | ADMIN | `{ regle }` ; corps `{ justification, derogation? }` |
| `POST /:id/analyses` | ADMIN, GESTIONNAIRE | 201 `{ analyse, resume }` ; corps vide `{}` (aucun paramètre de calcul n'est modifiable par la requête) |
| `GET /:id/analyses` | lecture | `{ analyses, curseurSuivant }` (`limite` 1 à 100, défaut 25 ; `curseur`) |
| `GET /:id/analyses/:aid` | lecture | `{ analyse }` |
| `GET /:id/analyses/:aid/comparaison?avec=:bid` | lecture | `:aid` est la comparée, `:bid` la **référence** |
| `GET /:id/conflits` | lecture | `{ conflits, compteurs, total, curseurSuivant }` |
| `GET /:id/conflits/export.csv` | ADMIN, GESTIONNAIRE, audité | `text/csv`, un conflit par ligne, aucune géométrie |
| `GET /:id/conflits/:cid` | lecture | fiche complète |
| `PATCH /:id/conflits/:cid` | ADMIN, GESTIONNAIRE | `{ conflit, modifie }` |
| `POST /:id/conflits/:cid/statut` | ADMIN, GESTIONNAIRE (selon la transition) | `{ conflit }` |
| `POST /:id/conflits/:cid/preuves` | ADMIN, GESTIONNAIRE | 201 `{ preuve }` |
| `POST /:id/conflits/:cid/decisions` | ADMIN, GESTIONNAIRE | 201 `{ decision }` |
| `POST /:id/conflits/:cid/decisions/:did/approuver` et `/refuser` | ADMIN, GESTIONNAIRE (séparation des tâches) | `{ decision }` ; corps `{ motif, derogation? }` |

### Calcul : ce qu'est un conflit

Entrées : les jeux **`AUTORISE`** du projet (jamais la quarantaine), les largeurs du projet, la règle applicable à la famille de chaque réseau. Le calcul réutilise celui du socle (mêmes axes simplifiés, mêmes tampons, mêmes morceaux d'axe, même mesure sur la géographie) : la mesure d'un conflit est celle de l'analyse indicative pour le même axe et le même objet (vérifié par le banc, écart maximal 0,02 m). Seuls les réseaux **linéaires** sont évalués.

Un conflit = une **partie connexe** d'un réseau, pour un axe, un objet et un type ; les parties d'un même objet qui tombent dans la même cellule de localisation (environ 22 m, `floor(x / 0,0002° + 0,5)`) ne font qu'un dossier.

| Type | Géométrie du dossier | Quand |
|---|---|---|
| `INTERSECTION_CHAUSSEE` | partie du réseau dans la bande de chaussée (axe ± demi-chaussée) | réseau dans la chaussée |
| `INTERSECTION_EMPRISE` | partie dans l'emprise, **hors chaussée** | réseau dans l'emprise |
| `PROXIMITE` | partie comprise dans la bande élargie | objet sans aucune partie dans l'emprise, à moins de demi-emprise + tolérance + précision déclarée x marge |
| `TRAVERSEE` | un point par croisement | le réseau coupe l'axe |
| `COUVERTURE_INSUFFISANTE` | l'axe | aucun jeu de réseau autorisé (linéaire) dont l'emprise englobante **contient** l'axe : zone à investiguer, **jamais** « absence de réseau » |
| `DIVERGENCE_SOURCES` | | **non calculé dans ce lot** (voir « Ce qui n'est pas fait ») |

La **mesure** porte `longueurChausseeM`, `longueurEmpriseM` (chaussée comprise, comme dans le socle), `distanceMinM` (à l'axe, `null` pour une couverture), `nbCroisements`, `longueurPieceM` (longueur de la partie, de l'axe pour une couverture). Chaque objet d'un fichier produit ses propres dossiers : trois circuits de même tracé donnent trois dossiers (le socle les fusionne dans ses totaux, pas dans son détail par objet).

**Classification initiale.** Un calcul ne produit que `A_INVESTIGUER` ou `POTENTIEL`, jamais un statut humain. Précision déclarée A, B ou C : `POTENTIEL` ; D, E ou **inconnue** : `A_INVESTIGUER` (motif `PRECISION_INCONNUE` ou `PRECISION_INSUFFISANTE`) ; couverture et divergence : toujours `A_INVESTIGUER`. `verticalEvalue` est **toujours faux** dans ce lot (profondeur et altitude absentes) et chaque dossier porte la mention ; aucun champ ne permet de le déclarer évalué (le noyau sait faire passer en `A_INVESTIGUER` un conflit dont le vertical est exigé et non évalué, derrière un paramètre faux dans ce lot).

**Clé stable.** `cle` = SHA-256 de (projet, axe, objet de réseau, type, cellule de localisation). L'objet de réseau est identifié par concessionnaire + nom (ou empreinte de géométrie s'il n'a pas de nom), jamais par les identifiants de jeu et d'objet, qui changent à chaque version. Deux objets de même nom, même axe, même type et même cellule restent deux dossiers (départagés par l'empreinte) ; deux copies exactes n'en font qu'un.

### Analyse persistée

`POST /:id/analyses` rend 201 :

```json
{ "analyse": { "id": "d7ee318c-...", "projetId": "8ec2f02b-...", "numero": 1, "statut": "TERMINEE", "largeurEmpriseM": 15, "largeurChausseeM": 7,
    "regles": [ { "code": "RC-2D-0.1", "portee": "DEFAUT", "famille": "TELECOM", "regleId": "00000000-0000-4000-8000-00000000c301", "version": 0, "margeIncertitude": 1, "toleranceProximiteM": 0 } ],
    "jeux": [ { "role": "RESEAU_TIERS", "jeuId": "ce7ac294-...", "sha256": "25ce7e1e94f7...", "statut": "AUTORISE", "version": 1, "nomFichier": "r1.geojson", "typeReseau": "TELECOM", "classePrecision": "B", "concessionnaireId": "71b4a746-...", "precisionHorizontaleM": 3.5 } ],
    "versionAlgorithme": "RC3-2D-UTM-1", "nbConflitsTrouves": 14, "declenchePar": { "id": "d592c42c-...", "nomComplet": "Sekou Gestionnaire" }, "duree": 345, "createdAt": "2026-11-06T13:46:48.594Z",
    "resume": { "statut": "TERMINEE", "versionAlgorithme": "RC3-2D-UTM-1",
      "totaux": { "conflitsTrouves": 14, "axes": 2, "jeuxReseau": 3, "axesNonCouverts": 1 },
      "parType": { "INTERSECTION_CHAUSSEE": 6, "INTERSECTION_EMPRISE": 4, "PROXIMITE": 1, "TRAVERSEE": 2, "COUVERTURE_INSUFFISANTE": 1 },
      "parStatut": { "POTENTIEL": 12, "A_INVESTIGUER": 2 },
      "nouveaux": 14, "retrouves": 0, "identiques": 0, "modifies": 0, "disparus": 0, "reapparus": 0, "marquesAReexaminer": 0,
      "plafond": { "conflitsMax": 20000 },
      "limites": [ "Conflit vertical non évalué : profondeur et altitude absentes.", "Aucun conflit détecté ne prouve l'absence de réseau.", "Résultat indicatif : aucune décision de déplacement n'en découle.", "..." ] } },
  "resume": { "...": "même objet que analyse.resume" } }
```

`parStatut` est l'état du projet **après** l'analyse (statuts existants, inchangés, plus statuts initiaux des nouveaux). `statut` vaut `TERMINEE` ou `ECHEC` (une analyse qui échoue par délai ou volume laisse une ligne `ECHEC` sans conflit : `resume.erreur = { code, message }` ; elle n'est pas comparable, 409 `ANALYSE_NON_COMPARABLE`). Les `jeux` d'une analyse listent les jeux **pris en compte** (axes et réseaux autorisés) avec leur empreinte ; une analyse est immuable (la base refuse UPDATE et DELETE).

**Rejeu** (une nouvelle analyse sur un projet qui a déjà des conflits) :
- conflit retrouvé (même clé) : `derniereAnalyseId`, mesure, géométrie, objet et jeu courants sont mis à jour ; si la **mesure** a changé, `aReexaminer = true` et `motifReexamen = MESURE_MODIFIEE` ; si la mesure est la même mais que le plan d'axes, le jeu de réseau (empreinte) ou la classe de précision ont changé, `NOUVELLE_VERSION_DONNEES` ;
- conflit **non retrouvé** : il reste en base, `aReexaminer = true`, `motifReexamen = NON_RETROUVE` ;
- conflit nouveau : créé ;
- **aucun statut, risque, responsable, échéance ni action proposée n'est jamais modifié par un calcul** (la base le refuse : déclencheur `conflits_projet_recalcul`, la transaction d'analyse pose `bdri.conflit_recalcul`) ; si la classe de précision d'un jeu change, le dossier est marqué à réexaminer, il n'est pas requalifié ;
- un dossier non retrouvé qui réapparaît avec la même mesure redevient normal (`aReexaminer = false`) et reçoit une ligne `RETROUVE` ;
- **idempotent** : rejouer les mêmes entrées ne change que `derniereAnalyseId` ; aucune ligne d'historique n'est ajoutée pour un dossier inchangé.

**Cadence (revue RC-3, m8).** Une analyse terminée écrit une ligne immuable et une ligne d'audit même si rien n'a changé : une nouvelle analyse n'est acceptée que 60 s (`PROJETS_VOIRIE_ANALYSE_INTERVALLE_S`) après la précédente analyse **terminée** du même projet ; sinon **429 `ANALYSE_TROP_FREQUENTE`**, avec le délai restant dans le corps (`retryAfterS`) et dans l'en-tête `Retry-After`, et rien n'est écrit. Le délai est par projet, vérifié sous le verrou de l'analyse (deux demandes qui se croisent ne passent pas toutes deux) ; une analyse en échec (`ECHEC`) ne compte pas : après un 504 ou un 422, on recommence tout de suite.

Une seule analyse à la fois par projet (verrou consultatif propre à l'analyse, qui ne bloque pas les autres opérations du projet) : 503 `PROJET_OCCUPE` sinon. Trois analyses simultanées au plus par processus (503 `SERVICE_OCCUPE`, comme le socle). Délai côté base : `PROJETS_VOIRIE_DELAI_ANALYSE_MS` (504 `ANALYSE_TROP_LONGUE`) ; plafonds de sommets du socle (422 `ANALYSE_TROP_VOLUMINEUSE` avec `sommetsAxes` et `sommetsReseau`) ; plafond de conflits `PROJETS_VOIRIE_CONFLITS_MAX` (défaut 20 000, bornes 100 à 100 000 ; 422 `ANALYSE_TROP_VOLUMINEUSE` avec `conflitsMax`).

**Comparaison** : `GET /:id/analyses/:aid/comparaison?avec=:bid` (`:aid` = comparée, `:bid` = référence). Extrait réel (analyse 4 contre analyse 3, après décalage de l'axe A de 4 m) :

```json
{ "reference": { "id": "b6d0b635-...", "numero": 3, "createdAt": "2026-11-06T13:46:55.513Z" },
  "comparee": { "id": "ddffbb93-...", "numero": 4, "createdAt": "2026-11-06T13:46:55.976Z" },
  "identiques": { "nb": 10 },
  "apparus": { "nb": 4, "cles": [ "1d57180b16df..." ], "detailsTronques": false,
    "conflits": [ { "cle": "1d57180b16df...", "id": "b0853b7e-...", "type": "INTERSECTION_CHAUSSEE", "axe": "Axe A", "statut": "POTENTIEL", "aReexaminer": false } ] },
  "disparus": { "nb": 3, "cles": [ "3a0cebb9fcdd..." ], "detailsTronques": false,
    "conflits": [ { "cle": "3a0cebb9fcdd...", "id": "b7949562-...", "type": "INTERSECTION_EMPRISE", "axe": "Axe A", "statut": "POTENTIEL", "aReexaminer": true } ] },
  "modifies": { "nb": 2, "cles": [ "1e6ff5f1edd6..." ], "detailsTronques": false, "conflits": [ { "...": "même forme" } ] } }
```

`identiques` porte aussi `cles` (la liste complète). `conflits` identifie les dossiers touchés (au plus 1 000 par catégorie, `detailsTronques` sinon) : un dossier disparu est toujours en base, avec son statut.

### Liste et fiche

`GET /:id/conflits` : filtres `statut` et `type` (une valeur ou une liste séparée par des virgules), `axe` (nom de l'axe, casse ignorée ; voir « Jokers » ci-dessous), `concessionnaireId`, `responsableId`, `aReexaminer` et `echeanceDepassee` (`true` ou `false`), `q` (recherche dans l'axe, l'action proposée, le concessionnaire, le nom de l'objet), `limite` (1 à 200, défaut 50), `curseur` (opaque). Tout filtre inconnu ou invalide : 400 `PARAMETRES_INVALIDES` ; curseur invalide : 400 `CURSEUR_INVALIDE`. `total` = nombre de conflits qui répondent à **tous** les filtres ; `compteurs` = répartition par statut des conflits qui répondent aux filtres **hors statut** (pour afficher les pastilles d'un filtre à choix multiple). Une échéance est « dépassée » si elle est antérieure à aujourd'hui (UTC) et que le conflit n'est ni `CLOTURE` ni `INFIRME`. Tri : du plus récent au plus ancien.

**Curseur (revue RC-3, m7).** Le curseur est opaque mais lu par le serveur : tout curseur qui n'a pas la forme produite par le serveur est refusé en 400 `CURSEUR_INVALIDE` avant tout accès à la base (dossiers : horodatage ISO 8601 UTC à la milliseconde, année 1970 à 2200, identifiant UUID en minuscules ; analyses : entier de 1 à 2 147 483 647).

**Qui voit quoi (revue RC-3, M1).** Un dossier dépend d'un jeu (le réseau qui l'a produit ou, pour une couverture insuffisante, le plan d'axes). Un jeu `RETIRE` n'est montré à personne ; un jeu `REMPLACE`, reçu, contrôlé ou rejeté n'est montré qu'à `ADMIN` et `GESTIONNAIRE` ; un jeu `AUTORISE` à tout compte qui a la clé de module. Conséquences : (1) **un compte qui ne décide pas** (lecteur...) ne voit **pas** un dossier dont un jeu n'est pas `AUTORISE` : il est absent de la liste, du `total` et des `compteurs`, des comparaisons, et sa fiche répond 404 `CONFLIT_INTROUVABLE` ; il revient dès que l'analyse suivante le repointe sur un jeu autorisé ; (2) **un compte qui décide** voit toujours le dossier (archive des verdicts, preuves et décisions), mais, pour un jeu `RETIRE`, **sans rien de ce que ce jeu a produit** : `geometrie`, `bbox`, `jeuReseauId`, `objet`, `mesure`, `concessionnaire`, `typeReseau`, `classePrecision` (nuls, `geometrieMasquee: true`), `regle` (nulle), `tronconsProches` (vide), détails des lignes d'historique issues du calcul (`{ "masquees": true }`), colonnes correspondantes de l'export CSV ; les filtres `concessionnaireId` et `q` ne sondent pas le contenu d'un jeu retiré ; (3) `GET /analyses` et `GET /analyses/:aid` ne rendent, dans `jeux`, que les jeux lisibles selon leur statut **courant** ; la comparaison ne liste pas les dossiers masqués et ne les compte pas. Les `resume` des analyses (totaux, conflits par type et par statut) sont des agrégats figés au calcul : ils ne sont pas filtrés. Les règles (`GET /regles`) sont des paramètres de calcul, sans donnée de jeu : elles ne sont pas filtrées.

**Jokers (revue RC-3, observation).** Prisma n'échappe ni `%`, ni `_`, ni `\` dans `contains` et dans `equals` insensible à la casse (ILIKE). Mesuré sur PostGIS (banc, section 14) : `q=%` et `q=_` rendent tous les dossiers, `axe=Axe_A` rend les mêmes dossiers que `axe=axe a`, `q=Fibre_Marqueur` les mêmes que `q=fibre-marqueur`, `q=\%` ne rend rien. Aucune injection (les valeurs sont liées) ; mais le filtre `axe` n'est **pas** une égalité stricte et un joker élargit la recherche. Non corrigé (hors périmètre) ; à échapper si l'exploitant veut une égalité stricte.

```json
{ "conflits": [ { "id": "ddfedf00-...", "projetId": "8ec2f02b-...", "cle": "664876a4a805...", "type": "TRAVERSEE", "axe": "Axe A", "statut": "POTENTIEL",
      "risque": null, "aReexaminer": false, "motifReexamen": null, "responsable": null, "echeance": null, "echeanceDepassee": false, "actionProposee": null,
      "classePrecision": "B", "verticalEvalue": false, "concessionnaire": { "id": "71b4a746-...", "nom": "Operateur Telecom Synthetique" }, "typeReseau": "TELECOM",
      "jeuReseauId": "ce7ac294-...", "objet": { "id": "8", "nom": "Fibre-Marqueur P" },
      "mesure": { "distanceMinM": 0, "nbCroisements": 1, "longueurPieceM": 0, "longueurEmpriseM": 0, "longueurChausseeM": 0 },
      "premiereAnalyseId": "d7ee318c-...", "derniereAnalyseId": "b1c20bdc-...", "bbox": [ -10.0908815, 9.1805913, -10.0908815, 9.1805913 ], "geometrieMasquee": false,
      "createdAt": "2026-11-06T13:46:48.250Z", "updatedAt": "2026-11-06T13:46:50.049Z" } ],
  "compteurs": { "A_INVESTIGUER": 2, "POTENTIEL": 12, "CONFIRME": 0, "INFIRME": 0, "TRAITEMENT_DECIDE": 0, "CLOTURE": 0 }, "total": 14, "curseurSuivant": null }
```

La liste ne porte **aucune géométrie** : `bbox` (ouest, sud, est, nord) suffit à zoomer. `GET /:id/conflits/:cid` rend la fiche :

```json
{ "conflit": { "...": "les champs de la liste", "geometrie": { "type": "LineString", "coordinates": [ [ -10.092065, 9.180606 ], [ -10.091519, 9.180608 ] ] } },
  "sources": [ { "jeuId": "441dd75a-...", "role": "AXES_TRAVAUX", "version": 1, "sha256": "707294b93bbf...", "statut": "AUTORISE", "nomFichier": "axes.kml", "confidentialite": "RESTREINT_PROJET", "classePrecision": null, "precisionHorizontaleM": null, "concessionnaire": null, "typeReseau": null, "dateDonnees": null },
               { "jeuId": "ce7ac294-...", "role": "RESEAU_TIERS", "version": 1, "sha256": "25ce7e1e94f7...", "statut": "AUTORISE", "nomFichier": "r1.geojson", "confidentialite": "CONFIDENTIEL_CONCESSIONNAIRE", "classePrecision": "B", "precisionHorizontaleM": 3.5, "concessionnaire": { "id": "71b4a746-...", "nom": "Operateur Telecom Synthetique" }, "typeReseau": "TELECOM", "dateDonnees": null } ],
  "regle": { "code": "RC-2D-0.1", "portee": "DEFAUT", "famille": "TELECOM", "regleId": "00000000-0000-4000-8000-00000000c301", "version": 0, "toleranceProximiteM": 0, "margeIncertitude": 1, "versionAlgorithme": "RC3-2D-UTM-1" },
  "largeurs": { "empriseM": 15, "chausseeM": 7 },
  "analyses": { "premiere": { "id": "d7ee318c-...", "numero": 1, "createdAt": "..." }, "derniere": { "id": "d7ee318c-...", "numero": 1, "createdAt": "..." } },
  "tronconsProches": [ { "code": "BANC-T-PROCHE", "nom": "Troncon proche de l'axe A" } ],
  "historique": [ { "id": "f2e689b4-...", "action": "CREATION", "ancienStatut": null, "nouveauStatut": "POTENTIEL", "justification": null, "acteur": null, "analyseId": "d7ee318c-...", "analyseNumero": 1,
                    "donnees": { "type": "INTERSECTION_CHAUSSEE", "axe": "Axe A", "statutInitial": "POTENTIEL", "motifs": [], "notes": [ "VERTICAL_NON_EVALUE" ], "classePrecision": "B", "mesure": { "...": "..." } }, "createdAt": "..." } ],
  "preuves": [], "decisions": [],
  "transitionsPossibles": [ { "vers": "CONFIRME", "justificationRequise": true, "preuveRequise": true, "decisionRequise": false, "cloture": false, "bloquee": "PREUVE_REQUISE" },
                            { "vers": "INFIRME", "justificationRequise": true, "preuveRequise": false, "decisionRequise": false, "cloture": false, "bloquee": null } ],
  "avertissements": [ "Un conflit est un signal de vérification : aucun déplacement n'est décidé ni ordonné par le système.", "Conflit vertical non évalué : profondeur et altitude absentes.", "L'absence de conflit détecté ne prouve pas l'absence de réseau." ] }
```

- `transitionsPossibles` ne liste que les transitions que **le compte** peut tenter depuis l'état courant (vide pour un compte qui ne décide pas, et pour un dossier clos) ; `bloquee` dit ce qui la refuserait aujourd'hui (`PREUVE_REQUISE`, `DECISION_REQUISE`) ; `cloture: true` signale qu'une mention de récolement peut être exigée. **Aucune action « déplacer » ni « ordonner » n'existe.**
- `regle` est celle de la **dernière analyse** pour la famille du réseau (pour un dossier de couverture, la première règle de l'analyse). `sources` : le plan d'axes et le jeu de réseau avec versions et empreintes ; un lecteur n'y voit que les jeux `AUTORISE`, un `RETIRE` n'est montré à personne.
- `historique` est trié du plus ancien au plus récent ; `acteur` est nul pour un calcul (alors `analyseId` renseigné). `donnees` d'une ligne `CREATION` porte les motifs d'investigation (`PRECISION_INCONNUE`, `PRECISION_INSUFFISANTE`, `COUVERTURE_INSUFFISANTE`) et les notes (`VERTICAL_NON_EVALUE`) ; une ligne `MESURE_MODIFIEE` porte `avant` et `apres`.
- **Géométrie et confidentialité.** `conflit.geometrie`, `bbox` et `jeuReseauId` suivent la règle des jeux du socle : un **lecteur** ne les reçoit (valeurs `null`, `geometrieMasquee: true`) que si le jeu de réseau est encore `AUTORISE` ; un jeu `REMPLACE` reste visible d'un ADMIN ou GESTIONNAIRE, un jeu `RETIRE` n'est visible de personne (le dossier reste, sa géométrie non). Un dossier de couverture n'a pas de jeu de réseau : sa géométrie (l'axe) est toujours rendue. Lire la géométrie ou la boîte englobante d'un réseau `CONFIDENTIEL_CONCESSIONNAIRE` ou `INFRASTRUCTURE_SENSIBLE` (liste ou fiche) est **tracé** comme la carte : une ligne `ConsultationJeuProjet` (`route: "conflits"`) par compte, par jeu et par fenêtre de 15 minutes, écrite avant la remise, sans géométrie.
- Les réponses d'**écriture** (`PATCH`, `statut`) rendent le conflit sans `bbox` ni `geometrie` : relire la fiche.

### Statuts et transitions

Dix transitions seulement ; toute autre : 409 `TRANSITION_INTERDITE` (y compris vers le même statut, et toute sortie de `CLOTURE`). Chaque transition exige une **justification de 10 caractères au moins** (422 `JUSTIFICATION_REQUISE`) et écrit une ligne `STATUT` (acteur, ancien et nouveau statut, justification).

| De | Vers | Qui | Exigences |
|---|---|---|---|
| `A_INVESTIGUER` | `POTENTIEL`, `INFIRME` | ADMIN, GESTIONNAIRE | justification |
| `POTENTIEL` | `CONFIRME` | ADMIN, GESTIONNAIRE | justification, **au moins une preuve** (409 `PREUVE_REQUISE`) |
| `POTENTIEL` | `INFIRME`, `A_INVESTIGUER` | ADMIN, GESTIONNAIRE | justification |
| `CONFIRME` | `TRAITEMENT_DECIDE` | ADMIN, GESTIONNAIRE | justification, **une décision `APPROUVEE` depuis le dernier passage à `CONFIRME`** (409 `DECISION_REQUISE` ; une approbation d'une confirmation antérieure est périmée) |
| `CONFIRME`, `TRAITEMENT_DECIDE` | `INFIRME` | ADMIN (GESTIONNAIRE : 403 `ROLE_INSUFFISANT`) | justification |
| `TRAITEMENT_DECIDE` | `CLOTURE` | ADMIN | justification (le motif), séparation des tâches, mention du récolement si un déplacement de réseau est décidé |
| `INFIRME` | `A_INVESTIGUER` | ADMIN, GESTIONNAIRE | justification (réouverture) |

Ordre des contrôles : transition connue (409), rôle (403), justification (422), preuve (409), décision (409), clôture. Corps : `{ "vers": "...", "justification": "...", "derogation": "...", "recolementAValider": true }` (`derogation` et `recolementAValider` facultatifs). Une transition faite par une personne **acquitte** le drapeau `aReexaminer` (la ligne d'historique porte `reexamenAcquitte` avec le motif d'origine). Un **verdict humain** (`CONFIRME`, `INFIRME`, `TRAITEMENT_DECIDE`, `CLOTURE`) n'est jamais modifié par un calcul.

Clôture : si une décision `DEPLACER_RESEAU` est approuvée, le corps doit porter **`recolementAValider: true`** (mention explicite que le récolement reste à valider ; le récolement n'est pas géré dans ce lot) sinon 422 `MENTION_RECOLEMENT_REQUISE` ; la mention est inscrite dans l'historique. **Séparation des tâches** : la personne qui a placé le dossier en `TRAITEMENT_DECIDE` (la « proposition » de clôture) ne le clôt pas : 409 `SEPARATION_DES_TACHES`, sauf `derogation` motivée (10 caractères au moins) d'un ADMIN, inscrite dans l'historique et dans l'audit.

Extrait réel d'une infirmation conservée (AT-08) : la ligne d'historique `STATUT` porte `acteur`, `createdAt`, `justification`, `ancienStatut: "A_INVESTIGUER"`, `nouveauStatut: "INFIRME"` ; la ligne `CREATION` (la proposition du calcul) reste en tête de l'historique et la mesure reste lisible ; le dossier reste dans la liste (`statut=INFIRME`) et offre la réouverture.

### Attribution, preuves, décisions

**`PATCH /:id/conflits/:cid`** : `responsableId` (UUID d'un compte actif, ou `null`), `echeance` (`AAAA-MM-JJ` ou `null`), `risque` (`FAIBLE`, `MOYEN`, `ELEVE`, `INCONNU` ou `null`), `actionProposee` (texte de 2 000 caractères au plus, ou `null`), et `aReexaminer: false` avec `justification` (10 caractères au moins, 422 sinon) pour **acquitter un re-examen** (ligne `REEXAMEN` d'un acteur, avec le motif d'origine). Tout autre champ (dont `statut`, `verticalEvalue`, `aReexaminer: true`) : 400 `CHAMPS_INVALIDES`. Un changement écrit une ligne `ATTRIBUTION` (`donnees`: `{ champ: { avant, apres } }`) ; **sans changement, 200 avec `modifie: false` et aucune ligne**. Responsable inexistant : 400 `RESPONSABLE_INCONNU` ; compte **inactif** ou **sans la clé de module** `projets-voirie` (un `ADMIN` l'a toujours) : 422 `RESPONSABLE_NON_HABILITE` (le périmètre territorial du responsable n'est pas contrôlé). **Dossier `CLOTURE`** : plus aucune modification de `responsableId`, `echeance`, `risque` ni `actionProposee` (409 `STATUT_INCOMPATIBLE`, ADMIN compris) ; seul l'acquittement d'un re-examen reste possible. **Déplacement de réseau** : tant qu'une décision `DEPLACER_RESEAU` est proposée ou approuvée, `responsableId: null` est refusé (422 `RESPONSABLE_REQUIS`) ; désigner un autre responsable reste possible. Réponse :

```json
{ "conflit": { "id": "0cf08ccc-...", "statut": "POTENTIEL", "risque": "ELEVE", "responsable": { "id": "e4d5019b-...", "nomComplet": "Fanta Gestionnaire" },
               "echeance": "2099-01-31", "echeanceDepassee": false, "actionProposee": "Verifier la profondeur avec l'operateur avant tout travaux", "...": "..." }, "modifie": true }
```

**`POST /:id/conflits/:cid/preuves`** : `{ type, texte, reference? }` (`type` : `NOTE`, `REFERENCE_DOCUMENT`, `CONTACT_CONCESSIONNAIRE`, `RELEVE_TERRAIN` ; `reference` : texte libre de 500 caractères, **aucun fichier** dans ce lot). Journal en **ajout seul** (la base refuse UPDATE et DELETE). 201 :

```json
{ "preuve": { "id": "13e2d58a-...", "type": "REFERENCE_DOCUMENT", "texte": "Courrier de l'operateur confirmant le passage du cable", "reference": "Courrier 2026/045",
              "auteur": { "id": "d592c42c-...", "nomComplet": "Sekou Gestionnaire" }, "createdAt": "2026-11-06T13:46:52.734Z" } }
```

**`POST /:id/conflits/:cid/decisions`** : `{ option, justification, contraintes?, coutEstime?, coutReel?, deviseCout?, dateDebutPrevue?, dateFinPrevue? }`. `option` : `PROTEGER`, `ADAPTER_PROJET`, `DEPLACER_RESEAU`, `SANS_INTERVENTION`, `A_ETUDIER`. Une décision se **propose** pour un conflit `CONFIRME` (409 `STATUT_INCOMPATIBLE` sinon) avec une justification de 10 caractères (422). `DEPLACER_RESEAU` exige un **responsable désigné sur le dossier** (422 `RESPONSABLE_REQUIS`) et un **planning complet** (422 `PLANNING_REQUIS`) ; deux dates inversées : 422 `PLANNING_REQUIS`. `coutEstime` et `coutReel` sont **deux champs distincts, saisis, jamais calculés** (positifs ou nuls, 13 chiffres entiers au plus) ; un coût exige `deviseCout` (trois majuscules, ex. `GNF`) : 400 sinon. Proposer ne change pas le statut du conflit. 201 :

```json
{ "decision": { "id": "7e99ec76-...", "conflitId": "0cf08ccc-...", "option": "DEPLACER_RESEAU", "justification": "Deplacement du cable propose : la chaussee prevue le recouvre sur 7 m",
                "contraintes": "Coupure de service a coordonner avec l'operateur", "coutEstime": 12500000.5, "deviseCout": "GNF", "coutReel": null,
                "dateDebutPrevue": "2026-12-01", "dateFinPrevue": "2026-12-20", "statut": "PROPOSEE", "proposePar": { "id": "d592c42c-...", "nomComplet": "Sekou Gestionnaire" },
                "approuvePar": null, "approuveLe": null, "motifDecision": null, "derogationSeparation": null, "createdAt": "2026-11-06T13:46:53.478Z" } }
```

**`.../decisions/:did/approuver`** et **`/refuser`** : `{ motif, derogation? }` (motif de 10 caractères, 422 sinon). La décision doit être `PROPOSEE` (409 `DECISION_DEJA_TRANCHEE` : une décision tranchée ne change plus, la base le refuse) et le conflit `CONFIRME` (409 `STATUT_INCOMPATIBLE`). `approuvePar` est la personne qui a **tranché** (approbation ou refus). **Séparation des tâches** : la personne qui tranche une décision qu'elle a proposée doit avoir une `derogation` motivée (10 caractères au moins), exigée **aussi par une contrainte de la base** ; pour `DEPLACER_RESEAU`, ou dès qu'il existe au moins **deux comptes habilités** (ADMIN ou GESTIONNAIRE actifs, avec la clé de module, dans le périmètre du projet), seule la dérogation d'un **ADMIN** est admise ; s'il n'y a qu'un compte habilité, la dérogation motivée suffit. Sans dérogation valable : 409 `SEPARATION_DES_TACHES`. La dérogation est inscrite sur la décision, dans l'historique (`DECISION_APPROUVEE`, `DECISION_REFUSEE`) et dans l'audit (`memePersonne: true`).

### Règles de conflit

Une règle porte `toleranceProximiteM` (bande à vérifier **au-delà de l'emprise**, 0 à 1 000 m) et `margeIncertitude` (facteur appliqué à la **précision horizontale déclarée** du jeu, jamais inventée, 0 à 100, défaut 1) ; bande de proximité = demi-emprise + tolérance + précision x marge. Règle applicable à la famille d'un réseau : la plus récente approuvée, dans l'ordre **projet + famille**, **projet**, **générale + famille**, **générale**, **défaut** (`portee`: `PROJET_FAMILLE`, `PROJET`, `GENERALE_FAMILLE`, `GENERALE`, `DEFAUT`).

**La règle par défaut `RC-2D-0.1` est créée par la migration** (version 0, `APPROUVEE`, tolérance 0, marge 1, identifiant fixe `00000000-0000-4000-8000-00000000c301`, sans auteur : `systeme: true`) : une base neuve a toujours une règle applicable, sans amorçage à l'exécution, et le rejeu de la migration ne la duplique pas. Elle est la seule règle sans auteur ; aucun seuil n'y est inventé.

`POST /:id/regles` : `{ famille?, code, toleranceProximiteM, margeIncertitude?, justification }` (`famille` : une des six familles de réseau, ou absente = toutes ; `code` : 2 à 64 caractères, lettres, chiffres, `.`, `_`, `-`). La règle naît `BROUILLON`, rattachée au projet, en **version suivante** de (projet, famille, code) (1 pour la première) ; justification de 10 caractères (422). **Un brouillon n'est jamais appliqué.** `POST .../approuver` : ADMIN seulement (403 sinon), `{ justification, derogation? }`. L'**auteur** ne peut pas approuver sa propre règle sans `derogation` motivée (409 `SEPARATION_DES_TACHES`), tracée dans la règle (`derogationApprobation`) et dans l'audit. Une règle approuvée est **immuable** (409 `REGLE_IMMUABLE`, et déclencheur : on crée une nouvelle version) ; la règle par défaut aussi. Une règle approuvée s'applique à la **prochaine** analyse, qui enregistre sa version ; les analyses passées ne changent pas.

```json
{ "regle": { "id": "36e2dac3-...", "projetId": "8ec2f02b-...", "portee": "PROJET", "famille": "TELECOM", "code": "TOL-TELECOM", "version": 1, "toleranceProximiteM": 2, "margeIncertitude": 1.5,
             "statut": "BROUILLON", "justification": "Tolerance proposee par la direction technique", "systeme": false, "creePar": { "id": "d592c42c-...", "nomComplet": "Sekou Gestionnaire" },
             "approuvePar": null, "approuveLe": null, "motifApprobation": null, "derogationApprobation": null, "createdAt": "2026-11-06T13:46:54.880Z" } }
```

### Export CSV

`GET /:id/conflits/export.csv` (mêmes filtres que la liste, sans `limite` ni `curseur`) : `text/csv; charset=utf-8`, BOM UTF-8, séparateur `;`, virgule décimale, `Content-Disposition: attachment; filename="conflits-<code>-AAAA-MM-JJ.csv"`, `X-Lignes-Exportees`, 100 000 lignes au plus. Un conflit par ligne, **agrégats seulement, aucune géométrie**. Cellules neutralisées contre l'injection de formules (préfixe apostrophe si elles commencent par `=`, `+`, `-`, `@`, tabulation ou retour chariot) comme l'export du socle. Audité (`ExportConflitsProjetVoirie`) **avant** la remise. Réservé aux ADMIN et GESTIONNAIRE (403 pour un lecteur).

```
axe;type;statut;risque;aReexaminer;motifReexamen;concessionnaire;typeReseau;classePrecision;verticalEvalue;longueurChausseeM;longueurEmpriseM;distanceMinM;nbCroisements;longueurPieceM;responsable;echeance;actionProposee;nbPreuves;nbDecisions;premiereAnalyse;derniereAnalyse;cle
Axe A;INTERSECTION_CHAUSSEE;A_INVESTIGUER;;non;;Societe des Eaux Synthetique;EAU_POTABLE;inconnue;non;60,02;60,02;2;0;60,02;;;;0;0;1;2;45005a25f79d753c...
```

### Codes d'erreur ajoutés par ce lot

| Statut | Code | Cas |
|---|---|---|
| 400 | `IDENTIFIANT_INVALIDE` | `:cid`, `:aid`, `:did`, `:regleId` ou `avec` qui n'est pas un UUID |
| 400 | `CHAMPS_INVALIDES`, `PARAMETRES_INVALIDES`, `CURSEUR_INVALIDE`, `RESPONSABLE_INCONNU` | entrée mal formée (`details` donne le champ) |
| 403 | `ROLE_INSUFFISANT` | transition ou approbation réservée à l'ADMIN |
| 404 | `PROJET_INTROUVABLE` (masqué), `CONFLIT_INTROUVABLE`, `ANALYSE_INTROUVABLE`, `REGLE_INTROUVABLE`, `DECISION_INTROUVABLE` | inexistant ou d'un autre projet ; **projet retiré ou inconnu : 404 pour tous les comptes, nationaux compris, en lecture comme en écriture** ; fiche d'un dossier dont le jeu n'est pas autorisé, pour un compte qui ne décide pas |
| 409 | `TRANSITION_INTERDITE`, `SEPARATION_DES_TACHES`, `DECISION_REQUISE`, `PREUVE_REQUISE`, `REGLE_IMMUABLE` | contrat, sections 4 et 6 |
| 409 | `STATUT_INCOMPATIBLE`, `DECISION_DEJA_TRANCHEE`, `ANALYSE_NON_COMPARABLE` | décision proposée ou tranchée hors d'un conflit confirmé ; `PATCH` sur un dossier `CLOTURE` ; décision déjà tranchée ; analyse en échec |
| 422 | `JUSTIFICATION_REQUISE`, `MENTION_RECOLEMENT_REQUISE`, `RESPONSABLE_REQUIS`, `PLANNING_REQUIS` | justification ou motif de moins de 10 caractères ; clôture d'un déplacement sans mention du récolement ; déplacement sans responsable ou sans planning |
| 422 | `RESPONSABLE_NON_HABILITE` | responsable inactif ou sans la clé de module |
| 422 | `ANALYSE_TROP_VOLUMINEUSE` | trop de sommets (`sommetsAxes`, `sommetsReseau`) ou trop de conflits (`conflitsMax`) |
| 429 | `ANALYSE_TROP_FREQUENTE` (+ `retryAfterS` et `Retry-After`) | une analyse terminée du projet date de moins de 60 s |
| 503 | `PROJET_OCCUPE` | une autre analyse du projet est en cours, ou une écriture attend la ligne d'un dossier au-delà du délai de verrou |
| 503 | `SERVICE_OCCUPE` (+ `Retry-After`) | plus de trois analyses ou exports simultanés dans le processus (l'export CSV passe par le même limiteur) |
| 504 | `ANALYSE_TROP_LONGUE`, `EXPORT_TROP_LONG` | la base a coupé l'analyse ou l'export CSV (`PROJETS_VOIRIE_DELAI_ANALYSE_MS`) |

Exemples réels :

```json
{ "error": "La transition A_INVESTIGUER vers CLOTURE n'existe pas.", "code": "TRANSITION_INTERDITE" }
{ "error": "La personne qui a proposé une décision ne peut pas la trancher elle-même sans dérogation motivée (10 caractères au moins).", "code": "SEPARATION_DES_TACHES" }
{ "error": "Une analyse de conflits est déjà en cours sur ce projet : réessayez dans quelques instants.", "code": "PROJET_OCCUPE" }
{ "error": "L'analyse a dépassé 1 s et a été interrompue : le projet est trop volumineux pour un calcul immédiat.", "code": "ANALYSE_TROP_LONGUE" }
```

### Garanties de la base

Journaux en **ajout seul** (UPDATE et DELETE refusés, code 23001) : `conflits_projet_historique`, `conflits_projet_preuves`, `analyses_conflit_projet`. **`TRUNCATE` est refusé** (23001, déclencheur d'instruction) sur les six tables du lot, y compris par `CASCADE` depuis la table des projets ; la base refuse déjà le `TRUNCATE` simple des deux tables référencées par une clé étrangère (0A000). Un dossier `CLOTURE` ne change plus de statut, même hors API (23001). Aucune suppression physique d'un conflit, d'une règle ou d'une décision. Une règle approuvée est immuable ; une décision tranchée ne change plus ; un recalcul ne peut modifier ni statut, ni risque, ni responsable, ni échéance, ni action proposée. Contraintes : historique de statut avec justification d'au moins 10 caractères, décision à coût sans devise refusée, `DEPLACER_RESEAU` sans planning refusé, trancher sa propre décision sans dérogation refusé. Aucune écriture dans le référentiel : `troncons` n'est lu que pour `tronconsProches` (code et nom, au plus 10, à moins de la demi-largeur d'emprise).

### Ce qui n'est pas fait, décisions hors contrat, défauts connus

- **`DIVERGENCE_SOURCES` n'est pas calculé** : le type et la classification (`A_INVESTIGUER`) existent, aucun dossier n'est produit. Apparier deux sources de la même famille exige un seuil de corridor qu'aucune décision n'a fixé ; en inventer un serait un seuil caché.
- Les objets ponctuels et surfaciques ne sont pas évalués (comme dans l'analyse indicative). Les limites de route ne servent pas encore au calcul (emprise théorique).
- La **géométrie d'un conflit retrouvé est remplacée** par la géométrie courante (seules les mesures avant et après sont gardées dans l'historique) ; les analyses passées gardent l'empreinte de chaque mesure, pas la géométrie.
- Le récolement n'est pas géré ; la clôture d'un déplacement n'en porte que la mention.
- Les dossiers conservent pour toujours le lien vers le jeu de réseau d'origine et sa géométrie courante (suppression logique) : la politique de conservation d'un tiers qui retire son accord (m6 de la revue) reste à décider.
- **Revue indépendante RC-3 (07/11/2026)** : M1, M2, m1, m3 à m8 et m11 sont corrigés ; voir `CONTRAT-CONFLITS.md`, section 9, points 17 (complément) et 19 à 34, pour les règles exactes, les limites connues (`resume` des analyses non filtré, séparation des tâches d'un ADMIN envers lui-même, annulation d'une décision, jokers LIKE...) et les décisions à prendre. Lecture de la liste, de la fiche et de la comparaison : un délai côté base n'est posé que pour l'export CSV (les autres lectures sont paginées).
- Le 504 de l'analyse persistée réutilise le mécanisme du socle (`statement_timeout` posé par étape) ; il est prouvé par le banc avec une table verrouillée et un délai de 1 s, pas avec un calcul réellement trop long.


## Import des formats ouverts, CRS, mapping et versions (lot A1)

Contrat : `docs/projets-voirie/CONTRAT-IMPORT.md` (fait foi pour les règles) ; les exemples ci-dessous sont des réponses réelles du banc `backend/tests-integration/import-formats.integration.mts` (données 100 % synthétiques, identifiants raccourcis, listes tronquées). Formats lus : KML, KMZ, GeoJSON, GPX, CSV/TSV/TXT. GeoPackage, Shapefile ZIP et DXF passent par la conversion asynchrone du lot B2 (section « Conversion GDAL asynchrone », désactivée par défaut) ; DWG reste refusé.

### Routes ajoutées (toutes `ADMIN` et `GESTIONNAIRE`, lectures comprises)

| Route | Écrit en base ? | Réponse |
|---|---|---|
| `GET /:id/import/options` | non | formats, formats non pris en charge, limites, CRS source autorisés (nom et unité lus dans PostGIS), zone attendue, champs cibles du mapping, options CSV, mode de conservation de l'original |
| `POST /:id/import/inventaire` (multipart `fichier` + options) | non | format détecté par le contenu, entrées d'archive, couches, colonnes CSV, CRS exigé ou déclaré, champs disponibles, suggestions de mapping |
| `POST /:id/import/apercu` (multipart `fichier` + options) | non (transaction `READ ONLY`) | `resume` (dont `crs` et `import`), `statistiques`, `validationGeometrique`, `echantillon` borné, `mapping`, `avertissements` |
| `GET /:id/jeux/:jeuId/delta` | non | delta détaillé, statut des suppressions, retour arrière possible, événements |
| `POST /:id/jeux/:jeuId/revue-suppressions` | oui (événement et audit) | `{ jeu, suppressions, evenement }` |
| `POST /:id/jeux/:jeuId/retour-arriere` | oui (deux jeux, événement, deux audits) | `{ jeuRestaure, jeuRetire, evenement }` |

`POST /:id/jeux` (dépôt, `?simuler=true`) accepte en plus les champs d'options d'import (`couche`, `entreeKml`, `epsgSource`, `confirmerHorsZone`, `sha256Attendu`, `mapping`, `delimiteur`, `encodage`, `separateurDecimal`, `colonneX`, `colonneY`, `colonneWkt`, `colonneCle`, `colonneOrdre`) et répond en plus `suppressions` et `validationGeometrique` ; `delta` porte désormais `modifies`. `POST .../autoriser` répond 409 `SUPPRESSIONS_A_REVOIR` ou `SUPPRESSIONS_REFUSEES` pour une version qui retire des objets sans revue acceptée.

### Aperçu d'un plan d'axes en UTM 29N (CSV, virgule décimale, ordre mélangé)

`POST /:id/import/apercu`, champs `colonneX=x`, `colonneY=y`, `colonneCle=axe`, `colonneOrdre=ordre`, `epsgSource=32629` :

```json
{
  "fichier": { "nom": "plan-axes.csv", "tailleOctets": 546, "sha256": "f4c8d843e272..." },
  "format": "CSV",
  "couche": null,
  "resume": {
    "nbObjets": 3, "libelleNbObjets": "circuits ou objets du fichier",
    "parTypeGeom": { "LIGNE": 3, "POINT": 0, "POLYGONE": 0 }, "longueurTotaleM": 1914.1,
    "bbox": [-10.1, 9.187, -10.09, 9.1945],
    "crs": {
      "source": "EPSG:32629 (WGS 84 / UTM zone 29N)", "cible": "EPSG:4326",
      "methode": "ST_Transform (PostGIS, PROJ 7.2.1)",
      "justification": "CRS EPSG:32629 (WGS 84 / UTM zone 29N) choisi par l'utilisateur (liste blanche) : ...",
      "epsgSource": 32629, "epsgCible": 4326, "uniteSource": "metre", "uniteCible": "degre",
      "origine": "choisi_par_utilisateur", "transformation": "ST_Transform", "versionProj": "7.2.1",
      "plausibilite": { "zoneAttendue": { "nom": "Guinee", "bbox": [-15.2, 7.1, -7.5, 12.8] }, "empriseResultat": [-10.1, 9.187, -10.09, 9.1945],
                        "nbElementsHorsZone": 0, "nbObjets": 3, "statut": "CONFORME", "confirmationRequise": false, "confirmee": false }
    },
    "import": { "couche": null, "entreeKml": null,
                "csv": { "delimiteur": ";", "encodage": "utf-8", "separateurDecimal": ",", "mode": "lignes", "colonnes": { "x": "x", "y": "y", "cle": "axe", "ordre": "ordre" }, "nbLignes": 13, "nbLignesRejetees": 0 },
                "mapping": {}, "rejets": [], "rejetsTronques": false }
  },
  "statistiques": { "nbObjets": 3, "parTypeGeom": { "LIGNE": 3, "POINT": 0, "POLYGONE": 0 }, "longueurTotaleM": 1914.1, "doublonsInternes": 0, "sommets": 13, "geometriesAReparer": 0, "geometriesVides": 0 },
  "validationGeometrique": { "nbProblemes": 0, "problemes": [], "tronque": false, "elementsEcartes": [] },
  "echantillon": { "taille": 3, "total": 3, "objets": [ { "ordre": 0, "nom": "A", "typeGeom": "LIGNE", "geometrie": { "type": "LineString", "coordinates": [[-10.1, 9.19], [-10.098, 9.1902], "..."] }, "simplifiee": false, "attributs": { "axe": "A", "commune": "Kissidougou", "nbPoints": "6" } } ] },
  "mapping": { "applique": {}, "propositionsJeu": {}, "avertissements": [] },
  "avertissements": [ { "code": "CRS_CHOISI_PAR_UTILISATEUR", "message": "Le CRS source (EPSG:32629) a ete choisi par l'utilisateur : il n'est pas verifie par le fichier." } ]
}
```

Le banc a vérifié sommet par sommet, contre un oracle indépendant (séries de Krüger en JavaScript, sans PROJ), que `ST_Transform` rend les positions WGS 84 d'origine à moins de 1e-6 degré, et que la longueur calculée par la base égale la distance de Vincenty à 5 cm près.

### Inventaire d'un CSV

```json
{ "format": "CSV", "detection": { "methode": "contenu", "extensionDeclaree": "csv", "extensionCoherente": true }, "archive": null, "couches": [], "nbCouches": 0, "couchesTronquees": false,
  "csv": { "delimiteur": ";", "delimiteurDetecte": true, "encodage": "utf-8", "encodageDetecte": true, "bom": true, "separateurDecimal": ",", "separateurDecimalDetecte": true, "nbLignes": 13,
           "colonnes": [ { "nom": "axe", "exemples": ["A", "B", "C"] }, { "nom": "x", "exemples": ["380250,357", "380030,541", "379810,723"] } ],
           "echantillon": [ ["A", "6", "380250,357", "1016150,670", "Kissidougou"] ] },
  "crs": { "normeDuFormat": null, "declareDansLeFichier": null, "choixObligatoire": true },
  "champsDisponibles": ["axe", "ordre", "x", "y", "commune"], "suggestionsMapping": {}, "avertissements": [] }
```

### Delta d'une version qui retire un objet, revue, retour arrière

`GET /:id/jeux/:jeuId/delta` (version 2 en contrôle, remplaçant la version 1 autorisée) :

```json
{ "jeu": { "id": "2a5025fc-...", "version": 2, "statut": "CONTROLE", "role": "RESEAU_TIERS" },
  "comparaison": { "jeuId": "6978b344-...", "version": 1, "statut": "AUTORISE" },
  "delta": { "ajoutes": 1, "modifies": 1, "retires": 1, "identiques": 0 },
  "cleComparaison": "identifiant", "clesAmbigues": 0,
  "echantillons": { "ajoutes": [ { "objetId": "30", "nom": "Regard 3" } ],
                    "modifies": [ { "cle": "R1", "nomAvant": "Regard 1", "nomApres": "Regard 1 (deplace)" } ],
                    "retires": [ { "objetId": "24", "nom": "Regard 2" } ] },
  "suppressions": { "statut": "A_REVOIR", "nb": 1, "revue": null },
  "retourArriere": null, "evenements": [] }
```

Autoriser sans revue :

```json
{ "error": "Cette version retire 1 objet(s) de la version autorisee : une revue explicite des suppressions (acceptation justifiee) est exigee avant l'autorisation. Aucune suppression n'est appliquee sans revue.",
  "code": "SUPPRESSIONS_A_REVOIR", "jeuId": "2a5025fc-...", "nb": 1 }
```

Retour arrière (`POST .../retour-arriere`, `{ "justification": "..." }`) :

```json
{ "jeuRestaure": { "id": "6978b344-...", "statut": "AUTORISE", "...": "..." }, "jeuRetire": { "statut": "REMPLACE", "...": "..." },
  "evenement": { "id": "04b92547-...", "type": "RETOUR_ARRIERE", "le": "2026-11-08T00:41:43.860Z", "justification": "La version 2 supprimait R2 a tort : retour a la version 1" } }
```

### Erreurs de CRS et de zone (réponses réelles)

```json
{ "error": "le CRS declare est geographique (EPSG:4326, degres) mais les coordonnees atteignent 1016540 : ce sont probablement des metres d'un CRS projete (par exemple EPSG:32629 pour l'UTM 29N). Aucun CRS n'est devine : choisissez le bon epsgSource", "code": "CRS_INCOHERENT" }
{ "error": "1 element(s) tombent hors de l'emprise de la Guinee apres application du CRS EPSG:32629 : verifiez le CRS choisi. Pour importer les autres elements en ecartant ceux-la, envoyez confirmerHorsZone=true.", "code": "CONFIRMATION_HORS_ZONE_REQUISE", "nbElementsHorsZone": 1, "nbObjets": 3 }
```

### Codes d'erreur ajoutés par le lot A1

Voir `CONTRAT-IMPORT.md`, sections 5.4, 6 et 11 (archives `ARCHIVE_*`, `KMZ_*`, CSV, CRS, mapping, couches, suppressions, retour arrière). Statuts : 400 `MAPPING_INVALIDE`, `CONCESSIONNAIRE_REQUIS` ; 404 `JEU_INTROUVABLE` ; 409 `EMPREINTE_DIVERGENTE`, `CONFIRMATION_HORS_ZONE_REQUISE`, `SUPPRESSIONS_A_REVOIR`, `SUPPRESSIONS_REFUSEES`, `AUCUNE_SUPPRESSION`, `AUCUNE_VERSION_PRECEDENTE`, `VERSION_PRECEDENTE_INDISPONIBLE` ; 415 `FORMAT_NON_SUPPORTE` (DWG) et `FORMAT_GDAL_DESACTIVE` (GeoPackage, Shapefile, DXF, interrupteur coupé) ; 422 tous les autres codes de lecture ; 504 `APERCU_TROP_LONG`.

### Réglages serveur ajoutés

`PROJETS_VOIRIE_CRS_SOURCE_AUTORISES` (défaut `4326,32628,32629`), `PROJETS_VOIRIE_CONSERVER_ORIGINAL` (défaut `non`), `PROJETS_VOIRIE_ARCHIVE_ENTREES_MAX` (100), `PROJETS_VOIRIE_ARCHIVE_TAILLE_DECOMPRESSEE_MAX` (100 Mo), `PROJETS_VOIRIE_ARCHIVE_TAUX_MAX` (100), `PROJETS_VOIRIE_CSV_LIGNES_MAX` (500 000), `PROJETS_VOIRIE_APERCU_ECHANTILLON` (20), `PROJETS_VOIRIE_DELAI_APERCU_MS` (30 000). Même règle que le socle : une valeur absente, illisible ou hors bornes redonne le défaut. Détail et bornes : `CONTRAT-IMPORT.md`, section 12.

### Ce que le lot A1 ne fait pas

- GeoPackage, Shapefile, DXF : lot B2 (conversion GDAL asynchrone). DWG, raster, IFC, LAS : hors lot.
- Pas de traitement asynchrone : plafonds stricts et synchrones (25 Mo, 50 000 objets, 2 000 000 de sommets, 500 000 lignes CSV, 100 entrées d'archive), contrat d'un futur job dans `CONTRAT-IMPORT.md`, section 13.
- CSV : pas de fichier sans en-tête, pas de séparateur de milliers, pas de délimiteur espace, pas de polygones construits depuis des points, pas de clés d'axe imbriquées ; la rupture de chaînage d'une ligne reconstruite n'est pas détectée.
- Le fichier d'origine n'est conservé que si `PROJETS_VOIRIE_CONSERVER_ORIGINAL=oui`, et aucune route ne le relit.
- Une version qui retire des objets ne peut pas les « conserver » sélectivement : accepter les suppressions, c'est accepter que la nouvelle version remplace l'ancienne telle quelle (l'ancienne reste en base, statut `REMPLACE`).
## Workflow concessionnaire, référents et récolement (lot B3)

Contrat : `docs/projets-voirie/CONTRAT-WORKFLOW.md` (rôles du cahier, matrice des droits, états, séparation des tâches). **La correspondance des rôles et la matrice des droits sont une proposition provisoire, en attente de la décision du DSI.** Les exemples de réponses réelles sont écrits par le banc `backend/tests-integration/workflow-roles.integration.mts` (`WORKFLOW_EXEMPLES=<fichier>`), données 100 % synthétiques.

**Principes.** L'application **n'envoie aucun message** : l'envoi d'une demande à un concessionnaire est fait hors application par une personne, qui l'**enregistre** (date, canal, référence, interlocuteur). Une preuve est une **référence et une empreinte** (aucun fichier n'est stocké ; le stockage de pièces jointes n'est pas décidé). Recevoir une réponse, valider un récolement, clore une tâche **ne modifient ni le référentiel, ni un jeu, ni un conflit**. Tout est audité (`ReferentConcessionnaire`, `DemandeConcessionnaire`, `TacheProjetVoirie`, `RecolementProjetVoirie`), sans géométrie. L'historique de chaque objet est en ajout seul.

**Gardes, dans l'ordre** : jeton, clé de module `projets-voirie`, octet NUL (400), **restriction du compte rattaché** (403 `COMPTE_REFERENT_RESTREINT` hors `/workflow/...`), identifiants UUID (400 `IDENTIFIANT_INVALIDE` pour `:demandeId`, `:tacheId`, `:recolementId`, `:rattachementId`), projet désigné (404 `PROJET_INTROUVABLE` identique s'il est inexistant, retiré, hors périmètre territorial, ou, pour un référent, s'il n'y est pas rattaché), droit de la matrice (403 `ACTION_NON_AUTORISEE`, champ `action`), validation du corps (400), service (qui ne rend que les lignes visibles du profil : un élément d'un autre concessionnaire répond 404 `DEMANDE_INTROUVABLE`, `TACHE_INTROUVABLE`, `RECOLEMENT_INTROUVABLE`).

### Routes

| Route | Droit (défaut) | Réponse |
|---|---|---|
| `GET /workflow/mon-profil` | tout compte du module | `{ role, profil, referent, rattachements: [{ id, projet: {id, code, nom}, concessionnaire: {id, nom} }], droits, matrice, socle, correspondanceCahier, provisoire: true, avertissements }` |
| `GET /:id/workflow/referents` | `referent.lire` (ADMIN, GESTIONNAIRE) | `{ rattachements }` (actifs et révoqués, avec compte, concessionnaire, motif, auteur) |
| `POST /:id/workflow/referents` | `referent.gerer` (ADMIN) | 201 `{ rattachement }` ; corps `{ userId, concessionnaireId, motif }` |
| `POST /:id/workflow/referents/:rattachementId/revoquer` | ADMIN | `{ rattachement, avertissements }` ; corps `{ motif }` |
| `GET /:id/workflow/jeux` | `workflow.lire` | `{ jeux }` : métadonnées seules (id, rôle, concessionnaire, version, nom de fichier, format, date, nombre d'objets, classe de précision, statut) ; référent : jeux **AUTORISE** de son concessionnaire |
| `GET /:id/workflow/conflits` | `workflow.lire` | `{ conflits, curseurSuivant }` : vue concessionnaire sans géométrie ni mesure (`id, type, axe, statut, concessionnaire, objet, decisionRetenue`) ; filtres `statut`, `type`, `limite`, `curseur` ; référent : dossiers **confirmés** de son concessionnaire |
| `GET /:id/workflow/demandes` | `workflow.lire` | `{ demandes, compteurs, curseurSuivant }` ; filtres `statut` (liste), `concessionnaireId`, `echeanceDepassee`, `limite`, `curseur` |
| `POST /:id/workflow/demandes` | `demande.ecrire` | 201 `{ demande }` (`BROUILLON`) ; corps `{ concessionnaireId, objet, description?, echeance? }` |
| `GET /:id/workflow/demandes/:demandeId` | `workflow.lire` | `{ demande, preuves, historique?, transitionsPossibles }` |
| `PATCH /:id/workflow/demandes/:demandeId` | `demande.ecrire` | `{ demande, modifie }` ; corps `{ objet?, description?, echeance?, jeuRecuId?, justification? }` |
| `POST /:id/workflow/demandes/:demandeId/statut` | `demande.ecrire` | `{ demande }` ; corps `{ vers: "ENVOYEE", canalEnvoi, dateEnvoi, referenceEnvoi?, interlocuteur? }`, `{ vers: "RECUE", dateReception, jeuRecuId?, note? }` ou `{ vers: "CLOTUREE" ou "ANNULEE", justification }` |
| `POST /:id/workflow/demandes/:demandeId/preuves` | `preuve.ajouter` | 201 `{ preuve }` ; corps `{ type, texte, reference?, nomFichier?, sha256?, tailleOctets?, partagee? }` |
| `GET /:id/workflow/taches` | `workflow.lire` ou `tache.executer` | `{ taches, compteurs, curseurSuivant }` ; filtres `statut`, `responsableId`, `conflitId`, `demandeId`, `concessionnaireId`, `echeanceDepassee` ; un agent de terrain ne reçoit que ses tâches |
| `POST /:id/workflow/taches` | `tache.gerer` | 201 `{ tache }` ; corps `{ titre, description?, responsableId, echeance?, priorite?, validationRequise?, conflitId?, demandeId?, concessionnaireId?, partagee? }` |
| `GET /:id/workflow/taches/:tacheId` | `workflow.lire` ou `tache.executer` | `{ tache, preuves, historique?, transitionsPossibles }` |
| `PATCH /:id/workflow/taches/:tacheId` | `tache.gerer` | `{ tache, modifie }` ; `justification` exigée pour changer `responsableId` |
| `POST /:id/workflow/taches/:tacheId/statut` | `tache.executer` (le noyau exige `tache.gerer` hors du responsable) | `{ tache }` ; corps `{ vers, justification?, derogation? }` |
| `POST /:id/workflow/taches/:tacheId/preuves` | `preuve.ajouter` | 201 `{ preuve }` |
| `GET /:id/workflow/recolements` | `workflow.lire` | `{ recolements, compteurs, curseurSuivant }` ; filtres `statut`, `conflitId`, `jeuId` |
| `POST /:id/workflow/recolements` | `recolement.ecrire` | 201 `{ recolement }` ; corps `{ conflitId?, jeuId?, objet, constat?, ecarts?, dateRecolement? }` |
| `GET /:id/workflow/recolements/:recolementId` | `workflow.lire` | `{ recolement, preuves, historique?, transitionsPossibles }` |
| `PATCH /:id/workflow/recolements/:recolementId` | `recolement.ecrire` | `{ recolement, modifie }` ; brouillon seulement ; `justification` obligatoire ; `revision` +1, avant/après historisés |
| `POST /:id/workflow/recolements/:recolementId/statut` | `recolement.ecrire` (valider, rejeter : `recolement.valider`, ADMIN par défaut) | `{ recolement }` ; corps `{ vers: "SOUMIS", "BROUILLON", "VALIDE" ou "REJETE", justification, derogation? }` |
| `POST /:id/workflow/recolements/:recolementId/preuves` | `preuve.ajouter` | 201 `{ preuve }` |

L'historique (`historique`) n'est rendu qu'aux décideurs (ADMIN, GESTIONNAIRE) : liste de `{ id, action, ancienStatut, nouveauStatut, justification, acteur, acteurProfil, donnees: { avant, apres, ... }, createdAt }`.

### Clôture d'un conflit appuyée sur un récolement (extension de RC-3)

`POST /:id/conflits/:cid/statut` accepte `recolementId` (UUID d'un récolement `VALIDE` de ce dossier) à la clôture : il dispense de la mention `recolementAValider`, et l'historique de la clôture porte `recolementId`. Sans lui, comportement de RC-3 inchangé. Erreurs : 404 `RECOLEMENT_INTROUVABLE`, 409 `RECOLEMENT_NON_VALIDE`, 422 `CHAMPS_INVALIDES` (`recolementId` hors clôture). Réglage `PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE=1` : la clôture d'un déplacement décidé exige un récolement validé (le dernier est retenu sans `recolementId`). Voir `CONTRAT-CONFLITS.md`, section 9, point 35.

### Codes d'erreur ajoutés par ce lot

400 `COMPTE_INCONNU`, `REFERENCE_INVALIDE`, `CURSEUR_INVALIDE`, `CHAMPS_INVALIDES` ; 403 `COMPTE_REFERENT_RESTREINT` (aussi sur `GET /api/audit` pour les entités du module), `ACTION_NON_AUTORISEE` ; 404 `DEMANDE_INTROUVABLE`, `TACHE_INTROUVABLE`, `RECOLEMENT_INTROUVABLE`, `RATTACHEMENT_INTROUVABLE`, `CONCESSIONNAIRE_INTROUVABLE` ; 409 `TRANSITION_INTERDITE`, `STATUT_INCOMPATIBLE`, `SEPARATION_DES_TACHES`, `PREUVE_REQUISE`, `RECOLEMENT_EN_COURS`, `RATTACHEMENT_DEJA_ACTIF`, `RATTACHEMENT_DEJA_REVOQUE`, `RECOLEMENT_NON_VALIDE` ; 422 `JUSTIFICATION_REQUISE`, `DATE_INVALIDE`, `RESPONSABLE_NON_HABILITE`, `COMPTE_NON_ELIGIBLE`, `COMPTE_SANS_MODULE`, `CONCESSIONNAIRE_INCOHERENT`, `LIEN_INVALIDE`, `CONFLIT_NON_ELIGIBLE`, `CHAMPS_INCOMPLETS`, `QUOTA_ATTEINT` ; 429 `CADENCE_CREATION` (avec `retryAfterS` et `Retry-After`) ; 503 `PROJET_OCCUPE`.

### Réglages serveur du workflow (variables d'environnement, bornées)

`PROJETS_VOIRIE_WORKFLOW_CREATIONS_PAR_MINUTE` (30 ; 1 à 600), `PROJETS_VOIRIE_WORKFLOW_DEMANDES_MAX` (2000 ; 100 à 100 000), `PROJETS_VOIRIE_WORKFLOW_TACHES_MAX` (5000 ; 100 à 100 000), `PROJETS_VOIRIE_WORKFLOW_RECOLEMENTS_MAX` (500 ; 10 à 10 000), `PROJETS_VOIRIE_WORKFLOW_PREUVES_MAX` (200 ; 10 à 5 000), `PROJETS_VOIRIE_WORKFLOW_MATRICE` (JSON, voir `CONTRAT-WORKFLOW.md` 3.3), `PROJETS_VOIRIE_RECOLEMENT_OBLIGATOIRE` (`1` pour activer). Une valeur illisible redonne le défaut. Les délais côté base sont ceux du socle (`PROJETS_VOIRIE_DELAI_DEPOT_MS`, `PROJETS_VOIRIE_VERROU_MS`).

### Ce qui n'est pas fait, décisions hors contrat, limites connues

- Pas d'interface (lot suivant). Pas de dépôt de jeu par un référent (la réception reste un acte d'AGEROUTE). Pas de stockage de pièces jointes (références et empreintes seulement). Pas d'envoi de message, par construction.
- Un référent reste un `LECTEUR` : il conserve les lectures ouvertes de la Console qui ne demandent aucune clé de module (patrimoine routier). Seules les routes du module `projets-voirie` et l'audit de ses entités lui sont fermées. Révoquer un rattachement ne retire pas la clé de module (voir l'avertissement de la réponse).
- Les clés étrangères des six tables sont dans la migration seulement (aucune relation Prisma, pour ne pas modifier les modèles existants) : l'outil de dérive du schéma les listera comme écarts documentés.
- Le motif de rejet d'un récolement et le motif de clôture d'une demande sont **internes** : le référent voit l'état et la date, pas le motif.
- Observateurs et auditeurs : pas de lecture du workflow par défaut ; ouvrable par configuration en vue de projet (sans historique, sans tâche ni récolement liés à un conflit) ; l'auditeur lit le journal par `GET /api/audit`.
## Réseaux physiques et circuits logiques (lot B1)

Contrat : `docs/projets-voirie/CONTRAT-RESEAUX.md` (modèle, règles de comptage, méthode d'association). Les exemples ci-dessous sont des réponses **réelles** du banc `backend/tests-integration/reseau-physique-logique.integration.mts` (données 100 % synthétiques ; identifiants raccourcis, listes tronquées, `…` pour les parties omises).

**Principe.** Le nombre de lignes d'un fichier n'est pas un nombre d'équipements physiques : plusieurs **circuits logiques** peuvent suivre le même **support physique**. Ce lot ajoute un **descripteur** par objet (nature, type, qualité déclarée, profondeur et altitude **seulement si fournies**), des **relations** entre objets (circuit porté par une infrastructure, équipement contenu dans une chambre), des **propositions d'association** par superposition qui ne sont **jamais appliquées sans validation humaine**, et un **comptage par nature** dont aucun total ne mélange les natures. **Aucune route ne rend ni n'exporte de géométrie.** La connectivité du réseau n'est pas gérée (voir `CONTRAT-RESEAUX.md`, section 9).

Mêmes gardes, dans le même ordre, que le socle (voir « Gardes, dans l'ordre ») : jeton, clé de module, octet NUL, identifiants (`:objetId` : entier positif sur 18 chiffres au plus ; `:relId` : UUID ; sinon 400 `IDENTIFIANT_INVALIDE`), rôle, **projet désigné (404 `PROJET_INTROUVABLE` identique si inexistant, retiré ou hors périmètre, administrateur national compris pour un projet retiré)**, validation stricte du corps (400, champs inconnus refusés). **Lisibilité** (celle du socle et de RC-3) : un jeu `RETIRE` n'est montré à personne ; un jeu autre que `AUTORISE` n'est montré qu'à `ADMIN` et `GESTIONNAIRE` ; un objet ou une relation dont un jeu est illisible répond 404 (`OBJET_INTROUVABLE`, `RELATION_INTROUVABLE`). La lecture des objets de jeux `CONFIDENTIEL_CONCESSIONNAIRE` ou `INFRASTRUCTURE_SENSIBLE` est tracée (`ConsultationJeuProjet`, route `reseau`).

### Routes

| Route | Rôle | Réponse |
|---|---|---|
| `GET /:id/reseau/objets` | lecture | `{ objets, curseurSuivant }` ; filtres `jeuId` (UUID), `nature` (`ACTIF_PHYSIQUE`, `CIRCUIT_LOGIQUE`, `EQUIPEMENT`, `INCONNUE`), `typeObjet`, `q` (texte dans le nom, sans joker), `limite` (1 à 200, défaut 50), `curseur` |
| `GET /:id/reseau/objets/:objetId` | lecture | `{ objet, relations, tracePartagee }` |
| `PUT /:id/reseau/objets/:objetId/descripteur` | ADMIN, GESTIONNAIRE | 201 (création) ou 200 (remplacement) `{ objet }` ; **aucune route de suppression** |
| `GET /:id/reseau/relations` | lecture | `{ relations, curseurSuivant }` ; filtres `statut` (liste séparée par des virgules), `type`, `objetId`, `origine`, `limite` (1 à 200), `curseur` |
| `POST /:id/reseau/relations` | ADMIN, GESTIONNAIRE | 201 `{ relation }` ; déclaration manuelle, créée `VALIDEE` |
| `POST /:id/reseau/relations/:relId/valider` | ADMIN, GESTIONNAIRE | `{ relation }` ; corps `{ justification }` |
| `POST /:id/reseau/relations/:relId/refuser` | ADMIN, GESTIONNAIRE | `{ relation }` ; corps `{ justification }` |
| `POST /:id/reseau/relations/:relId/revoquer` | ADMIN, GESTIONNAIRE | `{ relation }` ; corps `{ justification }` |
| `POST /:id/reseau/associations/proposer` | ADMIN, GESTIONNAIRE | 201 `{ statut, parametres, bilan, idsCrees, avertissements }` |
| `GET /:id/reseau/comptage` | lecture | comptage par nature (ci-dessous) ; `jeuId`, `inclureNonAutorises` (ADMIN, GESTIONNAIRE : 403 `QUARANTAINE_RESERVEE` sinon) |

### Objet (liste et fiche)

Aucune géométrie. `nature` et `qualite.classePrecision` sont **effectives** : celles du descripteur, sinon celles du jeu, sinon inconnues (`origineNature`, `origineClasse` : `OBJET`, `JEU` ou `INCONNUE`). `source` et `confidentialite` sont celles du jeu. Sans profondeur ni altitude, `vertical.etat` vaut `ABSENTE` : **aucune conclusion 3D** ; `evaluable` est **toujours faux** et `conclusion3D` toujours nul, même quand des données sont fournies.

Un objet **sans** descripteur (hérite du jeu, classe inconnue, vertical absent) :

```json
{
  "id": "10",
  "jeuId": "fe13103e…",
  "nom": "Fibre-Marqueur L13",
  "typeGeom": "LIGNE",
  "longueurM": 60.01,
  "source": {
    "jeuId": "fe13103e…",
    "version": 1,
    "role": "RESEAU_TIERS",
    "statut": "AUTORISE",
    "nomFichier": "circuits.geojson",
    "typeReseau": "TELECOM",
    "concessionnaire": {
      "id": "e07ccd4f…",
      "nom": "Operateur Telecom Synthetique"
    },
    "dateDonnees": null,
    "confidentialite": "CONFIDENTIEL_CONCESSIONNAIRE"
  },
  "nature": "CIRCUIT_LOGIQUE",
  "origineNature": "JEU",
  "typeObjet": null,
  "qualite": {
    "classePrecision": null,
    "origineClasse": "INCONNUE",
    "precisionHorizontaleM": null,
    "precisionVerticaleM": null,
    "methodeCollecte": null,
    "dateConstat": null,
    "niveauConfiance": null,
    "statutQualite": "INCONNU"
  },
  "vertical": {
    "etat": "ABSENTE",
    "evaluable": false,
    "conclusion3D": null,
    "motifs": [
      "Profondeur et altitude absentes : aucune conclusion 3D.",
      "Profondeur inconnue.",
      "Altitude inconnue.",
      "Précision verticale non déclarée."
    ],
    "profondeurM": null,
    "altitudeM": null,
    "referenceVerticale": null
  },
  "descripteur": null
}
```

La fiche porte aussi `relations` (chacune avec son `role` : `SOURCE` ou `CIBLE`, et les actions possibles pour le compte) et `tracePartagee` : nombre d'**autres** objets du même jeu à la trace strictement identique (circuits superposés : ils restent séparés, ce ne sont pas des câbles distincts).

### Descripteur (PUT)

Corps (`strict`, champs inconnus refusés) : `nature` (`ACTIF_PHYSIQUE`, `CIRCUIT_LOGIQUE`, `EQUIPEMENT` ou nul = hérite du jeu), `typeObjet` (code en majuscules, parmi les types de la nature : voir `CONTRAT-RESEAUX.md`, 3.3), `classePrecision` (A à E ou nul), `precisionHorizontaleM`, `precisionVerticaleM` (strictement positives, arrondies au centimètre, jamais nulles après arrondi), `methodeCollecte`, `dateConstat` (`AAAA-MM-JJ`), `niveauConfiance` (`ELEVE`, `MOYEN`, `FAIBLE` ou nul), `statutQualite` (défaut `INCONNU`), `profondeurM` (0 à 10 000), `altitudeM` (-500 à 9 000), `referenceVerticale` (exige une profondeur ou une altitude), `justification` (**obligatoire**, 10 à 2 000 caractères). **Le descripteur est REMPLACÉ** : une valeur omise devient inconnue (nulle), jamais héritée ni conservée ni déduite. Seuls les objets d'un réseau de concessionnaire ou d'un jeu « autre » en contrôle ou autorisé se qualifient.

```json
{
  "id": "4",
  "jeuId": "fe13103e…",
  "nom": "Fibre-Marqueur L6",
  "typeGeom": "LIGNE",
  "longueurM": 60.01,
  "source": {
    "jeuId": "fe13103e…",
    "version": 1,
    "role": "RESEAU_TIERS",
    "statut": "AUTORISE",
    "nomFichier": "circuits.geojson",
    "typeReseau": "TELECOM",
    "concessionnaire": {
      "id": "e07ccd4f…",
      "nom": "Operateur Telecom Synthetique"
    },
    "dateDonnees": null,
    "confidentialite": "CONFIDENTIEL_CONCESSIONNAIRE"
  },
  "nature": "CIRCUIT_LOGIQUE",
  "origineNature": "JEU",
  "typeObjet": null,
  "qualite": {
    "classePrecision": "A",
    "origineClasse": "OBJET",
    "precisionHorizontaleM": 0.1,
    "precisionVerticaleM": null,
    "methodeCollecte": "GNSS RTK",
    "dateConstat": "2026-10-01",
    "niveauConfiance": "ELEVE",
    "statutQualite": "OBSERVE"
  },
  "vertical": {
    "etat": "FOURNIE",
    "evaluable": false,
    "conclusion3D": null,
    "motifs": [
      "Données verticales fournies par la source ; l'évaluation 3D n'est pas implémentée dans ce lot.",
      "Altitude inconnue.",
      "Précision verticale non déclarée."
    ],
    "profondeurM": 1.2,
    "altitudeM": null,
    "referenceVerticale": "terrain naturel"
  },
  "descripteur": {
    "justification": "Controle effectue avec le chef de projet",
    "declarePar": "Sekou Gestionnaire",
    "declareLe": "2026-11-08T00:40:23.884Z",
    "modifiePar": null,
    "modifieLe": "2026-11-08T00:40:23.884Z"
  }
}
```

Erreurs : 422 `ROLE_NON_QUALIFIABLE` (plan d'axes, limites de route), `NATURE_INCOMPATIBLE_GEOMETRIE` (un circuit est une ligne, un équipement un point), `TYPE_OBJET_INCONNU_POUR_NATURE`, `TYPE_OBJET_SANS_NATURE`, `REFERENCE_VERTICALE_SANS_VALEUR`, `PRECISION_INCOHERENTE`, `INCOHERENCE_REFUSEE` (refus d'une contrainte ou d'un déclencheur de la base, message de la base) ; 409 `JEU_NON_QUALIFIABLE` (jeu rejeté, remplacé), `RELATIONS_ACTIVES` (la nature ne change pas sous une relation proposée ou validée) ; 404 `OBJET_INTROUVABLE`.

### Relations

`PORTE_PAR` : circuit logique (ligne) vers infrastructure physique (ligne). `CONTENU_DANS` : équipement (point) vers infrastructure physique (point ou polygone). Statuts : `PROPOSEE` (**aucun effet**), `VALIDEE`, `REFUSEE`, `REVOQUEE`. Un seul enregistrement par couple, quel que soit son statut.

Une relation manuelle (équipement dans une chambre), créée `VALIDEE` :

```json
{
  "id": "49125954…",
  "projetId": "0bf39bf6…",
  "typeRelation": "CONTENU_DANS",
  "statut": "VALIDEE",
  "origine": "MANUELLE",
  "proposition": {},
  "source": {
    "objetId": "15",
    "nom": "Vanne V1",
    "nature": "EQUIPEMENT",
    "typeObjet": null,
    "typeGeom": "POINT",
    "jeuId": "57c62821…"
  },
  "cible": {
    "objetId": "14",
    "nom": "Chambre C1",
    "nature": "ACTIF_PHYSIQUE",
    "typeObjet": null,
    "typeGeom": "POINT",
    "jeuId": "5cc65a08…"
  },
  "decision": {
    "par": "Sekou Gestionnaire",
    "le": "2026-11-08T00:40:30.513Z",
    "justification": "Vanne visible dans la chambre au releve"
  },
  "creePar": "Sekou Gestionnaire",
  "createdAt": "2026-11-08T00:40:30.513Z",
  "updatedAt": "2026-11-08T00:40:30.513Z",
  "actionsPossibles": [
    "revoquer"
  ]
}
```

Transitions (corps `{ justification }`, 10 caractères au moins) : `valider` depuis `PROPOSEE`, `REFUSEE` ou `REVOQUEE` ; `refuser` depuis `PROPOSEE` ; `revoquer` depuis `VALIDEE` ; toute autre : 409 `TRANSITION_INTERDITE` ; justification courte : 400 `JUSTIFICATION_INVALIDE`. Erreurs de déclaration : 422 `NATURE_RELATION_INCOMPATIBLE`, `GEOMETRIE_RELATION_INCOMPATIBLE`, `RELATION_SUR_SOI` ; 409 `RELATION_DEJA_CONNUE` (avec `relationId` et `statut` : **une proposition refusée ne se contourne pas par une déclaration manuelle**), `JEU_NON_QUALIFIABLE` ; 404 `OBJET_INTROUVABLE` (objet d'un autre projet ou illisible), `RELATION_INTROUVABLE`.

### Propositions d'association (superposition géométrique)

`POST /:id/reseau/associations/proposer`, corps facultatif : `jeuId` (restreint les circuits examinés à ce jeu), `couvertureMin` (0,5 à 1), `parCircuitMax` (1 à 20), `tolerances` (par classe `A`, `B`, `C`, `D`, `INCONNUE`, 0,01 à 100 m, fusionnées sur celles du serveur ; **la classe E n'a pas de tolérance : elle est exclue**). Méthode et valeurs par défaut : `CONTRAT-RESEAUX.md`, section 7. **Les relations créées sont `PROPOSEE`, origine `AUTOMATIQUE`** ; une proposition déjà connue (validée, refusée, révoquée) n'est jamais réécrite : une proposition refusée ne revient pas.

```json
{
  "statut": "PROPOSITIONS_A_VALIDER",
  "parametres": {
    "version": "ASSOC-0.1",
    "statut": "PROVISOIRE_A_VALIDER",
    "methodeTolerance": "maximum",
    "tolerancesParClasseM": {
      "A": 0.5,
      "B": 1,
      "C": 2,
      "D": 5,
      "INCONNUE": 2
    },
    "couvertureMin": 0.9,
    "parCircuitMax": 5,
    "projection": "EPSG:32629",
    "jeuId": "fe13103e…"
  },
  "bilan": {
    "circuitsExamines": 8,
    "infrastructuresExaminees": 3,
    "classeEExclus": {
      "circuits": 0,
      "infrastructures": 0
    },
    "propositionsCalculees": 4,
    "creees": 4,
    "dejaConnues": 0,
    "tronque": false
  },
  "idsCrees": [
    "7f4fe483…",
    "…"
  ],
  "avertissements": [
    "Ce sont des PROPOSITIONS : aucune association n'est appliquée tant qu'une personne ne l'a pas validée (avec justification).",
    "Une simple superposition géométrique ne prouve pas qu'un circuit est porté par une infrastructure.",
    "…"
  ]
}
```

Chaque proposition porte, dans `proposition`, sa méthode : `methode`, `version`, `toleranceM` (maximum des composantes, jamais leur somme), `composantes`, `couverture`, `couvertureMin`, `longueurCircuitM`, `longueurDansToleranceM`, `projection`, `statutParametres: "PROVISOIRE_A_VALIDER"` (sans géométrie).

Erreurs : 409 `JEU_NON_AUTORISE` (les propositions ne portent que sur des jeux autorisés) ; 422 `TROP_DE_CIRCUITS` (avec `maximum`) ; 429 `ASSOCIATION_TROP_FREQUENTE` (avec `retryAfterS` et l'en-tête `Retry-After`) ; 503 `PROJET_OCCUPE`, `SERVICE_OCCUPE` ; 504 `ASSOCIATION_TROP_LONGUE`.

### Comptage par nature

`GET /:id/reseau/comptage` : **aucun total ne mélange les natures**. Par défaut les jeux `AUTORISE` ; avec `inclureNonAutorises` (ADMIN, GESTIONNAIRE), un jeu en attente **remplace** le jeu autorisé de même rôle et de même concessionnaire (jamais deux fois le même réseau).

- `infrastructuresPhysiques` : `nombreDeclare` (**nombre d'infrastructures déclarées**, sans dédoublonnage géométrique), `nombreLineaires`, `parType`, `longueurSommeM`, `longueurTraceFusionneM` (**longueur de trace fusionnée** : union des tracés) ;
- `circuitsLogiques` : `nombreDeclare` (**pas un nombre de câbles**), `sommeLongueursCircuitsM` (**somme des longueurs de circuits** : un tracé partagé par N circuits y compte N fois), `longueurTraceFusionneM`, `tracesPartagees` (`groupes`, `circuitsConcernes` : traces strictement identiques, sens de lecture indifférent), `supportPhysique` (`avecSupportValide`, `avecPropositionSeulement`, `sansSupportConnu` : une proposition n'est pas un support valide) ;
- `equipements`, `natureInconnue` : à part ; un objet de nature inconnue n'est compté **ni comme infrastructure ni comme circuit** ;
- `libelles`, `avertissements`, `jeux` (faits de chaque jeu, jamais additionnés), `qualite` (répartition par classe déclarée ou « inconnue », objets sans profondeur ni altitude, `evaluables: 0`), `limites`.

Trois circuits superposés, un câble distinct (KIS-LOGIC-01), avant toute relation :

```json
{
  "infrastructuresPhysiques": {
    "nombreDeclare": 4,
    "nombreLineaires": 3,
    "parType": {
      "INCONNU": 4
    },
    "longueurSommeM": 180.03,
    "longueurTraceFusionneM": 180.03
  },
  "circuitsLogiques": {
    "nombreDeclare": 8,
    "nombreLineaires": 8,
    "parType": {
      "INCONNU": 8
    },
    "sommeLongueursCircuitsM": 410.05,
    "longueurTraceFusionneM": 290.04,
    "tracesPartagees": {
      "groupes": 1,
      "circuitsConcernes": 3
    },
    "supportPhysique": {
      "avecSupportValide": 0,
      "avecPropositionSeulement": 0,
      "sansSupportConnu": 8
    }
  },
  "equipements": {
    "nombreDeclare": 1,
    "parType": {
      "INCONNU": 1
    }
  },
  "natureInconnue": {
    "nombreObjets": 0,
    "nombreLineaires": 0,
    "longueurSommeM": 0,
    "longueurTraceFusionneM": 0
  },
  "avertissements": [
    "Le nombre de circuits logiques n'est pas un nombre de câbles physiques : plusieurs circuits peuvent suivre le même support.",
    "Les 8 circuits logiques linéaires déclarés partagent tout ou partie de leur tracé : la somme de leurs longueurs (410,05 m) dépasse la longueur de trace fusionnée (290,04 m). Ce ne sont pas 8 câbles physiques.",
    "…"
  ]
}
```

Erreurs : 403 `QUARANTAINE_RESERVEE`, 404 `JEU_INTROUVABLE`, 503 `SERVICE_OCCUPE`, 504 `COMPTAGE_TROP_LONG`.

### Extension des dossiers de conflit, de l'analyse 2D et de la carte

- `GET /:id/conflits` et `GET /:id/conflits/:cid` : `conflit.cible` (nature effective, `qualification`, `libelle`, `supportPhysique`, et `tracePartagee` sur la fiche) ; export CSV : colonnes `natureCible` et `qualificationCible` **avant `cle`, qui reste la dernière**. Voir `CONTRAT-CONFLITS.md`, section 9, points 35 à 41.

```json
{
  "nature": "CIRCUIT_LOGIQUE",
  "origineNature": "JEU",
  "qualification": "CIRCUIT_LOGIQUE_SUR_INFRASTRUCTURE_VALIDEE",
  "libelle": "Conflit avec un circuit logique porté par 1 infrastructure(s) physique(s) validée(s) : c'est l'infrastructure physique qui est concernée.",
  "supportPhysique": {
    "valides": 1,
    "proposes": 0
  },
  "tracePartagee": 2
}
```

- `GET /:id/analyse` : chaque objet de `conflits.parAxe[].objets` porte `nature`, `origineNature`, `classePrecision` effective ; `reseaux.parNature` et `conflits.total.parNature` : totaux par nature à la granularité du jeu ; `natures` le dit. `reseaux.parType` et `reseaux.parConcessionnaire` sont inchangés (ils somment les natures d'un même type de réseau : écart connu du socle).
- `GET /:id/carte` : chaque feature porte `nature`, `origineNature`, `typeObjet`, `classePrecision`, `origineClasse`.

### Garanties de la base

Descripteur : un seul par objet ; objets d'un plan d'axes ou de limites de route refusés ; nature déclarable limitée ; circuit linéaire, équipement ponctuel ; précisions strictement positives ; référence verticale seulement avec une valeur ; `jeuId` rempli par la base. Relation : un seul enregistrement par couple ; natures, géométries et projet vérifiés par un déclencheur ; décision exigeant auteur, date et justification de 10 caractères ; extrémités, type, origine et proposition figés ; **`DELETE` et `TRUNCATE` refusés** sur les deux tables (23001) ; changement de nature effective sous une relation `PROPOSEE` ou `VALIDEE` refusé (23514).

### Réglages serveur (variables d'environnement)

`PROJETS_VOIRIE_ASSOC_TOLERANCES_M` (défaut `A=0.5,B=1,C=2,D=5,INCONNUE=2`, **provisoire, à valider par la DSI**), `PROJETS_VOIRIE_ASSOC_COUVERTURE_MIN` (0,9), `PROJETS_VOIRIE_ASSOC_PAR_CIRCUIT_MAX` (5), `PROJETS_VOIRIE_ASSOC_CIRCUITS_MAX` (3 000, bornes 100 à 100 000), `PROJETS_VOIRIE_ASSOC_INTERVALLE_S` (30, bornes 0 à 3 600 ; 0 réservé aux bancs). Valeur absente, illisible ou hors bornes : le défaut.

### Ce qui n'est pas fait, décisions hors contrat, défauts connus

- **Connectivité** (nœuds, continuité, traces amont et aval) : non implémentée, reportée par le cahier ; ce qu'il faudrait est décrit dans `CONTRAT-RESEAUX.md`, section 9.
- **Évaluation 3D** : aucune. La profondeur, l'altitude et leur référence sont stockées et rendues ; `evaluable` reste faux, `conclusion3D` nul.
- Les descripteurs et relations suivent l'**objet** : une nouvelle version d'un jeu crée de nouveaux objets sans descripteur ni relation (le delta par empreinte pourrait les proposer ; à décider).
- Les tolérances et le seuil de couverture sont des **valeurs provisoires** (le cahier demande de ne pas attribuer une précision standard) ; la classe d'un objet est une déclaration humaine justifiée et auditée, pas une mesure.
- Pas de GET d'une relation seule (la liste filtrée par `objetId` suffit) ; pas de lot (un descripteur par requête) ; l'historique des valeurs d'un descripteur est dans l'audit (`before` et `after`), pas dans une table dédiée.
- Jeux comptés par `GET /comptage` et propositions : les jeux de rôle `AUTRE` sont inclus ; les propositions n'examinent que les jeux `AUTORISE`.

## Conversion GDAL asynchrone : GeoPackage, Shapefile ZIP, DXF (lot B2)

Contrat : `CONTRAT-IMPORT.md` sections 13 et 14 (règles) ; spool et conteneur : `CHAINE-GDAL.md` ; preuves : banc `backend/tests-integration/gdal-jobs.integration.mts` (conteneur GDAL réel, fichiers 100 % synthétiques). **Interrupteur `PROJETS_VOIRIE_GDAL`, DÉSACTIVÉ par défaut** : désactivé, aucune dépendance au conteneur (ni au démarrage, ni dans les routes, ni dans le sondage).

### Routes (toutes `ADMIN` et `GESTIONNAIRE`, lectures comprises ; mêmes gardes que l'import, projet supprimé : 404 à tous)

| Méthode | Chemin | Rôle |
|---|---|---|
| POST | `/:id/import/jobs` | multipart : `fichier` + `epsgSource` (Shapefile et DXF : obligatoire ; GeoPackage : facultatif) + `unitesDxf` (`metre` ou `degre`, DXF : obligatoire). Répond **202** `{ job }` |
| GET | `/:id/import/jobs?limite=` | jobs du projet, du plus récent au plus ancien, `limite` de 1 à 50 (20 par défaut) : `{ jobs, total, tronque }` |
| GET | `/:id/import/jobs/:jobId` | `{ job }` ; un job d'un autre projet répond le même 404 `JOB_INTROUVABLE` qu'un job inexistant |
| POST | `/:id/import/jobs/:jobId/annuler` | EN_ATTENTE ou EN_COURS vers ANNULE ; 409 `JOB_NON_ANNULABLE` sinon |
| POST | `/:id/import/inventaire`, `/:id/import/apercu`, `/:id/jeux` | champ `jobId` **à la place de** `fichier` (les deux ensemble : 400 `CHAMPS_INVALIDES`) : le résultat validé du job entre dans le MÊME pipeline (CRS, mapping, validation géométrique, simulation, quarantaine `CONTROLE`, delta, revue des suppressions) |

`GET /:id/import/options` annonce `formatsGdal` : `{ actif, disponible, raison, spoolConfigure, formats: [{ format, extensions, etat: "SUPPORTE" | "INDISPONIBLE", raison, crs, specifique, preuve }], limites }`. Désactivé (défaut) : les trois formats sont `INDISPONIBLE` avec la raison, `limites` est `null`. Un format n'est `SUPPORTE` que si l'interrupteur est actif, le dossier d'échange accessible, et qu'une preuve de bout en bout est citée (`preuve.verification`, vérifiée par un test unitaire).

### Le job

```
{ "job": { "id", "projetId", "format": "GPKG" | "SHAPEFILE" | "DXF", "statut": "EN_ATTENTE" | "EN_COURS" | "TERMINE" | "ECHEC" | "ANNULE" | "EXPIRE",
           "nomFichier", "tailleOctets", "sha256", "parametres": { "epsgSource", "unitesDxf" }, "etape", "progression": 0 a 100,
           "codeErreur", "messageErreur" (libellé FIXE), "tentatives", "tentativesMax", "creeLe", "reclameLe", "finLe", "expireLe",
           "fichiersPurges", "utilisable", "jeuId",
           "resume": { "format", "source": { nom, octets, sha256 }, "gdal": { version, proj },
                       "couches": [ { id, nom, nbObjets, parTypeGeom, typesReels, sommets, emprise, attributs, coordonnees, reprojete, crsSource: { origine: "fichier" | "demande", epsg, nom }, slug } ],
                       "champsDisponibles", "dxf": { lues, ignorees, blocs, calques, unitesDeclarees, insunits, ... } | null, "avertissements", "integrite" } | null } }
```

`resume` n'existe que pour un job `TERMINE` et ne porte **jamais** une coordonnée d'objet. `utilisable` : TERMINE, non utilisé, non expiré, fichiers présents. Un seul dépôt par job (`jeuId`) : le job utilisé répond ensuite 409 `JOB_DEJA_UTILISE`.

### Règles de CRS et d'unités (rien n'est deviné)

- **Shapefile** : `epsgSource` obligatoire à la création (422 `CRS_REQUIS` sinon, aucun job créé). Le `.prj` est lu mais ne vaut jamais confirmation ; un `.prj` d'un autre EPSG fait échouer le job (`CRS_CONFLIT`), un `.prj` sans code EPSG identifiable aussi. Sans `.prj`, le CRS confirmé est appliqué (avertissement `CRS_FOURNI_PAR_LA_DEMANDE`).
- **DXF** : `epsgSource` obligatoire, `unitesDxf` obligatoire (422 `UNITES_REQUISES`). `metre` exige un CRS en mètres, `degre` un CRS géographique (422 `DXF_UNITES_CONFLIT`). L'en-tête `$INSUNITS` doit être absent, 0 ou 6 (mètres) pour `metre` ; millimètres, pieds, pouces donnent un job en `ECHEC` `DXF_UNITES_CONFLIT` : **aucune mise à l'échelle silencieuse**.
- **GeoPackage** : CRS déclaré par le fichier. WGS 84 : aucune confirmation. Projeté : l'aperçu exige `epsgSource` identique (422 `CRS_REQUIS`, 422 `CRS_CONFLIT` si différent). Fichier sans CRS : création avec `epsgSource`, sinon coordonnées brutes refusées à l'usage (`CRS_REQUIS`).
- Dans tous les cas : liste blanche `PROJETS_VOIRIE_CRS_SOURCE_AUTORISES` (422 `CRS_NON_AUTORISE`) ; plusieurs couches de CRS source différents ne se mélangent pas (422 `CRS_MULTIPLES`, choisir `couche`).

### DXF : entités et calques

Lues : `LINE`, `LWPOLYLINE`, `POLYLINE` 2D, `POLYLINE` 3D (`3DPOLYLINE`). Ignorées **et comptées** (`resume.dxf.ignorees`, avertissement `DXF_ENTITES_IGNOREES`) : `TEXT`, `MTEXT`, `HATCH`, `POINT`, `CIRCLE`, `ARC`, `SPLINE`, cotes, maillages, espace papier ; les blocs (`INSERT` et définitions) sont ignorés et comptés (`DXF_BLOCS_IGNORES`). Les calques sont les couches du wizard : `couche=calque:<nom>`. Le DXF binaire est refusé (422 `DXF_BINAIRE_NON_PRIS_EN_CHARGE`). L'altitude est ignorée (GDAL l'écarte).

### Codes d'erreur

| Statut | Code | Cas |
|---|---|---|
| 415 | `FORMAT_GDAL_DESACTIVE` | interrupteur coupé : dépôt d'un job, aperçu ou dépôt synchrone d'un GeoPackage, d'un Shapefile ZIP ou d'un DXF (champ `format`) |
| 503 | `GDAL_DESACTIVE` | interrupteur coupé : lecture, liste, annulation, `jobId` à l'aperçu ; `SPOOL_INDISPONIBLE` : dossier d'échange absent ou illisible |
| 422 | `CONVERSION_ASYNCHRONE_REQUISE` | fichier GDAL envoyé aux routes synchrones alors que l'interrupteur est actif : créer un job |
| 422 | `CRS_REQUIS`, `CRS_CONFLIT`, `CRS_NON_AUTORISE`, `CRS_MULTIPLES`, `UNITES_REQUISES`, `DXF_UNITES_CONFLIT`, `DXF_BINAIRE_NON_PRIS_EN_CHARGE`, `SHAPEFILE_INCOMPLET`, `ARCHIVE_*`, `COUCHE_INTROUVABLE`, `HORS_GUINEE` | règles ci-dessus ; mêmes codes que les autres formats pour le reste |
| 415 | `FORMAT_NON_SUPPORTE` | contenu qui n'est ni GeoPackage, ni archive de Shapefile, ni DXF texte (création d'un job) |
| 409 | `JOB_DEJA_EN_COURS` (`jobId`, `statut`), `JOB_NON_TERMINE` (`statut`, `codeErreur`), `JOB_DEJA_UTILISE` (`jeuId`), `JOB_NON_ANNULABLE`, `RESULTAT_ALTERE` | un fichier du spool ne correspond plus à ce qui a été validé |
| 410 | `RESULTAT_EXPIRE` | fichiers temporaires retirés |
| 404 | `JOB_INTROUVABLE` | job inexistant ou d'un autre projet |
| 429 | `PLAFOND_JOBS_COMPTE`, `PLAFOND_JOBS_PROJET`, `JOBS_TROP_FREQUENTS` | plafonds de jobs actifs, cadence par heure ; `Retry-After` en secondes |
| 503 | `FILE_JOBS_PLEINE` | file globale pleine ; `Retry-After` |

`codeErreur` d'un job en `ECHEC` ou `EXPIRE` : code du conteneur (CHAINE-GDAL.md 4.3, `ENTREE_ABSENTE` à `ERREUR_INTERNE`, `DXF_*`) ou propre au backend (`SORTIE_INVALIDE`, `SORTIE_INCOHERENTE`, `SPOOL_INDISPONIBLE`, `JOB_PERDU`, `DXF_UNITES_CONFLIT`, `CONVERSION_EXPIREE`). Le message est **fixe** par code : le texte libre du conteneur n'est jamais renvoyé (il peut citer un chemin ou une ligne de fichier).

### Réglages serveur (variables d'environnement, bornées : une valeur illisible redonne le défaut)

`PROJETS_VOIRIE_GDAL` (absent = désactivé), `PROJETS_VOIRIE_GDAL_SPOOL` (aucun défaut), `_DELAI_S` 90 (10 à 120), `_SORTIE_MAX_OCTETS` 80 Mo (1 à 200 Mo), `_TENTATIVES` 3 (1 à 5), `_RETENTION_H` 24 (1 à 72), `_SONDAGE_S` 3 (1 à 60), `_CONCURRENCE` 2 (1 à 4), `_ACTIFS_COMPTE` 2, `_ACTIFS_PROJET` 3, `_FILE_MAX` 20, `_CREATIONS_HEURE` 12. Valeurs de départ à valider par le DSI.

## Territoires, référentiels configurables et configuration nationale (lot T1)

Contrat : `CONTRAT-TERRITOIRES.md` (modèle, règles, schémas, codes) ; preuves : banc `backend/tests-integration/territoires-referentiels.integration.mts` (78 vérifications, données synthétiques). Mêmes gardes que le socle ; **toute écriture est réservée à l'ADMIN**, auditée et historisée (ajout seul).

### Routes

| Méthode | Chemin | Rôle | Contenu |
|---|---|---|---|
| GET | `/territoires` | lecture | `?niveau=&parentId=&q=&actifs=&limite=(1..500, 200)&curseur=` : `{ territoires, curseurSuivant }` (ordre du chemin, filtré par périmètre) |
| GET | `/territoires/comptes` | lecture | `?territoireId=` : `{ comptes: [ { territoireId, code, nom, niveau, parentId, profondeur, projets, jeux: { STATUT: n }, conflits: { STATUT: n } } ], tronque }` (territoire et descendants) |
| POST | `/territoires` | ADMIN | `{ code, nom, niveau, parentId?, regionId?, crsMetriqueEpsg?, emprise?, source? }` : 201 `{ territoire, avertissements }` |
| GET | `/territoires/:tid` | lecture | `{ territoire: { ...vue, ancetres, nbEnfants } }` ; 404 masqué |
| PATCH | `/territoires/:tid` | ADMIN | `{ nom?, regionId?, crsMetriqueEpsg?, emprise? (ou null), actif?, source? }` : `{ territoire, avertissements }` |
| DELETE | `/territoires/:tid` | ADMIN | `{ id, retire: true }` ; 409 `TERRITOIRE_UTILISE` |
| GET | `/referentiels` | lecture | `{ domaines: [ { domaine, nb, nbActifs } ] }` |
| GET | `/referentiels/:domaine` | lecture | `?tous=true` : `{ domaine, valeurs }` |
| GET | `/referentiels/:domaine/:code` | lecture | `{ valeur }` |
| POST | `/referentiels/:domaine` | ADMIN | `{ code, libelle, ordre?, actif?, parametres }` : 201 `{ valeur }` |
| PATCH | `/referentiels/:domaine/:code` | ADMIN | `{ libelle?, ordre?, actif?, parametres? }` : `{ valeur }` |
| DELETE | `/referentiels/:domaine/:code` | ADMIN | `{ code, retire: true }` ; 409 `VALEUR_UTILISEE` |
| GET | `/configuration` | lecture | `{ configuration: [ { cle, valeur, source, valeurBase, valeurDefaut, variableEnvironnement, version, approuvePar, approuveLe, justification, updatedAt } ] }` |
| GET | `/configuration/:cle` | lecture | `{ configuration }` |
| PUT | `/configuration/:cle` | ADMIN | `{ valeur, justification? }` : `{ configuration }` |

Vue d'un territoire : `{ id, code, nom, niveau, parentId, chemin, profondeur, regionId, regionEffectiveId, crsMetriqueEpsg, emprise, bbox, source, actif, version, creePar, createdAt, updatedAt }`. Vue d'une valeur : `{ id, domaine, code, libelle, ordre, actif, parametres, version, systeme, approuvePar, approuveLe, createdAt, updatedAt }`.

Exemple (banc, données synthétiques) : `POST /territoires` avec `{ "code": "BANC-CORRIDOR-RN", "niveau": "ZONE", "parentId": "<région>", "emprise": { "type": "Polygon", ... } }` répond 201, `niveau` ZONE, `regionEffectiveId` celle de la région, `bbox` `[-9.5, 8.8, -8.5, 10.5]`, `avertissements` vide. Deux projets (`largeurEmpriseM` 40 et 30) s'y rattachent par `territoireId` ; `GET /?territoireId=<corridor>` les rend tous deux, et eux seuls.

### Changements des routes du socle

- `POST /` : `territoireId` **obligatoire** (400 `TERRITOIRE_REQUIS`), `categorieCode?` (largeurs par défaut de la catégorie), `regionId` dérivé du territoire ; `commune` et `prefecture` dérivées des ancêtres. Codes : `TERRITOIRE_INTROUVABLE` (inconnu, retiré ou inactif), `TERRITOIRE_REGION_INCOHERENTE`, `CATEGORIE_INCONNUE`.
- `PATCH /:id` : `territoireId?`, `categorieCode?`. `GET /` : `?territoireId=`. Les vues de projet portent `territoireId`, `categorieCode`, `territoire` (`GET /:id` : avec `ancetres`).
- `POST /concessionnaires` : `typeReseau` **ou** `typeReseauCode`. `POST /:id/jeux` : `typeReseauCode?` (400 `TYPE_RESEAU_INCONNU`, `TYPE_RESEAU_INCOHERENT`). Les vues de jeu et de concessionnaire portent `typeReseauCode`.
- Lecture des fichiers : l'emprise nationale est celle de la configuration (`EMPRISE_PLAUSIBILITE` ; codes `ELEMENTS_HORS_GUINEE` et `HORS_GUINEE` conservés pour la compatibilité, messages avec le nom configuré) ; un objet hors de l'emprise du **territoire du projet** est conservé et compté (avertissement `ELEMENTS_HORS_TERRITOIRE`) ; `resume.crs.plausibilite.zoneAttendue` est l'emprise du territoire quand il en porte une ; la confirmation `CONFIRMATION_HORS_ZONE_REQUISE` compte les deux.
- Analyse 2D, analyse de conflits et propositions d'associations : CRS métrique imposé par le territoire du projet (ou son plus proche ancêtre), sinon règle par bandes de la configuration.
- `GET /:id/import/options` : `crs.sourcesAutorises` (liste blanche effective), `crs.zoneAttendue`, `crs.zoneNationale`, `crs.territoireId`, `crs.crsMetriqueImpose`.

### Réglages

`PROJETS_VOIRIE_CONFIG_CACHE_MS` (défaut 30 000, bornes 1 000 à 600 000) : durée de fraîcheur de la configuration lue en base, par processus (invalidée à l'écriture dans le même processus ; une autre instance la relit à l'expiration). Les variables d'environnement des protections (`PROJETS_VOIRIE_ANALYSE_INTERVALLE_S`, `_CONFLITS_MAX`, `_SOMMETS_PAR_OBJET`, `_SOMMETS_PAR_FICHIER`, `_DELAI_ANALYSE_MS`, `_DELAI_CARTE_MS`, `_DELAI_DEPOT_MS`) et de la liste blanche (`PROJETS_VOIRIE_CRS_SOURCE_AUTORISES`) restent **prioritaires** sur la base ; `GET /configuration` dit la source.
