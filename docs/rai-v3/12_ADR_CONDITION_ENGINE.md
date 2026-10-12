# ADR proposé pour le moteur d'état du réseau

Date : 12/10/2026  
Statut : proposition à valider ; aucune migration créée ou appliquée.  
Périmètre : phase RCI du cahier des charges AGEROUTE RAI V3.1.

## Constat vérifié

Le dépôt ne contient pas de moteur RCI. `Troncon.etat` et `Troncon.dateDerniereEvaluation`
portent un état courant, tandis que `ValeurQualite` garde la provenance d'une valeur par
champ. Aucun de ces modèles ne conserve un score 0–100, ses composantes, la règle
utilisée et la version de cette règle. La matrice de schéma classe donc
`ConditionAssessment` comme ajout.

Le cahier des charges donne des coefficients indicatifs (chaussée 30 %, drainage 15 %,
ouvrages 15 %, signalisation 10 %, sécurité 10 %, trafic 10 %, historique 5 %,
incidents 5 %) et demande qu'ils soient configurables et versionnés. Il ne les désigne
pas comme coefficients approuvés. La qualité et la fraîcheur des valeurs existantes
doivent aussi être prises en compte : un état sans date de constat ne permet pas de
comparer les tronçons.

## Options examinées

1. **Réutiliser `Troncon.etat` et `ValeurQualite`.** Aucun changement de schéma, mais
   impossible de conserver l'historique des scores, leurs composantes et la version de
   la règle. Cette option ne satisfait pas la traçabilité demandée.
2. **Ajouter une règle versionnée et des évaluations historisées.** Une table de règles
   conserve les coefficients et la version de formule ; une table d'évaluations relie le
   tronçon, le score, la date, la confiance, les composantes et un instantané des sources.
   C'est une migration additive et le modèle s'intègre à `Troncon` et `ValeurQualite`.
3. **Créer un service ou schéma analytique séparé.** Cela isole les calculs, mais
   introduit une nouvelle frontière de données et des mécanismes de synchronisation
   avant qu'il y ait un moteur ou un volume qui le justifie.

## Recommandation

Retenir l'option 2 après validation métier des coefficients et de la règle de données
manquantes. Ajouter trois modèles Prisma :

- `RegleCondition` : identifiant logique, version, version de formule, coefficients,
  état de publication, dates d'effet et auteur/approbateur;
- `EvaluationCondition` : `tronconId`, score 0–100, classe, date de constat, confiance,
  référence de règle et version, score consolidé et instantané des sources.
- `ComposanteEvaluation` : une ligne par composante calculée, avec valeur observée,
  valeur normalisée éventuelle, poids/contribution effectifs, provenance et motif
  d'absence.

Chaque modification de coefficients crée une nouvelle version de règle. Une évaluation
est immuable ; recalculer crée une nouvelle évaluation. Le moteur ne modifie pas
automatiquement les valeurs métier ni `Troncon.etat`. Les observations et défauts non
validés ne contribuent pas au score officiel. Les entrées dont la date, la provenance ou
la confiance ne satisfont pas les règles restent manquantes et ne sont pas remplacées
par une valeur inventée.

## Modèle de données proposé

### Mapping explicite des modèles cibles

Le mapping ci-dessous complète et précise la recommandation de stockage initiale ; aucune
de ces tables n'existe encore dans le schéma local :

| Modèle cible V3.1 | Modèle local proposé | Cardinalité / contenu |
|---|---|---|
| `ConditionRule` | `RegleCondition` | une version publiée de règle référence plusieurs évaluations |
| `ConditionAssessment` | `EvaluationCondition` | une évaluation appartient à un `Troncon` et référence une seule version de règle |
| `ConditionComponent` | `ComposanteEvaluation` | plusieurs composantes détaillent une évaluation ; chacune conserve valeur et provenance utilisées |

Pour la persistance des composantes, trois options ont été comparées : JSON seul (simple
mais difficile à filtrer et agréger), lignes relationnelles seules (requêtables mais
insuffisantes pour reconstituer les entrées si leurs sources changent), ou lignes
relationnelles accompagnées d'un instantané immuable des sources d'entrée. La troisième
option est recommandée : `ComposanteEvaluation` porte les valeurs requêtables et
`EvaluationCondition` conserve l'instantané permettant d'expliquer le score après
évolution des sources. Cette recommandation remplace la mention initiale d'un snapshot
des composantes uniquement embarqué dans `EvaluationCondition`.

### Décisions métier à obtenir avant migration

- Les coefficients initiaux du cahier sont-ils approuvés ou servent-ils uniquement de
  point de départ pour un atelier technique ?
- Quelle règle de normalisation transforme les composantes en un score RCI de 0 à 100 ?
- Quel seuil de fraîcheur et quelle confiance minimale rendent une composante exploitable ?
- Comment calculer un score partiel et signaler qu'il est incomplet ?
- Qui peut approuver une nouvelle version de règle, et à partir de quelle date prend-elle
  effet ?

## Suite proposée

Après approbation de ces règles, préparer une migration additive avec contraintes de
score, clés étrangères vers `Troncon` et `User`, index d'historique, tests de migration
sur une copie de recette et rollback documenté. Puis implémenter le moteur déterministe,
ses tests de calcul, l'audit de publication des règles et une API de lecture/recalcul
protégée par rôle. Aucune donnée historique ne sera rétrocalculée sans validation
métier de sa provenance.
