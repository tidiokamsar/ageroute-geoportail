# Les onze profils métier, posés sur les quatre rôles techniques

Décision du 13/10/2026. Le §5 du cahier RAI V3.1 décrit **onze profils** ; l'application
connaît **quatre rôles**. Aucun mapping n'était écrit nulle part : créer un compte
« Ingénieur réseau » consistait à choisir un rôle au jugement, sans trace de ce qu'on
avait voulu dire.

## Ce qu'un profil est ici, et ce qu'il n'est pas

Un profil est un **préréglage nommé** par-dessus ce qui autorise déjà : le rôle technique
et la liste `modulesAutorises`. **Ce n'est pas un second mécanisme d'autorisation.**

J'avais d'abord recommandé une couche de permissions séparée. C'était une erreur, et la
raison est dans le code : le cloisonnement par module **existe déjà**, il est éprouvé, et
sa règle a déjà été corrigée une fois — une liste vide valait « aucune restriction », si
bien que tout compte dont la configuration avait été oubliée obtenait **tous** les modules
(voir `lib/access.ts`, correction du 05/09/2026). Ajouter un chemin d'autorisation à côté
reviendrait à refaire cette erreur en plus grand : deux implémentations de la même règle
finissent par diverger, et la divergence est silencieuse.

Appliquer un profil **écrit** `role` et `modulesAutorises`, puis disparaît. Aucune colonne
`profil` n'est ajoutée au modèle : un profil appliqué puis modifié à la main ne doit pas
continuer d'afficher un nom qui ne correspond plus à ce que le compte peut faire. C'est le
journal d'audit qui dit quel profil a été appliqué, par qui et quand.

## Pourquoi la table est dans le code et non en base

Je me corrige ici aussi. J'avais proposé une table administrable, par analogie avec le
catalogue des défauts. **Mauvaise analogie** : un catalogue de dégradations décrit le
monde, une table de profils **distribue des privilèges**.

La rendre modifiable depuis l'interface créerait un chemin d'élévation de privilèges
administrable : il suffirait de changer une ligne pour que le prochain « Auditeur »
devienne `ADMIN`. En code, toute modification passe par une revue et un déploiement — le
bon niveau de cérémonie pour cela.

Si vous voulez les rendre administrables, c'est une décision à prendre **en connaissant
cette conséquence**.

## Le mapping proposé

Libellés et usages sont **verbatim du §5** — un test les fige. Rôles et modules sont des
**propositions**.

| Profil | Rôle proposé | Modules proposés |
|---|---|---|
| Administrateur plateforme | `ADMIN` | aucun — son rôle ne connaît pas de restriction |
| Administrateur SIG | `GESTIONNAIRE` | socle + points noirs, postes, documents |
| Agent terrain | `INSPECTEUR` | socle + inspections |
| Coordonnateur | `GESTIONNAIRE` | socle + inspections, alertes, rapports, signalements |
| Ingénieur réseau | `GESTIONNAIRE` | socle + inspections, programmation, décision, rapports |
| Entretien & Maintenance | `GESTIONNAIRE` | socle + inspections, ordres de travaux, chantiers, programmation |
| Planification | `GESTIONNAIRE` | socle + programmation, décision, rapports, marchés |
| Contrôle de gestion | `LECTEUR` | socle + marchés, programmation, rapports |
| Direction Technique | `GESTIONNAIRE` | socle + inspections, programmation, décision, rapports, marchés |
| Direction Générale | `LECTEUR` | socle + rapports, décision, programmation, alertes |
| Auditeur | `LECTEUR` | socle large, en lecture |

Le socle est `dashboard`, `geoportail`, `troncons`, `ouvrages` : aucune des onze lignes du
cahier ne décrit un usage qui se passerait de voir la carte.

**Un seul profil reçoit `ADMIN`**, et un test le vérifie. Tout autre profil administrateur
serait une élévation de privilège déguisée en préréglage.

**Direction Technique reçoit `GESTIONNAIRE` par contrainte du code**, pas par choix :
`ROLES_VALIDATEURS` dans `governance/validation.ts` n'admet que `ADMIN` et `GESTIONNAIRE`.
Un profil dont l'usage est « validation et arbitrage technique » ne peut pas être `LECTEUR`
sans être contredit au premier clic.

## Cinq arbitrages qui vous appartiennent

Ils sont portés par le champ `aArbitrer` et exposés par l'API, pour que l'interface puisse
les **dire** à l'administrateur au moment où il applique un profil, au lieu de laisser
croire que la question est réglée.

**1. Administrateur SIG.** Ce profil édite des géométries, donc le linéaire publié. Faut-il
le distinguer d'un gestionnaire ordinaire, qui n'a pas vocation à toucher aux tracés ? Les
quatre rôles ne savent pas exprimer cette nuance.

**2. Coordonnateur — « validation selon délégation ».** Cette phrase n'a **aucun
équivalent dans le code**. La validation est aujourd'hui ouverte à tout `GESTIONNAIRE`,
sans périmètre ni délégation. Une délégation suppose de savoir qui délègue, sur quoi, et
jusqu'où. C'est la fonction manquante la plus structurante des cinq.

**3. Contrôle de gestion.** `LECTEUR` proposé : « coûts, budgets et indicateurs » se lit
comme de l'analyse. Mais s'il doit **saisir** des décomptes, il lui faut `GESTIONNAIRE` —
et il écrit alors sur des données financières.

**4. Direction Générale.** `LECTEUR` proposé. « Décisions » peut vouloir dire arbitrer
**dans** l'outil — et il faudrait `GESTIONNAIRE` — ou décider hors de l'outil et s'y
informer, et `LECTEUR` suffit. Les deux lectures sont défendables ; seul AGEROUTE sait
laquelle.

**5. Auditeur.** L'historique se lit **par entité** : `/api/audit` exige `entityType` et
`entityId`, et l'accès est cadré par le module dont relève l'entité. Il n'existe **aucune
vue de journal global**, que « consultation des historiques et journaux » suppose pourtant.
C'est une fonction manquante, pas un problème de rôle.

## Ce qui est en place

`backend/src/lib/profils.ts`, 18 tests. `GET /api/users/profils` liste les onze avec leurs
arbitrages ; `POST /api/users/:id/profil` en applique un. Les deux sont réservés à `ADMIN`,
comme tout le routeur `users`.

**L'application délègue à `usersService.update`**, et c'est le point qui compte. Écrire
`role` et `modulesAutorises` directement aurait été plus court et aurait contourné tous ses
garde-fous : appliquer un profil « Auditeur » au dernier administrateur actif aurait alors
suffi à rendre la plateforme ingouvernable. Un test le vérifie.

Le profil appliqué voyage dans la **même** ligne d'audit que la modification
(`motif: "profil:AGENT_TERRAIN"`). Une seconde ligne aurait séparé l'acte de son intention,
et permis que l'une survive sans l'autre.

`GET /profils` est déclaré **avant** `GET /:id` : l'inverse ferait matcher `/:id` sur la
chaîne « profils » et rendrait un 404 d'utilisateur introuvable. Le dépôt connaît ce piège,
un test de tronçons vérifie déjà que `/geo` n'est pas confondu avec un identifiant.

## Ce qui n'est pas fait

Aucun compte existant n'a reçu de profil. L'outil existe, son usage est une décision
d'exploitation — et il faudrait d'abord trancher les cinq points ci-dessus, sans quoi on
figerait mes déductions en décisions d'AGEROUTE.

Le frontend n'expose pas encore ces deux routes.
