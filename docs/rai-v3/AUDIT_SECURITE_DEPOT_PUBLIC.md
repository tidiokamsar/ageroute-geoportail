# Audit de sécurité du dépôt public

Relevé le 13/10/2026. Ce document ne contient aucune valeur sensible : il décrit ce qui
était exposé, pas son contenu.

## La question la plus urgente, et sa réponse

**Un secret a-t-il été publié, ou seulement des références ?**

| Recherche | Résultat |
|---|---|
| Bloc de clé privée ou de certificat dans l'arbre suivi | **aucun** |
| « PRIVATE KEY » dans **tout** l'historique Git | **jamais commité** |
| Fichiers `.pem`, `.key`, `.p12`, `id_rsa` suivis | **aucun** |
| `.env` commité, même supprimé depuis | **jamais** |
| Mot de passe, jeton ou clé d'API en dur | **aucun** |

**Aucun matériel cryptographique n'a jamais été publié.** La seule ligne ressemblant à un
mot de passe était `SEED_ADMIN_PASSWORD="${MDP_ADMIN}"`, une référence de variable.

**Conséquence sur la rotation :** la clé de chiffrement des sauvegardes **n'a pas besoin
d'être rotée pour cause de publication**, puisque seul son *chemin* était connu. Elle reste
à roter pour une autre raison, antérieure et indépendante : elle n'a **aucune copie hors
serveur**, ce qui rend les archives chiffrées illisibles en cas de perte de la machine.

## Ce qui était réellement exposé, et qui l'est encore dans l'historique

Six familles d'informations opérationnelles, toutes retirées de l'arbre suivi le
13/10/2026 :

| Famille | Occurrences | Nature du risque |
|---|---|---|
| Adresse IP d'un serveur de production | 8, dans 6 fichiers | cible nommée |
| Noms de comptes de service système | plusieurs fichiers | surface d'attaque par nom |
| Chemin absolu de la clé de sauvegarde, avec son compte | 1 fichier | où chercher, sous quel compte |
| Emplacement des sauvegardes hors serveur | 3 fichiers | où est la copie |
| Nom d'hôte d'une base interne | README, `.env.example` | topologie interne |
| Adresses de comptes applicatifs nominatifs | 6 fichiers | énumération de comptes privilégiés |

La règle 1 d'`AGENTS.md` interdit explicitement « d'adresse IP de serveur de production ».
Elle a donc été enfreinte dans le dépôt même qui l'énonce, et depuis début septembre 2026 —
avant mon intervention.

## Ce qui a été corrigé, et ce que cela ne corrige pas

**Corrigé dans l'arbre suivi**, vérifié par `git grep` rendant zéro résultat :

- Les trois scripts qui portaient l'adresse en valeur par défaut la **réclament** désormais
  (`${VAR:?message}`) et échouent bruyamment si elle manque. Un repli silencieux sur une
  adresse enverrait une archive au mauvais endroit, ou nulle part.
- Les chemins absolus portant un nom de compte sont devenus `$HOME/...`, qui révèle une
  convention et non un compte.
- `README.md` et `.env.example` n'utilisent plus que des valeurs manifestement factices.
- `prisma/seed.ts` **exige** `SEED_ADMIN_EMAIL` au lieu de porter une adresse réelle par
  défaut : le seed échoue plutôt que de créer un compte au nom de quelqu'un qui ne l'a pas
  demandé.
- Les documents d'audit gardent leur substance, les repères nominatifs en moins.

**CE QUE CELA NE CORRIGE PAS, ET IL FAUT L'ENTENDRE :** l'historique Git reste intact.
Chaque valeur retirée est encore lisible dans les commits antérieurs, et le dépôt est
public depuis le début. Retirer un fichier dans le dernier commit n'efface pas son
historique, et l'addendum V4.1 a raison de le rappeler.

## Les deux seules actions qui traitent vraiment l'exposition

**1. Passer le dépôt en privé.** Immédiat, réversible, ne casse rien, et c'est la seule
mesure qui ferme l'accès à l'historique. Une minute dans les réglages GitHub.

```bash
gh repo edit tidiokamsar/ageroute-geoportail --visibility private
```

