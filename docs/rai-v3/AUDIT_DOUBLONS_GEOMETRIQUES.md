# Fiches de comparaison des doublons géométriques

Mesuré le 14/10/2026 contre la production, en lecture seule. Livrable de votre décision du
13/10 : « Produire une fiche de comparaison pour chaque paire ou groupe, sans fusion
automatique. » **Aucune fusion n'a été faite, aucun tronçon supprimé.**

La définition du doublon est celle du moteur de qualité, reprise sans la modifier :
groupement par `ST_AsBinary(geom)`, soit une égalité **binaire** des géométries.

## 1. Le décompte

| Mesure | Valeur |
|---|---|
| Groupes | **42** |
| Objets concernés | 84 |
| Objets en trop | 42 |
| Taille des groupes | **2 membres, pour les 42** — aucun triplet |
| Kilomètres comptés deux fois dans le registre complet | **18,4** |

## 2. Ce ne sont pas des doublons accidentels

Les 42 paires ont **exactement la même structure**, sans une exception :

| | Membre A | Membre B |
|---|---|---|
| Créé le | **29/06/2026** | **03 ou 04/09/2026** |
| `sourceReference` | **nul** → réseau classé | `voirie_locale:<uuid>` → voirie locale |
| Code | administratif : `DI 002`, `MA 784`, `KA. 050` | OSM : `CKY-OSM-w32237148` |
| Nom | gabarit : « Voirie Urbaine DI 002 » | **le vrai nom de rue** : « Route Donka » |
| Dépendances | **0** | 1 (sa ligne `voirie_locale`) |
| Lignes de provenance | **0** | **6 ou 7** |

Chaque paire est **une seule route enregistrée deux fois** : une fois dans l'inventaire
administratif de juin sous un code de voirie, une fois dans l'import OpenStreetMap de
septembre sous son nom réel.

## 3. Les statistiques officielles ne comptent PAS ces mètres deux fois

C'est la correction la plus importante de cet audit, et elle contredit un commentaire du
dépôt.

`qualite/anomalies.depot.ts` écrit : « MESURE DU 13/10/2026 : 42 groupes, 42 objets en trop.
Toute statistique de linéaire compte donc ces mètres deux fois. »

**Mesuré le 14/10 : exactement 42 tronçons du réseau classé ont un jumeau géométrique.** Soit
**un par groupe**. Chaque paire a donc un membre dans le réseau classé et un seul, l'autre
étant de la voirie locale, que `lib/reseau.ts` exclut déjà.

| Périmètre | Les 42 routes y sont comptées |
|---|---|
| **Réseau classé — 21 156,6 km, le chiffre publié** | **une fois** |
| Registre complet — 185 264,4 km | deux fois, soit 18,4 km en trop |

L'affirmation du commentaire est donc vraie pour le registre et **fausse pour le chiffre
publié**. Elle mérite d'être corrigée dans le code, parce qu'elle ferait croire à une erreur
dans les 21 156,6 km alors qu'il n'y en a pas.

## 4. Deux paires ne ressemblent pas aux quarante autres

Sur les 42, **40 sont des rues de Conakry** (région 1) dont les deux membres portent des
attributs identiques : `BON` et `BITUME` de part et d'autre. L'arbitrage y est sans enjeu
d'état.

**Deux paires sont d'une autre nature**, et ce sont les seules où les attributs divergent :

| Groupe | Membre classé | Membre voirie locale | Région |
|---|---|---|---|
| 22 | `RN4-OSM-0` — **RN4**, `MOYEN`, `BITUME`, 0,598 km | `GNL-OSM-w264847127` — « Voie résidentielle », `NON_EVALUE`, `NON_RENSEIGNE` | Kindia |
| 33 | `RN24-OSM-30` — **RN24**, `MOYEN`, `BITUME`, 0,208 km | `GNL-OSM-w623658475` — « Voie résidentielle », `NON_EVALUE`, `NON_RENSEIGNE` | Boké |

