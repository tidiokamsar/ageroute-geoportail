# BDRI — Inventaire réel des données

**Date de mesure** : 1er septembre 2026
**Base** : `console_bdri` en production, accès lecture seule
**Méthode** : comptage exact ligne à ligne. Aucune estimation.

---

## Avertissement de méthode

La première tentative d'inventaire s'est appuyée sur `pg_stat_user_tables.n_live_tup`,
la statistique interne de PostgreSQL. Elle annonçait **0 chantier**, alors que la table
en contient 488. Ce compteur n'est rafraîchi que par `ANALYZE` et dérive librement
entre deux passages.

Tous les chiffres ci-dessous viennent de `count(*)`, avec le filtre `deletedAt IS NULL`
là où la suppression logique existe.

---

## 1. Volumes exacts

| Table | Lignes | Statut |
|---|---:|---|
| `troncons` | **1 690** | alimenté |
| `chantiers` | **488** | alimenté |
| `audit_logs` | 1 423 | alimenté |
| `ouvrages` | **126** | alimenté |
| `matrices_degradation` | 9 | référentiel |
| `baremes_intervention` | 9 | référentiel |
| `regions` | 9 | référentiel |
| `users` | 6 | alimenté |
| `bailleurs` | 5 | référentiel |
| `indicateurs_reseau_historique` | 3 | alimenté |
| `points_noirs` | **2** | quasi vide |
| `inspections` | **1** | quasi vide |
| `documents` | **1** | quasi vide |
| `marches` | **0** | vide |
| `decomptes` | **0** | vide |
| `ordres_travaux` | **0** | vide |
| `signalements_citoyens` | **0** | vide |
| `postes` (péages / pesages) | **0** | vide |

### Écarts avec le brief

Le brief annonçait 0 inspection et 0 document. La base en contient une de chacun.
L'inspection unique date du 29 juin 2026, porte l'état `BON`, est rattachée à un
tronçon, et a été créée par le compte `tidiane.diallo@ageroute.gov.gn`.

Elle a son importance : elle établit que la chaîne inspection fonctionne au moins une
fois de bout en bout. Elle n'établit rien sur l'usage terrain.

Le brief ne mentionnait pas les référentiels. Ils sont peuplés : 9 régions, 5 bailleurs,
9 matrices de dégradation, 9 barèmes d'intervention. Ce sont des acquis qu'il ne faut
pas refaire.

---

## 2. Tronçons — remplissage champ par champ

| Champ | Renseigné | Taux | Lecture |
|---|---:|---:|---|
| `code` | 1 690 | 100 % | |
| `nom` | 1 690 | 100 % | |
| `classe` | 1 690 | 100 % | RN 621 / RR 1 029 / RU 40 |
| `regionId` | 1 690 | 100 % | |
| `geom` | 1 690 | 100 % | toutes valides, toutes en 4326 |
| `pkDebut` + `pkFin` | **1 690** | **100 %** | le référencement linéaire existe déjà |
| `revetement` | 1 690 | 100 % | **une seule valeur : `BITUME`** |
| `etat` | 1 690 | 100 % | **mais 1 043 valent `NON_EVALUE`** |
| `longueurKm` | 662 | 39,2 % | 621 RN + 40 RU + 1 RR |
| `traficMoyenJma` | **0** | 0 % | |
| `traficDateComptage` | **0** | 0 % | |
| `criticiteStrategique` | **0** | 0 % | |
| `coutRehabEstime` | **0** | 0 % | |
| `dateDerniereEvaluation` | **0** | 0 % | |
| `prefecture` | **0** | 0 % | |
| `commune` | **0** | 0 % | |

### Les deux champs qui trompent

**`revetement` est rempli à 100 % et ne dit rien.** Une seule valeur distincte sur
1 690 lignes n'est pas une observation, c'est un défaut d'import. Détail et preuve
dans `TRONCONS-DATA-AUDIT.md` §6.

**`etat` est rempli à 100 % et n'est renseigné qu'à 38 %.**

| État | Tronçons | Part |
|---|---:|---:|
| `NON_EVALUE` | **1 043** | **61,7 %** |
| `MOYEN` | 296 | 17,5 % |
| `MAUVAIS` | 135 | 8,0 % |
| `BON` | 118 | 7,0 % |
| `CRITIQUE` | 98 | 5,8 % |

`NON_EVALUE` est une valeur honnête — elle dit qu'on ne sait pas. Mais un taux de
remplissage de 100 % sur ce champ est une mesure trompeuse : la donnée utile n'existe
que sur 647 tronçons.

Et **aucun de ces 647 n'a de date d'évaluation**. Un état « BON » sans date n'est pas
comparable à un autre état « BON » : on ignore s'il date d'un mois ou de dix ans.

---

## 3. Le score d'aide à la décision, mesuré

Le brief indiquait que trois des quatre critères sont vides. La mesure est plus sévère.

