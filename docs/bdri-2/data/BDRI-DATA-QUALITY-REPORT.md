# BDRI — Qualité des données, par dimension

**Date de mesure** : 1er septembre 2026
**Base** : `console_bdri` en production, lecture seule
**Complète** : `docs/audit-2026/DATA-QUALITY-BDRI.md` (phase 3), qui posait le premier constat de volume. Ce document-ci mesure la qualité, pas la quantité.

---

## Méthode, et pourquoi elle est écrite avant les scores

Le §32 du brief interdit une formule opaque. Chaque score ci-dessous est donc une
division dont le numérateur et le dénominateur sont donnés. Aucun coefficient, aucune
pondération, aucun agrégat final unique.

Un principe guide tout le document : **un champ rempli n'est pas un champ renseigné**.
`revetement` est rempli à 100 % et ne porte aucune information. `etat` est rempli à
100 % et dit « je ne sais pas » dans 62 % des cas. Les taux de remplissage bruts
mentent, et c'est précisément ce que ce rapport corrige.

---

## Dimension 1 — Complétude

La complétude se lit très différemment selon qu'on interroge **où est l'objet** ou
**ce qu'on sait de lui**. Il faut donc deux mesures, pas une.

### Tronçons

| Groupe | Champs | Renseignés | Score |
|---|---|---:|---:|
| Identification et localisation | code, nom, classe, régionId, geom, pkDebut, pkFin | 11 830 / 11 830 | **100 %** |
| Caractérisation | longueurKm, revêtement, état, trafic, criticité, coût, dateÉval, préfecture, commune | 1 309 / 15 210 | **8,6 %** |

Le détail du numérateur de la caractérisation : `longueurKm` 662 + `etat` réellement
évalué 647 = 1 309. `revetement` compte pour zéro parce qu'il est constant sur toute
la table ; les sept autres champs sont vides.

**La BDRI sait où se trouve chaque tronçon et ne sait presque rien à son sujet.**

### Chantiers

| Groupe | Renseignés | Score |
|---|---:|---:|
| Identification (intitulé, entreprise) | 976 / 976 | **100 %** |
| Rattachement financier (bailleur, montant, contrat) | 1 329 / 1 464 | **90,8 %** |
| Localisation exploitable (géométrie ou tronçon + PK) | 6 / 488 | **1,2 %** |
| Suivi temporel (début prévu, fin prévue, début réel, fin réelle) | 428 / 1 952 | **21,9 %** |

Le contraste est net : le volet contractuel est presque complet, le volet géographique
est vide. C'est cohérent avec une saisie faite depuis des dossiers de marché, sans
passage par la carte.

### Ouvrages d'art

| Groupe | Renseignés | Score |
|---|---:|---:|
| Localisation (geom, pk, tronçon) | 362 / 378 | **95,8 %** |
| Caractérisation (état, longueur, année, matériau) | 272 / 504 | **54,0 %** |
| Suivi (dernière inspection) | 0 / 126 | **0 %** |

---

## Dimension 2 — Exactitude

L'exactitude ne se mesure que là où une contre-vérification existe. Ailleurs, on ne
peut rien affirmer, et il faut le dire plutôt que d'inventer un score.

| Champ | Contre-vérification disponible | Résultat |
|---|---|---|
| `longueurKm` | comparaison à `ST_Length(geom)` | **662 / 662 concordants à ≤ 1 %** |
| `geom` | validité PostGIS, SRID, emprise | **1 690 / 1 690 conformes** |
| `revetement` | intitulés de chantiers | **contredit dans 29 cas** |
| `etat` | aucune | non mesurable |
| `montantGnf` | aucune (module Marchés vide) | non mesurable |
| trafic, criticité, coût | sans objet — vides | — |

Le seul champ attributaire dont l'exactitude soit démontrée est la longueur, et
seulement sur les 39 % qui la portent. Le seul champ dont l'inexactitude soit démontrée
est le revêtement.

**Preuve de l'inexactitude du revêtement** : les 1 690 tronçons valent `BITUME`, sans
exception, alors que 29 intitulés de chantiers décrivent des routes « en terre », en
« piste » ou en « latérite » — dont *« Travaux de réhabilitation de la Route
Préfectorale en terre Pita-Maci-Sangareah longue de 85 km »*.

---

## Dimension 3 — Cohérence

Contradictions internes, mesurées par croisement de deux champs de la même table.

| Contrôle | Résultat |
|---|---:|
| Chantiers `TERMINE` avec avancement < 100 % | **41 / 312 (13,1 %)** dont 35 à 0 % |
| Chantiers à 100 % non marqués `TERMINE` | 0 |
| Chantiers `EN_COURS` sans date de début prévue | 5 / 89 |
| Chantiers `PLANIFIE` avec avancement > 0 | 0 / 66 |
| Chantiers sans montant | 51 / 488 |
| Dates de début prévues dans le futur | 0 |
| Géométries dupliquées (tronçons) | 0 |
| Géométries hors emprise Guinée | 0 |

**Score de cohérence des chantiers : 46 anomalies sur 488 lignes, soit 9,4 %.**

L'incohérence principale est unidirectionnelle — on clôt un chantier sans mettre
l'avancement à jour, jamais l'inverse. C'est le signe d'un statut modifié à la main
sans que le champ d'avancement suive, pas d'une corruption.

---

