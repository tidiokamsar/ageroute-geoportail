# Audit du RCI — coefficients, formule effective, seuils, anomalies

Mesuré le 13/10/2026 contre le code et la base de production. Document demandé par
l'addendum V4.1, livrable 1.

## 1. Où les coefficients, seuils et règles sont définis

**Dans un seul endroit, et c'est une donnée, pas du code.**

| Élément | Où il vit |
|---|---|
| Pondérations | colonne `poids` de `regles_condition`, JSON |
| Correspondance état-vers-score | colonne `normalisation`, JSON |
| Classes de score | colonne `classes`, JSON |
| Seuil de couverture | colonne `couvertureMinimale` |
| Fraîcheur maximale | colonne `fraicheurMaxJours` |
| Confiances acceptées | colonne `confiancesAcceptees` |
| Sens du score | colonne `sensCroissant` |
| Approbation | colonnes `approuveeLe` / `approuveeParId` |

Le seul fichier qui porte des nombres est `backend/scripts/peupler-regle-condition.ts`, et
son rôle est de les **écrire en base**. Aucune valeur n'est lue depuis le code au moment du
calcul.

## 2. Définitions concurrentes : aucune

L'addendum demande de les chercher dans le frontend, le backend, les bases, les tableaux de
bord et les scripts. Recherche faite sur tout le dépôt :

| Recherche | Résultat |
|---|---|
| `RCI`, `rci*`, `conditionIndex`, `indiceEtat` hors documentation | 12 occurrences, **toutes des commentaires** renvoyant à la règle |
| Nombres 30 / 15 / 10 associés à une composante, hors moteur | **aucun** |
| Dans `frontend/src` | **aucun** |
| Dans le module tableau de bord | **aucun** |

**La centralisation demandée est donc acquise par construction**, et non par discipline :
les coefficients n'existent nulle part ailleurs qu'en base, et aucune application ne peut
donc en utiliser de divergents.

## 3. La formule effective

```
score = somme( valeur_normalisee(composante) x poids_effectif(composante) )

ou poids_effectif = poids_declare / somme(poids des composantes RETENUES)
```

**La renormalisation est le cœur de la formule**, et trois comportements en découlent :

**Une composante absente ne vaut pas zéro.** Elle est retirée du calcul et son poids
redistribué. Compter l'absence comme zéro noircirait un tronçon faute de données ; la
compter comme la moyenne serait pire, parce qu'invisible.

**Sous la couverture minimale, le moteur REFUSE.** Il ne rend pas un score prudent : il rend
`null` avec un motif, et le refus est conservé en base. « On a regardé sans pouvoir
conclure » n'est pas « il n'y a pas d'évaluation ».

**La confiance prend le maillon le plus faible** et se dégrade avec la couverture.

### Unités, arrondis, valeurs manquantes

| Point | Traitement |
|---|---|
| Intervalle du score | 0 à 100, 100 étant le meilleur état (`sensCroissant`) |
| Arrondi du score | **1 décimale** |
| Arrondi de la couverture | 3 décimales |
| Valeur source illisible | composante **ABSENTE**, jamais zéro |
| Valeur hors 0-100 dans la normalisation | **refusée**, composante absente |
| Date d'observation absente | **PÉRIMÉE**, jamais fraîche |
| Confiance absente | **CONFIANCE_INSUFFISANTE**, jamais supposée bonne |
| Score `null` | **aucune classe**, jamais « critique » |

## 4. Les arbitrages, et qui les a pris

| Paramètre | Valeur | Qui | Quand |
|---|---|---|---|
| Pondérations | 30/15/15/10/10/10/5/5 | cahier §13, **non calibrées** | — |
| Correspondance | BON 90, MOYEN 65, MAUVAIS 35, CRITIQUE 10 | **AGEROUTE** | 13/10/2026 |
| Classes | six, 0 à 100, bornes inclusives | **AGEROUTE** | 13/10/2026 |
| Couverture minimale | **0,5** | **AGEROUTE**, après mesure | 13/10/2026 |
| Fraîcheur | 365 jours | proposée, **non arbitrée** | — |
| Confiances acceptées | `HIGH`, `MEDIUM` | proposées, **non arbitrées** | — |
| **Approbation de la règle** | **NON** | — | — |

**La règle n'est pas approuvée**, donc tout score qu'elle produirait sort avec
`publiable: false` et porte « NON APPROUVÉE — ne pas publier » dans son explication.

### Une divergence de coefficients, vérifiée

AGEROUTE a transmis une liste de neuf composantes. Comparée à `rci-2026.1` :

| Composante | Liste AGEROUTE | `rci-2026.1` |
|---|---|---|
| chaussée, drainage, ouvrages | 30, 15, 15 | **identiques** |
| sécurité, trafic | 10, 10 | **identiques** |
| historique, incidents | 5, 5 | **identiques** |
| **signalisation** | **absente** | **10** |
| **environnement** | **5** | absente |
| **autres critères** | **5** | absente |
| Total | **100** | **100** |

Sept postes sur neuf concordent. L'écart tient en un bloc de dix points : la signalisation
devient environnement 5 + autres 5. Les deux totalisent 100, aucune n'est arithmétiquement
fausse, **mais ce n'est pas un renommage** : la signalisation est inventoriable, et depuis le
13/10 c'est même une famille d'actif à part entière. « Autres critères » ne l'est pas.

`ENVIRONNEMENT` et `AUTRES` ont été ajoutées à l'enum pour pouvoir **exprimer** cette
proposition, donc la comparer. Les ajouter ne les approuve pas.

