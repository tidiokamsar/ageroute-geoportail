# Remédiation de sécurité

> Livrable exigé par le § A.7 du prompt maître V10, qui en fait une priorité **P0, avant tout
> le reste**. Chaque ligne porte la commande exécutée et son résultat (§ A.5.7).
>
> **Ce document ne contient ni IP de production, ni chemin de clé, ni valeur de secret.** Les
> vérifications sont décrites par leur méthode et leur verdict, jamais par leur contenu.

Dernière vérification : **14/10/2026**. Méthode : lecture locale du dépôt et de son historique
Git complet (225 commits, toutes branches), plus une requête de visibilité à l'API GitHub.
Aucune opération sur la production (§ A.5.1).

---

## Synthèse

| # | Alerte § A.7 | Vérifié | Verdict |
|---|---|---|---|
| S-1 | Dépôt public contenant une IP de production et le chemin d'une clé de sauvegarde | **oui, complètement** | **dépôt public confirmé ; aucun secret ni IP jamais committé.** Pas de rotation nécessaire |
| S-2 | Mot de passe ADMIN transmis en clair et non changé | non | **bloqué** : exige une opération sur la production |
| S-3 | Compte de test avec rôle ADMIN en production | partiellement | **traité le 13/10/2026** (rétrogradé, audité) ; à reconfirmer |
| S-4 | Rôle PostgreSQL `bdri_app` superuser | partiellement | privilèges constatés le 13/10 ; réduction **bloquée** |
| S-5 | Sauvegardes : fraîcheur et **restaurabilité réelle** | partiellement | archive lisible vérifiée ; **restauration jamais exécutée** |

**Le point le plus important de ce document est S-1, et il contredit la formulation de
l'alerte.**

---

## S-1 — Dépôt public : ce qui a réellement été exposé

### Méthode

Six vérifications, toutes locales ou en lecture seule.

| Vérification | Commande | Résultat |
|---|---|---|
| Volume de l'historique | `git rev-list --all --count` | **225 commits** |
| Fichiers sensibles ayant jamais existé | `git log --all --diff-filter=A --name-only`, filtré sur `.env`, `.pem`, `.key`, `.p12`, `.jks`, `keystore`, `id_rsa`, `secret`, `credential` | **aucun** |
| Entêtes de clé privée | `git log --all -S` sur `BEGIN RSA PRIVATE KEY`, `BEGIN PRIVATE KEY`, `BEGIN OPENSSH PRIVATE KEY`, `BEGIN EC PRIVATE KEY` | **aucun commit** |
| Mots de passe d'environnement | `git log --all -S` sur `PGPASSWORD`, `JWT_SECRET`, `AWS_SECRET`, `PRIVATE_KEY` | **aucun commit** |
| Chaînes de connexion | `git log --all -S` sur `postgres://`, `postgresql://` | 4 commits, **analysés ci-dessous** |
| **IP du serveur de production** | `git grep` sur l'arbre courant, puis `git log --all -S` sur l'historique entier | **0 fichier, 0 commit** |

### Les chaînes de connexion trouvées, et ce qu'elles contenaient

Quatre commits des 1er et 2 septembre 2026 contiennent `postgresql://` ou `postgres://`, dans
`backend/.env.example`, `README.md`, `infra/verifier-en-local.sh`,
`docs/phase5/MIGRATIONS-NON-REJOUABLES.md` et `backend/scripts/migrate-legacy-data.ts`.

Toutes ont été classées sans jamais afficher leur valeur, en mesurant la nature du mot de passe
qu'elles portaient :

| Fichier | Verdict |
|---|---|
| `backend/.env.example` | **gabarit** (`changeme`), conforme à la règle 1 d'`AGENTS.md` |
| `infra/verifier-en-local.sh` | **gabarit**, hôte local |
| `docs/phase5/MIGRATIONS-NON-REJOUABLES.md` | **gabarit** |
| `backend/scripts/migrate-legacy-data.ts` | **aucune paire utilisateur/mot de passe** |
| `README.md` (historique) | **mot de passe masqué**, voir ci-dessous |

**Le cas du `README.md` méritait d'être tranché, et il l'est.** Dans les trois commits
concernés, la chaîne portait bien une paire `utilisateur:motdepasse@hôte` avec un hôte non
local — ce qui ressemble à un identifiant réel. La mesure dit autre chose : le mot de passe
faisait **trois caractères, tous identiques, de classe spéciale**, soit une entropie de
**0 bit**. C'est un **masque** du type `***`, pas un secret.

Le `README.md` actuel porte un gabarit explicite. Le nettoyage a eu lieu dans le commit
`3bddd34`, « Securite P1 : le depot nettoye, le compte de test retrograde en production ».

### L'IP de production n'a jamais été committée

C'est la vérification la plus importante, et elle est négative dans les deux dimensions :

- `git grep` sur l'arbre courant : **0 fichier suivi** ;
- `git log --all -S` sur les 225 commits, toutes branches : **0 commit** l'ayant ajoutée ou
  retirée.