Un fragment de **route nationale** partage sa géométrie exacte avec une voie qualifiée de
résidentielle par OpenStreetMap. Ce n'est pas la même erreur que les rues de Conakry : soit
l'import a repris un segment de RN comme voie locale, soit la RN emprunte réellement une rue.
**Ces deux-là demandent un regard de terrain, pas un arbitrage de bureau.**

## 5. L'arbitrage, et ce qu'il coûte

Votre décision interdit la fusion automatique, et le moteur de qualité recommande déjà :
« Arbitrer lequel fait foi, rattacher les observations au retenu, puis marquer l'autre
remplacé. Supprimer l'un des deux ferait perdre les observations qui y pendent. »

Trois options, avec leur conséquence mesurée :

| Option | Effet sur le réseau classé | Ce qu'il faut déplacer | Ce qu'on perd |
|---|---|---|---|
| **Retenir le membre classé** (A) | inchangé, 21 156,6 km | **257 lignes de provenance** à rattacher | les vrais noms de rue |
| **Retenir le membre OSM** (B) et le promouvoir | inchangé si la promotion est faite, **-18,4 km si elle est oubliée** | rien : B porte déjà sa provenance | les codes de voirie administratifs |
| **Garder les deux, liés explicitement** | inchangé | rien | rien, mais le registre garde 42 jumeaux |

**La deuxième option a un piège.** Marquer A remplacé retire 18,4 km du réseau classé, et
promouvoir B ne les rend que si la promotion aboutit. Faire les deux gestes dans le désordre
ferait baisser le chiffre publié sans que personne ne comprenne pourquoi. Le dépôt porte déjà
`scripts/promouvoir-voirie-troncons.ts` et `scripts/requalifier-lot-promotion.ts` pour cette
opération : elle est connue, elle n'est pas improvisée.

**Mon avis, qui ne vous engage pas.** Pour les 40 rues de Conakry, retenir le membre OSM et le
promouvoir donne un géoportail lisible par un citoyen : « Route Donka » vaut mieux que
« Voirie Urbaine DI 002 », et ce membre porte déjà sa provenance. Pour les groupes 22 et 33,
ne rien faire avant vérification : un fragment de RN n'est pas une voie résidentielle, et
l'une des deux qualifications est fausse.

## 6. Ce qui n'a pas été fait, et ne doit pas l'être automatiquement

Aucune fusion, aucune suppression, aucune géométrie modifiée, aucun `remplaceeLe` écrit.

Supprimer un membre ferait perdre soit 257 lignes de provenance, soit 18,4 km du réseau
classé, selon le membre. Et dans les 42 cas, la géométrie est **binairement identique** : il
n'y a aucun arbitrage géométrique à faire, seulement un arbitrage d'**identité
administrative**. Aucun programme ne peut décider lequel de deux noms est le bon.

## 7. Les 42 fiches

Deux lignes par groupe : le membre classé d'abord, le membre voirie locale ensuite. `km` est
la longueur géométrique commune aux deux, `prov.` le nombre de lignes de provenance.

