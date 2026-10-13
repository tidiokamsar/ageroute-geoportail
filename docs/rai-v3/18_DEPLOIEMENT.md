# Déploiement du socle terrain — ce qui est prêt, ce qui bloque

Préparé le 13/10/2026. **Rien n'a été déployé, et rien ne peut l'être depuis ce poste.**

`AGENTS.md` règle 5 : ne pas déployer depuis ce dépôt sans validation humaine explicite.
Ce document est la préparation ; la décision reste la vôtre, et deux points la précèdent.

## L'écart à déployer, mesuré

| | |
|---|---|
| Commits non fusionnés dans `main` | 25 |
| Fichiers modifiés | 150 (+20 652 / −399) |
| Migrations que la branche ajoute à `main` | 5 |
| Pages du frontend | 29 |

Les cinq migrations, dans leur ordre d'application :

| Migration | Ce qu'elle fait | Réversible |
|---|---|---|
| `20261007180000_audit_validation` | 3 valeurs sur l'enum `AuditAction` | **non** |
| `20261007200000_gouvernance_defauts` | 8 enums, 4 tables, 9 colonnes, 3 index GIST | oui |
| `20261013120000_delegation_validation` | 1 enum, 1 table | oui |
| `20261013140000_droit_de_deleguer` | 1 colonne sur `users` | oui |
| `20261013160000_condition_engine` | 2 enums, 3 tables, 11 contraintes `CHECK` | oui |

`20261007140000_socle_terrain` est déjà dans `main`. **Être dans `main` et être appliqué en
production sont deux questions différentes**, et la seconde n'est pas tranchée d'ici.

## Deux choses bloquent, et une seule est technique

### 1. L'historique de migration n'a pas été lu

`20261007200000_gouvernance_defauts` a été **amendée** après avoir été écrite, en supposant
qu'elle n'était pas appliquée. Si elle l'est, l'amendement est invalide.

Ce n'est pas une précaution de principe : `_prisma_migrations` porte une colonne
`checksum VARCHAR(64) NOT NULL`, et le moteur de schéma refuse une migration
`modified after it was applied` — vérifié dans le binaire du moteur Prisma 5.22, pas supposé.
Dans ce cas il faut une **migration séparée** portant l'amendement, jamais une retouche.

La réponse qui fait foi, en lecture seule :

```bash
npx prisma migrate status
```

Elle est en lecture seule et compare l'historique de la base aux fichiers du dépôt. La
détection fait autorité parce qu'elle vient du moteur, et non d'une comparaison faite à la
main : une somme de contrôle calculée localement dépend des fins de ligne, donc un dépôt
cloné avec `autocrlf=true` donnerait un écart sans qu'un seul caractère ait changé.

### 2. `AuditAction` n'est pas réversible

`audit_validation` ajoute trois valeurs d'enum. PostgreSQL n'a pas de
`ALTER TYPE ... DROP VALUE` : la migration est **définitive**. Sans conséquence — une valeur
que personne n'écrit ne coûte rien — mais le retour arrière ne rend pas la base à son état
d'origine au sens strict, et l'inverse serait faux.

## Le banc d'essai

[`infra/tester-migrations-socle.sh`](../../infra/tester-migrations-socle.sh), écrit sur le
modèle de `tester-migrations-phase4.sh`, répond à la question 1 **sans ouvrir la
production** : la sauvegarde restaurée contient `_prisma_migrations`.

Il restaure la dernière archive chiffrée dans un conteneur jetable, compare l'historique
aux fichiers du dépôt, applique les cinq migrations, vérifie que la structure attendue
existe et qu'**aucune ligne existante n'a bougé**, puis défait et revérifie. Il s'arrête à
l'étape 2 si l'historique ne correspond pas : les étapes suivantes n'auraient aucun sens.

```bash
bash infra/tester-migrations-socle.sh
```

À exécuter **sur le serveur**, où se trouvent la sauvegarde et la clé.

Il ne teste pas la rejouabilité, contrairement à son aîné : ces migrations sont des
migrations Prisma, elles font `CREATE TABLE` sans `IF NOT EXISTS`, et Prisma ne les rejoue
jamais. Exiger une rejouabilité que personne ne porte ferait échouer le banc d'essai sur
une fausse exigence.

## Vérification avant livraison

`infra/verification-avant-livraison.sh`, exécuté aujourd'hui :

```
Dependances      OK    verrous npm cohérents (backend, frontend)
Compilation      OK    TypeScript sans erreur (backend, frontend)
Tests            OK    837 backend, 206 frontend
Base de donnees  OK    41 dossiers de migration, tous complets
Infrastructure   IGNORE  nginx : Docker injoignable, syntaxe non verifiee
Securite         OK    aucun fichier sensible suivi par Git
```

**Le contrôle nginx reste à faire** : il exige Docker, qui ne tourne pas sur ce poste. Une
erreur de syntaxe y met le site hors ligne, donc ce n'est pas un contrôle optionnel.

> Ce script répondait d'abord `ECHEC nginx — NE PAS LIVRER`. À tort : sa liste de messages
> d'erreur avait été écrite d'après Docker sous Linux, et Docker Desktop sous Windows dit
> autre chose quand son moteur est arrêté. Le garde-fou refusait donc la livraison pour un
> motif d'environnement, sans avoir lu la configuration — exactement ce que son propre
> commentaire mettait en garde contre, au 01/09/2026, pour une autre formulation. La liste
> est élargie et le script distingue à nouveau « je ne peux pas vérifier » de « c'est
> invalide ».