## Dimension 4 — Fraîcheur

C'est la dimension la plus dégradée, et de loin.

| Champ de datation métier | Renseigné |
|---|---:|
| `troncons.dateDerniereEvaluation` | **0 / 1 690** |
| `troncons.traficDateComptage` | **0 / 1 690** |
| `ouvrages.derniereInspectionDate` | **0 / 126** |
| `chantiers.dateDebutReelle` | **0 / 488** |
| `chantiers.dateFinReelle` | **0 / 488** |
| `chantiers.dateFinPrevue` | 3 / 488 |

**Score de fraîcheur : 3 / 4 970, soit 0,06 %.**

Aucune donnée métier de la BDRI ne porte de date de validité. Les seules dates fiables
sont techniques — `createdAt`, `updatedAt` — et elles disent quand la ligne a été
écrite, pas quand le fait a été constaté.

La conséquence est concrète : les 647 tronçons dont l'état est connu ne sont pas
comparables entre eux. Un « BON » relevé il y a six mois et un « BON » relevé il y a
six ans occupent la même case. Aucune priorisation sérieuse ne peut s'appuyer là-dessus.

Et 312 chantiers sont déclarés terminés sans qu'aucun ne porte de date d'achèvement.

---

## Dimension 5 — Qualité géométrique

C'est la dimension la mieux tenue, et il faut le dire aussi clairement que le reste.

| Contrôle | Tronçons | Ouvrages |
|---|---:|---:|
| Géométrie présente | 1 690 / 1 690 | 124 / 126 |
| `ST_IsValid` | **1 690 / 1 690** | — |
| SRID 4326 | **1 690 / 1 690** | — |
| `ST_IsSimple` (pas d'auto-intersection) | 1 689 / 1 690 | — |
| Dans l'emprise Guinée | 1 690 / 1 690 | — |
| Doublons de géométrie | 0 | — |

**Score de validité géométrique : 99,94 %** (1 689 / 1 690).

La réserve porte non sur la validité mais sur la **finesse** :

| Classe | Densité de description |
|---|---:|
| RU | 26,4 pts/km |
| RN | 12,0 pts/km |
| RR | **2,2 pts/km** |

Les régionales sont décrites cinq fois plus grossièrement. L'effet mesuré sur la
longueur reste sous 1 % — démonstration dans `TRONCONS-DATA-AUDIT.md` §3 — mais
l'effet sur l'affichage cartographique et sur toute analyse de tracé est réel.

---

## Dimension 6 — Source

| Question du §21 | Réponse actuelle |
|---|---|
| D'où vient cette donnée ? | **aucun champ** |
| Qui l'a saisie ? | partiellement — 1 423 entrées d'audit, **aucune sur les créations** |
| Quand ? | date technique seulement |
| Quelle source ? | **aucun champ** |
| Est-elle vérifiée ? | **aucun champ** |
| Quand a-t-elle été vérifiée ? | **aucun champ** |

**Score de traçabilité de la source : 0 / 6.**

Les 1 690 tronçons et les 488 chantiers sont entrés par un chemin qui n'écrit pas dans
le journal d'audit. La base ne conserve donc aucune trace de leur origine.

C'est la dimension à traiter en premier, parce qu'elle conditionne toutes les autres :
tant qu'on ignore d'où vient une valeur, on ne peut ni la corriger avec méthode, ni
décider si elle prime sur une valeur concurrente.

---

## Synthèse

| Dimension | Score | Fondement |
|---|---:|---|
| Qualité géométrique | **99,94 %** | 1 689 / 1 690 valides et simples |
| Complétude — localisation des tronçons | **100 %** | 11 830 / 11 830 |
| Complétude — localisation des ouvrages | **95,8 %** | 362 / 378 |
| Cohérence des chantiers | **90,6 %** | 442 / 488 sans anomalie |
| Complétude — caractérisation des ouvrages | **54,0 %** | 272 / 504 |
| Complétude — suivi temporel des chantiers | **21,9 %** | 428 / 1 952 |
| Complétude — caractérisation des tronçons | **8,6 %** | 1 309 / 15 210 |
| Complétude — localisation des chantiers | **1,2 %** | 6 / 488 |
| Fraîcheur | **0,06 %** | 3 / 4 970 |
| Source | **0 %** | 0 / 6 questions |

Aucun score global n'est proposé. Une moyenne de ces dix chiffres n'aurait aucun sens
métier et masquerait exactement ce que le tableau montre : la qualité de la BDRI n'est
pas médiocre en moyenne, elle est **excellente sur la géométrie et nulle sur la
provenance et la fraîcheur**.

---

## Ce qu'il faut en conclure pour la suite

1. **Ne pas repartir de la géométrie.** Elle est bonne. Le §36 du brief a raison de
   placer l'UX après les données : ce n'est pas la carte qui est en défaut.
2. **Traiter la source avant l'exactitude.** Corriger `BITUME` sans savoir d'où il
   vient reviendrait à remplacer une supposition par une autre.
3. **La fraîcheur commande la décision.** Un référentiel sans date de constat ne
   permet aucune priorisation défendable, quel que soit le nombre de champs remplis.
4. **La localisation des chantiers est le plus gros gisement de valeur immédiate** :
   482 objets ont un intitulé riche et aucune position. Voir
   `BDRI-CHANTIERS-GEOLOCALISATION.md`.
