# Géolocalisation des chantiers — Phase 4

**Tickets** : T5, T6
**État** : livré et testé, **non déployé**

---

## 1. Point de départ mesuré

| Niveau | Chantiers | Part |
|---|---:|---:|
| Précis — géométrie propre | 6 | 1,2 % |
| Linéaire — tronçon + PK, sans géométrie | **0** | 0 % |
| Approximatif — région réelle | 432 | 88,5 % |
| Aucun — région « Non renseigné » | **50** | 10,2 % |

Le niveau linéaire, le plus réaliste à alimenter, n'était utilisé par personne. Et un
quatrième niveau existait sous l'approximatif : 50 chantiers rattachés à une entrée de
la table des régions littéralement nommée « Non renseigné », qui n'est pas une région
mais un contournement de la contrainte d'obligation.

---

## 2. T6 — Les 50 sortent de la carte

### Le défaut

La carte repliait ces 50 chantiers **sur le centroïde de Conakry**, avec une
dispersion déterministe autour du point. Le commentaire du code assumait ce choix :
garder le chantier « visible et cliquable » plutôt que de le faire disparaître, en le
marquant `approximate`.

L'intention était bonne, la conséquence ne l'est pas. Aucune étiquette ne rend
honnête une épingle à Conakry pour un chantier peut-être situé à Nzérékoré. Le §17 est
explicite : ne jamais inventer une position.

### Ce qui change

`statutLocalisation` est une valeur **dérivée**, jamais saisie, recalculée depuis la
géométrie, le tronçon, les PK et la région :

| Statut | Fondement | Sur la carte |
|---|---|---|
| `PRECISE` | géométrie propre | oui, emprise réelle |
| `LINEAIRE` | tronçon + PK début et fin | oui, emprise déduite |
| `APPROXIMATIVE` | région réelle, ou route sans PK | oui, marqueur régional dit approximatif |
| `NONE` | aucune région exploitable | **non** |

Les `NONE` ne disparaissent pas : `GET /api/chantiers/sans-localisation` les rend
visibles sans leur prêter de position. Retirer les 50 sans cette liste reviendrait à
les effacer.

Tests : 19, dont la régression demandée — un chantier sans localisation n'apparaît
pas comme point géographique, et rien n'est plus replié sur Conakry.

---

## 3. T5 — Propositions depuis les intitulés

### L'extraction fonctionne

Éprouvée sur les 36 intitulés réels contenant une route et un PK :

| Résultat | Intitulés | Exemple |
|---|---:|---|
| Emprise, confiance HIGH | 11 | `PK24 - PK66 RN5 (42 km)` |
| Emprise, confiance MEDIUM | 3 | `pk 39 Tanené (pk 78) rn 3` — aucune longueur pour recouper |
| Route seule, LOW | 19 | `Kankan - pk 41 (Kouroussa) rn 1` — un seul PK |
| Refusé | 3 | `rn23- rn5` — deux routes citées |

Le contrôle par la longueur citée a fait ses preuves : sur
`RN38 … PK94+300 et PK135+100`, l'intervalle calculé vaut 40,8 km, exactement la
longueur annoncée dans le même intitulé.

### Le rattachement ne fonctionne pas, et c'est le résultat qui compte

**Sur les 14 emprises extraites, zéro trouve un tronçon qui la couvre.**

| Cause | Mesure |
|---|---|
| Échelle | les emprises font 40 à 55 km, les tronçons quelques km : chaque emprise chevauche **4 à 36 tronçons** |
| PK non continus | sur la RN5, six tronçons commencent à PK 0 ; la somme des intervalles vaut 433 km pour un PK maximum de 156. **24 désignations sur 42** ont un PK de départ dupliqué |
| PK hors étendue | `RN38 PK94→135` vise une route dont le PK maximum en base est 61,6 |

Le texte est clair, la cible ne l'est pas. Le référencement linéaire de la BDRI n'est
pas exploitable en l'état — les PK sont locaux à des branches d'import, pas continus
par route.

### Ce qui est livré

Une file de **propositions** qu'un agent tranche. Chaque proposition porte l'intitulé
d'origine tel quel, les PK lus, la longueur citée, la confiance, et le motif. L'agent
juge sur pièce, pas sur une interprétation, et peut corriger la cible.

**`chantiers.geom` n'est écrit que par `POST /valider`**, par un agent identifié, et
la validation est refusée sans tronçon **et** deux PK — valider une proposition vide
marquerait le chantier comme localisé sans qu'il le soit. Chaque validation est
tracée dans le journal d'audit avec la méthode.

Tests : 28, dont 15 sur l'extraction et 13 sur l'API et ses refus.

### Correction de mes propres documents

J'avais annoncé « de 6 à 42 chantiers localisés, soit sept fois plus ». C'était une
estimation faite sans avoir testé le rattachement. Le gain immédiat est une file de
33 propositions instruites, pas des chantiers localisés.

---

## 4. Le gisement principal reste bloqué

299 intitulés portent un couple origine-destination — `Pita-Maci-Sangareah`,
`N'zérékoré-Macenta`. Aucun tronçon ne porte de nom de localité : leur champ `nom`
vaut le code ou une désignation courte. **La cible n'a pas de noms.**

Ce gisement — 61 % des chantiers — ne s'ouvrira pas avant un référentiel
administratif, et l'extraction OSM reçue n'en fournit pas : `CL_ADMIN` vaut « Autre »
sur ses 262 656 enregistrements.

---

## 5. Ce que la Phase 4 change dans les chiffres

| | Avant | Après déploiement et validation des propositions |
|---|---:|---:|
| Chantiers affichés à une position fausse | 50 | **0** |
| Chantiers localisés précisément | 6 | 6, plus ce que les agents valideront |
| Propositions instruites en attente | 0 | 33 |
| Chantiers listés sans localisation | 0 | 50 |

Le premier chiffre est le seul gain automatique, et c'est le plus important : la carte
ne ment plus.