| # | km | Membre classé (29/06) | Membre voirie locale (03-04/09) | Rég. | prov. |
|---|---|---|---|---|---|
| 1 | 2,616 | `RO. 001` — Voirie Urbaine RO. 001 | `CKY-OSM-w141065457` — Transversal 1 | Conakry | 6 |
| 2 | 2,351 | `MA 784` — Voirie Urbaine MA 784 | `CKY-OSM-w374726147` — Route Niger | Conakry | 6 |
| 3 | 2,021 | `DI 002` — Voirie Urbaine DI 002 | `CKY-OSM-w32237148` — Route Donka | Conakry | 6 |
| 4 | 1,860 | `MA. 250` — Voirie Urbaine MA. 250 | `CKY-OSM-w629696053` — Corniche Sud | Conakry | 6 |
| 5 | 1,818 | `DI 256` — Voirie Urbaine DI 256 | `CKY-OSM-w291395357` — Corniche Nord | Conakry | 6 |
| 6 | 1,811 | `MA 286` — Voirie Urbaine MA 286 | `CKY-OSM-w448879333` — Route Niger | Conakry | 6 |
| 7 | 1,804 | `DI 814-w140785572` — Voirie Urbaine DI 814 | `CKY-OSM-w140785572` — Boulevard Belle-Vue | Conakry | 6 |
| 8 | 1,690 | `DI 814` — Voirie Urbaine DI 814 | `CKY-OSM-w38640731` — Boulevard Belle-Vue | Conakry | 6 |
| 9 | 1,593 | `MA. 500` — Voirie Urbaine MA. 500 | `CKY-OSM-w629696052` — Corniche Sud | Conakry | 6 |
| 10 | 1,481 | `MA. 006-w605957605` — Voirie Urbaine MA. 006 | `CKY-OSM-w605957605` — Route Niger | Conakry | 6 |
| 11 | 1,457 | `KA 080` — Voirie Urbaine KA 080 | `CKY-OSM-w31786023` — Route Niger | Conakry | 6 |
| 12 | 1,372 | `KA 004` — Voirie Urbaine KA 004 | `CKY-OSM-w38663482` — Corniche Sud | Conakry | 6 |
| 13 | 1,324 | `DI 002-w1096262466` — Voirie Urbaine DI 002 | `CKY-OSM-w1096262466` — Route Donka | Conakry | 6 |
| 14 | 1,314 | `KA 086-w38895164` — Voirie Urbaine KA 086 | `CKY-OSM-w38895164` — Route principale | Conakry | 7 |
| 15 | 1,076 | `KA 086` — Voirie Urbaine KA 086 | `CKY-OSM-w31786044` — Route principale | Conakry | 7 |
| 16 | 1,019 | `MA. 006-w605957606` — Voirie Urbaine MA. 006 | `CKY-OSM-w605957606` — Route Niger | Conakry | 6 |
| 17 | 1,016 | `KA 094` — Voirie Urbaine KA 094 | `CKY-OSM-w38895325` — Corniche Sud | Conakry | 6 |
| 18 | 0,990 | `KA. 032` — Voirie Urbaine KA. 032 | `KALOUM-OSM-w291504356` — Avenue William Tubman | Conakry | 6 |
| 19 | 0,817 | `KA. 050-w38652599` — Voirie Urbaine KA. 050 | `CKY-OSM-w38652599` — 11e Avenue | Conakry | 6 |
| 20 | 0,772 | `MA 006` — Voirie Urbaine MA 006 | `CKY-OSM-w140784945` — Route Niger | Conakry | 6 |
| 21 | 0,673 | `DI 256-w1097251582` — Voirie Urbaine DI 256 | `CKY-OSM-w1097251582` — Corniche Nord | Conakry | 6 |
| **22** | 0,598 | `RN4-OSM-0` — **RN4**, MOYEN, BITUME | `GNL-OSM-w264847127` — Voie résidentielle, NON_EVALUE | **Kindia** | 7 |
| 23 | 0,567 | `KA 007` — Voirie Urbaine KA 007 | `CKY-OSM-w38894956` — Boulevard du Commerce | Conakry | 6 |
| 24 | 0,562 | `DI 814-w140785577` — Voirie Urbaine DI 814 | `CKY-OSM-w140785577` — Boulevard Belle-Vue | Conakry | 6 |
| 25 | 0,551 | `DI 814-w269147255` — Voirie Urbaine DI 814 | `CKY-OSM-w269147255` — Boulevard Belle-Vue | Conakry | 6 |
| 26 | 0,519 | `KA. 080` — Voirie Urbaine KA. 080 | `CKY-OSM-w636150062` — Route Niger | Conakry | 6 |
| 27 | 0,405 | `DI 256-w1097251581` — Voirie Urbaine DI 256 | `CKY-OSM-w1097251581` — Corniche Nord | Conakry | 6 |
| 28 | 0,401 | `KA. 035` — Voirie Urbaine KA. 035 | `CKY-OSM-w571806434` — Boulevard de Boulbinet | Conakry | 6 |
| 29 | 0,378 | `KA. 050-w38698336` — Voirie Urbaine KA. 050 | `CKY-OSM-w38698336` — 11e Avenue | Conakry | 6 |
| 30 | 0,341 | `DI 002-w1096262465` — Voirie Urbaine DI 002 | `CKY-OSM-w1096262465` — Route Donka | Conakry | 6 |
| 31 | 0,253 | `MA 784-w270805335` — Voirie Urbaine MA 784 | `CKY-OSM-w270805335` — Route Niger | Conakry | 6 |
| 32 | 0,222 | `MA 784-w174021510` — Voirie Urbaine MA 784 | `CKY-OSM-w174021510` — Route Niger | Conakry | 6 |
| **33** | 0,208 | `RN24-OSM-30` — **RN24**, MOYEN, BITUME | `GNL-OSM-w623658475` — Voie résidentielle, NON_EVALUE | **Boké** | 7 |
| 34 | 0,180 | `KA. 050` — Voirie Urbaine KA. 050 | `CKY-OSM-w571806428` — 11e Avenue | Conakry | 6 |
| 35 | 0,141 | `DI 814-w269147253` — Voirie Urbaine DI 814 | `CKY-OSM-w269147253` — Boulevard Belle-Vue | Conakry | 6 |
| 36 | 0,139 | `DI 814-w38649509` — Voirie Urbaine DI 814 | `CKY-OSM-w38649509` — Boulevard Belle-Vue | Conakry | 6 |
| 37 | 0,099 | `DI 814-w1097249164` — Voirie Urbaine DI 814 | `CKY-OSM-w1097249164` — Boulevard Belle-Vue | Conakry | 6 |
| 38 | 0,078 | `MA. 006` — Voirie Urbaine MA. 006 | `CKY-OSM-w174022130` — Route principale | Conakry | 7 |
| 39 | 0,070 | `MA 784-w264627784` — Voirie Urbaine MA 784 | `CKY-OSM-w264627784` — Route Niger | Conakry | 6 |
| 40 | 0,061 | `DI. 002` — Voirie Urbaine DI. 002 | `CKY-OSM-w291395349` — Route Donka | Conakry | 6 |
| 41 | 0,054 | `DI. 002-w291395350` — Voirie Urbaine DI. 002 | `CKY-OSM-w291395350` — Route Donka | Conakry | 6 |
| 42 | 0,050 | `KA. 050-w571806430` — Voirie Urbaine KA. 050 | `CKY-OSM-w571806430` — 11e Avenue | Conakry | 6 |

Les membres classés portent tous `sourceReference` nul, `etat` BON et `revetement` BITUME,
sauf les groupes 22 et 33 déjà signalés. Aucun membre classé ne porte de dépendance ni de
ligne de provenance : les 257 lignes de provenance et les 42 lignes `voirie_locale` pendent
toutes aux membres OSM.

## 8. Une régularité qui dit l'origine

Les 40 rues de Conakry portent des noms de gabarit « Voirie Urbaine » et des codes de voirie,
toutes créées le **même jour**, toutes à `BON` et `BITUME`, toutes sans provenance. C'est la
signature d'un **import administratif en lot**, pas d'un relevé : un inventaire où l'état et
le revêtement ont été renseignés par défaut.

Cela recoupe exactement ce qu'`AUDIT_RCI.md` montre sur les 6 192 états déclarés de la voirie
locale, qui ne portent que du moyen et du bon. Deux imports, la même signature : des valeurs
par défaut là où personne n'est allé voir.
