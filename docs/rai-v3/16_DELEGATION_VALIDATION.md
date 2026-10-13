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
| API de création et révocation d'une délégation | fait |
| Interface | **absente** |

La table est donc vide à la sortie, et le comportement est inchangé : sept domaines non
désignés, règle d'avant partout.

## L'API de désignation — 13/10/2026

**Qui a le droit de déléguer : la Direction Technique**, sur décision d'AGEROUTE. Le §35
disait qu'un validateur est désigné, pas par qui.

### Pourquoi ce n'est pas un contrôle de rôle

« Direction Technique » est un **profil**, et les profils ne persistent pas : appliquer un
profil écrit `role` et `modulesAutorises`, puis disparaît. C'était un choix délibéré — un
profil appliqué puis modifié à la main ne doit pas continuer d'afficher un nom qui ne
correspond plus.

Et le rôle technique ne suffit pas : **six profils sur onze sont `GESTIONNAIRE`**. Ouvrir
la désignation à tout `GESTIONNAIRE` la donnerait à l'Ingénieur réseau, à l'Entretien, à la
Planification, au Coordonnateur et à l'Administrateur SIG — presque tout le monde, ce qui
vide la désignation de son sens.

Le droit est donc un **effet du profil**, au même titre que le rôle et les modules :
`users.peutDeleguerValidation`. Durable, révocable, audité, et cohérent avec
l'architecture au lieu de la contredire. Un `ADMIN` en est dispensé — il administre les
comptes, donc il peut de toute façon se l'accorder.

**`effetDuProfil` pose toujours ce droit, même à `false`.** L'omettre laisserait un compte
le conserver après qu'on lui a appliqué un profil qui ne l'accorde pas : un privilège
survivant à un changement de fonction, ce qu'un préréglage doit empêcher.

### Les routes ne sont pas sur le routeur d'administration

`adminSettingsRouter` pose `requireRole("ADMIN")` sur tout ce qu'il porte. Les y placer
reviendrait à refuser la décision qu'on vient de prendre : la Direction Technique n'est pas
administrateur. Elles vivent donc sous `/api/gouvernance`, derrière `requireAuth`, et
vérifient le droit elles-mêmes.

| Route | |
|---|---|
| `GET /api/gouvernance/delegations` | la liste, historique compris |
| `POST /api/gouvernance/delegations` | désigner |
| `POST /api/gouvernance/delegations/:id/revocation` | révoquer |

### Trois refus qui méritaient chacun leur raison

**L'auto-désignation** est refusée. Un délégant qui se désigne sur les sept domaines
concentrerait l'arbitrage qu'on voulait répartir. L'auto-validation reste par ailleurs
interdite, donc il ne pourrait pas valider ses propres relevés — mais il pourrait valider
**tous les autres, seul**, ce que la désignation par domaine existe précisément pour éviter.

**Désigner un compte qui ne peut pas valider** est refusé. `ROLES_VALIDATEURS` n'admet que
`ADMIN` et `GESTIONNAIRE` : désigner un `LECTEUR` créerait une délégation qui ne servirait
jamais, puisque le contrôle de rôle passe avant celui de la délégation. Elle aurait l'air
de fonctionner dans l'interface et n'autoriserait rien. Une désignation inutilisable est
une erreur de configuration, pas une option.

**Révoquer la désignation d'un pair** est refusé à un délégant — un `ADMIN` le peut.
Pouvoir défaire celle d'un autre permettrait de vider un domaine de ses validateurs pour
s'y substituer, sans jamais rien désigner soi-même.

### La liste est restreinte, pour la raison qui a déjà servi

Elle dit qui est désigné. Rapprochée des sept domaines connus, elle dit aussi **où personne
ne l'est** — la même carte des points faibles que j'ai refusé de publier sur `/api/health`.
La restreindre là et pas ici l'aurait rendue accessible à tout compte authentifié. Elle
exige donc le même droit que la désignation.

## Les six autres domaines — 13/10/2026

En allant les câbler, j'ai trouvé qu'il n'y en avait **qu'un** à câbler.

### Observation : câblé

`POST /api/v2/observations/:id/validate` consulte désormais les délégations, avec la région
tirée du tronçon apparié ou de la mission, et l'autorité inscrite dans l'historique
(`terrain:DOMAINE_NON_DESIGNE` ou `terrain:DELEGATION_COUVRANTE`).

La lecture des délégations est passée dans `governance/delegation.service.ts`, partagée par
les deux routes. Recopier la requête aurait produit des copies qui divergent — et la suite
montre que ce n'est pas une crainte théorique.

### Les cinq autres : il n'y a rien à câbler

**Aucune route ne valide un tronçon, un ouvrage, un point noir, un poste ou un chantier.**
La colonne `statutValidation` leur a été ajoutée le 07/10 et **rien ne l'écrit**.

Y désigner un validateur serait donc sans effet. Le rapport de gouvernance le dit
maintenant, au lieu de présenter sept domaines équivalents :

| Champ | Sens |
|---|---|
| `domainesActifs` | ceux où une désignation change réellement quelque chose : `DEFAUT`, `OBSERVATION` |
| `sansChemindeValidation` | les cinq où elle n'aurait aucun effet |
| `aDesigner` | non désignés **parmi** ceux qui valident — la seule mesure à combler |

Sans cette distinction, le rapport aurait invité à cocher cinq cases qui ne changent rien,
ce qui est pire qu'un manque affiché : cela donne le sentiment du travail fait.

### Une copie morte de la règle, trouvée en chemin

`field/observations.regles.ts` portait **son propre** `validationPermise`, avec son propre
`ROLES_VALIDATEURS` et son propre dictionnaire de messages. Elle n'était plus importée que
par son propre test : la route utilise la version partagée depuis la centralisation.

**Elle avait déjà commencé à s'écarter** — son dictionnaire nommait un motif `MOTIF_REQUIS`
qui n'existe pas dans la gouvernance, laquelle dit `COMMENTAIRE_REQUIS`. Et elle n'avait
évidemment pas la vérification de délégation : quiconque l'aurait importée aurait obtenu la
règle d'avant en croyant appliquer la courante, et ses tests le lui auraient confirmé.

C'est exactement le danger que la centralisation visait à supprimer, et il s'était
réinstallé sans bruit. La porte de validation est retirée de ce fichier, qui ne garde que
ce qui lui est propre : la machine à états `BROUILLON / PROPOSEE / VALIDEE / REJETEE /
CONVERTIE`, celle de l'enum en base, qui ne se confond pas avec les quatre statuts de la
gouvernance.

### Ce qui reste

L'interface.

Et, pour les cinq domaines patrimoniaux, la question n'est pas la délégation mais **la
validation elle-même** : il n'existe aucun chemin pour rendre un tronçon officiel. C'est un
chantier à part, et il faut décider s'il est voulu — la validation d'un relevé de terrain
et celle d'un référentiel routier ne se ressemblent pas.

La migration du droit est additive et **ne change aucun comportement** : personne ne le
porte à la sortie, donc seul un `ADMIN` peut désigner — ce qui était déjà le cas, la table
des délégations étant vide.
