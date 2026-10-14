# Conception des moteurs d'évaluation, de prévision et de programmation

> Livrable 7 du § B.6, fondé sur le § 7.7 du prompt maître V10 — « cœur décisionnel ».
> **Rédigé le 14/10/2026.**
>
> 🔒 Ce document est une **conception**, étiquetée proposition. Le § 7.7 est explicite : « aucun
> calcul normatif n'est activé comme officiel avant approbation des paramètres ». Et le § B.6
> interdit de décrire une fonction comme existante avant qu'elle soit implémentée et testée.
> Le § 1 dit donc d'abord **ce qui existe**, et c'est peu.

## 1. État réel, mesuré le 14/10/2026

| Moteur nommé par le § 7.7 | Ce qui existe | Ce qui n'existe pas |
|---|---|---|
| **RCI** | `engines/condition.ts`, 38 tests ; `regles_condition` 1 version, **désapprouvée le 14/10** ; version de formule, couverture et motif de refus stockés à côté de chaque résultat | aucun score publié ; **0 évaluation** ; confrontation VIZIR/UEMOA à faire (D-01) |
| **Risk Engine** | colonne `troncons.criticiteStrategique` (entier) — **provenance et taux de remplissage non mesurables** depuis le gel de la production | tout le moteur |
| **Treatment Engine** | `matrices_degradation`, **9 lignes, lues par aucun code** | catalogue des traitements, conditions d'application, durées de vie, effets, fenêtres saisonnières |
| **Cost Engine** | `baremes_intervention`, **9 lignes**, 350 M à 3,5 Md GNF/km, `source = standard_initial`, **aucune approuvée**, millésime et largeur **inconnus** (D-07) ; colonne `troncons.coutRehabEstime` — provenance non mesurable | bordereau versionné par année et région, classes de précision, estimation depuis les métrés |
| **Programming Engine** | rien | PPE, PAE, scénarios, optimisation, fiche d'intervention, cycle de vie |
| **Control Tower** | tableau de bord qui **ignore portions et qualité** ; `reseau/couverture.reseau.ts` reproductible (212 ms) | cellule de veille, suivi programme/réalisé, suivi budgétaire |
| **Fiche 360°** | existe pour tronçon et ouvrage | volet portion, volet programmation |
| **Lois de vieillissement** | **trouvées — correction** : `matrices_degradation` est exactement cela. 9 lignes = 3 familles de revêtement (bitume, terre/latérite, pavé) × 3 classes de trafic (T1 faible, T2 moyen, T3 fort), chacune portant trois **probabilités de transition markoviennes** `pBonVersMoyen`, `pMoyenVersMauvais`, `pMauvaisVersCritique`, avec `source = standard_initial`, version 1, **aucune approuvée**. C'est la « spécification existante » du § 7.7. Elle n'est **pas** l'embryon du catalogue des traitements, comme la première version de ce document l'écrivait : les traitements sont dans `baremes_intervention` (`typeIntervention`) | le pas de temps des probabilités (annuel ?) **n'est pas documenté** ; aucun recalage possible sans observations répétées |

**Et la contrainte qui domine la conception** : `missions`, `observations`, `defauts`,
`portions`, `evaluations_condition` sont à **0 ligne**. Un moteur de programmation sans état
observé produirait un programme depuis des valeurs d'import — précisément ce que le § 7.7
interdit de présenter comme officiel.

## 2. Le contrat commun aux cinq moteurs — proposition

Le § 7.7 l'exige pour chacun : **entrées, sorties, `method_id`, version, date d'effet,
approbateur, paramètres, limites**. Le dépôt en a déjà le modèle avec `regles_condition` :

| Élément | Déjà présent pour le RCI | À généraliser |
|---|---|---|
| `method_id` + `version` | `regles_condition.version` (`rci-2026.1`) | une table `method_versions` commune (nom conceptuel du § C) |
| approbation datée et signée | `approuveeLe`, `approuveeParId` | identique pour chaque moteur |
| `publiable` figé à l'écriture | oui — un résultat ne change pas de sens rétroactivement | identique |
| motif de refus | couverture insuffisante → refus **avec motif** | identique : un moteur qui ne peut pas calculer **le dit**, il ne devine pas |
| résultat « provisoire » tant que non approuvé | oui | identique |

