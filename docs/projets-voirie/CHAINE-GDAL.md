# Chaîne de conversion GDAL isolée (GeoPackage, Shapefile ZIP, DXF)

Statut : lot RC-1 bis, préparation. Document du 28/10/2026. Code : `infra/geoconv/`. **Rien de ce lot n'est branché au déploiement** : ni `docker-compose.yml`, ni `infra/deployer-console.sh`, ni le `Dockerfile` ou la configuration nginx du backend ne sont modifiés. Le backend ne sait pas encore appeler cette chaîne : ce document fixe le contrat que l'autre agent implémentera.

## 1. Décisions d'architecture appliquées

- Un conteneur GDAL **isolé** convertit les fichiers d'ingénierie en GeoJSON WGS84. Il est non privilégié, sans réseau, sans secret, avec système de fichiers racine en lecture seule, limites de ressources, délai maximal et liste blanche de pilotes.
- Le worker n'a **jamais** accès à la base de production : ni réseau, ni identifiant, ni socket Docker. Il ne connaît que deux répertoires (le « spool »).
- Les contrôles de géométrie, de CRS, d'attributs, de doublons et l'aperçu cartographique restent au backend, avant toute autorisation. Le worker fournit une sortie propre, des mesures et des avertissements typés, pas un verdict.
- Un DXF n'a pas de georéférencement : le CRS n'est **jamais** déduit. Sortie `crs: null`, `reprojete: false`, avertissement `CRS_ABSENT`, tant que l'utilisateur n'a pas fourni un EPSG explicite.
- Un format n'est déclaré pris en charge qu'après vérification du pilote et test réel (voir `MATRICE-FORMATS.md`).

## 2. Architecture

```
backend (autre conteneur, non root ou root)             conteneur geoconv (réseau coupé, UID 10001)
  écrit entree/<jobId>/fichier.<ext>                      lit    /spool/entree  (lecture seule)
  puis entree/<jobId>/demande.json  (en dernier)  ----->  copie le fichier dans /tmp (tmpfs borné)
                                                          pré-contrôle ZIP, détecte le format PAR LE CONTENU
  lit sortie/<jobId>/statut.json                          ogrinfo / ogr2ogr (processus enfants bornés)
  puis resultat.json, inventaire.json,           <-----   écrit /spool/sortie/<jobId>/...  (statut.json en dernier)
  couches/<nom>.geojson
```

Langage du worker : **Python 3.14 (bibliothèque standard seule)**, déjà présent dans l'image GDAL officielle. Justification : `zipfile` et `struct` permettent de lire l'enregistrement de fin et le répertoire central d'un ZIP avant toute décompression, `resource` et `subprocess` donnent des limites POSIX et un arrêt par groupe de processus, et un script shell aurait demandé de l'interpolation et un shell dans l'image. Le worker n'importe **pas** les liaisons `osgeo` dans son propre processus (sauf un enfant minuscule qui relève la version de PROJ) : tout fichier hostile n'est lu que par des processus `ogrinfo` et `ogr2ogr` tués au délai, avec limites de mémoire, de CPU et de taille de fichier.

L'image est dérivée de `ghcr.io/osgeo/gdal:ubuntu-small-3.13.3`, épinglée par empreinte (`sha256:64250faf...c0b40`). Le Dockerfile ajoute l'utilisateur 10001, le code du worker (en lecture seule) et supprime les shells (`sh`, `bash`, `dash`), `apt`/`dpkg`, `su`/`login`, `perl`, `unzip` et les bits setuid. `/var/lib/dpkg/status` est conservé pour les scanneurs de vulnérabilités.

## 3. Modèle de menaces

