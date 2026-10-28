# Lot RC-1 bis, préparation : chaîne de conversion GDAL isolée

Rapport du 28/10/2026. Branche `feat/geoconv-gdal` (base `5dbabf6`). Documents associés : `docs/projets-voirie/CHAINE-GDAL.md` (architecture, contrat, activation), `docs/projets-voirie/MATRICE-FORMATS.md` (formats et pilotes).

## A. Agents et déroulement

Un seul agent a construit et testé la chaîne. Incident de poste : pendant le travail, le volume externe `F:` a présenté des erreurs NTFS (événements 55, « Spot Fix Needed »), qui ont mis à zéro plusieurs fichiers en cours d'écriture et corrompu 10 objets git loose dans `F:\ageroute-geoportail\.git`. Sur instruction du coordinateur, le travail a été repris sur `C:` (`C:\ageroute-secours\w-gdal`) ; rien n'a été écrit sur `F:` après l'alerte, aucun `chkdsk` n'a été lancé, aucun fichier de production n'a été modifié. Les fichiers testés sont ceux de `C:` : le banc a été rejoué intégralement depuis `w-gdal` (résultats section E).

## B. Fichiers livrés (tous nouveaux, rien de modifié)

| Chemin | Rôle |
|---|---|
| `infra/geoconv/Dockerfile`, `reduire-image.py`, `.dockerignore`, `.gitattributes` | image dérivée de GDAL officiel, épinglée par empreinte ; utilisateur 10001 ; shells, apt/dpkg, perl, setuid retirés ; fins de ligne LF forcées |
| `infra/geoconv/worker/` (`geoconv_worker.py`, `travail.py`, `archive.py`, `detection.py`, `gdalio.py`, `processus.py`, `analyse.py`, `config.py`, `erreurs.py`) | worker Python (bibliothèque standard seule), environ 1 500 lignes |
| `infra/geoconv/docker-compose.geoconv.yml` | overlay de préproduction, non référencé par le déploiement |
| `infra/geoconv/tests/` (`lancer-tests.sh`, `fabriquer_jeux.py`, `verifier_resultats.py`, `verifier_isolement.py`) | banc d'essai : jeux synthétiques, vérification des sorties, isolement |
| `docs/projets-voirie/CHAINE-GDAL.md`, `MATRICE-FORMATS.md`, ce rapport | documentation |

Ni `docker-compose.yml`, ni `infra/deployer-console.sh`, ni `backend/Dockerfile`, ni nginx ne sont touchés. L'image locale à conserver : `ageroute-geoconv:0.1.0`.

## C. Audit de capacité (preuve)

- Image de base choisie : `ghcr.io/osgeo/gdal:ubuntu-small-3.13.3`, tag **vérifié existant** sur le registre (liste des tags interrogée : les derniers tags publiés sont `*-3.13.3`), empreinte `sha256:64250faf833c06d4b21afce4c27190039ba7ab58d70f0eebc87cf77d929c0b40`, taille locale 601 Mo. `ogrinfo --version` : `GDAL 3.13.3 "Iowa City", released 2026/08/13`. PROJ 9.8.1 (via `osr.GetPROJVersion*`). Python 3.14.4, liaisons `osgeo` présentes, SQLite 3.46.1 (module Python). Ubuntu 26.04.
- Ce que le variant `small` contient : 74 pilotes (vecteur et raster) dont `GPKG` (rw+uvs), `ESRI Shapefile`, `DXF`, `GeoJSON`, `KML`, `GPX`, `CSV`, `GML`, `SQLite`, `OpenFileGDB`, `CAD` (DWG en lecture seule). `LIBKML` est **absent**.
- Choix de `small` plutôt que `full` : moins de pilotes, donc moins de surface ; les quatre pilotes nécessaires y sont. Alternative non évaluée : variantes Alpine (`alpine-small-3.13.3`), potentiellement plus légères mais avec une libc différente.
- Options de restriction : voir la section 3 de `MATRICE-FORMATS.md`. En résumé, `GDAL_SKIP` fonctionne ; `GDAL_ENABLED_DRIVERS`, `OGR_ENABLED_DRIVERS` et `GDAL_DISABLE_DRIVERS` n'ont aucun effet sur cette version (vérifié) et ne sont pas documentées. La liste blanche est donc obtenue par le complément calculé au démarrage et vérifiée.
- Image finale : 596 Mo (`docker images`). Pas de réduction notable par rapport à la base : le poids vient de GDAL, de Python et de leurs bibliothèques.

