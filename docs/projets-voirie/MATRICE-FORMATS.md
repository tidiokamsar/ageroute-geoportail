# Matrice des formats de la chaîne GDAL isolée

Document du 28/10/2026. Image : `ageroute-geoconv:0.1.0`, dérivée de `ghcr.io/osgeo/gdal:ubuntu-small-3.13.3` (GDAL 3.13.3 « Iowa City », 2026/08/13 ; PROJ 9.8.1 ; Ubuntu 26.04 ; Python 3.14.4).

Règle : « **supporté** » n'est écrit que pour ce qui a un test réel dans `infra/geoconv/tests/` (banc exécuté le 28/10/2026 : 71 jobs conformes). Tous les jeux de test sont synthétiques, fabriqués avec GDAL et Python : **aucun fichier produit par AutoCAD, Covadis, ArcGIS ou QGIS n'a été testé**. Un « supporté » ci-dessous signifie « lu et converti correctement sur des fichiers fabriqués par GDAL », pas « validé sur les fichiers des fournisseurs ».

## 1. Formats d'entrée

| Format | Pilote GDAL (activé dans l'image) | État | Ce qui a été testé | Limites connues |
|---|---|---|---|---|
| GeoPackage | `GPKG` (rw+uvs) | **supporté, testé** | v01 : 2 couches géométriques (lignes en EPSG:32629, points en 4326) + table sans géométrie ignorée avec avertissement ; v14 : 4326 sans reprojection ; v06/v07 : conflit et surcharge de CRS ; v08/v09 : sélection de couche ; m20 : noms de couches hostiles, déclencheurs, `-sql` refusé ; m21 : vue récursive infinie arrêtée au délai ; m22/m23 : compte d'objets menteur ; m24/m25 : géométries aberrantes ; m26/m29 : 1 et 3 millions de sommets ; g01, g04, g05 : 60 000 objets, sortie trop grosse, 20 000 lignes | non testés : MultiPolygon, géométries 3D et courbes, `.gpkg.zip`, GeoPackage avec tuiles raster (seules les couches vectorielles sont listées), CRS personnalisé sans code EPSG. Un GeoPackage de plus de 50 Mo est refusé (plafond réglable) |
| Shapefile en archive ZIP | `ESRI Shapefile` (rw+uv) | **supporté, testé** | v02 : ZIP avec sous-dossier, `.prj` EPSG:32629 reprojeté et vérifié au sommet près (écart < 2e-6 degré) ; v04/v05 : sans `.prj`, brut puis avec `epsg_source` ; i01 à i05 : sans `.shx`, sans `.dbf`, sans `.shp`, en-tête invalide ; i03 : sans `.prj` accepté avec `CRS_ABSENT` ; m01 à m19 : archives malveillantes ; m19 : nom commençant par `-` renommé ; g02 : 60 000 points | non testés : plusieurs Shapefiles dans une même archive, `.cpg` et encodages non UTF-8, `.shz` et `.shp.zip` natifs GDAL (la détection part du ZIP et cherche des `.shp`), Shapefile avec M ou Z, polygones. Un `.shp` seul (hors archive) n'est pas accepté |
| DXF texte (ASCII) | `DXF` (rw+v) | **supporté, testé sur fichiers synthétiques** | v03 : LINE et POINT écrits par GDAL, `$INSUNITS = 6` relevé et rapporté comme « métriques, ne vaut pas CRS » ; v11 : reprojeté seulement avec `epsg_source` explicite ; v10 : EPSG inconnu refusé ; v13 : DXF nommé `.gpkg` accepté avec `EXTENSION_INCOHERENTE` ; i10, i11 : DXF vide et sans entité ; m27 : bombe de blocs imbriqués arrêtée au délai ; m28 : ligne de 20 Mo refusée ; g03 : 120 000 lignes refusées | **aucun CRS n'est jamais déduit** : `crs: null`, `CRS_ABSENT`. Non testés : POLYLINE, LWPOLYLINE, ARC, CIRCLE, TEXT, HATCH, INSERT utiles, encodage `$DWGCODEPAGE`, DXF réels de Covadis/AutoCAD. Les entités sont exposées dans une couche `entities` avec le calque en attribut |
| DXF binaire | `DXF` (lecture binaire depuis GDAL 3.12) | **supporté, testé sur un fichier minimal** | v15 : 3 lignes, fabriqué octet par octet (GDAL ne sait pas écrire du DXF binaire) ; coordonnées brutes exactes | `$INSUNITS` n'est pas lu pour le binaire : avertissement `UNITES_ABSENTES`. Aucun DXF binaire réel testé |
| DWG | `CAD` (lecture seule) présent dans l'image de base, **retiré** de l'image de travail | non pris en charge, non testé | rien | reste à décider (section 3 du rapport) |
| KML / KMZ, GPX, CSV, GML, GeoJSON en entrée, SQLite/Spatialite, FlatGeobuf, OpenFileGDB, MapInfo | pilotes présents dans l'image de base, **retirés** de l'image de travail (liste blanche) | non pris en charge, non testé | testé uniquement que ces pilotes sont inutilisables (contrôle d'isolement : KML, GPX, CSV, SQLite, WFS, VRT, HTTP) | KML et GeoJSON restent lus par le backend actuel (CONTRAT.md 4.1). `LIBKML` n'existe pas dans cette image |

## 2. Format de sortie

| Format | Pilote | État | Test |
|---|---|---|---|
| GeoJSON (`RFC7946=NO`, une Feature par ligne, sans nom de couche ni bbox) | `GeoJSON` (rw+uv) | **supporté, testé** | écrit et relu par le banc dans les 18 jobs convertis du banc (53 autres sont refusés avec un code) ; précision de 9 décimales en degrés quand il y a reprojection |

`RFC7946=NO` est volontaire : avec `RFC7946=YES`, GDAL impose WGS84 et réécrit les coordonnées, ce qui masquerait le cas « CRS inconnu, coordonnées brutes ». Quand le CRS est inconnu, aucun membre `crs` n'est écrit dans le GeoJSON ; quand la sortie est en WGS84, GDAL écrit `urn:ogc:def:crs:OGC:1.3:CRS84`.

## 3. Pilotes actifs dans le conteneur, mesurés

Mesure faite par le worker au démarrage et par le test d'isolement (`ogrinfo --formats` brut) : exactement quatre pilotes enregistrés, `DXF`, `ESRI Shapefile`, `GPKG`, `GeoJSON`. L'image de base en enregistre 74 (vecteur et raster).

Options de restriction vérifiées :

| Option | Résultat sur GDAL 3.13.3 |
|---|---|
| `GDAL_SKIP` (liste de noms séparés par des virgules) | **fonctionne**, retire les pilotes raster et vecteur ; documentée par GDAL. Le worker calcule le complément de la liste blanche au démarrage et vérifie que le registre résultant est exactement la liste blanche |
| `OGR_SKIP` | fonctionne pour les pilotes vecteur, mais émet des avertissements pour les noms qu'il ne connaît pas : non utilisée |
| `GDAL_ENABLED_DRIVERS`, `OGR_ENABLED_DRIVERS`, `GDAL_DISABLE_DRIVERS` | **sans effet** dans cette version (essai : le nombre de pilotes listés reste 74) et absents de la page des options de configuration : **non utilisées** |
| `-if <pilote>` (ogrinfo, ogr2ogr, GDAL 3.2+) | utilisé à chaque ouverture, et le pilote réellement ouvert est comparé au pilote attendu |
| `GDAL_DRIVER_PATH=disable` | utilisé : aucun plugin n'est chargé |
| `PROJ_NETWORK=OFF`, `CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.none`, `GDAL_HTTP_MAX_RETRY=0` | posés ; l'isolement réseau réel est fait par `network_mode: none` |
| `SHAPE_RESTORE_SHX=NO` | posé (une archive sans `.shx` est refusée avant GDAL) |
| `OGR_SQLITE_LOAD_EXTENSIONS` | non posée (désactivée par défaut) |
| `DXF_FEATURE_LIMIT_PER_BLOCK` | non modifiée (défaut 10000 selon la documentation) ; la bombe de blocs est arrêtée par le délai |
