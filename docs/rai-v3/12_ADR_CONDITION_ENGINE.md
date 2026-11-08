# ADR proposé pour le moteur d'état du réseau

Date : 12/10/2026  
Statut : proposition à valider ; migration **écrite et non appliquée** depuis le
13/10/2026 — voir l'addendum en fin de document.  
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

---

# Addendum du 13/10/2026 — ce qui est construit, ce qui reste à décider

L'option 2 est retenue et le **mécanisme** est écrit. Les **nombres** ne sont pas
approuvés, et c'est volontaire : la section ci-dessus dit que le cahier ne désigne pas ses
coefficients comme approuvés, et la règle impérative du §39 interdit de publier un chiffre
que personne n'a validé.

## Ce qui existe

| Élément | Fichier |
|---|---|
| Moteur déterministe | [`backend/src/engines/condition.ts`](../../backend/src/engines/condition.ts) |
| 26 tests, qui défendent surtout les **refus** | [`backend/src/engines/condition.test.ts`](../../backend/src/engines/condition.test.ts) |
| Trois modèles, deux enums | `backend/prisma/schema.prisma` |
| Migration additive, **non appliquée** | `backend/prisma/migrations/20261013160000_condition_engine/` |
| Règle `rci-2026.1`, non approuvée | [`backend/scripts/peupler-regle-condition.ts`](../../backend/scripts/peupler-regle-condition.ts) |

Le DDL de la migration a été comparé ligne par ligne à celui que
`prisma migrate diff --from-empty --to-schema-datamodel` produit : colonnes, sept index et
cinq clés étrangères concordent, nom par nom. La migration ajoute en outre onze contraintes
`CHECK` que Prisma ne gère pas et dont l'absence ne crée pas de dérive.

## Les cinq questions métier, et ce que le code en fait

**1. Les coefficients du cahier sont-ils approuvés ?** Répondu, structurellement :
**non**. `approuveeLe` nul est le seul interrupteur qui rend un score publiable, et la
version 1 sort sans. Un score calculé aujourd'hui porte `publiable = false` et la mention
« NON APPROUVÉE — ne pas publier » dans son explication.

**2. Quelle règle de normalisation donne un score de 0 à 100 ?** **Non répondu**, et c'est
le trou le plus important. Le moteur reçoit des composantes **déjà normalisées** entre 0 et
100 et refuse de deviner comment un état `BON` devient un nombre. Rien, aujourd'hui, ne
produit ces valeurs : `calculerRci` n'est appelé que par ses tests. Il manque la couche de
collecte qui lit les huit sources et les convertit — et cette conversion est elle-même une
décision, pas un calcul.

**3. Quel seuil de fraîcheur et quelle confiance minimale ?** **Proposé, non arbitré** :
365 jours et `HIGH` + `MEDIUM` dans la version 1. Une année est la périodicité
d'inspection courante, pas une norme écrite dans le cahier.

**4. Comment calculer un score partiel et le signaler ?** Répondu, et c'est ce que le code
tranche vraiment :

- le poids des composantes disponibles est **renormalisé**. Compter une composante
  manquante comme 0 noircirait un tronçon faute de données ; la compter comme la moyenne
  serait pire, parce qu'invisible ;
- sous `couvertureMinimale`, le moteur **refuse** et dit ce qui manque. Le refus est
  conservé en base : il dit qu'on a regardé sans pouvoir conclure, ce qui n'est pas
  l'absence d'évaluation ;
- la confiance prend le **maillon le plus faible** et se dégrade avec la couverture ;
- chaque composante écartée porte **pourquoi** — `ABSENTE`, `PERIMEE`,
  `CONFIANCE_INSUFFISANTE`, `POIDS_NUL`. `PERIMEE` demande une réinspection, `ABSENTE` un
  inventaire : les confondre enverrait les équipes au mauvais endroit. Une valeur **sans
  date est périmée**, pas fraîche ;
- un refus n'a **pas de confiance** : écrire `LOW` porterait un jugement de qualité sur un
  chiffre qui n'existe pas. La colonne est nulle, et une contrainte l'impose.

**5. Qui approuve une version, et à partir de quand ?** **Non répondu**. Aucune route
d'approbation n'existe. Les colonnes `approuveeLe` / `approuveeParId` sont là, et une
contrainte interdit une approbation sans approbateur, mais rien ne les écrit encore.

## Trois écarts par rapport au modèle proposé plus haut

**Pas de `classe`.** Traduire un score en bon / moyen / mauvais demande des seuils que
personne n'a arbitrés. Une colonne nulle que rien ne remplit serait une promesse vide.

**Pas de `versionFormule` distincte de `version`.** Une seule version identifie la règle.
Conséquence à connaître : l'instantané `entrees` permet de **rejouer les entrées** d'un
score ancien, pas l'ancienne formule. Si le code de calcul change en modifiant les
résultats, il faudra créer une version de règle pour que les scores antérieurs restent
explicables — c'est une discipline, pas une garantie du schéma.

**Pas de dates d'effet.** `approuveeLe` et `retireeLe` suffisent : un score est calculé à
un instant et porte la version utilisée.

## Une composante sur huit est calculée sur du vide

Mesure du 13/10/2026 : `traficMoyenJma` est renseigné sur **0 des 1 690** tronçons
antérieurs à la promotion de la voirie. Le TRAFIC — 10 % du modèle — sera donc exclu de
chaque score, et `couvertureMinimale` vaut 0,5 pour cette raison : exiger la totalité
refuserait tout score aujourd'hui.

`criticiteStrategique` est vide également, mais ce n'est **pas** une composante du §13 —
c'est un facteur du Risk Engine (§14). Les deux champs sont à zéro et bloquent deux moteurs
différents ; les compter ensemble donnerait au RCI un trou qu'il n'a pas.

Ce seuil est une proposition de départ et attend le même arbitrage que les pondérations.

## Avant d'appliquer la migration

- Vérifier d'abord que `_prisma_migrations` ne contient pas déjà `20261007200000`, amendée
  en supposant qu'elle n'était pas appliquée ; les quatre autres migrations en attente
  passent avant celle-ci.
- Rejouer la migration sur une copie de recette, avec `BEGIN` / `ROLLBACK`, avant toute
  base réelle.
- Le script de règle exige un compte `ADMIN` actif et échoue clairement sans lui.

Retour arrière : les trois tables et les deux enums sont neufs, donc `DROP TABLE` dans
l'ordre composantes → évaluations → règles, puis `DROP TYPE`. Aucune colonne existante
n'est touchée.