## D. Formats effectivement testés

Voir `MATRICE-FORMATS.md`. Résumé : GeoPackage, Shapefile ZIP, DXF texte et DXF binaire sont lus et convertis en GeoJSON sur des fichiers **synthétiques**. KML, GPX, CSV, GML, SQLite, DWG et les autres ne sont pas pris en charge (pilotes retirés). Aucun fichier réel de fournisseur n'a été testé.

## E. Preuves : résultats réels du banc (`infra/geoconv/tests/lancer-tests.sh`)

Dernier passage complet, depuis `C:\ageroute-secours\w-gdal`, après les dernières corrections du code (sortie : « TOUS LES CONTROLES SONT CONFORMES ») :

| Contrôle | Résultat |
|---|---|
| Jobs traités par le worker durci | 71 sur 71 conformes à l'attendu (18 convertis, 53 refusés avec le code attendu) ; code de sortie du worker 0 ; `OOMKilled` faux |
| Autotest des pilotes | actifs : `DXF`, `ESRI Shapefile`, `GPKG`, `GeoJSON` |
| Isolement vérifié depuis le conteneur | 23 contrôles sur 23 conformes (liste en `verifier_isolement.py`) |
| Arrêt propre | `docker stop` : 1 s, code 0 ; job interrompu marqué `echec/INTERROMPU`, aucune sortie partielle ; un statut `en_cours` laissé par un arrêt brutal est transformé en `echec/INTERROMPU` au redémarrage |
| Overlay compose | `docker compose config -q` valide ; `up -d` : état `healthy` ; paramètres effectifs relevés par `docker inspect` : réseau `none`, racine en lecture seule, utilisateur 10001:10001, `cap_drop ALL`, `no-new-privileges`, 1 Go, 1 CPU, 64 processus, `init`, redémarrage `on-failure:5` |
| Exactitude géométrique | premier sommet de v01, v02, v05, v11 (reprojetés) et v14 comparé à une transformation indépendante calculée à la fabrication (tolérance 2e-6 degré) ; v03, v04, v15 : coordonnées brutes exactes, `crs: null` |

Cas anormaux et malveillants (tous échouent proprement avec le code attendu, sans sortie partielle) : zip-slip, chemin absolu, lecteur Windows, antislash, lien symbolique, périphérique, NUL et caractères de contrôle dans un nom, archive chiffrée, bombe de décompression (taux), bombe à petite échelle (total abaissé), taille déclarée mensongère, entrées qui se chevauchent, archives imbriquées (par nom et déguisée), 300 000 entrées, noms dupliqués, méthode bzip2. Noms de couches hostiles (`-sql`, `x"; DROP TABLE ok;--`, `$(touch pwned)`, `../../../tmp/evil`, saut de ligne et ESC) : `-sql` (tiret initial, que GDAL pourrait lire comme une option) et le nom à saut de ligne sont refusés avec `COUCHE_NOM_REFUSE`, les trois autres sont convertis comme des données ; aucun fichier hors de `couches/` n'apparaît.

## F. Sécurité : ce qui est prouvé et ce qui ne l'est pas

Prouvé par exécution : tout ce qui figure en section E et dans la table de menaces de `CHAINE-GDAL.md`.

Non prouvé, à ne pas considérer comme acquis :

