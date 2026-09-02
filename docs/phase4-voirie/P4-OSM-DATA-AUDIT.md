# P4-01 — Audit des couches SIG OSM

**Date** : 2 septembre 2026
**Source** : `A_OSM_RESEAU_ROUTIER`, quatre couches shapefile fournies par AGEROUTE
**Méthode** : lecture directe des formats SHP et DBF, en flux, sans GDAL ni pyshp (absents du poste). Script reproductible : `scripts/osm-audit/audit_osm.py`. **Lecture seule** — aucune écriture en base, production non touchée.
**Résultats bruts** : `donnees/osm_inventory.csv`, `osm_categories.csv`, `osm_champs.csv`

---

## 0. Deux corrections au cadrage, avant tout le reste

Le cadrage de la mission énonce deux faits que la mesure contredit. Ils changent la
stratégie, donc ils viennent en premier.

### `ROUTE.dbf` n'est pas manquant

> *« Le fichier DBF associé à `ROUTE.shp` semble manquer dans les fichiers actuellement disponibles. »*

**FAIT MESURÉ** : `ROUTE.dbf` est présent, **315 450 370 octets**, et porte
**15 champs** pour les 262 656 objets. La couche est donc pleinement attribuée.

De même, `SURFACE_ROUTE.shp` est présent (524 octets, 3 polygones). Aucun fichier
en `(1)` n'existe sur le disque.

### `CHEMIN` n'est pas « beaucoup plus exploitable » — c'est l'inverse

> *« CHEMIN.shp est beaucoup plus exploitable : 171 570 objets »*

**FAIT MESURÉ** : les **171 570 géométries de `CHEMIN` sur 171 570 se retrouvent à
l'identique dans `ROUTE`** — **100 %**. Test par empreinte des coordonnées arrondies
au millionième de degré (≈ 0,1 m), sur la totalité des objets, pas sur un échantillon.

Et l'attribution est plus pauvre :

| | `ROUTE` | `CHEMIN` |
|---|---:|---:|
| Objets | 262 656 | 171 570 |
| Champs | **15** | **4** |
| Valeurs de `NATURE` | 21 | 4 |

`CHEMIN` est donc un **sous-ensemble strict** de `ROUTE`, ré-étiqueté :

| `CHEMIN` | Objets | `ROUTE` — même géométrie | Objets |
|---|---:|---|---:|
| Sentier | 102 100 | Chemin non carrossable | 102 100 |
| Chemin | 69 425 | Chemin carrossable | 69 425 |
| Escalier | 40 | Escaliers | 40 |
| Piste cyclable | 5 | Voie cyclable | 5 |

**Conséquence pour la suite : tout doit être bâti sur `ROUTE`.** Utiliser `CHEMIN`
perdrait onze champs et 91 086 objets. Additionner les deux couches compterait
171 570 objets deux fois — 87 788 km en double.

---

## 1. Inventaire des quatre couches

| Couche | Géométrie | Objets | Champs | km | Date DBF |
|---|---|---:|---:|---:|---|
| `ROUTE` | PolyLine | **262 656** | 15 | **179 980** | 2023-03-08 |
| `CHEMIN` | PolyLine | 171 570 | 4 | 87 788 | 2023-03-08 |
| `SURFACE_ROUTE` | Polygon | 3 | 4 | — | 2023-03-08 |
| `TOPONYME_COMMUNICATION` | Point | 30 | 5 | — | 2023-03-08 |

**Système de coordonnées** : les quatre `.prj` déclarent `GCS_WGS_1984`. Aucun code
EPSG n'est écrit dans le fichier ; **EPSG:4326 est déduit du datum** — c'est une
inférence, sûre mais à noter. C'est le même système que la BDRI : aucune
reprojection ne serait nécessaire.

**Encodage** : les quatre `.cpg` déclarent UTF-8, et la lecture le confirme.

**Emprise de `ROUTE`** : longitude −15,0671 à −7,6266, latitude 7,1723 à 12,7425 —
la totalité du territoire guinéen.

### Qualité géométrique de `ROUTE`

