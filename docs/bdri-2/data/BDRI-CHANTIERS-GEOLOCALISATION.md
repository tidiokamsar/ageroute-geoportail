# Plan de géolocalisation des chantiers

**Date** : 1er septembre 2026
**Problème** : 482 chantiers sur 488 n'ont aucune position exploitable.
**Objet** : dire ce qui est récupérable, avec quelle méthode, à quel coût, et surtout ce qui ne l'est pas.

---

## 1. État exact

| Niveau | Chantiers | Part |
|---|---:|---:|
| **Précis** — géométrie propre | 6 | 1,2 % |
| **Linéaire** — tronçon + PK, sans géométrie | **0** | 0 % |
| **Approximatif** — région réelle | 432 | 88,5 % |
| **Aucun** — région « Non renseigné » | 50 | 10,2 % |

Le niveau linéaire, pourtant le plus réaliste à alimenter, n'est utilisé par personne :
les 4 chantiers qui portent un `tronconId` sont les mêmes que ceux qui ont déjà une
géométrie complète.

Bonne nouvelle de structure : **le schéma porte déjà les trois niveaux**. `geom` pour
le précis, `tronconId` + `pkDebut` + `pkFin` pour le linéaire, `regionId` pour
l'approximatif. Aucune migration n'est nécessaire pour commencer.

---

## 2. Ce que contiennent les intitulés

Les 488 intitulés sont du texte libre, saisi depuis des dossiers de marché. Ils sont
plus riches qu'attendu.

| Indice présent dans l'intitulé | Chantiers |
|---|---:|
| Couple origine–destination (« Xxx-Yyy ») | **299** |
| Longueur explicite (km ou ml) | **221** |
| Désignation de route (RN/RR + numéro) | 98 |
| Point kilométrique (« PK123 ») | 78 |
| **Route ET PK** — référencement linéaire complet | **36** |
| Au moins un indice | **330** |
| Aucun indice structuré | 158 |

Exemples authentiques, par niveau de précision décroissant :

> `lot 12 : travaux de cantonnage manuel de la route PK24 - PK66 RN5 (42 km)`

Celui-ci est directement exploitable : route, PK début, PK fin, longueur de contrôle.

> `lot 17 travaux de cantonnage manuel de la route PK50-Marela (PK103) RN2 53KM`

Exploitable aussi, avec une localité intermédiaire nommée.

> `Travaux de réhabilitation de la Route Préfectorale en terre Pita-Maci-Sangareah longue de 85km`

Trois localités, une longueur, pas de route ni de PK. Exploitable seulement si les
trois localités existent dans un référentiel.

> `Travaux de construction et de bitumage de 2km de route dans la commune urbaine de Labé`

Une commune, une longueur. Ne peut donner mieux qu'un centre communal.

> `Construction pont du Konkoure (2eme ouvrage)`

Un ouvrage nommé. Récupérable via la table `ouvrages`, pas via un référentiel de lieux.

---

## 3. Le mur : le référentiel de tronçons n'a pas de noms de lieux

C'est le résultat qui commande tout le reste du plan, et il est négatif.

J'ai testé l'appariement automatique entre intitulés de chantiers et tronçons :

| Test | Résultat |
|---|---:|
| Chantiers dont l'intitulé contient un **code** de tronçon exact | **1 / 488** |
| Tronçons dont le **nom** porte un couple origine-destination | **0 / 1 690** |
| Chantiers dont l'intitulé cite une **désignation RN** existante | **98 / 488** |

Les tronçons ne portent pas de noms humains. Leur champ `nom` vaut soit le code
lui-même (`RES-972`), soit une désignation courte (`RN3`, `RN6`). Aucun ne s'appelle
« Kankan – Kissidougou ».

**Conséquence** : l'appariement par nom de localité est impossible aujourd'hui, non
pas parce que les intitulés sont pauvres, mais parce que **la cible n'a pas de noms**.
Le chaînon manquant n'est pas un algorithme, c'est le référentiel administratif du §19.

Le seul appariement qui fonctionne est celui par désignation de route : 98 chantiers
citent une des 42 désignations RN présentes dans le référentiel.

