# Module « Projets de voirie et réseaux » : contrat d'import (formats ouverts, CRS, mapping, versions)

Statut : contrat du lot A1 (backend), écrit AVANT le code le 07/11/2026 pour l'agent d'interface (lot A2). Il complète `CONTRAT.md` (v2, qui reste la référence du modèle, de la quarantaine et des règles) et `API.md` (les réponses réelles). En cas de divergence avec le code livré, le rapport `docs/reports/LOT-A1-RAPPORT.md` le dit ; ce document est tenu à jour dans le même lot.

Portée : formats **KML, KMZ, GeoJSON, GPX, CSV/TSV/TXT** (sans GDAL), choix du CRS source dans une liste blanche, transformation par PostGIS (`ST_Transform`, PROJ), inventaire des couches, aperçu borné sans persistance, mapping de champs, validation géométrique, statistiques, delta de versions avec revue des suppressions, retour arrière d'une version, conservation facultative du fichier d'origine.

Hors portée de ce lot : GeoPackage, Shapefile, DXF (chaîne GDAL, lot à part, `CHAINE-GDAL.md`), raster, DWG, IFC, LAS, interface, conflits. Ces formats répondent toujours 415 `FORMAT_NON_SUPPORTE`.

## 1. Règles non négociables (rappel et ajouts)

1. **Rien n'est deviné.** Pas de CRS déduit : un CSV sans `epsgSource` est refusé (`CRS_REQUIS`), un CRS hors liste blanche est refusé (`CRS_NON_AUTORISE`). Pas d'encodage deviné : un CSV qui n'est ni UTF-8 valide ni UTF-16 avec BOM est refusé (`ENCODAGE_AMBIGU`) tant que l'utilisateur n'a pas déclaré `encodage`. Pas de délimiteur ni de séparateur décimal ambigus.
2. **Aucune transformation silencieuse.** Toute réponse d'aperçu, de simulation et de dépôt porte `resume.crs` : CRS source et cible, unités, méthode, version de PROJ, et le contrôle de plausibilité.
3. **Type réel par le contenu.** L'extension et le `Content-Type` ne servent qu'à un avertissement (`EXTENSION_INCOHERENTE`).
4. **Un lot reçu n'est pas un lot importé** (inchangé) : un dépôt crée un jeu `CONTROLE`. L'aperçu et l'inventaire ne persistent **rien** (ni jeu, ni objet, ni audit).
5. **Les suppressions d'une nouvelle version ne sont jamais appliquées sans revue explicite** : un jeu dont le delta contient des objets retirés ne s'autorise (409 `SUPPRESSIONS_A_REVOIR`) qu'après une revue humaine, auditée, justifiée (section 8).
6. **Aucun code n'est exécuté depuis un fichier téléversé.** Aucune ressource externe n'est chargée (KML `NetworkLink`, `Icon`, GPX `link`, etc. sont ignorés). Une archive n'est jamais extraite sur disque : seule l'entrée KML principale est décompressée, en mémoire, sous plafond.
7. **Aucune route n'exporte la géométrie d'un jeu.** L'aperçu ne renvoie que le contenu du fichier que l'utilisateur vient d'envoyer, borné à un échantillon.
8. Les erreurs ne divulguent aucun chemin interne ni aucune donnée de jeu non autorisé.

## 2. Parcours du wizard (aucune session côté serveur)

Le serveur ne garde rien entre deux étapes : **le client renvoie le fichier à chaque étape** (multipart, champ `fichier`), avec les mêmes options. Chaque réponse porte le `sha256` calculé côté serveur ; le dépôt accepte `sha256Attendu` et refuse (409 `EMPREINTE_DIVERGENTE`) si le fichier a changé entre l'aperçu et le dépôt. Compromis assumé : jusqu'à 25 Mo envoyés plusieurs fois, contre aucune décision de conservation d'un fichier non encore accepté.

| Étape | Route | Écrit en base ? | Rôle |
|---|---|---|---|
| 0 | `GET /:id/import/options` | non | formats, limites, CRS source autorisés, champs cibles du mapping, options CSV, mode de conservation de l'original |
| 1 | `POST /:id/import/inventaire` | non | détection par le contenu, entrées d'archive, couches, colonnes CSV, CRS exigé ou non, attributs disponibles pour le mapping |
| 2 | `POST /:id/import/apercu` | non (lecture seule en base : `ST_Transform`, `ST_IsValid`) | échantillon borné, statistiques, validation géométrique par objet (bornée), plausibilité du CRS, mapping appliqué |
| 3 | `POST /:id/jeux?simuler=true` | non (transaction annulée) | chemin exact du dépôt réel : mesures, delta, suppressions à revoir |
| 4 | `POST /:id/jeux` | oui, jeu `CONTROLE` | dépôt en quarantaine |
| 5 | `GET /:id/jeux/:jeuId/delta` puis `POST /:id/jeux/:jeuId/revue-suppressions` | revue : oui | delta détaillé ; décision sur les suppressions |
| 6 | `POST /:id/jeux/:jeuId/autoriser` ou `/rejeter` | oui | inchangé, sauf la garde 409 des suppressions |
| 7 | `POST /:id/jeux/:jeuId/retour-arriere` | oui | remise de la version précédente comme `AUTORISE` |