| Critère | Renseigné | Taux réel |
|---|---:|---:|
| État | 647 / 1 690 | **38,3 %** (le reste est `NON_EVALUE`) |
| Trafic | 0 / 1 690 | **0 %** |
| Criticité stratégique | 0 / 1 690 | **0 %** |
| Coût de réhabilitation | 0 / 1 690 | **0 %** |

Trois critères sur quatre sont entièrement vides, et le quatrième manque sur 62 % du
réseau. Un score calculé là-dessus classe en réalité les tronçons selon le seul état,
sur la petite moitié du réseau où il est connu, sans savoir de quand il date.

C'est la justification du §9 du brief : le module ne doit pas être présenté comme une
aide à la décision fiable tant que ces colonnes sont vides.

---

## 4. Chantiers — 488 lignes, presque aucune localisation

| Niveau de localisation | Chantiers | Part |
|---|---:|---:|
| **Précise** — géométrie propre | 6 | 1,2 % |
| **Linéaire** — tronçon + PK, sans géométrie | **0** | 0 % |
| **Approximative** — région réelle | 432 | 88,5 % |
| **Aucune** — région « Non renseigné » | **50** | **10,2 %** |

Le §17 du brief prévoit trois niveaux. La mesure en trouve un de moins et un de plus.

Le niveau **linéaire est vide** : les 4 chantiers qui portent un `tronconId` sont les
mêmes que ceux qui ont déjà une géométrie. Aucun chantier n'est référencé par
route + PK seuls. Le niveau intermédiaire, qui est pourtant le plus réaliste à
alimenter, n'est utilisé par personne.

Et il existe un niveau **en dessous de l'approximatif** : 50 chantiers sont rattachés
à une région littéralement nommée « Non renseigné ». Ceux-là n'ont aucune
localisation, pas même régionale.

Répartition régionale des 488 :

| Région | Chantiers |
|---|---:|
| Conakry | **224** |
| « Non renseigné » | 50 | 
| Kankan | 49 |
| Kindia | 49 |
| Nzérékoré | 32 |
| Faranah | 25 |
| Labé | 21 |
| Mamou | 20 |
| Boké | 18 |

Conakry concentre 46 % des chantiers. C'est plausible pour des travaux urbains, mais
ce chiffre n'a pas été vérifié contre une source externe : il pourrait aussi refléter
une valeur par défaut au moment de la saisie. À contrôler avant toute exploitation.

Autres champs :

| Champ | Renseigné / 488 |
|---|---:|
| `entreprise` | 488 |
| `montantGnf` | 437 |
| `numContrat` | 414 |
| `intitule` portant une longueur (km ou ml) | 221 |
| `tronconId` | 4 |
| `observations` | 3 |

---

## 5. Ouvrages d'art — géolocalisés mais non caractérisés

| Champ | Renseigné / 126 |
|---|---:|
| `etat` | 126 |
| `longueurM` | 126 |
| `geom` | **124** |
| `pk` | 124 |
| `tronconId` | 114 |
| `anneeConstruction` | **10** |
| `materiau` | **10** |
| `derniereInspectionDate` | **0** |

C'est le module le mieux localisé de la base : 98 % ont une géométrie, 90 % sont
rattachés à un tronçon. Mais aucun n'a jamais été inspecté dans le système, et l'âge
comme le matériau ne sont connus que sur 8 % — deux informations qui déterminent
pourtant la fréquence d'inspection d'un ouvrage.

---

## 6. Provenance — ce que la base ne sait pas

| Question | Réponse |
|---|---|
| Qui a modifié une donnée ? | 1 423 entrées d'audit |
| Qui a créé les 1 690 tronçons ? | **aucune entrée** |
| Qui a créé les 488 chantiers ? | **aucune entrée** |
| D'où viennent ces données ? | **aucun champ ne le dit** |
| Quand ont-elles été vérifiées ? | **aucun champ ne le dit** |

Les créations en masse sont entrées par un chemin qui n'écrit pas dans le journal
d'audit. Le journal ne couvre que ce qui a été modifié ensuite par l'application.

Aucune des six questions du §21 du brief n'a aujourd'hui de réponse dans la base.

---

## 7. Synthèse : où en est réellement la BDRI

| Domaine | Ce qui est acquis | Ce qui manque |
|---|---|---|
| Réseau routier | 1 690 tronçons, géométrie complète et valide, PK complets | longueur RR, revêtement réel, trafic, coût, criticité |
| Ouvrages | 126, dont 124 géolocalisés et 114 rattachés | âge, matériau, toute inspection |
| Chantiers | 488, avec entreprise, montant, contrat | localisation sur 478 d'entre eux |
| Référentiels | régions, bailleurs, matrices, barèmes | préfectures, communes, localités |
| Inspections | la chaîne fonctionne (1 cas) | tout usage terrain |
| Marchés, OT, signalements, péages | — | tout |
| Provenance | journal des modifications | origine, source, date de validité |

Le socle géographique est bon. C'est l'attribution — ce qu'on sait de chaque objet —
qui est absente.