## L'ordre

1. **Sauvegarder et vérifier la restauration.** `infra/backup/sauvegarde-bdri.sh`, puis
   `infra/backup/verifier-restauration-bdri.sh`. Une sauvegarde jamais restaurée est une
   intention, pas une sauvegarde.
2. **`npx prisma migrate status`** sur la base visée. Si `20261007200000` y figure comme
   éditée après application, **arrêter** : il faut une migration séparée.
3. **`bash infra/tester-migrations-socle.sh`** sur le serveur. Un échec arrête.
4. **Relancer `verification-avant-livraison.sh`** là où Docker tourne, pour que le contrôle
   nginx soit réellement exécuté.
5. **Fusionner la branche**, qui ne l'est pas.
6. `docker compose up -d --build`, puis `docker compose exec backend npm run prisma:deploy`.
   Pas `prisma:seed` : la base n'est pas neuve.
7. **Lire `audit.echecsDepuisDemarrage` sur `/api/health`.** S'il est non nul, les audits de
   décomptes et d'ordres de travaux échouaient probablement en silence sur un `BigInt`.
8. Rien n'oblige à peupler la règle RCI. `npm run condition:regle:seed` crée
   `rci-2026.1` **non approuvée** ; tant qu'elle n'existe pas, aucun score n'est calculable,
   ce qui est un état parfaitement tenable.

## Ce que le déploiement ne change pas

**Le coût de l'import en masse n'est pas mesuré.** Chaque ligne ouvre désormais une
transaction interactive, soit de l'ordre de 1 700 pour un import complet. À mesurer avant
le premier import, pas pendant.

**Les cinq migrations sont additives et n'écrivent rien.** Aucun tronçon ne reçoit de
statut de validation ni de périmètre, aucun compte ne reçoit le droit de déléguer. Le
comportement observable ne change donc pas du seul fait de la migration : il change quand
les nouvelles pages sont servies.

**Cinq des sept domaines de validation n'ont aucune route de validation.** Y désigner un
validateur reste sans effet, et l'écran de gouvernance le dit.

## Trois points de sécurité, toujours ouverts

Hérités et non résolus. Ils ne bloquent pas techniquement le déploiement, mais le mot de
passe d'un administrateur de production ne devient pas moins compromis parce qu'on livre
une version de plus.

Et un quatrième, constaté le 13/10/2026 : **ce dépôt est public sur GitHub.** Plusieurs
fichiers déjà poussés nomment des comptes réels avec leur rôle, et l'un d'eux est désigné
comme portant `ADMIN` en production. Associé à l'adresse publique du service et au mot de
passe jamais changé, cela forme une chaîne exploitable. Un retrait dans un commit ultérieur
ne suffirait pas : le contenu reste dans l'historique. Voir la note ci-dessous.

- Le mot de passe ADMIN transmis en clair dans une conversation **n'a pas été changé**.
- Un **compte de test détient `ADMIN` en production** ; il est nommé dans
  `01_AUDIT_ARCHITECTURE.md`.
- La clé de chiffrement des sauvegardes **n'a aucune copie hors serveur**, ce qui rend les
  archives chiffrées illisibles en cas de perte de la machine. Les sauvegardes existent
  donc, mais la garantie qu'elles représentent, non.

## Le dépôt est public, et cela n'a pas été traité

Constaté le 13/10/2026 : `tidiokamsar/ageroute-geoportail` est en visibilité **PUBLIC**.

Les fichiers suivants, **déjà poussés**, nomment des comptes réels :

| Fichier | Ce qu'il expose |
|---|---|
| `docs/phase5/DEPLOIEMENT-20260905-1828.md` | deux comptes nominatifs d'agents, avec leur rôle |
| `docs/rai-v3/01_AUDIT_ARCHITECTURE.md` | le compte de test qui porte `ADMIN` en production |
| `docs/phase5/DEPLOIEMENT-20260905-1828.md` | le même, avec le constat |
| `docs/rai-v3/17_ETAT_CONTRE_LE_CAHIER.md` | le même, et le mot de passe jamais changé |
| `backend/prisma/seed.ts` | l'adresse de l'administrateur par défaut |
| `docs/bdri-2/data/BDRI-DATA-BASELINE.md` | la même adresse |

Aucun mot de passe, jeton ni adresse IP de serveur n'a été trouvé : la règle 1 d'`AGENTS.md`
est respectée au sens strict. Mais elle a été lue comme « pas de secrets », alors que ce qui
est en jeu ici est l'**énumération des comptes privilégiés d'un service en ligne**, ce qui
n'a pas besoin d'un mot de passe pour être utile à quelqu'un.

Trois réponses possibles, dans l'ordre de ce que je recommande :

1. **Passer le dépôt en privé.** Immédiat, réversible, et cela ne casse rien. C'est la seule
   action qui traite l'exposition sans réécrire l'histoire.
2. **Changer le mot de passe ADMIN et retirer `ADMIN` du compte de test.** À faire de toute
   façon, et cela rend l'énumération sans valeur. Les deux premiers points sont
   complémentaires, pas alternatifs.
3. **Réécrire l'historique** pour retirer les occurrences. Coûteux, cassant pour tout clone
   existant, et inutile si 1 et 2 sont faits. À ne considérer que si le dépôt doit rester
   public.

Un retrait par simple commit ne traite rien : le contenu reste accessible dans l'historique
Git et dans les copies déjà faites.