**`AUTRES` est structurellement problématique** : une composante sans définition n'est
mesurable par rien, donc toujours absente, donc ses cinq points sont du poids mort
renormalisé à chaque calcul. Tant qu'elle n'est pas définie, la liste à neuf composantes
fonctionne en pratique comme une liste à huit sur 95 points.

## 5. Les composantes sont-elles calculées sur des données fiables et récentes ?

**Non, et il n'y en a presque aucune.** Mesure en production :

| Composante | Source | Données disponibles |
|---|---|---|
| CHAUSSEE | `troncons.etat`, portions validées | **6 840 / 261 387**, soit 2,6 % |
| OUVRAGES | `ouvrages.etat` | 126 / 1 172 lisibles, soit 10,7 % |
| TRAFIC | `troncons.traficMoyenJma` | **0 / 261 387** |
| DRAINAGE | défauts d'assainissement | **0 défaut** |
| SIGNALISATION | défauts de signalisation | **0 défaut** |
| SECURITE | défauts de sécurité | **0 défaut** |
| HISTORIQUE | — | **aucune source** |
| INCIDENTS | — | **aucune source** |
| ENVIRONNEMENT | — | **aucune source** |
| AUTRES | — | **aucune source possible** |

**Fiabilité de ce qui existe** : `troncons.etat` est une valeur **déclarée**, pas constatée.
La collecte la retient avec une confiance `LOW`, et une portion validée — datée, attribuée,
validée par un tiers — prime sur elle quand les deux existent.

**Fraîcheur** : aucun `dateDerniereEvaluation` n'a été vérifié contre le seuil de 365 jours
sur l'ensemble du réseau. À faire avant toute approbation, parce qu'un état de 2019 reconduit
aujourd'hui serait une donnée inventée.

## 6. Des scores calculés sur des données incomplètes ?

**Aucun score n'existe.** `evaluations_condition` est vide : la table n'est pas déployée, et
`regles_condition` est vide en production.

Et c'est le résultat voulu. Couverture atteignable, mesurée :

| Situation | Couverture | Tronçons |
|---|---|---|
| Chaussée seule | 0,30 | **6 834** |
| Chaussée + ouvrage | **0,45** | **6** |
| Ouvrage seul | 0,15 | 0 |
| Rien de lisible | — | **254 547** |

**Le maximum atteignable est 0,45.** Avec un seuil à 0,5, le moteur refuse donc chaque score.

Trois options ont été posées à AGEROUTE, avec leurs conséquences chiffrées : 0,5 et zéro
score, 0,45 et six scores, 0,30 et 6 840 scores calculés sur la chaussée seule. **AGEROUTE a
retenu 0,5 le 13/10/2026**, en connaissance de cause.

Un score sur 30 % du modèle serait l'état de chaussée renommé « RCI ». Il porterait sa
couverture et son explication, donc il serait traçable — mais le risque est qu'un tableau de
bord affiche « RCI 65 » et que personne ne lise le 30 %.

## 7. Les tests

| Couverture | Tests |
|---|---|
`engines/condition.test.ts` | 38 |
`engines/condition.collecte.test.ts` | 20 |

Ce qu'ils défendent, et qui n'est pas de l'arithmétique :

- **Bornes de classes** : les douze frontières, une par une, inclusives des deux côtés.
- **Score nul** : aucune classe. Donner « critique » à un refus transformerait un manque de
  données en mauvaise nouvelle sur la route.
- **Score hors classe** : aucune classe, jamais la plus proche.
- **Table de classes mal formée** : trou, recouvrement, bornes inversées, hors intervalle,
  non numériques, classe sans code, table vide. Et la validation des six classes réelles.
- **Valeur illisible** : composante absente, jamais zéro. Y compris une correspondance hors
  bornes ou `NaN`.
- **Renormalisation** : le poids des absentes redistribué, pas compté.
- **Refus** : sous la couverture minimale, et quand aucun poids n'est déclaré.
- **Bout en bout** : dans l'état réel de la base, le moteur refuse avec
  `COUVERTURE_INSUFFISANTE` et une couverture de 0,30. Et dès que la couverture suffit, le
  score sort `publiable: false`.
- **Table de correspondance vide** : aucun score, ce qui est l'état correct avant arbitrage.

## 8. Anomalies trouvées pendant cet audit

**`poids` n'avait aucune contrainte de forme.** `JSONB NOT NULL` depuis le matin du
13/10/2026, donc `poids: "trente pourcent"` passait. Le moteur aurait rendu
`AUCUN_POIDS_DECLARE` — le bon refus pour la mauvaise raison, donc un diagnostic trompeur.
Corrigé : `jsonb_typeof(poids) = 'object'`, et de même pour `normalisation` et `classes`.

**La collecte n'existait pas.** `calculerRci` n'était appelé que par ses tests, et le moteur
refusait de deviner la correspondance état-vers-score. La chaîne s'arrêtait avant de
commencer. Corrigé le 13/10 : `engines/condition.collecte.ts`.

**La classe n'existait pas.** L'ADR notait l'absence faute de seuils arbitrés. Débloqué par
l'addendum V4.1.

## 9. Ce qui reste, et qui n'est pas du code

1. **Trancher les pondérations** : celles du cahier, ou la liste à neuf composantes. Définir
   « autres critères » si elle est retenue, sinon ses cinq points sont du poids mort.
2. **Arbitrer la fraîcheur** (365 jours proposés) et les confiances acceptées.
3. **Approuver la règle**, ce qui est le seul geste rendant un score publiable.
4. **Faire tourner la collecte terrain.** C'est le vrai verrou : sans portions validées, la
   couverture n'atteindra jamais 0,5, quels que soient les coefficients.
5. **Vérifier la fraîcheur des 6 840 états existants** avant approbation.