- Aucun test d'évasion de conteneur (noyau, runc) : l'isolement dépend de Docker et du noyau de l'hôte. Pas de profil seccomp ou AppArmor dédié ; c'est le profil par défaut de Docker qui s'applique.
- Aucun scan de vulnérabilités de l'image (Trivy, Grype ou équivalent n'ont pas été exécutés). L'image de base est celle d'OSGeo ; ses CVE ne sont pas évaluées ici.
- Pas de test de GDAL sur des fichiers réellement hostiles issus de fuzzing : les fichiers « anormaux » sont fabriqués à la main et couvrent des classes d'attaque, pas l'espace des entrées.
- La séparation de privilèges entre le backend et le worker passe par des droits de fichiers sur deux volumes ; elle n'a pas été testée avec le vrai backend.
- La précision des reprojections n'a été vérifiée que pour EPSG:32629 vers WGS84 (transformation sans datum local).

## G. Performances mesurées

Poste de test : Docker Desktop (WSL2), 8 CPU, 8 Go, conteneur limité à 1 CPU et 1 Go. Mesures de `resultat.json` (`dureeMs` du job ; pic = `ru_maxrss` du processus GDAL le plus gourmand, via `wait4`) lors du dernier passage ; les durées varient d'un passage à l'autre d'un facteur pouvant atteindre 2 (poste partagé), les ordres de grandeur sont stables.

| Cas | Issue | Durée | Pic mémoire du plus gros processus GDAL |
|---|---|---|---|
| v01 GeoPackage, 25 objets, reprojection | terminé | 0,5 s | 57 Mo |
| v02 Shapefile ZIP, 10 lignes | terminé | 0,5 s | 52 Mo |
| g05 GeoPackage, 20 000 lignes UTM reprojetées | terminé | 1,4 s | 62 Mo |
| g01 GeoPackage 60 000 points (plafond 50 000) | `TROP_D_OBJETS` | 1,2 à 3,5 s | 62 Mo |
| g02 Shapefile 60 000 points | `TROP_D_OBJETS` | 1,1 à 2,2 s | 62 Mo |
| g03 DXF 120 000 lignes | `TROP_D_OBJETS` | 2,7 à 5,6 s | 62 Mo |
| g04 20 000 objets de 1 Ko avec plafond de sortie abaissé à 2 Mo | `SORTIE_TROP_GROSSE` | 3 à 6,5 s | 146 Mo |
| m26 une ligne de 1 million de sommets | terminé (analyse partielle signalée) | 7,8 à 11,7 s | 560 Mo |
| m29 une ligne de 3 millions de sommets | `MEMOIRE_EPUISEE` (SIGABRT sur allocation refusée) | 21 à 39 s | 937 Mo |
| m21 vue SQLite récursive infinie, délai abaissé à 6 s | `DELAI_DEPASSE` | 5 s | 32 Mo |
| m27 bombe de blocs DXF, délai abaissé à 20 s | `DELAI_DEPASSE` | 19 s | 62 Mo |
| m10 bombe de décompression | `ARCHIVE_TAUX_COMPRESSION` | 5 ms | 29 Mo (worker seul) |
| m16 archive de 300 000 entrées | `ARCHIVE_TROP_D_ENTREES` | 0,2 à 0,7 s | 32 Mo (worker seul) |

Mémoire du conteneur entier (`docker stats`, échantillon de 1 s) : pic 557 Mio sans le cas des 3 millions de sommets, **1 001 Mio avec lui**, soit la limite de 1 Go. Le cas m29 a été arrêté par le plafond d'espace d'adressage (1 Go par processus GDAL) et non par le tueur de mémoire du noyau (`OOMKilled` faux), mais la marge est nulle : il faut traiter 1 Go comme la limite pratique actuelle du conteneur, ou relever `mem_limit` et le tmpfs avant d'accepter des géométries plus lourdes. Le processus Python du worker reste autour de 60 Mo.

## H. Erreurs et défauts connus

