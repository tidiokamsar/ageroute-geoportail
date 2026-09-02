# P4-03 — Comparaison spatiale BDRI / OSM

**Date** : 2 septembre 2026
**Méthode** : PostGIS dans un conteneur **jetable**. La base de production n'a été lue qu'une fois, en `SELECT`, pour extraire les 1 690 tronçons. **Aucune écriture, production non modifiée.**
**Script** : `scripts/osm-comparison/comparer.sh`
**Résultats** : `donnees/bdri_couverture_osm.csv`, `bdri_only.csv`, `osm_synthese.csv`, `osm_candidats_reseau_classe.csv`

---

## 1. Méthode, et pourquoi celle-là

**Aucune comparaison textuelle.** Les noms manquent des deux côtés : 0,4 % côté
OSM, et les tronçons BDRI portent des codes (`RES-972`) plutôt que des noms de
lieux. Tout se joue en géométrie.

**Un tronçon n'est pas « retrouvé » ou « absent » en bloc.** On échantillonne un
point tous les 200 m le long de chaque tronçon BDRI — 104 955 points au total — et
on mesure la part de ces points proches d'une voie OSM classée. Une route à moitié
retrouvée doit se lire comme telle, pas basculer d'un côté.

**Trois seuils**, documentés : 25 m (superposition), 100 m (même corridor),
250 m (même axe).

**Réseau classé OSM** = voie rapide, principale, secondaire, tertiaire, et leurs
bretelles — 5 482 objets, 21 454 km.

---

## 2. Couverture du réseau BDRI par OSM

**FAIT MESURÉ.**

| Seuil | Classe | Tronçons | Part du linéaire couvert | Aucune correspondance |
|---|---|---:|---:|---:|
| **25 m** | RN | 621 | **92,6 %** | 12 |
| | RR | 1 029 | **2,4 %** | **582** |
| | RU | 40 | **97,7 %** | 1 |
| **100 m** | RN | 621 | 96,2 % | 10 |
| | RR | 1 029 | 8,6 % | 371 |
| | RU | 40 | 99,4 % | 0 |
| **250 m** | RN | 621 | **96,6 %** | 7 |
| | RR | 1 029 | **20,3 %** | **284** |
| | RU | 40 | — | 0 |

### Ce que cela dit

**Les nationales et les urbaines se superposent presque parfaitement.** 92,6 % du
linéaire RN et 97,7 % du linéaire RU sont à moins de **25 mètres** d'une voie OSM
classée. C'est une concordance de tracé, pas une coïncidence de longueur : deux
jeux constitués indépendamment décrivent les mêmes routes.

**Les régionales, non.** 2,4 % à 25 m, et seulement 20,3 % même en relâchant à
250 m. Élargir le seuil dix fois ne fait passer la couverture que de 2 à 20 % :
les 80 % restants ne sont pas des quasi-correspondances ratées, ce sont des tracés
qui n'existent pas dans le réseau classé d'OSM.

---

## 3. A — Tronçons BDRI sans correspondance OSM

**FAIT MESURÉ.** 291 tronçons n'ont **aucun** point d'échantillonnage à moins de
250 m d'une voie OSM classée.

| Classe | Famille de code | Tronçons |
|---|---|---:|
| RR | `RES-*` | **284** |
| RN | `GN N*` | 6 |
| RN | `*-OSM-*` | 1 |
| | **Total** | **291** |

**97,6 % de l'écart se concentre sur le lot `RES-*`.** C'est le même lot que la
Phase 5 avait identifié comme non expliqué : 1 028 tronçons entrés par un import
unique, sans longueur métier, à 2,1 points par kilomètre.

**INFÉRENCE** — trois lectures restent possibles, et cette mesure ne tranche pas
entre elles :

1. ces routes existent et OSM ne les a pas cartographiées (plausible en zone
   rurale peu contribuée) ;
2. elles sont dans OSM mais hors du réseau *classé* — rangées en « non
   classifiée » ou en « chemin » ;
3. leur tracé est approximatif au point de ne plus coïncider.

La deuxième hypothèse est testable et vaut d'être testée : elle changerait
complètement la lecture. Elle n'a pas été mesurée ici.

**DÉCISION HUMAINE REQUISE** : la nature du lot `RES-*` reste la question centrale,
ouverte depuis la Phase 5.

---

## 4. B — Voies OSM sans correspondance BDRI

**FAIT MESURÉ.** Pour chacune des 262 656 voies OSM, existence d'un tronçon BDRI à
moins de 25 m, puis de 250 m.

| Catégorie | Voies | km | Sans BDRI à 250 m | km concernés |
|---|---:|---:|---:|---:|
| Voie locale | 41 090 | 58 143 | 32 424 | 39 889 |
| Chemin | 69 425 | 44 532 | 59 367 | 36 573 |
| Sentier | 102 100 | 43 085 | 87 305 | 37 249 |
| **Tertiaire** | 2 962 | 12 636 | **1 507** | **3 977** |
| Résidentielle | 34 961 | 10 175 | 22 542 | 6 042 |
| **Voie rapide** | 1 072 | 3 286 | **5** | **23** |
| **Secondaire** | 852 | 3 018 | **236** | **622** |
| **Principale** | 596 | 2 514 | **104** | **264** |
| Accès | 5 806 | 1 180 | 3 958 | 706 |
| Piéton | 3 758 | 1 032 | 3 232 | 900 |
| Inconnu | 34 | 29 | 29 | 29 |

