# Qualité des données — Console BDRI

**Mesuré** sur la base de production le 1<sup>er</sup> septembre 2026, en lecture seule.
Chaque chiffre de ce document provient d'une requête, aucun n'est estimé.

---

## 1. Le constat qui domine tous les autres

**Cinq modules sur neuf ne contiennent aucune donnée.**

| Module | Enregistrements |
|---|---|
| Tronçons routiers | 1 690 |
| Chantiers | 488 |
| Ouvrages d'art | 126 |
| Points noirs | 2 |
| **Inspections** | **0** |
| **Ordres de travaux** | **0** |
| **Marchés** | **0** |
| **Signalements citoyens** | **0** |
| **Péages / Pesages** | **0** |

La BDRI n'est donc pas une application dont les données seraient à améliorer :
c'est une application **dont la moitié attend d'être alimentée**. Cela ne remet en
cause ni le code ni l'architecture — mais cela change l'ordre des priorités. Ajouter
des fonctionnalités à des modules vides ne produit rien d'observable.

### Une correction à apporter aux rapports précédents

J'ai écrit que la vulnérabilité `/api/marches` « livrait les montants, décomptes et
décaissements à tout compte authentifié ». **La faille était réelle, la fuite ne
l'était pas** : la table `marches` est vide. Les treize routes non protégées
auraient exposé ces données ; elles n'en contenaient aucune.

Le correctif reste entièrement justifié — les marchés seront saisis un jour, et la
faille aurait alors été active sans que personne ne la remarque. Mais l'affirmation
telle que je l'ai formulée était plus grave que les faits. Je la corrige.

---

## 2. Réseau routier — 1 690 tronçons

### Ce qui est sain

| Contrôle | Résultat |
|---|---|
| Géométries invalides | **0** |
| Tronçons sans géométrie | **0** |
| Codes en double | **0** |
| Tronçons sans région | **0** |
| PK incohérents (`pkFin < pkDebut`) | **0** |

La couche géométrique est en bon état. C'est le socle SIG, et il tient.

### Ce qui manque

| Champ | Renseigné | Sur |
|---|---|---|
| `longueurKm` non nulle | **662** | 1 690 |
| État évalué | **647** | 1 690 |
| `traficMoyenJma` | **0** | 1 690 |
| `coutRehabEstime` | **0** | 1 690 |
| `criticiteStrategique` | **0** | 1 690 |
| `dateDerniereEvaluation` | **0** | 1 690 |
| `prefecture` | **0** | 1 690 |

**1 028 tronçons ont une longueur nulle ou à zéro**, soit 61 %. Le linéaire de
7 933 km affiché sur le tableau de bord provient donc des 662 tronçons restants.
Le chiffre n'est pas faux — il est **partiel**, et rien ne le signale au lecteur.

Même mécanique pour l'état : 1 043 tronçons sont « non évalué », soit 62 % des
segments — mais seulement 4 % du linéaire, puisque ce sont précisément ceux dont la
longueur est nulle. La carte publique affiche donc « Non observé 4 % » là où
**trois segments sur cinq n'ont pas d'état connu**.

### Une anomalie qui saute aux yeux

```
revetement : BITUME = 1690
```

**Les 1 690 tronçons portent la même valeur de revêtement.** Sur un réseau national
guinéen, c'est invraisemblable : une part importante est en terre ou en latérite.
Il s'agit selon toute apparence d'une valeur par défaut appliquée à l'import. Une
colonne à valeur unique ne porte aucune information — elle en simule une.

---

## 3. L'aide à la décision calcule sur du vide

Le score de priorisation (`/api/priorisation/scores`) pondère quatre critères :

| Critère | Champ | Renseigné |
|---|---|---|
| État | `etat` | 647 / 1 690 |
| Trafic | `traficMoyenJma` | **0** |
| Criticité stratégique | `criticiteStrategique` | **0** |
| Coût | `coutRehabEstime` | **0** |

**Trois des quatre critères sont vides sur la totalité du réseau.** Le score produit
un classement, mais il ne peut refléter que le seul état — et encore, sur 38 % des
tronçons.

