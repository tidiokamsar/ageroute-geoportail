# API Projets de voirie et réseaux : référence

Préfixe : `/api/v2/projets-voirie`. Contrat : `docs/projets-voirie/CONTRAT.md` (v2, fait foi pour le modèle et les règles). Ce document décrit les routes **telles qu'elles répondent**. Les exemples sont des réponses réelles, relevées par le banc `backend/tests-integration/projets-voirie.integration.mts` sur des données 100 % synthétiques (identifiants raccourcis, listes tronquées).

Toutes les routes : jeton d'accès (`Authorization: Bearer ...`), clé de module `projets-voirie` (un `ADMIN` passe sans clé), réponses `Cache-Control: no-store` et `X-Content-Type-Options: nosniff`. Erreurs : `{ "error": "texte", "code": "CODE", ... }`.

## Gardes, dans l'ordre

1. Authentification : 401 sans jeton valide.
2. Module : 403 `{ error }` sans la clé `projets-voirie`.
3. Rôle (écritures) : 403 sans `ADMIN` ou `GESTIONNAIRE` (`DELETE` d'un projet : `ADMIN`). L'export CSV de l'analyse est réservé aux mêmes rôles, bien que ce soit un `GET`.
4. Projet désigné : **404 `PROJET_INTROUVABLE`** identique si le projet n'existe pas, est retiré, est hors du périmètre régional du compte ou n'a pas de région (un projet sans région n'est visible que des comptes nationaux). Cette garde précède la validation du corps.
5. Validation des entrées : 400 avec `code`, jamais 500.

Contrôle territorial : repose sur `perimetres_comptes` comme les autres routes (`requireTerritoireMasque` en lecture et en écriture ; `requireTerritoire`, 403, à la création : un compte régional ne crée que dans sa région).

## Routes

| Route | Rôle | Réponse |
|---|---|---|
| `GET /` | lecture | `{ projets: [ { ...projet, jeux: { CONTROLE: 1, AUTORISE: 2 } } ], curseurSuivant }` ; paramètres `q`, `limite` (1 à 100, défaut 25), `curseur` |
| `POST /` | écriture | 201 `{ projet }` |
| `GET /:id` | lecture | `{ projet: { ...champs, parametres, bbox, jeux: [ jeu ] } }` ; `bbox` = union des emprises des jeux autorisés, nul sans jeu autorisé |
| `PATCH /:id` | écriture | `{ projet }` |
| `DELETE /:id` | `ADMIN` | `{ id, retire: true }` (retrait logique) |
| `GET /concessionnaires` | lecture | `{ concessionnaires: [ { id, nom, typeReseau, contact, createdAt } ] }` triés par nom |
| `POST /concessionnaires` | écriture | 201 `{ concessionnaire }` |
| `POST /:id/jeux` | écriture | 201 (dépôt) ou 200 (`?simuler=true`) `{ simulation, jeu, resume, avertissements, delta, remplace }` |
| `GET /:id/jeux` | lecture | `{ jeux: [ jeu ] }`, tous statuts sauf `RETIRE`, du plus récent au plus ancien |
| `DELETE /:id/jeux/:jeuId` | écriture | `{ jeu }` (statut `RETIRE`, les objets restent en base) |
| `POST /:id/jeux/:jeuId/autoriser` | écriture | `{ jeu, remplaces: [ids] }` |
| `POST /:id/jeux/:jeuId/rejeter` | écriture | `{ jeu, remplaces: [] }` |
| `GET /:id/carte` | lecture | couches d'affichage (section Carte) |
| `GET /:id/analyse` | lecture | analyse indicative (section Analyse) |
| `GET /:id/analyse/export.csv` | `ADMIN`, `GESTIONNAIRE` | `text/csv`, audité |

Il n'existe **aucune** route d'export des géométries d'un jeu (ni GeoJSON, ni KML) ; un test de l'inventaire des accès fige la liste des 15 routes.

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

Paramètres : `jeux` (1 à 50 identifiants), `bbox` (degrés, ouest < est, sud < nord), `zoom` (0 à 22 ; simplification de la géométrie, aucune à partir de 17), `inclureNonAutorises`. Plafond : 20 000 objets par réponse, `tronque: true` au-delà (`total` donne le nombre exact par jeu).

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
- Par défaut, seuls les jeux `AUTORISE` comptent. Avec `inclureNonAutorises=true`, un jeu en contrôle **remplace**, pour ce calcul, le jeu autorisé de même rôle et de même concessionnaire (jamais les deux), et l'hypothèse « INCLUS » le dit.
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
| 415 | `FORMAT_NON_SUPPORTE` | KMZ, ZIP, Shapefile, DXF, DWG, GPX, CSV... (« prévu au lot suivant »), texte qui n'est ni XML ni JSON |
| 422 | `CONTENU_NON_RECONNU` | HTML, PDF, exécutable, image, binaire, octets NUL |
| 422 | `FICHIER_VIDE`, `TROP_D_OBJETS` (> 50 000), `GEOMETRIE_INVALIDE`, `HORS_GUINEE` | contenu refusé |
| 422 | `XML_INVALIDE`, `DTD_REFUSEE`, `ENTITE_REFUSEE`, `XML_TROP_PROFOND`, `XML_TROP_VOLUMINEUX`, `JSON_INVALIDE`, `JSON_TROP_PROFOND`, `ENCODAGE_NON_SUPPORTE`, `CRS_NON_SUPPORTE` | document illisible ou dangereux |
| 503 | `SERVICE_OCCUPE` (+ `Retry-After`) | plus de deux dépôts simultanés dans le processus |
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
- CRS : WGS 84 uniquement ; aucune transformation silencieuse ; un `crs` GeoJSON autre que CRS84 / EPSG:4326 est refusé.

## Sécurité et audit

- Données RESTREINT par défaut, jamais dans l'API publique ni les tuiles (test statique `isolation.test.ts` + banc : aucune réponse publique ne contient les noms des objets).
- Aucune écriture hors des tables du module et d'`audit_logs` (test statique + banc : comptes de toutes les tables avant et après).
- Entités auditées : `ProjetVoirie`, `JeuDonneesProjet`, `ConcessionnaireReseau`, `ExportProjetVoirie`. Actions : `CREATE` (projet, concessionnaire, dépôt, export), `UPDATE` (projet), `VALIDATE` (autorisation), `REJECT` (rejet), `DELETE` (retrait). Les valeurs auditées ne portent aucune géométrie.
- La base refuse : suppression physique, modification d'un objet, objet vide / invalide / hors Guinée / de type incohérent, jeu dont rôle, concessionnaire, nature, version, retrait ou décision sont incohérents, deux jeux autorisés de même clé.