| Menace | Parade | Test réel |
|---|---|---|
| Zip-slip (`../`, chemin absolu, `C:/`, antislash) | refus de l'archive entière avant extraction ; extraction uniquement vers des noms construits par le worker (basename, extensions blanches) | m01 à m04 |
| Lien symbolique, périphérique dans l'archive | refus (mode Unix lu dans l'attribut externe) | m05, m06 |
| Nom avec NUL ou caractère de contrôle | refus sur le nom d'origine (avant la troncature de `zipfile`) | m07, m08 |
| Bombe de décompression, taille mensongère, entrées qui se chevauchent | plafonds sur les tailles **déclarées** (avant), sur les octets **réellement décompressés** (pendant), taux, recouvrement des offsets | m10 à m13 |
| Centaines de milliers d'entrées | l'EOCD est lu seul : le nombre d'entrées est borné avant de lire le répertoire central | m16 (300 000 entrées refusées en 0,4 s) |
| Archive imbriquée, déguisée ou non | extension et octets de tête de **chaque** entrée | m14, m15 |
| Extension mensongère (HTML, PDF, exécutable) | détection par le contenu ; l'extension ne sert qu'à émettre un avertissement | i13 à i17, v13 |
| GeoPackage piégé : déclencheurs, vue récursive infinie, nombre d'objets menteur | ouverture `-ro` d'une **copie** dans `/tmp` ; délai dur et RLIMIT_CPU ; `-limit` impose le plafond réel quel que soit le compte déclaré ; `load_extension` n'est pas activé | m20 à m23 |
| Nom de couche ou valeur d'attribut pris pour une commande | arguments passés **en liste**, jamais de shell ; nom de couche commençant par `-` ou contenant un caractère de contrôle refusé ; fichier de sortie nommé par un slug ASCII calculé par le worker | m20 |
| Géométries aberrantes (NaN, 1e308, WKB tronqué, bowtie) | GDAL les lit ; le worker compte les nulls, les coordonnées hors plage, les avertissements GDAL ; échec propre si la reprojection échoue | m24, m25 |
| Géométrie de plusieurs millions de sommets | plafonds de mémoire (espace d'adressage par processus), de taille de sortie, de délai ; analyse en flux avec borne par ligne | m26, m29 |
| Bombe de blocs DXF, ligne géante | délai dur ; erreur GDAL sur ligne trop longue | m27, m28 |
| Sortie volumineuse | `RLIMIT_FSIZE` sur `ogr2ogr` + plafond total | g04 |
| Exfiltration réseau, résolution de noms, `/vsicurl/`, base distante | `network_mode: none`, pilotes réseau retirés, `PROJ_NETWORK=OFF` | `verifier_isolement.py` |
| Écriture hors zone, élévation de privilèges | racine en lecture seule, `cap_drop: ALL`, `no-new-privileges`, UID 10001, `/tmp` en `noexec` | `verifier_isolement.py` |
| Contexte hostile dans les messages | toute chaîne issue d'un fichier est nettoyée (contrôles retirés, longueur bornée) avant d'entrer dans un JSON ou un journal | m07, m08 |

## 4. Contrat des fichiers

Identifiant de job : `^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$` (un UUID convient). Le contrat porte `versionContrat: 1`.

### 4.1 Entrée (écrite par le backend)

```
entree/<jobId>/fichier.<ext>      un seul fichier, ext = 1 à 8 caractères alphanumériques (gpkg, zip, dxf)
entree/<jobId>/demande.json       écrit EN DERNIER, par écriture dans un fichier temporaire puis rename
```

Le worker ne traite un job que lorsque `demande.json` existe. Il ouvre le fichier sans suivre de lien et refuse tout ce qui n'est pas un fichier régulier.

`demande.json` (tous les champs sont facultatifs sauf `version` conseillé ; toute clé inconnue est refusée) :

```json
{
  "version": 1,
  "fichier": "fichier.gpkg",
  "couches": ["axes", "regards"],
  "epsg_source": 32629,
  "autoriser_surcharge_crs": false,
  "limites": { "objets_max": 20000, "delai_s": 60 }
}
```

- `couches` : liste des couches à convertir. Absent : toutes les couches **géométriques**. Une couche demandée mais absente fait échouer le job (`COUCHE_INTROUVABLE`).
- `epsg_source` : CRS explicite fourni par l'utilisateur. Utilisé seulement si le fichier n'en déclare pas. Si le fichier en déclare un **différent**, le job échoue (`CRS_CONFLIT`) sauf `autoriser_surcharge_crs: true` (avertissement `CRS_SURCHARGE`).
- `limites` : peut seulement **abaisser** les plafonds de l'opérateur (section 6). Une valeur supérieure fait échouer le job (`DEMANDE_INVALIDE`).

### 4.2 Sortie (écrite par le worker)

```
sortie/<jobId>/statut.json        en_cours -> termine | echec ; écrit en dernier à la fin
sortie/<jobId>/resultat.json      toujours écrit (aussi en cas d'échec)
sortie/<jobId>/inventaire.json    écrit dès que le fichier a pu être lu
sortie/<jobId>/couches/<slug>.geojson   FeatureCollection ; absent en cas d'échec (jamais de sortie partielle)
```

Le répertoire `sortie/<jobId>/` est créé de façon atomique : c'est la réclamation du job. Un job dont le répertoire de sortie existe n'est jamais retraité ; pour rejouer, le backend utilise un nouveau `jobId` ou supprime l'ancien répertoire.

`statut.json` : `{ jobId, statut: "en_cours"|"termine"|"echec", etape, code, message, debut, fin, versionWorker, versionContrat }`. Le backend ne lit les autres fichiers que si `statut` est `termine` ou `echec`.

`resultat.json` : `source { nom, octets, sha256 }`, `format { famille, pilote, detection: "contenu", extensionDeclaree, extensionCoherente }`, `couches[]`, `avertissements[]`, `limitesAppliquees`, `mesures { dureeMs, etapes[], picMemoireWorkerKo }`, `gdal { version, proj, pilotesActifs }`. Chaque entrée de `couches[]` :

| Champ | Sens |
|---|---|
| `nom`, `fichier` | nom d'origine (nettoyé) et chemin relatif du GeoJSON |
| `nbObjets`, `typesGeometrieReels`, `sommets`, `emprise` | comptes réellement lus dans la sortie ; l'emprise est dans le système de la sortie |
| `crs` | `{ epsg: 4326, nom }` si les coordonnées sont en WGS84, sinon **`null`** |
| `reprojete` | `true` seulement si une transformation a été appliquée |
| `crsSource` | `{ origine: "fichier"\|"demande", epsg, nom }` ou `null` si aucun CRS connu |
| `coordonnees` | `"wgs84"` ou `"brutes"` (coordonnées du fichier, sans transformation) |
| `avertissements` | codes propres à la couche |

`inventaire.json` : ce que le fichier contient, avant et après conversion : `source`, `format`, `archive` (entrées, tailles), `unites` (DXF : `$INSUNITS`, avec la mention que cela ne vaut pas CRS), et par couche : `nom`, `jeu` (nom du Shapefile), `geometrie`, `nbObjets` (compte **déclaré** par le fichier), `typeGeometrieDeclare`, `champs` (nom, type, largeur, précision), `emprise` (système d'origine), `crs` **tel que déclaré par le fichier** (`epsg`, `autorite`, `nom`, `type`, `unite`, `wkt`) ou `null`, `unites`, et après conversion `typesGeometrieReels`, `empriseSortie`, `sommets`. Racine : `avertissements`, `dureeMs`, `gdal { version, proj }`.

### 4.3 Codes d'échec (`statut.code`)

Entrée et demande : `ENTREE_ABSENTE`, `DEMANDE_INVALIDE`, `FICHIER_VIDE`, `FICHIER_TROP_GROS`, `FICHIER_TRONQUE`, `FICHIER_INVALIDE`, `FORMAT_NON_RECONNU`, `FORMAT_NON_AUTORISE`.
Archive : `ARCHIVE_INVALIDE`, `ARCHIVE_TROP_D_ENTREES`, `ARCHIVE_CHEMIN_DANGEREUX`, `ARCHIVE_NOMS_AMBIGUS`, `ARCHIVE_LIEN_SYMBOLIQUE`, `ARCHIVE_ENTREE_SPECIALE`, `ARCHIVE_CHIFFREE`, `ARCHIVE_METHODE_NON_SUPPORTEE`, `ARCHIVE_IMBRIQUEE`, `ARCHIVE_TROP_GROSSE`, `ARCHIVE_TAUX_COMPRESSION`, `ARCHIVE_CHEVAUCHEMENT`, `ARCHIVE_SANS_DONNEES`, `SHAPEFILE_INCOMPLET`, `SHAPEFILE_INVALIDE`.
Lecture et sélection : `SOURCE_ILLISIBLE`, `PILOTE_INATTENDU`, `TROP_DE_COUCHES`, `CHAMPS_TROP_NOMBREUX`, `AUCUNE_COUCHE`, `COUCHE_INTROUVABLE`, `COUCHE_AMBIGUE`.
CRS et conversion : `CRS_CONFLIT`, `CRS_NON_RECONNU`, `REPROJECTION_ECHEC`, `CONVERSION_ECHEC`, `TROP_D_OBJETS`, `AUCUN_OBJET`, `SORTIE_TROP_GROSSE`.
Ressources : `DELAI_DEPASSE`, `MEMOIRE_EPUISEE`, `GDAL_PLANTAGE`, `INTERROMPU`, `ERREUR_INTERNE`.
Au démarrage seulement (le worker refuse de démarrer, code de sortie 3) : `PILOTES_NON_CONFORMES`.

### 4.4 Avertissements typés `{ code, message, nb? }`

`EXTENSION_INCOHERENTE`, `ENTREES_ARCHIVE_IGNOREES`, `FICHIERS_ORPHELINS`, `NOM_FICHIER_RENOMME`, `UNITES_ABSENTES`, `COUCHE_SANS_GEOMETRIE_IGNOREE`, `COUCHE_SANS_GEOMETRIE`, `COUCHE_NOM_REFUSE`, `CRS_ABSENT`, `CRS_FOURNI_PAR_LA_DEMANDE`, `CRS_SURCHARGE`, `CRS_SANS_CODE_EPSG`, `COMPTE_DECLARE_DIVERGENT`, `COORDONNEES_NON_FINIES`, `COORDONNEES_HORS_PLAGE`, `GEOMETRIES_NULLES`, `AVERTISSEMENTS_GDAL`, `ANALYSE_GEOMETRIE_PARTIELLE`, `COUCHE_VIDE`.

Le backend doit traiter `crs: null` (avec `CRS_ABSENT`) comme « coordonnées brutes, CRS à fournir » : proposer à l'utilisateur de choisir un EPSG ou des points de contrôle, puis soumettre un **nouveau job** avec `epsg_source`. Aucun défaut n'est appliqué.

## 5. Règles de CRS

1. CRS déclaré par le fichier (GeoPackage, `.prj` de Shapefile) : transformation vers WGS84 (EPSG:4326, ordre longitude, latitude), `reprojete: true`, `crsSource.origine = "fichier"`. Si le fichier est déjà en EPSG:4326 : copie sans transformation, `reprojete: false`.
2. Aucun CRS dans le fichier, `epsg_source` fourni : transformation avec cet EPSG, `crsSource.origine = "demande"`. Un EPSG inconnu de PROJ échoue (`CRS_NON_RECONNU`).
3. Aucun CRS, aucun EPSG : coordonnées brutes, `crs: null`, `reprojete: false`, `CRS_ABSENT`.
4. CRS du fichier sans code EPSG (WKT personnalisé) : transformation avec sa définition, avertissement `CRS_SANS_CODE_EPSG`. **Non testé** (aucun jeu fabriqué).
5. La précision d'une transformation dépend des grilles PROJ présentes dans l'image (`PROJ_NETWORK=OFF`, aucune grille téléchargée). Le worker ne vérifie pas si PROJ a choisi une transformation approximative (« ballpark ») pour un datum local : à contrôler avec le service cartographique avant tout usage de précision.

## 6. Limites par défaut et réglage

Plafonds de l'opérateur, lus dans l'environnement du conteneur (fichier overlay) ; `demande.json` peut les abaisser par job.

| Variable d'environnement | Clé `limites` | Défaut | Effet |
|---|---|---|---|
| `GEOCONV_LIMITE_TAILLE_ENTREE` | `taille_entree_octets` | 50 Mo | taille du fichier déposé (le backend limite aujourd'hui à 25 Mo) |
| `GEOCONV_LIMITE_ENTREES_ARCHIVE` | `entrees_archive_max` | 200 | entrées d'un ZIP |
| `GEOCONV_LIMITE_TAILLE_DECOMPRESSEE` | `taille_decompressee_octets` | 250 Mo | total déclaré et réellement décompressé |
| `GEOCONV_LIMITE_TAUX_COMPRESSION` | `taux_compression_max` | 100 | rapport par entrée de plus de 1 Mo |
| `GEOCONV_LIMITE_OBJETS` | `objets_max` | 50 000 | objets par couche et au total (aligné sur CONTRAT.md 4.1) |
| `GEOCONV_LIMITE_COUCHES` | `couches_max` | 50 | couches d'un fichier |
| `GEOCONV_LIMITE_CHAMPS` | `champs_max` | 500 | champs par couche |
| `GEOCONV_LIMITE_SORTIE` | `sortie_octets_max` | 200 Mo | octets GeoJSON écrits, tous fichiers confondus |
| `GEOCONV_LIMITE_DELAI_S` | `delai_s` | 120 s | durée totale d'un job |
| `GEOCONV_MEMOIRE_ENFANT` | (opérateur seul) | 1 Go | espace d'adressage par processus GDAL (`RLIMIT_AS`) |
| `GEOCONV_RETENTION_H` | (opérateur seul) | 72 h | purge par le worker des répertoires `sortie/<jobId>/` anciens (0 : aucune purge) |

Limites du conteneur (overlay) : `mem_limit` 1 Go sans swap, 1 CPU, 64 processus, `/tmp` tmpfs 512 Mo, 512 descripteurs, fichier de 256 Mo au plus. Le tmpfs compte dans la mémoire du conteneur : un `/tmp` plein est de la mémoire consommée. Pour accepter de plus gros fichiers, augmenter ensemble `mem_limit`, la taille du tmpfs et `GEOCONV_MEMOIRE_ENFANT`, puis rejouer `infra/geoconv/tests/lancer-tests.sh`.

## 7. Branchement au backend

- Un volume nommé `geoconv_entree` (le backend en écriture, le worker en lecture seule) et un volume `geoconv_sortie` (le worker en écriture, le backend en lecture et purge). Le fichier overlay les déclare avec ces noms ; le fichier compose du backend les reprendra en `external: true`. **Le backend n'a pas besoin du socket Docker** et ne doit pas l'obtenir.
- Droits : le worker tourne en UID 10001 et écrit dans `sortie` (le répertoire racine du volume doit lui être inscriptible, propriétaire 10001). Il lit `entree` : les fichiers déposés doivent être lisibles par tous (umask 022, mode 0644, dossiers 0755). Un backend qui tourne en root (cas actuel, voir LOT-RC-00 section B) respecte ces conditions.
- Dépôt : écrire `fichier.<ext>`, puis `demande.json` par rename. Suivi : lire `statut.json` jusqu'à `termine` ou `echec`. Délai d'attente côté backend : `delai_s` + marge ; au-delà, considérer le job perdu et rejouer avec un nouveau `jobId`.
- Après consommation, le backend copie ce dont il a besoin dans sa propre base, puis supprime `entree/<jobId>/` et `sortie/<jobId>/`. Les fichiers GeoJSON du spool ne sont **pas** un stockage : ils sont purgés.
- Les GeoJSON de sortie contiennent des données sensibles de concessionnaires : le volume `geoconv_sortie` doit rester interne, sans exposition par nginx ni traefik.
- Conséquence sur CONTRAT.md : la détection de formats du backend (4.1, « archives, Shapefile, DXF, DWG, GPX : 415 `FORMAT_NON_SUPPORTE` ») restera valable tant que le backend n'appelle pas cette chaîne ; l'appel se fera dans un lot dédié, derrière la clé de module `projets-voirie`.

## 8. Activation en préproduction

Préconditions : décision de l'architecte sur l'hébergement de l'image (section 10), accord de la DSI sur un serveur de préproduction, jamais sur le serveur de production.

```bash
# Depuis un clone du dépôt, sur la machine de préproduction
docker compose -f infra/geoconv/docker-compose.geoconv.yml -p geoconv config -q     # valide le fichier
docker compose -f infra/geoconv/docker-compose.geoconv.yml -p geoconv up -d --build  # construit et démarre
docker inspect geoconv-worker --format '{{.State.Health.Status}}'                    # attendu : healthy
docker logs geoconv-worker | head -3                                                 # versions GDAL/PROJ, 4 pilotes
bash infra/geoconv/tests/lancer-tests.sh                                             # banc complet (volumes jetables)
```

Contrôles d'acceptation : image construite sans erreur ; `healthy` ; journal de démarrage listant exactement `DXF, ESRI Shapefile, GPKG, GeoJSON` ; `lancer-tests.sh` : « TOUS LES CONTROLES SONT CONFORMES » (71 jobs, 23 contrôles d'isolement, arrêt propre).

Les images ne sont jamais mises à jour implicitement : pour changer de version de GDAL, modifier l'argument `GDAL_IMAGE` du Dockerfile (tag **et** empreinte), reconstruire et rejouer le banc.

## 9. Retour arrière

```bash
docker compose -f infra/geoconv/docker-compose.geoconv.yml -p geoconv down          # arrête et supprime le conteneur
docker volume rm geoconv_entree geoconv_sortie                                       # supprime le spool (données temporaires)
docker image rm ageroute-geoconv:0.1.0                                               # facultatif
```

Aucune base, aucune migration, aucun fichier du déploiement existant n'est touché : le retour arrière est complet après ces trois commandes. Tant que le backend n'appelle pas la chaîne, l'arrêter n'a aucun effet sur la console.

## 10. Limites connues et décisions à prendre

Voir `docs/reports/LOT-RC-01B-GDAL-RAPPORT.md` (sections « Erreurs connues » et « Décisions à prendre »). Points structurants : l'image fait environ 600 Mo ; l'image de base charge `libtcmalloc` par `LD_PRELOAD` ; la lecture d'un DXF binaire ne relève pas `$INSUNITS` ; une géométrie de plus de 16 Mo de GeoJSON n'est comptée mais pas analysée (`ANALYSE_GEOMETRIE_PARTIELLE`) ; un seul worker est supposé (la réclamation par `mkdir` évite le double traitement, mais le contrôle des orphelins au démarrage suppose une seule instance).