| Contrôle | Résultat |
|---|---:|
| Géométries nulles | **0** |
| Objets à moins de 2 points | **0** |
| Objets multipart | **0** |
| Doublons de géométrie (au sein de `ROUTE`) | **0** |

La couche est propre. C'est un point solide.

---

## 2. Les attributs de `ROUTE`, et le piège du remplissage

**Le vide n'est pas une chaîne vide dans ce jeu : c'est la valeur `NC`.** Un
comptage naïf annonce 100 % de remplissage sur les quinze champs. Les taux
ci-dessous excluent `NC` explicitement.

| Champ | Renseignés | Taux réel | Valeurs distinctes |
|---|---:|---:|---:|
| `ID` | 262 656 | 100 % | > 2 000 |
| `NATURE` | 262 656 | 100 % | **21** |
| `SOURCE` | 262 656 | 100 % | **1** (`OpenStreetMap`) |
| `DATE_MAJ` | 262 656 | 100 % | > 2 000 |
| `CL_ADMIN` | 262 656 | 100 % | **1** (`Autre`) |
| `FRANCHISST` | 3 178 | 1,2 % | 3 |
| `NUMERO` | **1 453** | **0,6 %** | 60 |
| `NOM` | **1 046** | **0,4 %** | 610 |
| `SENS` | 909 | 0,3 % | 2 |
| `NB_VOIES` | 714 | 0,3 % | 4 |
| `LARGEUR` | 489 | 0,2 % | 19 |
| `VIT_MAX` | 225 | 0,1 % | 11 |
| `HAUT_MAX` | 17 | 0,0 % | 2 |
| `GESTION` | **0** | **0 %** | 0 |
| `POID_MAX` | **0** | **0 %** | 0 |

### Ce que cela interdit

**`CL_ADMIN` vaut `Autre` sur les 262 656 objets.** Une seule valeur distincte.
Cette couche **ne porte aucune classification administrative** — ni région, ni
préfecture, ni commune, ni quartier. C'est le champ qui aurait permis de rattacher
directement la voirie à un découpage : il est inutilisable.

**`GESTION` est entièrement vide.** Aucun gestionnaire déclaré.

Seuls trois champs portent une information réellement exploitable sur l'ensemble :
`NATURE`, `SOURCE`, `DATE_MAJ`. Tout le reste est marginal — le mieux renseigné
après eux, `FRANCHISST`, couvre 1,2 %.

---

## 3. `NATURE` : les 21 valeurs, et ce qu'elles pèsent

**DONNÉE SOURCE** — reproduite telle quelle, sans regroupement.

| Nature | Objets | km | Densité |
|---|---:|---:|---:|
| Route non classifiée | 41 083 | 58 248 | 27,0 pts/km |
| Chemin carrossable | 69 425 | 44 619 | 39,8 |
| Chemin non carrossable | 102 100 | 43 166 | 40,3 |
| Route tertiaire | 2 951 | 12 660 | 16,5 |
| Route résidentielle | 34 929 | 10 189 | 30,3 |
| Voie rapide | 1 007 | 3 287 | 13,4 |
| Route secondaire | 847 | 3 024 | 17,4 |
| Route primaire | 589 | 2 519 | 16,8 |
| Route d'accès | 5 806 | 1 182 | 33,8 |
| Voie piétonne | 3 672 | 1 015 | 48,9 |
| Inconnu | 34 | 29 | 25,6 |
| Route en construction | 7 | 9 | 16,1 |
| Chemin équestre | 14 | 9 | 30,9 |
| Rue piétonne | 27 | 8 | 44,3 |
| Bretelle voie rapide | 65 | 6 | 61,3 |
| Zone de rencontre | 32 | 6 | 32,8 |
| Voie cyclable | 5 | 1 | 45,2 |
| Escaliers | 40 | 1 | 112,1 |
| Bretelle route tertiaire | 11 | 1 | 57,2 |
| Bretelle route primaire | 7 | 1 | 56,5 |
| Bretelle route secondaire | 5 | 0 | 90,0 |
| **Total** | **262 656** | **179 980** | |

---

## 4. Correspondance avec la hiérarchie demandée

Le cadrage demande quatre niveaux. Voici ce que les données permettent, et ce
qu'elles ne permettent pas.