Toutes ces routes sont derrière : jeton, clé de module `projets-voirie`, octet NUL (400), UUID (400), **rôle `ADMIN` ou `GESTIONNAIRE`** (403, y compris pour `GET .../options` et `GET .../delta`), projet désigné (404 masqué hors périmètre ; **404 `PROJET_INTROUVABLE` à tous les comptes, nationaux compris, si le projet est inexistant ou retiré**), place de réception pour les routes à fichier (503 `SERVICE_OCCUPE`), validation (400), service. Réponses `Cache-Control: no-store`.

## 3. Champs d'options (multipart, identiques aux étapes 1 à 4)

Tous facultatifs, sauf `epsgSource` pour un CSV. Les valeurs vides (`""`) valent « non fourni ». Un champ inconnu : 400 `CHAMPS_INVALIDES`.

| Champ | Valeurs | Sens |
|---|---|---|
| `couche` | identifiant renvoyé par l'inventaire (`c0`, `c1`... pour KML ; `waypoints`, `routes`, `traces` pour GPX) | couche à importer. Absent : **toutes** les couches (comportement historique) avec avertissement `COUCHES_MULTIPLES` s'il y en a plusieurs |
| `entreeKml` | nom exact d'une entrée d'un KMZ | entrée KML à lire. Absent : `doc.kml` à la racine, sinon l'unique `.kml` ; plusieurs sans `doc.kml` : 422 `KMZ_PLUSIEURS_KML` |
| `epsgSource` | entier | CRS source choisi par l'utilisateur. **Obligatoire pour un CSV.** KML, KMZ, GPX : WGS 84 par la norme, toute autre valeur donne `CRS_INCOMPATIBLE_FORMAT`. GeoJSON : facultatif ; un membre `crs` projeté dans le fichier exige `epsgSource` identique |
| `confirmerHorsZone` | `true` / `false` | voir 5.3 |
| `sha256Attendu` | 64 caractères hexadécimaux | garde contre un fichier modifié entre deux étapes (dépôt seulement) |
| `mapping` | texte JSON `{ "<champCible>": "<colonneSource>" }` | voir section 7 |
| `delimiteur` | `,` `;` `\t` (tabulation) `\|` | CSV. Absent : détecté, ou 422 `DELIMITEUR_AMBIGU` |
| `encodage` | `utf-8` `iso-8859-1` `windows-1252` | CSV. Absent : UTF-8 (avec ou sans BOM) ou UTF-16 avec BOM, sinon 422 `ENCODAGE_AMBIGU` |
| `separateurDecimal` | `.` ou `,` | CSV. Absent : détecté si sans ambiguïté, sinon 422 `SEPARATEUR_DECIMAL_AMBIGU` |
| `colonneX`, `colonneY` | nom de colonne | CSV : coordonnées (x/y, ou longitude/latitude : désigner la longitude comme X et la latitude comme Y) |
| `colonneWkt` | nom de colonne | CSV : géométrie en WKT (mutuellement exclusif avec `colonneX`/`colonneY`) |
| `colonneCle`, `colonneOrdre` | nom de colonne | CSV : construit **une ligne par valeur de clé** ; `colonneOrdre` (numérique) trie les points de chaque ligne, sinon l'ordre du fichier |

Champs existants du dépôt (`role`, `concessionnaireId`, `typeReseau`, `dateDonnees`, `origineFichier`, `confidentialite`, `natureObjets`, `classePrecision`, `precisionHorizontaleM`, `precisionVerticaleM`, `methode`, `dateConstat`) : inchangés ; ils sont **ignorés** par l'inventaire et l'aperçu (qui ne lisent que le fichier et les options ci-dessus).

## 4. Formats

| Format (valeur de `format` du jeu) | Détection | Contenu lu | Ne fait pas |
|---|---|---|---|
| `KML` | texte XML, racine `kml`, `Document`, `Folder` ou `Placemark` | comme `CONTRAT.md` 4.1 | styles, `NetworkLink`, superpositions (ignorés avec avertissement) |
| `KMZ` | signature ZIP, central directory valide, au moins une entrée `.kml` | l'entrée KML principale seulement (section 6) | tout autre contenu de l'archive |
| `GEOJSON` | texte JSON `{`, membre `type` | comme `CONTRAT.md` 4.1 ; membre `crs` projeté accepté **avec** `epsgSource` identique | `crs` autre que `EPSG:xxxx` ou `urn:ogc:def:crs:EPSG::xxxx` |
| `GPX` | texte XML, racine `gpx` | `wpt` (points), `rte`/`rtept` (lignes), `trk`/`trkseg`/`trkpt` (une ligne par segment, regroupées en un objet par trace) ; `name`, `desc`, `cmt`, `src`, `type`, `number`, `sym` en attributs ; WGS 84 par définition | horodatages et précisions GPS (avertissement `HORODATAGES_IGNORES`), altitude (`ALTITUDE_IGNOREE`), extensions |
| `CSV` (CSV, TSV, TXT) | texte non XML, non JSON, non HTML, sans octet NUL, avec un en-tête et un délimiteur cohérent sur toutes les lignes | points, lignes par clé, ou WKT (section 4.1) | pas de ligne d'en-tête absente, pas de séparateur de milliers, pas de plusieurs tables |

