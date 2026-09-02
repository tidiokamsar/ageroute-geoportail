# P4-06 — Décisions requises avant implémentation

**Date** : 2 septembre 2026
**Objet** : ce qui ne peut pas être tranché par la mesure, et attend AGEROUTE.

Chaque point porte son statut : **FAIT MESURÉ**, **DONNÉE SOURCE**, **INFÉRENCE**,
**PROPOSITION** ou **DÉCISION HUMAINE REQUISE**.

---

## D1 — `RES` est-elle une classe institutionnelle ?

**FAIT MESURÉ.** Le cadrage place `RES` au rang de RN et RR dans la hiérarchie
cible. Le modèle ne le porte pas ainsi : `ClasseRoute` a quatre valeurs — `RN`,
`RR`, `RU`, `PISTE` (inutilisée). **`RES` est un préfixe de `code`**, et les
**1 028 tronçons `RES-*` sont tous de classe `RR`**.

| Famille de code | Classe réelle | Tronçons |
|---|---|---:|
| `GN N*` | RN | 551 |
| `*-OSM-*` | RN | 70 |
| `RES-*` | **RR** | **1 028** |
| autre | RU / RR | 41 |

**DÉCISION HUMAINE REQUISE.** En faire une classe suppose de modifier l'enum et de
reclasser 1 028 objets. C'est une décision de nomenclature institutionnelle.

Elle est d'autant moins neutre que la Phase 5 a laissé ouverte la question de ce
que recouvre réellement ce lot : les `RES-*` ne recouvrent le réseau classé OSM
qu'à hauteur de quelques pourcents, et leur périmètre n'est pas établi. Leur donner
un rang institutionnel avant d'avoir répondu à cette question figerait une
nomenclature sur un contenu inconnu.

---

## D2 — La granularité de la hiérarchie cible

**FAIT MESURÉ.** Le cadrage détaille :

- niveau 3 : voie principale, voie secondaire, résidentielle, desserte, autre voie
- niveau 4 : chemin, piste, sentier, accès

`NATURE` ne porte pas ces distinctions. OSM range la praticabilité, pas la nature :
`Chemin carrossable` (69 425) et `Chemin non carrossable` (102 100). « Piste » et
« sentier » n'y existent pas. `Route non classifiée` regroupe 41 083 objets sans
autre qualification — impossible d'en extraire « voie principale » et « desserte ».

La couche `CHEMIN` nomme bien « Chemin » et « Sentier », mais **applique ces noms
aux mêmes géométries** : c'est un ré-étiquetage de `ROUTE`, pas une information
supplémentaire.

**DÉCISION HUMAINE REQUISE.** Soit la hiérarchie s'aligne sur les 21 valeurs
réellement disponibles — c'est la proposition retenue dans `P4-LOCAL-ROAD-DESIGN.md`
avec onze catégories — soit une source complémentaire apporte la granularité
demandée. La reconstruire par déduction serait inventer une classification, ce que
le cadrage interdit lui-même.

---

## D3 — Le niveau quartier

**FAIT MESURÉ.** `CL_ADMIN` vaut `Autre` sur les **262 656 objets**. Une seule
valeur distincte. Ces fichiers ne portent **aucun rattachement administratif** — ni
région, ni préfecture, ni commune, ni quartier.

Le référentiel administratif reste par ailleurs le blocage identifié depuis la
phase 3 : `troncons.prefecture` et `troncons.commune` sont vides sur les 1 690
tronçons, et la BDRI ne connaît que 9 régions.

**DÉCISION HUMAINE REQUISE.** La recherche « Région → Préfecture → Commune →
Quartier → Rue » demande des polygones administratifs qui n'existent dans aucun
fichier fourni. D'où viendraient-ils, et quelle source ferait foi ?

Sans eux, le seul rattachement possible est `regionId` par intersection avec les
tronçons BDRI existants — approximatif, à marquer `DERIVE_DE_LA_GEOMETRIE`.

---

## D4 — Quel périmètre importer ?

**FAIT MESURÉ.**

