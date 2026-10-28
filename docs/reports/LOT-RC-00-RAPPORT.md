# Lot RC-0 : audit et preuve de CRS du module « Réseaux concessionnaires, axes, emprises et conflits »

Date : 28/10/2026. Référence : cahier des charges v2.0 du 28/10/2026 (roadmap, lot 0) et prompt maître V2. Branche de travail : `feat/projets-voirie` (issue de `integration/depuis-vendredi`, commit `b0f17ca`, déployé en production le 28/10/2026 avec 94 migrations appliquées). Aucun déploiement, aucune écriture en production dans ce lot : les mesures sur la base de production ont été faites en lecture seule.

Numérotation : « RC » désigne les lots de ce module, pour ne pas les confondre avec les lots 0 et 1 du mandat précédent (`LOT-00-RAPPORT.md`, `LOT-01-RAPPORT.md`).

## A. Ce qui a été fait

- Audit de l'environnement d'exécution et du code existant utile au module (section B).
- Inventaire des données du pilote Kissidougou et contrôles de cohérence (section C).
- **Preuve de CRS du plan d'axes** (section D).
- Plan de lots et décisions à prendre (sections F et G).
- Lancement du développement du socle (lots RC-1 et RC-2 partiels) par deux agents dans des copies de travail séparées : backend (`F:\ageroute-pv`, `feat/projets-voirie`) et interface (`F:\ageroute-pv-ui`, `feat/projets-voirie-ui`), sur un contrat commun `docs/projets-voirie/CONTRAT.md`.

## B. Audit de l'existant (constats vérifiés dans le dépôt et sur l'hôte)

| Sujet | Constat | Conséquence |
|---|---|---|
| Pile | React 18, Vite, Leaflet ; Express, Prisma 5.22 ; PostgreSQL 17 + PostGIS 3.5 | Aucun changement de pile nécessaire |
| Image du backend | `node:20-alpine`, exécutée **en root** (commentaire du `Dockerfile` : volume `bdri_uploads` appartenant à root) | Un analyseur de fichiers dans ce conteneur n'est pas isolé : l'import avancé doit passer par un processus séparé sans privilèges |
| GDAL, `ogr2ogr`, PROJ en ligne de commande | **Absents** de l'image backend et du poste de développement. Le conteneur PostGIS embarque `libgdal` (bibliothèque) mais pas `ogr2ogr` | Aucun format d'ingénierie ou GeoPackage via GDAL n'est disponible tant qu'un conteneur dédié n'est pas décidé (voir G) |
| Transformation de coordonnées | **PostGIS (PROJ intégrée) : `ST_Transform` vérifié** (UTM 29N vers WGS84 utilisé pour les contrôles de ce rapport) | Les changements de CRS se font en base, avec un SRID explicite |
| Import existant | Le module Lots d'import n'accepte que `csv` et `geojson` ; le GeoPackage est un écart consigné (`backend/src/import/pivot.noyau.ts`) ; tailles alignées sur nginx (25 Mo) | Réutiliser ses limites et son principe de simulation avant écriture |
| Géométrie existante | `Troncon.geom` : axe en `LineString` WGS84, sans largeur ni emprise ; `geo/utm.noyau.ts` et `geo/trace.import.noyau.ts` existent | Les limites de route n'existent pas dans le référentiel : à charger comme couche du projet |
| Modules et accès | clés de module (`requireModuleAccess`), rôles `ADMIN` / `GESTIONNAIRE` / `INSPECTEUR`, journal `audit_logs` | Le module réutilise ces mécanismes ; les rôles « référent concessionnaire », « terrain », « auditeur » du cahier sont un lot ultérieur |
| API publique | `/api/public/carte/geo` existe | Aucune donnée du module ne doit en dépendre |

## C. Inventaire des données du pilote