---

## 4. Priorité des sources, corrigée par la mesure

Le §18 propose un ordre. La mesure le réordonne, parce que certaines sources listées
n'existent pas dans le système.

| Rang | Source | Chantiers atteignables | Disponible ? |
|---|---|---:|---|
| 1 | Intitulé : route + PK début/fin | **36** | **oui, immédiatement** |
| 2 | Intitulé : désignation de route seule | 98 (dont les 36) | **oui, immédiatement** |
| 3 | Numéro de contrat → dossier de marché | 414 | **non** — module Marchés vide |
| 4 | Documents joints | 1 | **non** — 1 document en base |
| 5 | Ordres de service | 0 | **non** — module vide |
| 6 | Intitulé : localités → référentiel administratif | ~299 | **non** — référentiel absent (§19) |
| 7 | Saisie carte par un agent | 488 | oui, mais coûteux |

Trois des sources que le brief place en tête — marchés, documents, ordres de service —
**ne contiennent aucune donnée**. Elles ne sont pas des pistes à court terme.

---

## 5. Ce qui est faisable maintenant, et ce que ça donne

### Étape 1 — Les 36 chantiers à référencement complet

Extraire route, PK début et PK fin des 36 intitulés qui portent les deux, puis projeter
par `ST_LineSubstring` sur le tronçon correspondant.

**Réserve mesurée** : seuls 551 tronçons sur 1 690 portent un intervalle PK exploitable
(`pkFin > pkDebut`) — tous de la famille `GN N*`. Les 70 tronçons OSM, les 1 029
régionales et les 40 urbaines ont `pkDebut = pkFin = 0`. Pour ceux-là, la projection
retombe sur un repli qui interprète le PK comme un kilométrage depuis le début du tracé,
ce qui est une hypothèse plus faible et doit être signalé à l'agent qui valide.

**Gain réel, mesuré le 2 septembre 2026 : aucun automatiquement.**

*Correction d'une estimation trop optimiste de la première version.* L'extraction du
texte fonctionne — sur les 36 intitulés, elle rend 14 emprises et 19 rattachements à
une route seule, et refuse les 3 qui citent deux routes. Mais le **rattachement à un
tronçon** ne fonctionne pas :

| Cause mesurée | Constat |
|---|---|
| Échelle | les emprises font 40 à 55 km, les tronçons quelques km : chaque emprise chevauche **4 à 36 tronçons** |
| PK non continus | sur la RN5, six tronçons commencent à PK 0 ; la somme des intervalles vaut 433 km pour un PK maximum de 156. **24 désignations sur 42** ont des PK de départ dupliqués |
| PK hors étendue | le chantier `RN38 PK94+300 → PK135+100` vise une route dont le PK maximum en base est 61,6 |

**Sur les 14 emprises extraites, zéro trouve un tronçon qui la couvre.**

Le texte est clair, la cible ne l'est pas. Ces 33 chantiers entrent donc dans une file
de propositions qu'un agent tranche, avec l'intitulé d'origine, les PK lus, la longueur
citée et la liste des tronçons candidats. Aucune géométrie n'est posée sans décision
humaine.

> **Correction du 5 septembre 2026 — cette conclusion était fausse.**
>
> Le référencement linéaire n'est pas incohérent. Il est **relatif à une section**, et
> chaque section repart de zéro. Le code du tronçon la porte depuis le début :
> `GN N0001 3-1216` est la route 0001, section 3.
>
> Mesuré sur tout le réseau : **88 sections sur 90 sont chaînées sans trou ni
> recouvrement** à moins de 500 m près — 549 tronçons sur 551. Et les 551 intervalles
> concordent avec la longueur réelle du tracé à moins de 5 % : 13,5 km d'intervalle
> moyen pour 13,5 km de géométrie.
>
> Les six tronçons de la RN5 qui « commencent à PK 0 » sont donc six sections, pas six
> incohérences. La somme de 433 km pour un PK maximum de 156 est ce qu'on obtient en
> additionnant des kilométrages qui ne se suivent pas — l'erreur était dans l'addition,
> pas dans la donnée.
>
> **Ce qui manquait n'était pas un kilométrage continu, c'était une colonne.** Rien
> dans le schéma ne déclarait la section, donc tout consommateur supposant un PK global
> produisait du non-sens — y compris la projection d'emprises décrite ci-dessus.
>
> Effet mesuré une fois la section connue : sur les 12 chantiers dont l'intitulé porte
> une désignation et deux PK, **4 se résolvent à une seule section** — donc directement
> localisables — et 5 à deux ou trois, qu'un agent tranche sur pièce. Contre zéro
> auparavant.
>
> Voir la migration `20260905090000_troncon_section_pk` et
> `scripts/extraire-section-pk.ts`.