---

## 5. Le recalcul demandé — ce n'est pas 6 947 km

Le cadrage demande explicitement de ne pas reprendre le chiffre de 6 947 km et de
recalculer proprement.

**FAIT MESURÉ.** En restreignant au **réseau classé** — le seul périmètre où la
question « route manquante au référentiel » se pose sans ambiguïté :

| Catégorie | Voies sans BDRI à 250 m | km |
|---|---:|---:|
| Voie rapide | 5 | 23 |
| Principale | 104 | 264 |
| Secondaire | 236 | 622 |
| Tertiaire | 1 507 | 3 977 |
| **Total** | **1 852** | **4 886** |

**1 852 voies, 4 886 km** — et non 6 947.

Deux nuances qui comptent autant que le chiffre :

**Le réseau structurant est déjà là.** Sur 1 072 voies rapides OSM, **5** seulement
n'ont pas de tronçon BDRI à 250 m — soit **23 km sur 3 286**. Les principales :
104 voies, 264 km. Il ne manque quasiment rien du réseau stratégique.

**81 % de l'écart est tertiaire.** 3 977 des 4 886 km. Or « route tertiaire » au
sens OSM ne signifie pas « route régionale » au sens AGEROUTE — c'est une
classification fonctionnelle contributive, sans valeur institutionnelle.

**Ces 4 886 km sont des CANDIDATS À EXAMEN, pas des routes manquantes.** Les
appeler autrement referait exactement l'erreur que le cadrage met en garde.

Extrait des plus longs candidats du réseau classé
(`donnees/osm_candidats_reseau_classe.csv`, 1 852 lignes) :

| Catégorie | Numéro | km | ID OSM |
|---|---|---:|---|
| Principale | A7 | 66,8 | `w373881379` |
| Tertiaire | — | 58,7 | `w246571540` |
| Tertiaire | — | 46,3 | `w610051189` |
| Secondaire | — | 43,3 | `w270262211` |
| Tertiaire | — | 39,1 | `w238471898` |

---

## 6. C — Correspondances, et D — Conflits

**Correspondance** : 96,6 % du linéaire RN et 99,4 % du linéaire RU à 250 m. C'est
l'essentiel du réseau institutionnel.

**Conflits.** La comparaison de longueur et de désignation entre objets appariés
n'a **pas** été menée à ce stade, pour une raison de fond : l'appariement lui-même
n'est pas un-à-un. Un tronçon BDRI recouvre plusieurs voies OSM et réciproquement —
les découpages diffèrent. Déclarer un « conflit de longueur » entre objets dont on
n'a pas établi qu'ils se correspondent produirait du bruit.

Le seul conflit d'attribut mesurable aujourd'hui est le numérotage : **42
désignations RN côté BDRI sur 7 840 km, contre 60 désignations OSM sur 5 128 km**.
Les référentiels ne coïncident pas. Côté couverture, la BDRI est la meilleure
source.

**PROPOSITION** : traiter les conflits après un appariement explicite, tronçon par
tronçon, sur le sous-ensemble où la superposition dépasse un seuil.

---

## 7. Réponses aux questions du cadrage

| Question | Réponse |
|---|---|
| Routes officielles BDRI ? | 1 690 — 621 RN, 1 029 RR, 40 RU |
| Routes communautaires `RES` ? | 1 028, **de classe `RR`** — `RES` est un préfixe, pas une classe |
| Voies locales OSM ? | 76 051 (voie locale + résidentielle), 68 318 km |
| Voirie de quartier affichable ? | oui — 263 Ko gzippés pour Conakry entière |
| Données OSM exploitables ? | `ROUTE` seule. `NATURE`, `SOURCE`, `DATE_MAJ` à 100 % ; tout le reste sous 1,2 % |
| Routes BDRI absentes d'OSM ? | **291** à 250 m, dont **284 du lot `RES-*`** |
| Voies OSM absentes de BDRI ? | **1 852 du réseau classé (4 886 km)** ; 210 709 toutes catégories |
| Objets proposables à validation ? | les 1 852 du réseau classé, à examiner un par un |
| Architecture sans ralentir la carte ? | GeoJSON cadré, pas de tuiles vectorielles — voir `P4-MAP-VISUALIZATION.md` |
| Décisions institutionnelles ? | voir `P4-DECISIONS-REQUIRED.md` |

---

## 8. Limites de cette comparaison

**L'échantillonnage à 200 m** peut manquer un croisement bref. Sur des tronçons de
plusieurs kilomètres, l'effet est négligeable ; sur les plus courts, il grossit.

**Les catégories OSM sont une inférence**, pas une donnée : aucun champ ne porte ce
regroupement des 21 valeurs de `NATURE`.

**Le réseau classé OSM est un choix.** Exclure les 58 143 km de « voie locale » du
périmètre de comparaison est défendable — ce ne sont pas des routes au sens
AGEROUTE — mais c'est un choix, et il commande le résultat.

**L'hypothèse 2 du §3 n'est pas testée.** Les tronçons `RES-*` pourraient exister
dans OSM hors du réseau classé. Le vérifier changerait la lecture de l'écart le
plus important de cette analyse.
