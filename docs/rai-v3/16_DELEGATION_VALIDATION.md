# La délégation de validation

Décision du 13/10/2026. Cinquième et dernier arbitrage ouvert du §5, et le plus
structurant : `« validation selon délégation »` n'avait aucun équivalent dans le code.

## La réponse n'est pas au §5

Le §5 décrit le Coordonnateur comme faisant « validation selon délégation ». Pris seul,
cela ne dit pas ce qu'est une délégation. La réponse est au **§35, Gouvernance des
données** :

> « Un validateur est désigné pour chaque domaine. »

Une délégation n'est donc pas une permission générique : c'est une **désignation, par
domaine**. Le §26 ajoute « contrôle de séparation des rôles pour validation », et les
critères d'acceptation disent « lorsque la séparation de rôles s'applique » — le
conditionnel est dans le texte, et il suppose que quelqu'un ait décidé où elle s'applique.

## L'état avant

`ROLES_VALIDATEURS` admet `ADMIN` et `GESTIONNAIRE`. Tout gestionnaire pouvait donc valider
n'importe quel défaut, n'importe quelle observation, **partout dans le pays**. Ni domaine,
ni périmètre, ni terme, ni délégant.

## Le choix difficile

Deux réponses possibles pour un domaine sans validateur désigné, et aucune n'est évidente.

**Exiger une délégation** arrêterait la validation tant que personne n'en a créé. Les
relevés de terrain s'accumuleraient en `A_VALIDER`, et la chaîne de décision — défaut,
état, traitement, coût — resterait vide. Désigner des validateurs est un acte
d'organisation : cela prend des semaines, pas une soirée de déploiement.

**Ne rien exiger** laisse le comportement actuel, et la délégation devient décorative.

### La règle retenue : resserrement par domaine

Tant qu'**aucun** validateur n'est désigné sur un domaine, la règle d'avant s'applique. Dès
qu'un seul l'est, le domaine devient réservé aux désignés. AGEROUTE peut ainsi désigner
domaine par domaine, sans jour de bascule.

### Ce n'est pas le même défaut que celui des modules — à une condition

Ce dépôt a déjà payé un défaut de cette forme : `modulesAutorises` vide valait « aucune
restriction », si bien qu'un compte dont la configuration avait été oubliée obtenait tous
les modules — et l'interface affirmait l'inverse. **La ressemblance est réelle et il faut
la regarder en face.**

La différence tient en un mot : **visible**. Ce défaut-là était silencieux.
`GET /api/admin/gouvernance/validation` compte les domaines non désignés, pour que l'état
de la gouvernance se lise au lieu de se deviner. Sans cette route, le choix serait le même
défaut sous un autre nom.

**J'avais d'abord posé ce compteur sur `/api/health`.** C'était une faute : cette sonde est
**publique** et se déclare « volontairement muette sur les détails ». Publier la liste des
domaines non désignés y aurait appris à n'importe qui **où le contrôle de validation est le
plus lâche** — une carte des points faibles. La route est réservée à `ADMIN`.

## Ce qui n'est pas délégable

**L'auto-validation reste refusée en toutes circonstances.** Les critères du cahier la
conditionnent, ce qui ouvre la porte à des exceptions ; cette porte reste fermée. Une
délégation qui autoriserait son titulaire à valider ses propres relevés supprimerait le
contrôle à deux personnes dont dépend toute la chaîne — et le supprimerait précisément pour
celui à qui on a fait confiance.

L'ordre des refus le dit : un agent qui tente de valider son propre relevé lit
« auto-validation », **même s'il n'est par ailleurs pas désigné**. Lui répondre « vous
n'êtes pas désigné » l'enverrait demander une délégation qui ne changerait rien.

## Le périmètre géographique, et la région inconnue

Une délégation porte une région, ou aucune — et aucune vaut national.

**Une délégation régionale ne couvre pas un objet dont la région est inconnue.** Un défaut
peut n'en avoir aucune : son tronçon n'est pas apparié, ou sa mission n'en déclare pas.
L'accepter reviendrait à déduire une localisation de l'**absence** de localisation, sur un
système dont la règle première est de ne jamais inventer un rattachement. Une délégation
nationale les couvre, puisqu'elle couvre tout.

## L'autorité est inscrite dans l'historique

« Personne n'est désigné sur ce domaine » et « vous êtes désigné » autorisent la même action
pour des **raisons opposées**. La ligne de `validations` porte donc
`source: "console:DOMAINE_NON_DESIGNE"` ou `"console:DELEGATION_COUVRANTE"`.

Sans cette mention, on ne saurait pas dans un an si une validation reposait sur une
désignation ou sur son absence — et c'est exactement la question qu'un audit posera le jour
où le resserrement sera achevé.

## Rien n'est supprimé

Une délégation expirée ou révoquée reste en base : des validations ont été rendues sous son
autorité, et les retirer les rendrait inexplicables. `revoqueeLe` est une date, pas une
suppression — règle 2 d'`AGENTS.md` appliquée à un objet de gouvernance.

Aucune contrainte d'unicité non plus : une même personne peut être désignée sur une région
puis une autre, ou sur une période puis la suivante. Une clé unique interdirait l'historique
que cette table existe pour conserver.

## Ce qui est en place, et ce qui ne l'est pas

| | État |
|---|---|
| Décision pure + 31 tests | fait |
| Intégration dans la porte de validation | fait |
| Route de décision des **défauts** | consulte les délégations |
| Observations, tronçons, ouvrages, points noirs, postes, chantiers | **ne consultent pas encore** |
| Table + migration | écrites, **non appliquées** |
| Visibilité de l'état de gouvernance | `GET /api/admin/gouvernance/validation` |
| API de création et révocation d'une délégation | **absente** |
| Interface | **absente** |

La table est donc vide à la sortie, et le comportement est inchangé : sept domaines non
désignés, règle d'avant partout.

**Ce qui manque le plus est l'API de désignation.** Sans elle, une délégation ne peut
naître que par un `INSERT` manuel — ce qui est acceptable pour éprouver la règle, pas pour
exploiter. Et elle pose sa propre question de gouvernance : **qui a le droit de déléguer ?**
Le §35 dit qu'un validateur est désigné, pas par qui. Dans le code, seul `ADMIN` paraît
défendable par défaut, mais la Direction Technique — dont l'usage est « validation et
arbitrage technique » — est le candidat naturel. C'est le sixième arbitrage, et il naît de
celui-ci.