1. Une feature dont le GeoJSON dépasse 16 Mo (environ 500 000 sommets) est comptée mais non analysée : `sommets` et `emprise` manquent et `ANALYSE_GEOMETRIE_PARTIELLE` est émis (cas m26).
2. GDAL transforme silencieusement des géométries illisibles ou non finies (NaN, WKB tronqué) en géométries nulles ; le worker le détecte par `GEOMETRIES_NULLES` et `AVERTISSEMENTS_GDAL`, mais l'avertissement `COORDONNEES_NON_FINIES` n'a donc jamais été observé et n'est pas couvert par un test. Des coordonnées de l'ordre de 1e308 passent sans transformation (signalées par `COORDONNEES_HORS_PLAGE` en WGS84) ; en UTM elles font échouer la reprojection de toute la couche (`REPROJECTION_ECHEC`, cas m25) : une seule mauvaise feature fait échouer le job. Choix voulu (pas de `-skipfailures` silencieux), à confirmer.
3. `$INSUNITS` n'est lu que pour les DXF texte ; le DXF binaire donne `UNITES_ABSENTES`.
4. L'image de base charge `libtcmalloc` via `LD_PRELOAD` ; il est conservé et cohabite avec `RLIMIT_AS` (le cas m29 se termine proprement), mais l'interaction n'a pas été étudiée plus loin.
5. Le plafond de 1 Go d'espace d'adressage est atteint avec 3 millions de sommets dans une seule ligne ; les géométries de ce type sont rejetées avec `MEMOIRE_EPUISEE`.
6. Un ZIP qui contient des Shapefiles ET d'autres couches utiles (DXF, GeoPackage) n'est lu que pour ses Shapefiles ; le reste est ignoré avec `ENTREES_ARCHIVE_IGNOREES`.
7. Non testés : `CRS_SANS_CODE_EPSG`, `CHAMPS_TROP_NOMBREUX`, `TROP_DE_COUCHES`, `COUCHE_AMBIGUE`, `FICHIERS_ORPHELINS`, `GDAL_PLANTAGE`, `ERREUR_INTERNE`, `FICHIER_INVALIDE`, `PILOTE_INATTENDU`, ZIP64, la purge de rétention, le comportement avec deux instances du worker, la reprise du health check après plantage.
8. Le test d'arrêt propre fait un SIGTERM sur un job en cours ; un `SIGKILL` du conteneur (OOM du noyau sur le conteneur entier) n'a pas été simulé, seule la reprise des orphelins est testée par un statut préparé à la main.

## I. Risques

- Image de 600 Mo à héberger et à tenir à jour : une CVE dans GDAL, PROJ ou SQLite se corrige en changeant le tag et l'empreinte de base, en reconstruisant et en rejouant le banc.
- Les fichiers de concessionnaires transitent par un volume de spool et un conteneur : le volume `geoconv_sortie` contient des tracés d'infrastructure sensibles (CONTRAT.md, règle 5) ; il doit rester interne et être purgé.
- Fiabilité du disque de développement `F:` : voir section A. À traiter par la DSI avant toute reprise.
- Le contrat est « gelé » à la version 1 sans consommateur réel : le backend pourra demander des champs manquants.

## J. Décisions à prendre

1. **Hébergement de l'image et mise à jour** : registre interne ou construction sur le serveur de préproduction ? Cadence de mise à jour de GDAL (tag et empreinte) ?
2. **Plafonds de production** : 50 000 objets, 50 Mo, 1 Go de mémoire sont des valeurs de départ alignées sur CONTRAT.md, pas des besoins mesurés sur des fichiers réels de concessionnaires. À réviser dès réception d'échantillons.
3. **DWG** : le pilote `CAD` (lecture seule) existe dans l'image de base mais est retiré. Souhaite-t-on un DWG, ou exiger un DXF ? Le parseur DWG de GDAL est un code natif complexe : le conserver élargit la surface d'attaque.
4. **Politique d'échec par feature** : refuser le job entier si une géométrie est aberrante (comportement actuel) ou convertir le reste et rapporter les rejets (demande `-skipfailures`, avec comptage obligatoire).
5. **Où se fait la contrainte `epsg_source` obligatoire** : le backend doit-il refuser d'autoriser un jeu `crs: null` tant que l'utilisateur n'a pas choisi un EPSG ? Recommandation : oui, dans la quarantaine.
6. **Profil seccomp dédié et scan de vulnérabilités** dans la chaîne d'intégration continue avant la préproduction.
7. **Branchement du backend** (lot suivant) : appel par volumes comme décrit, ou file de tâches ; ce rapport suppose les volumes.
8. **Décision sur la réparation du volume `F:`** (hors périmètre de ce lot).