| Catégorie | Objets | km | Part du volume |
|---|---:|---:|---:|
| Réseau classé (rapide, principale, secondaire, tertiaire) | 5 482 | 21 454 | 2 % |
| Voirie locale et résidentielle | 76 051 | 68 318 | 29 % |
| Accès | 5 806 | 1 180 | 2 % |
| **Chemins et sentiers** | **171 525** | **87 617** | **65 %** |
| Piétons, divers | 3 792 | 1 061 | 1 % |

**DÉCISION HUMAINE REQUISE.** Les chemins et sentiers représentent **les deux tiers
du volume pour l'usage le moins certain**. Un sentier n'est pas de la voirie ; sa
présence au référentiel géographique se défend pour l'accessibilité rurale, se
défend moins pour la gestion routière.

Trois options : tout importer ; importer sans les sentiers (−102 100 objets) ;
n'importer que le réseau classé et la voirie locale (−175 283 objets, soit un
sixième du volume conservé).

---

## D5 — L'âge de la donnée

**DONNÉE SOURCE.** `DATE_MAJ` : **8 mars 2023**. La donnée a trois ans et demi.

**DÉCISION HUMAINE REQUISE.** Pour un affichage cartographique complémentaire,
c'est acceptable. Pour alimenter une décision d'investissement, moins. Faut-il
prévoir une extraction plus récente, et à quelle fréquence ?

Le champ `sourceDate` du modèle proposé rend cette ancienneté visible objet par
objet ; il ne la corrige pas.

---

## D6 — Gouvernance de la donnée contributive

**DÉCISION HUMAINE REQUISE.** OpenStreetMap est produit par des volontaires.
Intégrer 262 656 objets d'origine contributive dans le référentiel géographique
national engage AGEROUTE au-delà de la technique.

La question est déjà posée dans les faits : la BDRI porte **70 tronçons codés
`*-OSM-*`**, entrés lors d'un import antérieur, et le module Franchissements
affiche 3 178 propositions OSM. Elle n'a jamais été tranchée explicitement.

Le modèle proposé la rend tenable — source obligatoire, statut, jamais présentée
comme donnée AGEROUTE — mais ne la remplace pas.

---

## D7 — Les seuils d'affichage

**PROPOSITION**, à caler sur essais réels.

| Niveau | Zoom | Poids mesuré par vue |
|---|---|---:|
| National | < 10 | 876 Ko (inchangé) |
| Ville | 12–13 | **263 Ko** |
| Quartier | 14–15 | 35 Ko |
| Détail | ≥ 16 | 2 Ko |

**FAIT MESURÉ** : servir la couche entière représenterait **41,2 Mo gzippés** —
exclu. Mais Conakry entière ne pèse que 263 Ko, **moins que la carte publique
actuelle**. Un GeoJSON cadré suffit ; les tuiles vectorielles ne sont pas
nécessaires.

---

## D8 — Le nom du modèle

**PROPOSITION** : `VoirieLocale`, table `voirie_locale`. Le schéma nomme ses modèles
en français ; `LocalRoad` y ferait tache.

---

## Ce qui n'attend aucune décision

Trois points ont été tranchés par la mesure, et ne demandent pas d'arbitrage.

**`ROUTE` seule, jamais `CHEMIN`.** Les 171 570 géométries de `CHEMIN` se
retrouvent à l'identique dans `ROUTE` — 100 %, testé sur la totalité. `CHEMIN`
porte 4 champs contre 15. L'utiliser perdrait onze champs et 91 086 objets ;
additionner les deux compterait 171 570 objets en double.

**Table séparée de `Troncon`.** 262 656 lignes dans `troncons` multiplieraient par
156 tous les indicateurs existants, et les contraintes non nulles du modèle
(`regionId`, `longueurKm`, `revetement`, `etat`, `pkDebut`, `pkFin`) exigeraient des
valeurs par défaut inventées.

**Index GiST sur `(geom::geography)`.** La forme compte : la mesure de la phase 3 a
montré qu'un index sur `geom` est ignoré par le planificateur là où la forme
`geography` divise le temps par quarante.
