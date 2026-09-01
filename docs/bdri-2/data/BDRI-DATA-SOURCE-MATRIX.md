# BDRI — Matrice des sources de données

**Date** : 1er septembre 2026
**Objet** : pour chaque donnée, dire d'où elle vient, qui en répond, à quelle fréquence elle change, et quel crédit lui accorder.

---

## Comment lire ce document

Deux colonnes sont remplies par la mesure, deux ne peuvent pas l'être.

**Ce que la base peut dire** : la source technique et la fiabilité observée. Ces
colonnes sont établies par requête et par lecture du journal d'audit.

**Ce que la base ne peut pas dire** : le responsable métier et la fréquence de mise à
jour attendue. Ce sont des décisions d'organisation, pas des faits techniques. Elles
sont marquées **à établir** et attendent AGEROUTE. Les inventer serait exactement ce
que le §41 interdit.

Échelle de fiabilité utilisée :

| Niveau | Signification |
|---|---|
| **Vérifiée** | recoupée avec une seconde source, écart mesuré |
| **Cohérente** | non recoupée, mais sans contradiction interne détectée |
| **Importée** | origine inconnue, entrée sans trace d'audit |
| **Contredite** | une autre donnée de la base la contredit |
| **Absente** | le champ est vide |

---

## 1. Réseau routier — tronçons

| Donnée | Source technique | Responsable | Fréquence | Fiabilité |
|---|---|---|---|---|
| Géométrie | import sans trace d'audit | à établir | à établir | **Vérifiée** — 1 690/1 690 valides, SRID homogène, 0 doublon |
| `code`, `nom`, `classe` | même import | à établir | à établir | **Cohérente** — 100 % remplis, 3 classes distinctes |
| `pkDebut`, `pkFin` | même import | à établir | à établir | **Cohérente** — 100 % remplis |
| `longueurKm` (RN, RU) | même import | à établir | à établir | **Vérifiée** — concorde à ≤ 1 % avec la géométrie sur 662 cas |
| `longueurKm` (RR) | — | à établir | à établir | **Absente** — 1 sur 1 029 |
| `revetement` | même import | à établir | à établir | **Contredite** — `BITUME` sur 1 690, démenti par 29 intitulés de chantiers |
| `etat` | saisie applicative (1 155 modifications) | à établir | à établir | **Cohérente sur 647**, `NON_EVALUE` sur 1 043, **jamais datée** |
| `traficMoyenJma` | — | à établir | à établir | **Absente** — 0 / 1 690 |
| `criticiteStrategique` | — | à établir | à établir | **Absente** — 0 / 1 690 |
| `coutRehabEstime` | — | à établir | à établir | **Absente** — 0 / 1 690 |
| `prefecture`, `commune` | — | à établir | à établir | **Absente** — 0 / 1 690 |

---

## 2. Chantiers

| Donnée | Source technique | Responsable | Fréquence | Fiabilité |
|---|---|---|---|---|
| `intitule`, `entreprise` | import + 8 créations applicatives | à établir | à établir | **Cohérente** — 488/488, texte riche |
| `numContrat` | idem | à établir | à établir | **Cohérente** — 414/488 |
| `montantGnf` | idem | à établir | à établir | **Cohérente** — 437/488, non recoupable (module Marchés vide) |
| `bailleur` | idem | à établir | à établir | **Cohérente** — 478/488 |
| `statut` | saisie applicative (13 modifications) | à établir | à établir | **Contredite** — 41 `TERMINE` avec avancement < 100 % |
| `avancementPct` | idem | à établir | à établir | **Cohérente** — 364/488 > 0 |
| `regionId` | import | à établir | à établir | **Importée** — 50 valent « Non renseigné » |
| `geom` | saisie applicative | à établir | à établir | **Cohérente** — mais 6/488 seulement |
| dates réelles | — | à établir | à établir | **Absente** — 0/488 début, 0/488 fin |

---

## 3. Ouvrages d'art

| Donnée | Source technique | Responsable | Fréquence | Fiabilité |
|---|---|---|---|---|
| `geom`, `pk`, `tronconId` | import + 5 créations applicatives | à établir | à établir | **Cohérente** — 124/126, 114/126 rattachés |
| `etat` | même origine | à établir | à établir | **Importée** — 126/126 remplis, 104 valent `BON`, **jamais datés**, 0 inspection |
| `longueurM` | même origine | à établir | à établir | **Cohérente** — 126/126 |
| `anneeConstruction`, `materiau` | même origine | à établir | à établir | **Absente en pratique** — 10/126 |
| `derniereInspectionDate` | — | à établir | à établir | **Absente** — 0/126 |

L'état des ouvrages mérite une réserve explicite : 104 sur 126 sont déclarés `BON`,
alors qu'aucune inspection n'a jamais été enregistrée dans le système et qu'aucun de
ces jugements n'est daté. On ignore qui a porté cette appréciation et quand.