Sept adresses IPv4 publiques subsistent dans le dépôt, **toutes dans des fichiers de test**
(`auth.audit.test.ts`, `cookie.transport.test.ts`) : ce sont des adresses de jeu d'essai pour
éprouver la journalisation d'audit et le transport des témoins, pas des hôtes réels.

### Le dépôt est bien public

`gh repo view --json visibility` : **`PUBLIC`**, `isPrivate: false`.

### Conclusion de S-1, et pourquoi elle change la suite

La prémisse « dépôt public **contenant** une IP de production et le chemin d'une clé » se
décompose en trois affirmations, dont deux seulement se vérifient :

| Affirmation | Vérifiée |
|---|---|
| Le dépôt est public | **oui** |
| Un chemin de clé de sauvegarde y figure | **oui**, dans les scripts de `infra/backup/` |
| Une IP de production y figure | **non**, et jamais dans l'historique |

**Aucune rotation de secret n'est donc nécessaire au titre d'une exposition par le dépôt.** Un
chemin de fichier n'est pas un secret : il ne devient exploitable que par quelqu'un qui a déjà
accès au serveur, et qui n'a alors pas besoin du dépôt pour le trouver.

Rendre le dépôt privé reste souhaitable — c'est la règle 1 d'`AGENTS.md` et une réduction de
surface — mais c'est une **décision de politique, pas une réponse à incident**. La distinction
compte : traiter ceci comme une fuite déclencherait une rotation de clé de sauvegarde, opération
risquée qui rendrait les archives existantes illisibles si elle était mal conduite.

**Ce que cette vérification n'établit pas** : que rien n'a été exposé par un autre canal — une
capture d'écran, un message, un document partagé. Elle porte sur le dépôt Git, et sur lui seul.

---

## S-2 — Mot de passe ADMIN : bloqué

Le changer exige une écriture en production, que le garde-fou § A.5.1 interdit sans
autorisation explicite du responsable AGEROUTE.

**Préparé** : la procédure consiste à changer le mot de passe par le parcours applicatif
authentifié, puis à révoquer les jetons de rafraîchissement en cours — la table
`refresh_tokens` porte **799 lignes**, mesurées le 14/10, ce qui signifie que des sessions
antérieures au changement resteraient valides sans cette révocation.

**À faire valider** : qui procède, et quand. Aucun ancien secret ne doit être reproduit dans un
canal écrit.

---

## S-3 — Compte de test ADMIN : traité, à reconfirmer

**Action du 13/10/2026** : le compte a été rétrogradé en `LECTEUR` et désactivé, par un script
exigeant `--compte`, `--par` et `--motif`, dans une transaction unique avec une entrée d'audit
`SECURITY_EVENT`. Rien n'a été supprimé. Le script refuse de rétrograder le dernier ADMIN actif
et refuse qu'un compte se rétrograde lui-même.

**Constat du 14/10 qui mérite d'être signalé** : la production porte **quatre comptes `ADMIN`
actifs**. Ce n'est pas l'alerte d'origine, mais c'est la même question — le moindre privilège.
Quatre administrateurs sur neuf comptes est un ratio à justifier ou à réduire.

---

## S-4 — `bdri_app` superuser : préparé, bloqué

**Constat du 13/10** : `bdri_app` est `SUPERUSER` **et c'est le seul rôle de connexion de
l'instance**.

**L'ordre des opérations n'est pas négociable** : réduire ses privilèges avant qu'un rôle de
secours existe coupe le service, puisqu'aucun autre rôle ne peut se connecter. La séquence est
donc : créer un rôle de secours → vérifier qu'il se connecte → réduire `bdri_app` au moindre
privilège → vérifier l'application → conserver le retour arrière.

**Bloqué** : chaque étape est une opération sur la production.