Valeur de `format` stockée : `KML`, `KMZ`, `GEOJSON`, `GPX`, `CSV`. Un TSV ou un TXT est un `CSV` ; le délimiteur effectif est dans `resume.import.csv.delimiteur`.

### 4.1 CSV : règles

- **Encodage** : UTF-8 avec ou sans BOM, ou UTF-16 avec BOM ; sinon `ENCODAGE_AMBIGU` sauf `encodage` déclaré. Un octet NUL ailleurs : 422 `CONTENU_NON_RECONNU`.
- **Structure** : RFC 4180 (guillemets, `""`, retours à la ligne dans un champ guillemeté). Première ligne = en-tête. En-têtes vides renommés `colonne_N`, doublons suffixés ` (2)` (avertissement `COLONNES_RENOMMEES`).
- **Nombres** : `separateurDecimal` (`.` ou `,`), déclaré ou lu sur les colonnes de coordonnées seulement et sans ambiguïté (les deux présents : 422 `SEPARATEUR_DECIMAL_AMBIGU`). Un nombre doit être exactement un nombre : pas de séparateur de milliers (`1 234,5` est illisible), pas d'exposant avec la virgule. Nombre illisible : la ligne est rejetée (rapport par ligne).
- **Points** (`colonneX` + `colonneY`) : un objet `POINT` par ligne.
- **Lignes** (`colonneX` + `colonneY` + `colonneCle`, `colonneOrdre` facultative) : un objet `LIGNE` par valeur distincte de clé, nommé par la clé ; au moins deux points, sinon la clé est rejetée. Attributs : la clé, `nbPoints`, et les colonnes dont la valeur est identique sur toutes les lignes du groupe. **Non fait** : plusieurs clés d'axe imbriquées, détection de ruptures de chaînage, polygones depuis des points.
- **WKT** (`colonneWkt`) : `POINT`, `LINESTRING`, `POLYGON`, `MULTIPOINT`, `MULTILINESTRING`, `MULTIPOLYGON`, 2D (Z et M ignorés), sans préfixe `SRID=` ; sinon la ligne est rejetée.
- **Injection de formules** : les valeurs sont lues comme du texte et conservées telles quelles (`=...`, `+...`, `-...`, `@...` n'ont aucun effet : on ne les évalue ni ne les écrit en tableur). L'export CSV de l'analyse neutralise déjà ces préfixes.
- **Cellules** : 10 000 caractères au plus (422 `CSV_CELLULE_TROP_LONGUE`), sauf la colonne WKT (2 000 000). Colonnes non vides seulement dans `attributs` (une cellule vide est une valeur inconnue, jamais une valeur par défaut).
- **Lignes rejetées** : comptées dans l'avertissement `LIGNES_CSV_REJETEES` ; le détail (numéro de ligne du fichier, code, message) est dans `resume.import.rejets` (50 au plus, `rejetsTronques` au-delà). Codes de rejet : `COORDONNEES_ABSENTES`, `COORDONNEES_ILLISIBLES`, `WKT_ABSENT`, `WKT_INVALIDE`, `CLE_ABSENTE`, `ORDRE_ILLISIBLE`, `LIGNE_TROP_COURTE`. S'il ne reste aucun objet : 422 (`GEOMETRIE_INVALIDE`, `HORS_GUINEE` ou `FICHIER_VIDE`).

## 5. CRS

### 5.1 Liste blanche

`GET /:id/import/options` renvoie `crs.sourcesAutorisees` : `[ { epsg, nom, unite } ]`. Défaut : **EPSG:4326, EPSG:32628, EPSG:32629** (WGS 84 géographique, UTM 28N, UTM 29N). Réglable par `PROJETS_VOIRIE_CRS_SOURCE_AUTORISES` (liste d'entiers séparés par des virgules). Tout autre code : 422 `CRS_NON_AUTORISE` (« non validé par le DSI »). Un code autorisé que la base ne connaît pas : 422 `CRS_NON_DISPONIBLE`. Cible de stockage : **EPSG:4326** (inchangé).

### 5.2 `resume.crs` (aperçu, simulation, dépôt, fiche du jeu)

```
"crs": {
  "source": "EPSG:32629 (WGS 84 / UTM zone 29N)",      // texte lisible, champ historique
  "cible": "EPSG:4326",                                // champ historique
  "methode": "ST_Transform (PostGIS, PROJ 9.x)",       // "aucune transformation" pour une source WGS 84
  "justification": "CRS choisi par l'utilisateur ...",  // champ historique
  "epsgSource": 32629, "epsgCible": 4326,
  "uniteSource": "metre", "uniteCible": "degre",
  "origine": "choisi_par_utilisateur" | "norme_du_format",
  "transformation": "ST_Transform" | "aucune",
  "versionProj": "9.x.y" | null,
  "plausibilite": {
    "zoneAttendue": { "nom": "Guinee", "bbox": [-15.2, 7.1, -7.5, 12.8] },
    "empriseResultat": [ouest, sud, est, nord] | null,
    "nbElementsHorsZone": 0, "nbObjets": 31,
    "statut": "CONFORME" | "PARTIELLEMENT_HORS_ZONE",   // tout hors zone n'est pas un statut : c'est l'erreur 422 HORS_GUINEE
    "confirmationRequise": false, "confirmee": false
  }
}
```

Les champs historiques (`source`, `cible`, `methode`, `justification`) gardent leur forme texte. Les autres sont ajoutés.

### 5.3 Contrôle de plausibilité et confirmation

La zone attendue est l'emprise de la Guinée (`BBOX_GUINEE`). Après transformation :

- **tout est hors zone** : 422 `HORS_GUINEE`, jamais contournable (la base refuse de toute façon un objet hors Guinée). Cas typique : plan UTM 29N déclaré en WGS 84 (valeurs de plusieurs centaines de milliers lues comme des degrés : 422 `CRS_INCOHERENT`), ou mauvaise zone UTM (28N au lieu de 29N), ou longitude et latitude inversées ;
- **une partie seulement est hors zone** : pour un CSV et pour toute source dont le CRS est choisi par l'utilisateur, 409 `CONFIRMATION_HORS_ZONE_REQUISE` (avec `nbElementsHorsZone`) tant que `confirmerHorsZone=true` n'est pas envoyé ; confirmé, les éléments hors zone sont écartés (jamais stockés) et comptés dans l'avertissement `ELEMENTS_HORS_GUINEE`. KML, KMZ, GPX et GeoJSON WGS 84 gardent le comportement historique (éléments hors Guinée écartés, avertissement, sans confirmation).

### 5.4 Erreurs de CRS

| Statut | Code | Cas |
|---|---|---|
| 422 | `CRS_REQUIS` | CSV sans `epsgSource` ; GeoJSON dont le membre `crs` est projeté sans `epsgSource` |
| 422 | `CRS_NON_AUTORISE` | `epsgSource` hors liste blanche |
| 422 | `CRS_NON_DISPONIBLE` | code autorisé mais absent de `spatial_ref_sys` |
| 422 | `CRS_INCOMPATIBLE_FORMAT` | `epsgSource` différent de 4326 pour KML, KMZ, GPX |
| 422 | `CRS_CONFLIT` | `epsgSource` différent du `crs` déclaré par le GeoJSON |
| 422 | `CRS_INCOHERENT` | CRS géographique déclaré mais valeurs hors de ±180/±90 (probables mètres projetés) |
| 422 | `TRANSFORMATION_ECHEC` | PROJ refuse une coordonnée du fichier pour ce CRS |
| 409 | `CONFIRMATION_HORS_ZONE_REQUISE` | voir 5.3 |
| 422 | `CRS_NON_SUPPORTE` | membre `crs` GeoJSON illisible ou qui n'est pas un code EPSG (inchangé) |

## 6. KMZ (archive ZIP bornée)

Le central directory est lu et contrôlé **avant toute décompression** ; aucun fichier n'est écrit sur disque. Refus de l'archive entière dès la première infraction :

| Code (422) | Cas |
|---|---|
| `ARCHIVE_INVALIDE` | ZIP corrompu ou tronqué, ZIP64, multi-disques, signatures incohérentes, taille ou CRC menteurs, données avant l'archive |
| `ARCHIVE_TROP_D_ENTREES` | plus de 100 entrées (`PROJETS_VOIRIE_ARCHIVE_ENTREES_MAX`) |
| `ARCHIVE_CHEMIN_DANGEREUX` | `..`, chemin absolu, lettre de lecteur, antislash, octet NUL ou caractère de contrôle |
| `ARCHIVE_NOMS_AMBIGUS` | deux entrées de même nom (casse ignorée) |
| `ARCHIVE_LIEN_SYMBOLIQUE`, `ARCHIVE_ENTREE_SPECIALE` | lien symbolique, périphérique, tube |
| `ARCHIVE_CHIFFREE` | entrée chiffrée |
| `ARCHIVE_METHODE_NON_SUPPORTEE` | autre chose que stocké (0) et deflate (8) |
| `ARCHIVE_IMBRIQUEE` | entrée `.zip`, `.kmz`, `.gz`, `.tar`, `.7z`, `.rar`, `.jar`... ou entrée lue qui commence par une signature d'archive |
| `ARCHIVE_TROP_GROSSE` | taille décompressée déclarée de plus de 25 Mo pour une entrée ou 100 Mo au total (`PROJETS_VOIRIE_ARCHIVE_TAILLE_DECOMPRESSEE_MAX`), ou octets réellement décompressés au-delà du déclaré |
| `ARCHIVE_TAUX_COMPRESSION` | rapport déclaré supérieur à 100 (`PROJETS_VOIRIE_ARCHIVE_TAUX_MAX`) pour une entrée de plus de 1 Mo |
| `ARCHIVE_CHEVAUCHEMENT` | entrées dont les données se recouvrent (bombe par recouvrement) |
| `ARCHIVE_TROP_PROFONDE` | plus de 8 niveaux de dossiers |
| `KMZ_SANS_KML` | aucune entrée `.kml` (archive de documents, de Shapefile : un ZIP contenant `.shp`, `.gpkg` ou `.dxf` répond 415 `FORMAT_NON_SUPPORTE`, chaîne GDAL) |
| `KMZ_PLUSIEURS_KML` | plusieurs `.kml`, aucun `doc.kml` à la racine, et pas d'`entreeKml` : l'inventaire liste les entrées |
| `ENTREE_KML_INTROUVABLE` | `entreeKml` ne désigne aucune entrée `.kml` |

L'**inventaire** d'un KMZ liste (200 entrées au plus) `{ nom, tailleOctets, type: "kml" | "image" | "autre" | "dossier" }`, le `kmlPrincipal` retenu et les `entreesKml`. Les entrées non KML (icônes, images) ne sont jamais décompressées.

## 7. Couches, aperçu, mapping, validation

### 7.1 Inventaire (`POST /:id/import/inventaire`)

Réponse 200 :

```
{
  "fichier": { "nom", "tailleOctets", "sha256" },
  "format": "KML"|"KMZ"|"GEOJSON"|"GPX"|"CSV",
  "detection": { "methode": "contenu", "extensionDeclaree": "kmz"|null, "extensionCoherente": true },
  "archive": { "nbEntrees", "tailleDecompresseeOctets", "kmlPrincipal", "entreesKml": [..], "entrees": [ { nom, tailleOctets, type } ] } | null,
  "couches": [ { "id": "c0", "nom": "Fibre / Principal", "nbObjets", "parTypeGeom": { LIGNE, POINT, POLYGONE } } ],   // CSV : liste vide, une seule table (voir `csv`) ; GeoJSON : une couche c0 ; KMZ à plusieurs KML sans choix : liste vide
  "csv": { "delimiteur", "delimiteurDetecte", "encodage", "encodageDetecte", "bom",
           "separateurDecimal": "."|","|null, "separateurDecimalDetecte", "nbLignes",
           "colonnes": [ { "nom", "exemples": [3 valeurs au plus] } ], "echantillon": [ 5 lignes au plus ] } | null,
  "crs": { "normeDuFormat": "EPSG:4326"|null, "declareDansLeFichier": "EPSG:32629"|null, "choixObligatoire": true|false },
  "champsDisponibles": [ noms d'attributs ou de colonnes proposés au mapping ],
  "avertissements": [ ]
}
```

Les coordonnées ne sont **pas** contrôlées par l'inventaire (un fichier hors Guinée s'inventorie) ; les comptes de couches sont ceux du fichier, avant tout filtrage.

### 7.2 Aperçu (`POST /:id/import/apercu`)

Réponse 200 :

```
{
  "fichier": { nom, tailleOctets, sha256 }, "format", "couche": { id, nom } | null,
  "resume": { "nbObjets", "parTypeGeom", "longueurTotaleM", "bbox", "attributsDetectes", "crs": { ... 5.2 ... }, "import": { ... 7.4 ... } },
  "statistiques": { "nbObjets", "parTypeGeom", "longueurTotaleM", "doublonsInternes", "sommets", "geometriesAReparer", "geometriesVides" },
  "validationGeometrique": { "nbProblemes", "problemes": [ { "ordre", "nom", "typeGeom", "code", "message" } ], "tronque": false,
                             "elementsEcartes": [ { "element", "nom", "code", "message" } ] },
  "echantillon": { "taille", "total", "objets": [ { "ordre", "nom", "typeGeom", "geometrie": { GeoJSON WGS 84 }, "simplifiee": false, "attributs": { } } ] },
  "mapping": { "applique": { }, "propositionsJeu": { "<champ>": { "valeur", "colonne" } }, "avertissements": [ ] },
  "avertissements": [ { "code", "message", "nb?" } ]
}
```

- **Échantillon** : 20 objets au plus (`PROJETS_VOIRIE_APERCU_ECHANTILLON`, 1 à 100), choisis de façon déterministe : d'abord les objets à problème (au plus la moitié), puis des objets régulièrement espacés dans le fichier. Une géométrie de plus de 500 sommets est décimée (`simplifiee: true`). Jamais tout le fichier.
- `validationGeometrique.elementsEcartes` : les éléments du fichier **écartés avant la base**, 50 au plus (le nombre exact est dans les avertissements `ELEMENTS_HORS_GUINEE` et `GEOMETRIES_INVALIDES_IGNOREES`) : `element` = numéro de l'élément dans le fichier (1 = premier Placemark, Feature, point de passage ou ligne reconstruite d'un CSV), `code` = `COORDONNEES_HORS_ZONE` (hors de la Guinée ou hors de la plage des degrés) ou `GEOMETRIE_INVALIDE` (ligne de moins de deux points, anneau dégénéré, coordonnée illisible), message fixe sans coordonnée. Les lignes d'un CSV rejetées avant toute géométrie sont dans `resume.import.rejets`.
- `validationGeometrique.problemes` : 50 au plus. Codes : `GEOMETRIE_VIDE`, `AUTO_INTERSECTION`, `TROP_PEU_DE_POINTS`, `ANNEAU_INVALIDE`, `GEOMETRIE_INVALIDE`. Les valeurs de coordonnées de la base ne sont pas recopiées dans les messages.
- Une géométrie invalide au sens PostGIS est **réparée** au dépôt (comme aujourd'hui, `ST_MakeValid`) : l'aperçu la compte dans `geometriesAReparer`.
- L'aperçu fait au plus 2 exécutions simultanées par processus (503 `SERVICE_OCCUPE`), coupe la base au bout de 30 s (504 `APERCU_TROP_LONG`, `PROJETS_VOIRIE_DELAI_APERCU_MS`), et ne persiste rien.

### 7.3 Mapping de champs

`mapping` = `{ champCible: colonneSource }`. Champs cibles (liste blanche) renvoyés par `GET /:id/import/options` :

| Champ cible | Portée | Effet |
|---|---|---|
| `nom` | objet | nom de l'objet pris dans la colonne (sinon le nom du fichier) |
| `identifiant` | objet | clé stable pour détecter les objets **modifiés** entre deux versions (section 8) ; stockée dans le mapping du jeu, la valeur reste dans `attributs` |
| `typeReseau`, `concessionnaire`, `classePrecision`, `precisionHorizontaleM`, `precisionVerticaleM`, `methode`, `dateDonnees`, `dateConstat`, `natureObjets` | jeu | valeur **unique** de la colonne proposée comme valeur du jeu ; appliquée au dépôt seulement si le champ du formulaire correspondant est absent ; plusieurs valeurs distinctes : avertissement `MAPPING_VALEURS_MULTIPLES`, rien n'est appliqué (un jeu = un concessionnaire, un type de réseau : scinder le fichier) ; valeur inconnue (type de réseau, classe, nombre, date) : `MAPPING_VALEUR_INCONNUE`, rien n'est appliqué ; `concessionnaire` : retrouvé par son nom (casse ignorée), **jamais créé** |

Validation : un champ cible hors liste : 400 `MAPPING_INVALIDE` ; une colonne source absente du fichier (ou de la couche) : 422 `MAPPING_COLONNE_INTROUVABLE`. Aucune précision ni classe n'est jamais inventée : elles ne viennent que d'un mapping demandé ou du formulaire.

### 7.4 `resume.import` (aperçu, simulation, dépôt, fiche du jeu)

```
"import": {
  "couche": { "id", "nom" } | null, "entreeKml": "doc.kml" | null,
  "csv": { "delimiteur", "encodage", "separateurDecimal", "mode": "points"|"lignes"|"wkt", "colonnes": { x, y, wkt, cle, ordre }, "nbLignes", "nbLignesRejetees" } | null,
  "mapping": { "nom"?: "...", "identifiant"?: "...", ... },
  "champsDepuisMapping": { "typeReseau": { "valeur", "colonne" } },
  "rejets": [ { "ligne", "code", "message" } ], "rejetsTronques": false,
  "conservationOriginal": "EMPREINTE_SEULE" | "STOCKE"
}
```

## 8. Delta de versions et suppressions

`delta` (réponse de dépôt, `resume.delta`, route delta) : `{ ajoutes, modifies, retires, identiques }`.

- `identiques` : même empreinte (géométrie normalisée + nom).
- `modifies` : même **clé** dans l'ancienne et la nouvelle version, empreinte différente. Clé = colonne `identifiant` du mapping si elle existe dans les deux versions, sinon le nom. Une clé présente plusieurs fois d'un côté est **ambiguë** (`clesAmbigues`) : ses objets restent comptés en ajoutés et retirés.
- `ajoutes` : objets de la nouvelle version sans équivalent. `retires` : objets de l'ancienne version sans équivalent dans la nouvelle (**suppressions**). Les chiffres satisfont `ajoutes + modifies + identiques = nbObjets nouveau` et `retires + modifies + identiques = nbObjets ancien`.
- Changement par rapport à `CONTRAT.md` section 3 : `modifies` est nouveau ; `ajoutes` et `retires` n'incluent plus les objets modifiés quand une clé les rapproche.

**Statut des suppressions** (statut à part du statut du jeu) : `AUCUNE` (première version, ou aucun objet retiré), `A_REVOIR` (objets retirés, aucune revue), `ACCEPTEES`, `REFUSEES`. Il est dans la réponse du dépôt (`suppressions: { statut, nb }`) et de `GET .../delta`.

`POST /:id/jeux/:jeuId/revue-suppressions` : corps `{ "decision": "ACCEPTER" | "REFUSER", "justification": "10 caractères au moins" }`. Le jeu doit être `CONTROLE` ou `RECU` et avoir des objets retirés (409 `STATUT_INCOMPATIBLE`, 409 `AUCUNE_SUPPRESSION`). Une nouvelle revue remplace la précédente (la dernière fait foi ; toutes sont conservées et auditées). Réponse : `{ jeu, suppressions, evenement }`. La revue est liée à l'empreinte exacte de l'ensemble retiré.

**Garde de l'autorisation** : `POST .../autoriser` d'un jeu qui remplace un jeu autorisé et dont des objets sont retirés répond **409 `SUPPRESSIONS_A_REVOIR`** (avec `jeuId`, `nb`) sans revue, **409 `SUPPRESSIONS_REFUSEES`** si la dernière revue est un refus (le jeu ne peut plus qu'être rejeté ou retiré, ou remplacé par un fichier corrigé après rejet). `rejeter` n'est jamais bloqué. Aucun objet n'est jamais conservé « par défaut » d'une version à l'autre : accepter les suppressions, c'est accepter que la nouvelle version remplace l'ancienne telle quelle ; l'ancienne (et ses objets) reste en base, statut `REMPLACE`.

`GET /:id/jeux/:jeuId/delta` (ADMIN, GESTIONNAIRE ; jeu `RETIRE` : 404) :

```
{ "jeu": { id, version, statut, role },
  "comparaison": { "jeuId", "version", "statut" } | null,
  "delta": { ajoutes, modifies, retires, identiques } | null,
  "cleComparaison": "identifiant" | "nom" | null, "clesAmbigues": 0,
  "echantillons": { "ajoutes": [ { objetId, nom } ], "modifies": [ { cle, nomAvant, nomApres } ], "retires": [ { objetId, nom } ] },   // 20 au plus chacun, aucune géométrie
  "suppressions": { "statut", "nb", "revue": { "par": { id, nomComplet }, "le", "decision", "justification" } | null },
  "retourArriere": { "possible": true|false, "raison": "..."|null, "restaureraJeuId", "restaureraVersion" } | null,   // jeu AUTORISE seulement
  "evenements": [ { "id", "type", "par", "le", "justification", "details" } ] }
```

## 9. Retour arrière d'une version

`POST /:id/jeux/:jeuId/retour-arriere` : corps `{ "justification": "10 caractères au moins" }`. `jeuId` est le jeu **actuellement `AUTORISE`** ; la version restaurée est celle qu'il avait remplacée (`remplaceId`).

Conditions (409) : le jeu n'est pas `AUTORISE` (`STATUT_INCOMPATIBLE`) ; il ne remplaçait aucun jeu (`AUCUNE_VERSION_PRECEDENTE`) ; la version précédente n'est plus `REMPLACE`, par exemple retirée (`VERSION_PRECEDENTE_INDISPONIBLE`) ; un dépôt de même clé attend son autorisation (`DEPOT_EN_ATTENTE`, avec `jeuId`).

Effet, dans une transaction verrouillant le projet : la version précédente repasse `AUTORISE` (ses données de décision d'origine sont conservées), le jeu actuel passe `REMPLACE`. **Aucune perte** : ni jeu, ni objet, ni décision n'est supprimé ; les jeux et leurs objets restent en base. Deux lignes d'audit (`RESTORE` sur le jeu restauré, `UPDATE` sur le jeu retiré du service) et une ligne `projets_voirie_import_evenements` (type `RETOUR_ARRIERE`, acteur, justification). Réponse : `{ jeuRestaure, jeuRetire, evenement }`. Les analyses persistées existantes restent des instantanés immuables ; il faut relancer une analyse.

## 10. Conservation du fichier d'origine (décision de rétention non prise)

`PROJETS_VOIRIE_CONSERVER_ORIGINAL` : `non` (défaut, **comportement du socle** : seuls `sha256` et `tailleOctets` sont conservés) ou `oui` (le fichier est aussi enregistré dans `projets_voirie_fichiers_origine`, dans la transaction du dépôt, jamais en simulation). `resume.import.conservationOriginal` dit ce qui s'est passé (`EMPREINTE_SEULE` ou `STOCKE`). Aucune route ne relit ni ne renvoie le fichier d'origine (ce serait un export de géométrie). Décision à prendre par le DSI : conserver ou non, durée, voie de purge (la table refuse la suppression physique comme les autres tables du module).

## 11. Réponses et erreurs de dépôt (ajouts à `CONTRAT.md` 4.2)

Réponse de dépôt et de simulation : `{ simulation, jeu, resume, avertissements, delta, remplace, suppressions, validationGeometrique }` où `delta` suit la section 8, `suppressions` est `{ statut, nb }` ou `null` (première version), et `validationGeometrique` suit la section 7.2 (géométries réparées par la base, bornées à 50).

Codes ajoutés, par statut (les codes existants de `API.md` sont inchangés) :

| Statut | Codes |
|---|---|
| 400 | `MAPPING_INVALIDE`, `CHAMPS_INVALIDES` (options incohérentes : `colonneWkt` avec `colonneX`, `epsgSource` non entier, `sha256Attendu` malformé...) |
| 404 | `JEU_INTROUVABLE` (delta, revue, retour arrière) |
| 400 (suite) | `CONCESSIONNAIRE_REQUIS` : un jeu `RESEAU_TIERS` sans `concessionnaireId` dont le mapping ne désigne aucun concessionnaire connu (avertissement `CONCESSIONNAIRE_INCONNU` : un concessionnaire n'est jamais créé par un import) |
| 409 | `EMPREINTE_DIVERGENTE`, `CONFIRMATION_HORS_ZONE_REQUISE`, `SUPPRESSIONS_A_REVOIR`, `SUPPRESSIONS_REFUSEES`, `AUCUNE_SUPPRESSION`, `AUCUNE_VERSION_PRECEDENTE`, `VERSION_PRECEDENTE_INDISPONIBLE`, `DEPOT_EN_ATTENTE` (retour arrière), `STATUT_INCOMPATIBLE` |
| 415 | `FORMAT_NON_SUPPORTE` : GeoPackage, Shapefile (y compris en ZIP), DXF, DWG, texte non reconnu |
| 422 | `ARCHIVE_*`, `KMZ_SANS_KML`, `KMZ_PLUSIEURS_KML`, `ENTREE_KML_INTROUVABLE` (section 6) ; `CRS_*`, `TRANSFORMATION_ECHEC` (5.4) ; `ENCODAGE_AMBIGU`, `DELIMITEUR_AMBIGU`, `SEPARATEUR_DECIMAL_AMBIGU`, `CSV_STRUCTURE_INVALIDE`, `CSV_TROP_DE_LIGNES` (plus de 500 000), `CSV_TROP_DE_COLONNES` (plus de 200), `CSV_CELLULE_TROP_LONGUE` (plus de 10 000 caractères), `CSV_COLONNES_REQUISES` (pas de colonnes de coordonnées désignées), `CSV_COLONNE_INTROUVABLE`, `COUCHE_INTROUVABLE`, `MAPPING_COLONNE_INTROUVABLE`, `GPX_INVALIDE` |
| 504 | `APERCU_TROP_LONG` |

## 12. Réglages serveur ajoutés

Toute valeur absente, illisible ou hors bornes redonne le défaut (même règle que `config.ts`).

| Variable | Défaut | Bornes |
|---|---|---|
| `PROJETS_VOIRIE_CRS_SOURCE_AUTORISES` | `4326,32628,32629` | liste d'entiers positifs, 20 au plus |
| `PROJETS_VOIRIE_CONSERVER_ORIGINAL` | `non` | `non` ou `oui` |
| `PROJETS_VOIRIE_ARCHIVE_ENTREES_MAX` | 100 | 1 à 1 000 |
| `PROJETS_VOIRIE_ARCHIVE_TAILLE_DECOMPRESSEE_MAX` | 104 857 600 (100 Mo) | 1 Mo à 1 Go |
| `PROJETS_VOIRIE_ARCHIVE_TAUX_MAX` | 100 | 2 à 1 000 |
| `PROJETS_VOIRIE_CSV_LIGNES_MAX` | 500 000 | 100 à 5 000 000 |
| `PROJETS_VOIRIE_APERCU_ECHANTILLON` | 20 | 1 à 100 |
| `PROJETS_VOIRIE_DELAI_APERCU_MS` | 30 000 | 1 000 à 300 000 |

Valeurs de départ à valider par le DSI : aucune n'est un seuil métier validé (ce sont des bornes de protection).

## 13. Traitement hors du processus de l'API (décision)

Constat : le dépôt ne contient aucune file de jobs ni worker réutilisable (`backend/src/jobs/` : deux planificateurs `setInterval`). La chaîne GDAL a son propre contrat de spool fichier (`CHAINE-GDAL.md`), non branché. **Ce lot ne construit pas de système asynchrone** : les formats ouverts sont traités de façon synchrone sous plafonds stricts (25 Mo, 50 000 objets, 2 000 000 de sommets, 500 000 lignes CSV, 100 entrées de KMZ), derrière les limiteurs et les délais côté base du socle (`PROJETS_VOIRIE_DELAI_*`) ; l'aperçu a son propre budget. Les budgets de temps du socle ne sont pas contournés.

Contrat futur d'un job asynchrone (pour les gros fichiers GDAL, non implémenté) : table `projets_voirie_import_jobs` (`id`, `projetId`, `creeParId`, `statut` `EN_ATTENTE`, `EN_COURS`, `TERMINE`, `ECHEC`, `ANNULE`, `EXPIRE`, `etape`, `progression` 0 à 100, `codeErreur`, `tentatives`, `tentativesMax` = 3, `reclameLe`, `finLe`, `expireLe`, `parametres` JSON identique aux options de la section 3) ; réclamation atomique (`UPDATE ... WHERE statut = 'EN_ATTENTE' ... SKIP LOCKED`), relance bornée d'un job `EN_COURS` dont la réclamation a expiré, annulation par `ADMIN` ou `GESTIONNAIRE`, nettoyage par `expireLe` (fichiers temporaires 72 h, alignement `GEOCONV_RETENTION_H`), interrogation par `GET /:id/import/jobs/:jobId`. Le résultat d'un job est l'entrée de l'étape 2 du wizard.