Je ne l'ai pas lancée : c'est un réglage de votre compte.

**2. Rendre l'information publiée inutile.** Une adresse connue n'est un risque que si ce
qu'elle désigne est atteignable avec ce que l'on sait par ailleurs. D'où les trois gestes de
durcissement ci-dessous, dont un est fait.

**Réécrire l'historique Git** est la troisième option, et je la déconseille : coûteuse,
cassante pour tout clone existant, et inutile si 1 et 2 sont faits. À ne considérer que si le
dépôt doit absolument rester public.

## État du durcissement demandé

### Fait, en production, le 13/10/2026

**Le compte de test détenant `ADMIN` est rétrogradé.** `LECTEUR` et désactivé, en une
transaction, audité en `SECURITY_EVENT` avec son auteur et son motif. Quatre administrateurs
actifs demeurent, site vérifié à HTTP 200 après l'opération.

`backend/scripts/retrograder-compte.ts` porte trois refus : pas d'exécution sans auteur ni
motif, pas d'auto-rétrogradation, et **refus de retirer le dernier administrateur actif** —
celui-là verrouillerait l'application sans moyen de revenir. Les deux premiers ont été
éprouvés avant l'opération réelle.

Rien n'est supprimé : la ligne reste, et le retour arrière demande de réactiver **et** de
repromouvoir, donc de le décider deux fois.

### Préparé, non exécuté : les privilèges de `bdri_app`

Mesure qui change l'ordre des opérations : **`bdri_app` est le seul rôle capable de se
connecter à la base**, il est `SUPERUSER`, `CREATEDB`, `CREATEROLE`, et il possède les six
extensions dont PostGIS.

Lui retirer `SUPERUSER` maintenant serait **un verrouillage sans retour** : aucun autre rôle
ne pourrait le lui rendre. Votre instruction « préserver l'accès de secours » est donc
exactement le point, et l'ordre correct est :

1. Créer un rôle de secours `SUPERUSER`, avec un mot de passe que **vous** choisissez — je
   ne dois ni le composer ni le manipuler.
2. Vérifier qu'il se connecte.
3. Alors seulement `ALTER ROLE bdri_app NOSUPERUSER NOCREATEROLE;`, en gardant `CREATEDB`
   si les migrations en ont besoin.
4. Rejouer le banc d'essai des migrations : il installe `btree_gist`, qui est marquée
   *trusted* donc installable sans superuser — à confirmer par l'exécution, pas par la
   lecture.
5. Vérifier `/api/health` et une écriture applicative réelle.

**Je n'ai pas exécuté l'étape 1 :** créer un rôle demande un mot de passe, et composer ou
transporter un mot de passe de production n'est pas à moi de le faire.

### À faire par vous : le mot de passe administrateur

Le mot de passe ADMIN transmis en clair dans une conversation n'a jamais été changé. Cela se
fait depuis l'écran d'administration, par le titulaire du compte. **Je ne dois pas composer
ni saisir un mot de passe de production**, et un script qui le ferait laisserait sa trace
dans l'historique du shell.

## Une exposition que vous ne m'aviez pas signalée

**`abdoulaye.dabo@ageroute.gov.gn` est un `ADMIN` actif qui ne s'est JAMAIS connecté.**

Un compte privilégié dormant est au moins aussi risqué qu'un compte de test : personne ne
remarquera son usage, puisque personne n'attend d'usage. Je ne l'ai pas touché — vous ne me
l'avez pas demandé, et il peut correspondre à une personne qui doit l'utiliser bientôt.

Le script de rétrogradation est prêt si vous le décidez.

## Ce qui reste, par ordre d'effet

| | Action | Qui |
|---|---|---|
| 1 | Passer le dépôt en privé | vous, ou moi sur votre mot |
| 2 | Changer le mot de passe ADMIN | vous |
| 3 | Créer le rôle de secours, puis retirer `SUPERUSER` | vous pour le mot de passe, moi pour le reste |
| 4 | Décider du sort du compte ADMIN dormant | vous |
| 5 | Copie hors serveur de la clé de sauvegarde | vous |
| 6 | Réécriture d'historique | déconseillée si 1 est fait |