**Règle de conception** : un moteur ne renvoie jamais un nombre seul. Il renvoie *(valeur,
méthode, version, date d'effet, paramètres, couverture, provisoire ou non)*. C'est ce qui rend
la décomposition « pourquoi cette note » possible, et c'est ce qui manque à `coutRehabEstime`
et `criticiteStrategique` tels qu'ils sont : des nombres orphelins.

## 3. Évaluation — proposition

### 3.1 RCI et note UEMOA, côte à côte

Le § 7.7 tranche ce que `RCI_METHOD_DECISION.md` avait posé en écart É-1 : les deux indices
**coexistent**, « calculés en parallèle », « affichés avec leur méthode et comparés ». Le RCI est
l'indice d'état **d'AGEROUTE**, la note UEMOA l'indice **harmonisé** — ni l'un ne remplace
l'autre.

- RCI **par portion** homogène — l'existant.
- Note UEMOA **par section fixe**, projection des portions via `reseau_sections_fixes` —
  l'existant du 14/10, **sans la note** tant que la directive n'est pas obtenue.
- Les deux dans la fiche 360°, chacun avec `method_id` et version.

### 3.2 Indice de risque — à ne pas écrire avant les données

Formule du § 7.7 : état × trafic ou importance × enjeux de sécurité × vulnérabilité climatique ×
population desservie. Sur les cinq facteurs, **un seul existe** aujourd'hui (l'état, par
import) ; trafic (aucun flux), sécurité (`points_noirs`, remplissage non mesuré), climat
(CHIRPS, partie E non commencée), population (WorldPop, idem) sont absents. Écrire le moteur
maintenant produirait un indice à un facteur portant un nom à cinq.

**Proposition** : le moteur existe en code **seulement quand au moins trois facteurs ont une
source**, et il renormalise sur les facteurs disponibles en l'affichant — comme le RCI le fait
pour `TRAFIC`.

### 3.3 Prévision

Deux horizons que le § 7.7 distingue, et qu'il faut garder distincts :

| Horizon | Objet | Prérequis absolus |
|---|---|---|
| **Pluriannuel** (1, 3, 5, 6 ans) | lois de vieillissement markoviennes par revêtement, classe de trafic, zone climatique ; lois d'effet des traitements ; coût de l'inaction | **deux observations datées** du même objet au minimum, sinon aucune loi n'est recalable. Aujourd'hui : zéro |
| **Court terme** (6–12 mois) | probabilité de coupure avant et pendant la saison des pluies | historique des coupures (main courante § 7.17, absente), pluviométrie (partie E) |

Les deux familles sont « paramétrables, versionnées et recalées sur les observations
post-travaux » — donc elles **attendent le pilote corridor**, seule source d'observations
répétées à court terme.

## 4. Traitements et coûts — proposition

| Objet | Conception | Ce que le dépôt a déjà |
|---|---|---|
| **Catalogue des traitements** | famille, conditions (état × revêtement × trafic), durée de vie attendue, effet sur l'indice, **fenêtre de réalisation** hors saison des pluies **par région** | `matrices_degradation` en est l'embryon : 9 lignes à relire et à versionner |
| **Bordereau de prix** | GNF, **versionné par année et par région** (transport des matériaux), source et date, historique | `baremes_intervention` : 9 lignes **sans millésime ni largeur** — D-07 doit être tranchée avant toute estimation |
| **Estimation** | quantités du référentiel × bordereau, avec **classe de précision affichée** : réseau ±30 %, pré-étude ±15 %, métré validé | les métrés validés viendront des `defauts` (`quantite`, `uniteQuantite`, `methodeQuantite` existent) |

**Règle** : une estimation **refuse** de calculer quand le bordereau n'a pas de ligne — `BETON`,
`AUTRE`, `NON_RENSEIGNE` n'en ont aucune (D-07). Deviner un prix est pire que n'en donner aucun.

## 5. Programmation — proposition

### 5.1 PPE et PAE