---

## 4. Péages et pesages — le module n'est pas vide par manque de données

C'est la découverte la plus inattendue de cet inventaire.

La table `postes` compte 0 ligne. Mais le journal d'audit conserve **10 suppressions
effectuées le 1er juillet 2026**, et ces 10 enregistrements se réduisent à **6 sites
distincts** — les autres étaient des doublons d'accentuation (« Peage de Kilissi » et
« Péage de Kilissi »).

| Site | Type | Statut | Région | Trafic JMA | Recettes mensuelles (GNF) |
|---|---|---|---:|---:|---:|
| Péage de Kilissi | PEAGE | EN_SERVICE | 3 | 3 200 | 285 000 000 |
| Péage de Kilomètre 36 | PEAGE | EN_SERVICE | 3 | — | — |
| Péage de Maférinyah | PEAGE | EN_SERVICE | 9 | 2 100 | 198 000 000 |
| Pesage de Mamou | PESAGE | EN_SERVICE | 4 | — | — |
| Poste de pesage de Kissidougou | PESAGE | HORS_SERVICE | 6 | 1 500 | — |
| Poste de pesage de Linsan | PESAGE | EN_SERVICE | 3 | 3 200 | — |

**Le module a donc été vidé pour supprimer des doublons, et jamais repeuplé.** La
suppression était justifiée ; l'absence de reprise ensuite ne l'est pas.

### Réserve majeure sur ces chiffres

Ces valeurs **ne doivent pas être traitées comme des comptages réels** en l'état.
Trois indices vont contre :

- Kilissi et Linsan portent **exactement la même valeur**, 3 200 ;
- toutes les valeurs sont rondes à la centaine ou au million ;
- aucun de ces postes n'avait de coordonnées (`pk` et géométrie vides).

C'est la signature d'un jeu de démonstration, pas d'une campagne de comptage. Elles
sont consignées ici parce qu'elles constituent une piste — quelqu'un a saisi ces
sites, il faut retrouver qui et sur quelle base — pas parce qu'elles sont exploitables.

**Ce que cela change pour le §6** : le modèle de trafic existe déjà dans le schéma
(`postes.traficJma`), et le réseau compte au moins 6 points de mesure identifiés
nominativement. C'est un point de départ concret pour une collecte, et non un module
à concevoir de zéro.

---

## 5. Modules sans aucune donnée ni trace

| Module | Lignes | Trace dans l'audit | Lecture |
|---|---:|---|---|
| Marchés | 0 | aucune | jamais alimenté |
| Décomptes | 0 | aucune | jamais alimenté |
| Ordres de travaux | 0 | aucune | jamais alimenté |
| Signalements citoyens | 0 | aucune | jamais alimenté |

Contrairement aux postes, ces quatre modules n'ont jamais rien contenu. Le journal
d'audit ne porte pas une seule opération sur eux.

---

## 6. Référentiels internes — les acquis à ne pas refaire

| Référentiel | Lignes | Fiabilité |
|---|---:|---|
| `regions` | 9 | **Cohérente**, mais inclut une entrée « Non renseigné » qui n'est pas une région |
| `bailleurs` | 5 | **Cohérente** |
| `matrices_degradation` | 9 | **Cohérente** |
| `baremes_intervention` | 9 | **Cohérente** |

Ces quatre tables sont peuplées et fonctionnelles. Le brief ne les mentionnait pas.
Elles ne doivent pas être reconstruites.

La région « Non renseigné » est en revanche un problème de modèle : elle fait passer
une absence de donnée pour une donnée. 50 chantiers y sont rattachés.

---

## 7. Comptes et accès

| Rôle | Comptes | Actifs |
|---|---:|---:|
| ADMIN | 3 | 3 |
| GESTIONNAIRE | 2 | 1 |
| LECTEUR | 1 | 1 |

163 connexions réussies et 24 échouées sont enregistrées. Cinq comptes actifs pour un
référentiel national : la charge de saisie repose aujourd'hui sur très peu de personnes,
ce qui explique en partie l'état de l'alimentation.

---

## 8. Ce que cette matrice établit

1. **Aucune donnée de la BDRI n'a de source documentée.** La colonne « source
   technique » dit comment elle est entrée, jamais d'où elle vient.
2. **Une seule donnée est vérifiée** au sens strict : la longueur des RN et RU,
   recoupée avec la géométrie.
3. **Deux données sont contredites** par la base elle-même : le revêtement, et le
   statut de 41 chantiers.
4. **Les deux colonnes organisationnelles sont vides** et le resteront tant qu'AGEROUTE
   n'aura pas désigné, pour chaque donnée, qui en répond et à quel rythme elle doit
   être rafraîchie. C'est une décision, pas une mesure.

Tant que la colonne « responsable » est vide, aucune fréquence de mise à jour n'est
tenable : une donnée sans propriétaire ne se met pas à jour.