**Préparé et éprouvé le 22/10/2026 (base jetable, jamais la production)** :
`infra/securite/s4-reduire-bdri-app.sql` (refuse d'être lancé par le rôle qu'il réduit, ou s'il
n'existe aucun autre rôle SUPERUSER capable de se connecter ; garde `CREATEDB`),
`s4-retour-bdri-app.sql`, et l'épreuve `s4-epreuve.sh` : schéma complet reconstruit sous un rôle
propriétaire, réduit, puis contrôlé. **Permis** au rôle réduit : DML, DDL (table, index GiST,
colonne, fonction, déclencheur, vue), PostGIS, `CREATE EXTENSION btree_gist` (trusted).
**Refusé** : `CREATE ROLE`, `ALTER SYSTEM`, `COPY … TO PROGRAM`, `pg_read_file`, lecture de
`pg_authid`, se rendre SUPERUSER. Retour arrière rétabli. Bilan : 0 échec. Constat : une migration
qui installerait une extension **non trusted** (PostGIS) passerait par le rôle de secours.
**Reste à faire par AGEROUTE** : créer le rôle de secours avec un mot de passe qu'elle choisit,
vérifier qu'il se connecte, puis exécuter le script.

---

## S-5 — Sauvegardes : lisibles, jamais restaurées

**Ce qui est vérifié.** Trois archives ont été produites les 13 et 14/10 avant déploiement, de
**292 Mo** chacune, et l'une a été contrôlée par `pg_restore -l`, qui a listé **470 entrées** :
l'archive est donc lisible et structurellement complète.

**Ce qui ne l'est pas, et c'est l'essentiel.** Aucune restauration n'a jamais été exécutée. Le
§ A.7 le dit sans détour : « un fichier présent ne prouve rien ». Une archive lisible n'est pas
une archive restaurable — il manque la preuve qu'une base reconstruite depuis elle fonctionne.

**Et un risque qui n'est pas dans la liste d'origine** : la clé de chiffrement des sauvegardes
vit sur la machine qu'elle sauvegarde. Une sauvegarde dont la clé disparaît avec la machine
n'est pas une sauvegarde. Une copie hors site de la clé, conservée séparément des archives, est
à organiser.

**Bloqué** : une restauration d'épreuve demande une base cible, et il n'en existe aucune — ni
PostgreSQL local, ni Docker fonctionnel sur le poste de travail (voir `BLOCKERS.md`).

---

## Mise à jour du 22/10/2026 : l'incident de compromission des serveurs

> Ce chapitre rassemble ce que le dépôt documente déjà (ligne T-10 du suivi d'exécution) et ce que
> j'ai constaté pendant la reprise d'accès. **Il ne contient ni adresse de serveur, ni valeur de
> secret.** Les faits ci-dessous n'ont pas été revérifiés en production depuis le 21/10 : toute
> vérification sur un serveur exige une autorisation (§ A.5.1).

**Ce qui s'est produit.** Une compromission par tâche planifiée (cron) du compte applicatif `maarch`
a été trouvée sur **les deux serveurs** : cinq lignes de tâches pirates dans un fichier de spool
daté du 17/06, soit quatre mois de présence. Une clé SSH RSA étrangère (commentaire « mdrfckr ») et
**14 connexions** (18/09 et 19/10) sont documentées dans un dossier d'incident daté du 21/10 sur le
serveur de rebond.

**Ce qui a été fait (par les exploitants, avec le fournisseur)** : relance de `sshd` le 21/10 ;
nettoyage des tâches pirates sur les deux serveurs ; suppression des comptes `maarch` (application
abandonnée, décision du 21/10) ; durcissement de `sshd` partout (`PasswordAuthentication no`,
`PermitRootLogin no`), **vérifié de l'extérieur** : les deux serveurs refusent les connexions par
mot de passe et par `root`.

**Ce qui n'est PAS établi**
- **L'origine de l'intrusion.** Une clé étrangère sur le compte `maarch` du serveur de rebond,
  vue le 19/10, est l'hypothèse la plus plausible ; ce n'est qu'une hypothèse.
- **L'étendue réelle.** Quatre mois de présence : aucune analyse forensique complète n'a été faite,
  et je ne peux pas déclarer les données intactes. Les compteurs de la base sont identiques avant
  et après le déploiement du 21/10 (`261387 1172 1820694 1585 9`), ce qui ne prouve pas l'absence
  de lecture.

**À faire, par ordre d'urgence (aucun de ces gestes n'est fait)**
1. **Changer le mot de passe d'accès** qui a transité en clair dans une conversation de travail le
   21/10 (valeur volontairement non reproduite ici) : il est à considérer comme compromis.
2. **Faire tourner les clés SSH et les secrets** de l'application (JWT, base, sauvegardes) : cela
   coupera les sauvegardes le temps du redépôt de la clé, à planifier.
3. **Faire analyser les journaux** par le fournisseur sur la période du 17/06 au 21/10, pour borner
   l'étendue.
4. **Revoir les services exposés** relevés pendant la reprise d'accès et non revérifiés depuis :
   un tunnel d'administration GLPI publiant un port de base de données, et des ports de prise en
   main à distance (RustDesk). À confirmer avant toute conclusion.
5. **Mettre à jour GLPI** (signalé ouvert au suivi T-10).
6. **Rotation du compte de service de la base** et réduction des privilèges de `bdri_app` : scripts
   prêts et éprouvés sur base jetable (voir S-4), non exécutés en production.

**S-5, mise à jour.** Le suivi T-10 indique qu'une **copie restaurée de la base réelle** a servi à
essayer les 18 migrations avant le déploiement du 21/10, et qu'un dump de 292 Mo a été vérifié :
la restauration a donc été exercée une fois, sur une copie. Cela ne remplace pas une restauration
d'épreuve planifiée et consignée, et la clé de chiffrement des sauvegardes reste sans copie hors
serveur (B-21).

---

## Ce que je n'ai pas fait, et ne ferai pas sans autorisation

Changer un mot de passe, modifier un privilège, créer ou supprimer un rôle, réécrire
l'historique Git, rendre le dépôt privé, faire tourner une clé de chiffrement, restaurer une
sauvegarde sur une base existante.

Le § A.5.1 et le § A.5.5 les interdisent sans autorisation explicite, et le § A.5.7 m'interdit
d'en déclarer une faite.