**Condition impérative** : chaque extraction est **proposée**, jamais appliquée. Un
agent valide ou corrige. Le §18 l'exige, et les intitulés le justifient — `PK50-Marela
(PK103)` mêle un PK et une localité dans la même expression, une extraction naïve s'y
trompe.

### Étape 2 — Les 62 chantiers citant une route sans PK

Rattacher au tronçon (`tronconId`) sans emprise. La position reste celle de la route
entière, ce qui est un progrès sur la région, mais **ne doit pas être affiché comme
une localisation précise**.

**Gain** : 62 chantiers passent au niveau linéaire partiel.

### Étape 3 — Les 50 sans région

Ne pas géocoder. Les remonter en anomalie de saisie : une région est obligatoire en
base, et « Non renseigné » est un contournement de cette contrainte. Cela relève d'une
correction de saisie, pas d'un algorithme.

### Étape 4 — Les 299 à couple origine-destination

**Bloquée** jusqu'au référentiel administratif. C'est le plus gros gisement — 61 % des
chantiers — et il ne s'ouvrira pas avant le §19.

---

## 6. Ce que je ne propose pas

- **Aucun géocodage automatique sur un nom de lieu.** Le §18 l'interdit et la mesure
  le confirme : sans référentiel, un nom comme « Marela » n'a pas de cible vérifiable.
- **Aucun recours à un géocodeur externe** sans validation. Une position venue d'un
  service tiers qui entrerait en base sans marquage deviendrait indistinguable d'une
  donnée AGEROUTE.
- **Aucune écriture directe.** Toute position dérivée d'un intitulé doit porter sa
  méthode et son niveau de confiance, sinon elle sera lue plus tard comme un relevé.

---

## 7. Ce que l'affichage doit dire

Le §17 est catégorique : ne jamais présenter une localisation approximative comme
précise. Concrètement, quatre rendus distincts :

| Niveau | Rendu carte | Mention obligatoire |
|---|---|---|
| Précis | emprise ou point exact | source et date |
| Linéaire | segment de route surligné | « emprise déduite des PK » |
| Approximatif | marqueur au centre régional, halo large | « position régionale, non localisée » |
| Aucun | **hors carte**, listé à part | « localisation absente » |

Le quatrième cas mérite d'être souligné : 50 chantiers ne doivent pas apparaître sur
la carte. Les placer au centre d'une région par défaut créerait une fausse information
là où il n'y en a aucune.

---

## 8. Effet attendu du plan

| Étape | Chantiers localisés | Cumul | Blocage |
|---|---:|---:|---|
| Aujourd'hui | 6 | 6 (1,2 %) | — |
| Étape 1 — route + PK | +36 | 42 (8,6 %) | aucun |
| Étape 2 — route seule | +62 | 104 (21,3 %) | aucun |
| Étape 4 — localités | +~299 | ~403 (82,6 %) | **référentiel §19** |

Les étapes 1 et 2 multiplient par 17 le nombre de chantiers localisés et ne dépendent
d'aucune donnée externe. L'étape 4, qui porte l'essentiel du gisement, dépend
entièrement du référentiel administratif.

C'est l'argument le plus fort pour traiter le §19 en priorité : il ne débloque pas
seulement la recherche administrative, il débloque 61 % de la géolocalisation des
chantiers.