| Fichier reçu | Contenu vérifié | Traitement |
|---|---|---|
| `Plan_Axes_Kissidougou_A3.pdf` | 1 page, dessin vectoriel de 36 tracés (31 axes, l'axe 19 en 3 parties, l'axe 25-1, 2 tronçons de carrefour 7-8), tableau de longueurs et de coordonnées de début et de fin en « UTM zone 29N », mention « listing Covadis (tabulation) » | Extraction des polylignes du dessin vectoriel puis recalage sur le tableau : **pièce dérivée, à faire confirmer par la source CAO** (DXF, DWG, LandXML ou GeoPackage d'origine à demander à MC GROUPE) |
| `KISSIDOU.kml` et `kml.kml` | Identiques (16 lignes, 0 attribut différent, 0 écart de coordonnée) ; le deuxième ajoute une altitude à 0 et une extension Google Earth. Les lignes portent `REMOTE`, `CABLE`, `TUBE`, `CLIENT`, `BRINS`, `DISTANCE` : ce sont des **circuits clients**, pas des câbles distincts | À importer en quarantaine, `natureObjet` inconnue (le vocabulaire évoque de la fibre optique, l'opérateur l'a confirmé : Orange) |
| `carte-fibre-orange-kissidougou.html` | Aperçu local produit par l'assistant, non destiné à la diffusion | **Jamais importé ni exécuté** ; il n'est pas dans le dépôt |

Contrôle des longueurs du plan (tracé extrait contre tableau) : 30 axes sur 36 à 1 m ou moins ; 5 axes (06, 09, 10, 15, 23) à 1,4 à 3,3 m (0,1 à 0,5 %) ; **axe 28 : 135,2 m tracés contre 155,2 m au tableau, à signaler à MC GROUPE** (divergence signalée, non corrigée). Total : 20 164 m tracés contre 20 201 m au tableau. Les extrémités tracées tombent à 1,2 m au plus des coordonnées du tableau.

## D. Preuve de CRS du plan d'axes (cahier 22.2, point 1)

Le cahier interdit d'appliquer une transformation sur la seule foi du nom du fichier. Contrôle fait avec les coordonnées du tableau, transformées par PostGIS vers WGS84 :

| Hypothèse de CRS | Centre des axes (longitude, latitude) | Part des axes à moins de 10 m d'un tronçon de la base |
|---|---|---|
| EPSG:32629 (WGS84 / UTM zone 29N) | -10,0963 ; 9,1853 (Kissidougou) | **54,6 %** (distance médiane aux tronçons : 8,6 m) |
| EPSG:32628 (zone 28N, hypothèse contraire) | -16,0963 ; 9,1853 (hors du territoire, en mer) | 0 % |

Lecture : la zone 29N est la seule hypothèse compatible avec la position de Kissidougou et avec le réseau routier de la base (axes OpenStreetMap, précision de l'ordre de quelques mètres). **Ce que cette preuve ne démontre pas** : le datum (WGS84 contre un datum local type Adindan) et l'absence d'un décalage systématique de quelques mètres ; la distance médiane de 8,6 m mélange l'erreur du plan, celle d'OpenStreetMap et un éventuel écart de datum. **Statut : zone 29N « établie par recoupement », datum et précision « à confirmer par MC GROUPE ».** Le module ne marque pas le CRS comme confirmé tant que cette confirmation n'est pas enregistrée.

## E. Premiers résultats de superposition (indicatifs, hors dépôt)

Calculés dans la base PostGIS de développement, lecture seule, avec l'hypothèse de largeurs fournie par le DSI (emprise 15 m, chaussée 7 m, soit 7,5 m et 3,5 m de part et d'autre de l'axe) : tracé fusionné de la fibre 17 075 m (somme des 16 circuits : 24 567 m) ; 634 m dans la chaussée prévue et 759 m dans l'emprise prévue ; 9 croisements avec un axe ; 7 axes sur 36 touchés, dont l'axe 24 (508 m dans l'emprise, 6 circuits) et l'axe 25-1 (172 m, 4 croisements). **Ces chiffres sont des propositions à vérifier** : largeurs « théoriques », précision de la fibre inconnue, profondeur inconnue (conflit vertical non évalué), 16 circuits qui ne sont pas 16 câbles. Ils ne justifient aucun déplacement.

## F. Plan de lots (roadmap du cahier, section 24) et état

| Lot | Contenu | État au 28/10/2026 |
|---|---|---|
| RC-0 | Audit, matrice runtime, preuve de CRS | **Fait** (ce rapport) |
| RC-1 | Import fondamental : KML, GeoJSON ; quarantaine, simulation, statuts, CRS explicite, empreinte, idempotence, delta | **En développement** (backend et interface) |
| RC-1 bis | KMZ, Shapefile ZIP, CSV/TSV, GPX, GeoPackage ; CRS projeté choisi par l'utilisateur, mapping de champs, job asynchrone isolé | Non commencé : dépend de la décision G1 |
| RC-2 | Projet, axes, versions de plan, emprises, carte et analyse 2D indicative | **En développement** (socle) |
| RC-3 | Modèle physique / logique, règles de conflit versionnées, dossiers de conflit persistés | Non commencé |
| RC-4 | Workflow concessionnaire, terrain, récolement, rôles dédiés | Non commencé |
| RC-5 à RC-9 | DXF, LandXML, raster, services OGC, DWG, 3D, nationalisation, exploitation | Non commencés ; aucun format n'est déclaré « supporté » sans test réel |

## G. Décisions à prendre (aucune n'est prise par l'assistant)

1. **Conteneur de conversion GDAL.** Pour GeoPackage, Shapefile, DXF et formats d'ingénierie, créer un service dédié (image GDAL officielle, sans réseau, sans privilèges, système de fichiers en lecture seule) et accepter son poids en production, ou rester sur des bibliothèques JavaScript pour les formats de base. Recommandation : bibliothèques JavaScript pour KMZ, Shapefile, CSV, GPX au lot RC-1 bis ; conteneur dédié avant tout DXF ou GeoPackage.
2. **Source CAO du plan d'axes** (DXF, DWG, LandXML, GeoPackage) auprès de MC GROUPE, avec confirmation du CRS, du datum, de la longueur de l'axe 28 et des largeurs réelles d'emprise et de chaussée par axe.
3. **Seuils et tolérances** : approbation des largeurs et des tolérances par famille de réseau (aujourd'hui « théoriques »).
4. **Rôles** du cahier (référent concessionnaire, auditeur, agent terrain) : correspondance avec les rôles et clés de module existants.
5. **Politique de conservation** des fichiers originaux (le module conserve l'empreinte et les attributs, pas encore le fichier d'origine).

## H. Limites et non-vérifié

Rien de ce rapport n'a été exécuté en production. Le datum du plan n'est pas confirmé. La précision de position des données d'Orange est inconnue. Aucun parcours dans un navigateur réel n'est encore vérifié pour ce module (lots suivants).