C'est le point que le §22 de la mission demandait de vérifier avant de construire un
score : *« Ne jamais créer une formule arbitraire. »* La formule existe déjà ; ce
sont ses entrées qui manquent. **Aucun travail sur la pondération n'a de sens avant
que ces trois champs ne soient alimentés.**

---

## 4. Chantiers — le maillon faible du géoportail

| Contrôle | Résultat |
|---|---|
| Chantiers | 488 |
| Avec une géométrie | **6** (1,2 %) |
| Rattachés à un tronçon | **4** (0,8 %) |

482 chantiers sur 488 s'affichent au centre de leur région, faute de localisation.
Pour un géoportail, c'est le défaut le plus visible : la carte montre des chantiers
là où il n'y en a pas.

**Ne pas les déplacer arbitrairement.** Le rattachement à un tronçon est la voie la
plus prometteuse : il est déjà modélisé (`tronconId`), et un chantier rattaché à un
tronçon peut hériter de sa géométrie, ou d'un segment défini par PK début et PK fin.
Encore faut-il disposer de cette information à la source — elle existe
vraisemblablement dans l'application de gestion de projets, ce qui en fait un sujet
d'interconnexion plutôt que de saisie.

---

## 5. Ouvrages d'art

| Contrôle | Résultat |
|---|---|
| Ouvrages | 126 |
| Avec une géométrie | 124 (98 %) |
| Rattachés à un tronçon | 114 (90 %) |

C'est le module le mieux tenu. Deux ouvrages sans position et douze sans
rattachement : un volume traitable à la main.

---

## 6. Fichiers — cohérence base ↔ stockage

| | |
|---|---|
| Fichiers présents | 3 |
| Références en base | 2 (1 document, 1 photo d'ouvrage) |
| **Fichier orphelin** | **1** — `photos/5df25173-…png` |
| Référence sans fichier | 0 |

Aucune référence ne pointe dans le vide — c'est le sens de la vérification qui
compte le plus, puisqu'une référence cassée produit une erreur visible pour
l'utilisateur. Le fichier orphelin est sans gravité mais mérite d'être expliqué :
il date du 29 juin, période où le stockage a été détaché de l'application.

**Ce contrôle doit devenir automatique**, dans les deux sens. Trois fichiers
aujourd'hui, mais les modules qui téléversent viennent d'être mis en ligne.

---

## 7. Indicateurs de qualité proposés

Quatre indicateurs, calculables dès aujourd'hui à partir des mesures ci-dessus.

| Indicateur | Définition | Valeur au 01/09/2026 |
|---|---|---|
| **Complétude** | Champs renseignés sur champs attendus, tronçons | **≈ 23 %** — 3 champs sur 13 significativement remplis |
| **Qualité géométrique** | Géométries valides sur géométries présentes | **100 %** |
| **Localisation** | Objets positionnés sur objets total, toutes couches | **1 822 / 2 306 ≈ 79 %** — tiré vers le bas par les chantiers |
| **Fraîcheur** | Objets avec date d'évaluation | **0 %** — le champ n'est jamais renseigné |

La complétude et la fraîcheur sont les deux à surveiller. La qualité géométrique est
excellente et ne demande qu'à être maintenue.

---

## 8. Ce qu'il faut faire, et dans quel ordre

1. **Alimenter le revêtement.** Une colonne à valeur unique est pire qu'une colonne
   vide : elle donne l'illusion d'une information.
2. **Renseigner les longueurs manquantes.** Elles sont calculables depuis la
   géométrie (`ST_Length` en geography) — à confronter aux valeurs officielles avant
   d'écrire quoi que ce soit.
3. **Géolocaliser les chantiers**, par rattachement au tronçon plutôt que par saisie
   de coordonnées.
4. **Ne pas travailler l'aide à la décision** tant que trafic, criticité et coût
   restent vides.
5. **Automatiser le contrôle base ↔ fichiers**, avant que le volume ne rende la
   vérification manuelle impossible.

Aucune de ces actions n'est un développement lourd. Ce sont des chantiers de
**données**, et ils conditionnent l'essentiel de ce que la BDRI 2.0 promet.