**INFÉRENCE** — ce regroupement est une proposition de lecture des valeurs de
`NATURE`. Il n'existe pas dans les données : aucun champ ne le porte.

| Niveau demandé | Natures OSM correspondantes | Objets | km |
|---|---|---:|---:|
| **1–2. Réseau institutionnel** *(déjà BDRI)* | Voie rapide, primaire, secondaire, tertiaire, bretelles | 5 482 | **21 498** |
| **3. Voirie locale** | Route non classifiée, résidentielle, d'accès, zone de rencontre, en construction | **81 857** | **69 634** |
| **4. Chemins / pistes** | Chemin carrossable et non carrossable, voie et rue piétonnes, escaliers, chemin équestre, voie cyclable | **175 283** | **88 819** |
| Non classable | Inconnu | 34 | 29 |
| **Total** | | **262 656** | **179 980** |

### Ce que la hiérarchie demandée ne peut PAS recevoir des données

Le cadrage détaille le niveau 3 en « voie principale / voie secondaire /
résidentielle / desserte / autre voie » et le niveau 4 en « chemin / piste /
sentier / accès ».

**`NATURE` ne distingue pas « piste » de « sentier ».** OSM range les deux sous
`Chemin carrossable` (69 425) et `Chemin non carrossable` (102 100), qui décrivent
la praticabilité, pas la nature. La couche `CHEMIN` les nomme « Chemin » et
« Sentier », mais applique ces noms **aux mêmes géométries** — c'est un
ré-étiquetage, pas une information supplémentaire.

De même, « voie principale » et « desserte » n'ont aucun équivalent : `Route non
classifiée` regroupe 41 083 objets sans autre qualification.

**DÉCISION HUMAINE REQUISE** : soit la hiérarchie cible s'aligne sur les 21 valeurs
réellement disponibles, soit une source complémentaire apporte la granularité
demandée. Reconstruire ces sous-catégories par déduction reviendrait à inventer une
classification que la donnée ne porte pas — ce que le cadrage interdit lui-même.

---

## 5. Les deux couches accessoires

**`SURFACE_ROUTE`** — 3 polygones, tous de nature `Place`, autour de Conakry–Kindia.
Négligeable.

**`TOPONYME_COMMUNICATION`** — 30 points, et ce ne sont pas des toponymes de lieux :

| Nature | Points |
|---|---:|
| Pont | 16 |
| Parking | 7 |
| Tunnel | 6 |
| Échangeur | 1 |

24 noms distincts pour 30 points : il y a des doublons (« Pont Kenien », « Pont de
Kaka », « Yesafe » apparaissent deux fois). Ce sont des **ouvrages nommés**, utiles
au module Ouvrages, sans rapport avec un référentiel de quartiers.

---

## 6. Ce que cet audit établit pour la suite

| Question | Réponse |
|---|---|
| Quelle couche exploiter ? | **`ROUTE` seule.** `CHEMIN` en est un sous-ensemble à 100 %, moins attribué. |
| Reprojection nécessaire ? | Non — WGS 84 des deux côtés. |
| Qualité géométrique ? | **Aucun défaut** sur `ROUTE` : 0 nulle, 0 dégénérée, 0 multipart, 0 doublon. |
| Rattachement administratif possible depuis OSM ? | **Non.** `CL_ADMIN` vaut `Autre` partout. |
| Noms de voies disponibles ? | **1 046 sur 262 656** (0,4 %). |
| Niveau quartier atteignable ? | **Pas depuis ces fichiers.** Il faudra une intersection avec des polygones administratifs, qui n'existent pas ici. |
| Volume à afficher | 262 656 objets, 179 980 km. Un rendu GeoJSON intégral est exclu. |

---

## 7. Reproduire

```bash
python scripts/osm-audit/audit_osm.py \
  "<répertoire A_OSM_RESEAU_ROUTIER>" \
  docs/phase4-voirie/donnees
```

Le script relit les en-têtes SHP et DBF, parcourt les enregistrements en flux,
calcule les longueurs par haversine et compare les géométries des couches par
empreinte. Il n'écrit que les trois CSV de synthèse.
