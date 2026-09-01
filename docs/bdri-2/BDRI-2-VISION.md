# BDRI 2.0 — Vision

**Console BDRI → Référentiel SIG routier national d'AGEROUTE**
1<sup>er</sup> septembre 2026 · Document de cadrage, aucune ligne de code engagée

---

## 1. Ce que la BDRI doit devenir

Un agent d'AGEROUTE ouvre la carte. Il tape « RN3 ». Il voit la route, son état, les
ouvrages qui la jalonnent, les inspections qui l'ont évaluée, les chantiers en cours,
et l'historique de sa dégradation. S'il veut le détail contractuel, un lien l'emmène
vers l'application métier qui le détient.

C'est tout. La BDRI n'a pas d'autre ambition, et cette ambition suffit :
**être le seul endroit où l'on sait où est le patrimoine routier et dans quel état.**

## 2. Ce que la BDRI ne doit pas devenir

AGEROUTE possède déjà ses systèmes de projets, marchés, contrats, finances et
travaux. La BDRI ne les remplace pas. Elle **référence** et **localise**.

La distinction se joue à un endroit précis : la BDRI conserve ce qui a une dimension
géographique ou patrimoniale, et un identifiant externe vers le reste. Un chantier,
dans la BDRI, c'est une emprise sur une route, un statut, un avancement — pas un
échéancier de décomptes.

---

## 3. Le point de départ réel, et il change tout

La vision ci-dessus suppose des données. **Les mesures du 1<sup>er</sup> septembre
montrent qu'elles n'existent pas encore.**

### Cinq modules sur neuf sont vides

| Module | Enregistrements |
|---|---|
| Tronçons | 1 690 |
| Chantiers | 488 |
| Ouvrages d'art | 126 |
| Points noirs | 2 |
| Inspections | **0** |
| Ordres de travaux | **0** |
| Marchés | **0** |
| Signalements citoyens | **0** |
| Péages / Pesages | **0** |

### Et les tronçons eux-mêmes sont largement creux

| Champ | Renseigné sur 1 690 |
|---|---|
| Géométrie valide | **1 690** |
| Longueur non nulle | 662 |
| État évalué | 647 |
| Trafic · Criticité · Coût · Préfecture · Date d'évaluation | **0** |
| Revêtement | 1 690 — **tous à `BITUME`** |

### Ce que cela implique pour le plan

Trois conséquences qui commandent tout le reste.

**Une fiche objet riche afficherait du vide.** Le §8 demande identité, état, photos,
documents, historique, inspections, interventions, objets liés. Sur les données
actuelles, une fiche de tronçon afficherait : un nom, une géométrie, et sept
rubriques vides. Construire l'écran avant la donnée produit une coquille.

**L'aide à la décision calculerait sur rien.** Le §26 veut un score intégrant état,
trafic, sécurité, criticité, ancienneté, coût. **Quatre de ces six critères sont
vides sur la totalité du réseau.** Un score construit là-dessus serait exactement la
« formule opaque » que le §26 interdit — opaque non par sa formule, mais parce que
ses entrées n'existent pas.

**Le seul module qui produit de la donnée est le terrain.** Inspections, dégradations
constatées, photos géolocalisées : c'est la seule fonctionnalité de la liste qui
**alimente** la base au lieu de la lire. Tout le reste l'affiche.

---

## 4. Le renversement que je propose

L'ordre des lots du §48 est celui d'une application dont les données existent :
carte, fiches, référentiel, qualité, terrain, analyse. **Sur les données réelles, cet
ordre construit des vitrines avant d'avoir la marchandise.**

Je propose l'ordre inverse sur les deux premiers temps :

> **Le terrain d'abord. Puis ce qui affiche ce que le terrain a produit.**

Ce n'est pas un désaccord de principe : c'est ce que la mesure impose. Le §48 autorise
explicitement de modifier l'ordre « si l'audit montre qu'une autre dépendance est plus
importante ». C'est le cas, et la dépendance est la donnée elle-même.

Le détail du séquencement est dans `BDRI-2-ROADMAP.md`.

---

## 5. L'actif à préserver

Un chiffre mérite d'être isolé : **zéro géométrie invalide sur 1 690 tronçons.**
Zéro code dupliqué. Zéro PK incohérent.

La couche géométrique est saine. C'est le seul socle sur lequel la BDRI 2.0 peut
s'appuyer sans travaux préalables, et c'est précisément ce qui fait d'elle un candidat
crédible au rôle de référentiel SIG. Tout le reste des données est à construire ; la
géométrie, elle, est là.

**Corollaire :** toute évolution qui dégraderait cette qualité — un import non
contrôlé, une géolocalisation approximative écrite comme si elle était exacte — coûte
plus qu'elle ne rapporte. Le §43 a raison d'exiger un pipeline d'import contrôlé, et
le §21 a raison d'interdire de déplacer arbitrairement les chantiers.

---

## 6. Les six espaces fonctionnels

L'organisation cible du §3 est retenue telle quelle. Elle correspond à des questions
d'utilisateur, pas à un découpage technique :

| Espace | Question à laquelle il répond |
|---|---|
| **Carte** | Où ? |
| **Patrimoine** | Qu'est-ce qui existe ? |
| **Exploitation** | Que s'y passe-t-il ? |
| **Données** | Peut-on s'y fier ? |
| **Analyse** | Que faut-il faire ? |
| **Administration** | Qui peut quoi ? |

Aucun de ces espaces ne demande de nouveau module technique. Ce sont des regroupements
de ce qui existe, plus deux ajouts réels : le **centre de qualité** (espace Données) et
le **référentiel administratif** (espace Données également).

---

## 7. Ce qui rendra la BDRI 2.0 réussie

Le §50 fixe le critère : chercher une route, la localiser, ouvrir sa fiche, voir son
état, ses ouvrages, ses inspections, ses chantiers, son historique, puis l'application
métier.

**Aujourd'hui, quatre de ces neuf étapes sont possibles.** Chercher, localiser, ouvrir
la fiche, voir l'état — c'est ce que fait déjà la carte publique. Les ouvrages
existent mais ne sont pas rattachés à la fiche. Inspections, chantiers localisés,
historique et lien métier n'existent pas.

Le critère de réussite est donc mesurable : **passer de 4 sur 9 à 9 sur 9.** C'est ce
que la feuille de route organise.

---

## 8. Trois règles que la mission impose, et que je fais miennes

1. **Ne jamais renseigner une donnée inventée.** Le référentiel administratif attend
   une source officielle ; les chantiers attendent une localisation réelle ; le
   revêtement attend autre chose qu'une valeur par défaut.
2. **Ne jamais appeler « itinéraire » une distance à vol d'oiseau.** La fonction
   actuelle trompe l'utilisateur ; c'est le correctif le moins coûteux du dossier.
3. **Chaque nouvelle route API reçoit son test de permission.** Trois failles ont été
   trouvées en Phase 2, toutes dans des modules gardés route par route. La règle du
   §46 n'est pas une précaution théorique : elle répond à un défaut constaté trois
   fois.