- **PPE glissant 3–5 ans** sous contraintes : enveloppes par année et **par source** (FER, budget
  national, bailleurs, conventions minières), équité régionale minimale, continuité d'itinéraire,
  corridors stratégiques, fenêtres saisonnières, capacité de réalisation.
- Optimisation **explicable** : classement bénéfice/coût (gain d'indice × trafic × population /
  coût) puis affectation gloutonne sous contraintes ; PLNE en option. **Chaque intervention
  retenue ou écartée porte sa justification lisible** — c'est le critère A22.
- **Scénarios** : budget constant / maintien de l'état / optimal / contraint par source, chacun
  avec état projeté, backlog, carte, coût ; curseur budget (PR-10).
- **PAE** dérivé du PPE, arbitrage manuel **tracé** (qui, quoi, pourquoi, pièces), propositions
  régionales consolidées (PR-13).
- **Stratégies** compatibles L²R Programme : règles état × revêtement × trafic → traitement ;
  import des pré-programmes ONR pour comparaison **côte à côte**, écarts expliqués (IO-07).

### 5.2 Le cycle de vie, et la ligne que DigitalRoad trace dedans

```
BROUILLON → PROPOSÉ → ARBITRÉ → APPROUVÉ → TRANSMIS → EN_EXÉCUTION → ACHEVÉ → ÉVALUÉ
                                            ────────── reçus de DigitalRoad ──────────
```

Les statuts **à partir de `TRANSMIS` sont reçus**, jamais saisis dans le Géoportail. C'est la
même frontière que TI-01 tient par l'absence de colonnes : ici, elle se tient par l'absence de
**transition** — aucun chemin d'écriture ne mène de `APPROUVÉ` à `EN_EXÉCUTION` sans un message
de DigitalRoad. Le garde-fou de `taches-internes.garde.test.ts` est le modèle du test à écrire.

### 5.3 La fiche d'intervention

Objet unitaire transmis à DigitalRoad : identifiants patrimoniaux, plage linéaire, traitement,
quantités, coût estimé **et classe de précision**, score et justification, année, source de
financement. **Version figée à la transmission** — même mécanisme que `publiable` figé à
l'écriture : ce qui a été transmis ne change pas de sens parce que les paramètres changent.

Les pièces d'estimation (BPU, DQE, Excel détaillé) sont **reprises** par DigitalRoad pour la
passation, **sans constituer un engagement**. Le § 7.7 🔒 le redit, et ce document le répète :
aucune estimation ni programmation ne crée de marché, contrat, OT, chantier, décompte,
certification ni engagement.

### 5.4 Boucle de retour

- **Suivi programme vs réalisé** : écarts physiques et temporels depuis les retours DigitalRoad
  (X-18, bloqué B-11).
- **Évaluation après travaux** : inspection typée **« post-travaux »** par AGEROUTE — état mesuré,
  photos après, IRI — rattachée à la fiche. C'est un **constat d'état du patrimoine, pas une
  réception de travaux**. Elle recale les lois de vieillissement et les coûts unitaires.
- **Suivi budgétaire** : consommation par source et par trimestre, réalisé remonté par
  DigitalRoad.

## 6. Ordre de construction — proposition, et pourquoi il est à l'envers de l'intuition

L'intuition dit : d'abord le moteur de programmation, c'est lui qu'on montre. La dépendance dit
le contraire :

1. **D-07 tranchée** (millésime, largeur), sinon aucune estimation n'est défendable ;
2. **catalogue des traitements** depuis `matrices_degradation`, versionné ;
3. **estimation avec classe de précision**, qui refuse quand elle ne sait pas ;
4. **fiche d'intervention et cycle de vie**, avec le garde-fou de transition ;
5. **PPE glouton explicable** sur les données disponibles, étiqueté « estimation réseau ±30 % » ;
6. **scénarios et curseur** ;
7. **lois de vieillissement** — **après** les premières observations répétées du pilote, pas
   avant ;
8. **indice de risque** — quand trois facteurs sur cinq ont une source.

Et avant tout cela, la condition que rien ici ne lève : **que des données de terrain entrent**.
Un programme calculé sur des valeurs d'import serait un programme calculé sur `BITUME` partout
sans exception — la contradiction C-4 de `DATA_SOURCE_OF_TRUTH.md`.
