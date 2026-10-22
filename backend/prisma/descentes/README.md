# Scripts de retour arriere

Le paragraphe 9.4 du mandat v2.1 exige des migrations « additives, reversibles, **testees en
montee ET en descente** sur une base de developpement ». Prisma Migrate ne gere pas de migrations
descendantes : ces scripts sont ecrits a la main, un par migration, et nommes d'apres elle.

## Etat au 22/10/2026

**69 migrations, 69 descentes.** 67 sont reversibles, 2 sont **irreversibles par principe** et
refusent de s'executer. Toutes ont ete executees par le banc `verifier.sh` : 238 verifications, 0
echec. Voir « Ce que le banc prouve, et ce qu'il ne prouve pas » avant de s'y fier.

> **Branche `lot/17-consignes-dt`, 22/10/2026 (nuit)** : cette branche ajoute deux migrations,
> `20261025110000_index_geom_troncons` et `20261025120000_teledetection_coherence_complements`,
> toutes deux reversibles ; la seconde rend a l'identique la fonction et la vue de `20261022020000`.
> (Une troisieme, `20261025100000_metre_emprise_utm`, a ete retiree : la ligne principale porte la
> meme valeur d'enumeration par `20261024300000`.) Decompte et banc : voir `TEST_EVIDENCE.md`.

| Famille | Migrations | Ce que fait la descente |
|---|---|---|
| Ajout de colonnes, de tables, d'index | la grande majorite | retire ce que la migration a ajoute, apres une **garde** (voir plus bas) |
| Valeur d'enumeration ajoutee | `revetement_non_renseigne`, `classe_non_classee`, `audit_validation`, `portions_ecriture`, `actifs_lineaires`, `coefficient_unitaire_defauts` | PostgreSQL ne sait pas retirer une valeur : la descente **reconstruit le type**, et **refuse sans derogation** si une ligne porte la valeur (aucune valeur de remplacement n'est inventee) |
| **Irreversible** | `init`, `p3a_refresh_token_security` | **refuse toujours**, et renvoie a la restauration de la sauvegarde |
| Residu volontaire | `btree_gist` (portions), tables de vocabulaire (taches, main courante) | laisse en place un objet, **declare** dans le fichier par `-- RESIDU-ACCEPTE:` |

Les deux irreversibles le sont pour de bonnes raisons :

- `init` cree tout le patrimoine routier, que la regle 2 d'`AGENTS.md` interdit de supprimer
  physiquement. Il n'existe pas, et n'existera pas, de `DROP TABLE troncons` executable ici.
- `p3a_refresh_token_security` a remplace les jetons de rafraichissement **stockes en clair** par
  leur empreinte, puis supprime la colonne. L'empreinte ne redonne pas le jeton, et recreer une
  colonne de jetons en clair serait une regression de securite que seule AGEROUTE peut decider.

## Pourquoi ils ne sont PAS dans le dossier de la migration

Prisma lit `migration.sql` dans chaque dossier de `prisma/migrations/`. Un second fichier `.sql` y
est tres probablement ignore, mais le nom est code en dur dans l'outil et je n'ai pas pu l'etablir
avec certitude. Le risque est asymetrique : un `descente.sql` execute pendant un `migrate deploy`
SUPPRIMERAIT en production les colonnes que la migration vient d'ajouter. Le dossier separe rend
cet accident impossible.

## Executer une descente

Toujours dans **une seule transaction**, jamais en autocommit :

```bash
psql -v ON_ERROR_STOP=1 -1 -f backend/prisma/descentes/<migration>.sql
```

On descend dans l'**ordre inverse** de l'application : la plus recente d'abord. Apres une descente
reussie, retirer a la main la ligne correspondante de `_prisma_migrations` (la commande est en bas
de chaque fichier). Ne jamais marquer une migration comme appliquee ou annulee sans l'avoir fait.

### La garde

Une descente qui retire des colonnes ou des tables detruit les valeurs qu'elles portent. Chaque
descente qui le peut commence par une **garde** : elle compte les lignes concernees et, s'il y en a,
elle **refuse** avec le message `DESCENTE REFUSEE`, en disant combien.

Pour passer outre, **apres sauvegarde verifiee et autorisation explicite** (paragraphe A.5.2 ; le
garde-fou 2.8 interdit toute suppression silencieuse) :

```sql
BEGIN;
SET LOCAL bdri.perte_autorisee = 'OUI';
\i backend/prisma/descentes/<migration>.sql
COMMIT;
```

Certaines descentes refusent **meme avec cette autorisation** : retirer une valeur d'enumeration
portee par une ligne, ou restaurer une unicite que des versions multiples violent, obligerait a
**inventer** une valeur de remplacement ou a supprimer une version. C'est une decision metier, pas
une autorisation.

Trois pertes meritent une attention particuliere, parce qu'elles **elargissent des droits** ou
**ressuscitent des donnees supprimees** sans que personne ne soit prevenu :

- `modules_autorises` : les comptes restreints a certains modules verraient tous les modules ;
- `marche_soft_delete`, `p1_soft_delete_decomptes_bailleurs`, `p1_ot_photos_soft_delete` : les
  lignes supprimees logiquement redeviendraient actives ;
- `user_2fa_lockout` : les comptes perdraient leur inscription a la double authentification.

## Ce que le banc prouve, et ce qu'il ne prouve pas

`verifier.sh` execute chaque descente sur un clone jetable et compare le schema complet **avant** la
migration et **apres** sa descente (`instantane-schema.sql` : types, tables, colonnes, contraintes,
index, declencheurs, fonctions, vues, commentaires). Pour chaque migration :

1. la descente rend un schema **identique** a celui d'avant ;
2. la migration se **reapplique** ensuite a l'identique (aller-retour complet) ;
3. pour chaque garde, avec une ligne fabriquee : la descente **refuse** et ne change rien, puis
   **passe** avec l'autorisation explicite et rend le schema d'avant ;
4. une descente irreversible **refuse** et ne change rien.

```bash
docker cp backend/prisma bdri-dev-db:/tmp/prisma-verif
docker exec bdri-dev-db bash /tmp/prisma-verif/descentes/verifier.sh
# une seule descente :  ... verifier.sh --seulement 20260702150000_user_2fa_lockout --jusqua 20260702150000_user_2fa_lockout
```

Le banc a ete eprouve par **contre-epreuve** : quatre descentes volontairement cassees (colonne
oubliee, garde neutralisee, reconstruction d'enumeration absente, descente irreversible qui
s'execute) ont ete detectees, chacune avec son message.

### Ce qu'il ne prouve PAS

- **Le comportement sur les donnees de production** : volumes, verrous, durees. La base de
  developpement est vide ; seules les gardes sont eprouvees, avec des lignes fabriquees. Reconstruire
  l'index sur 261 000 troncons, ou reecrire la colonne d'une enumeration de `troncons`, prend du temps
  et un verrou : a faire en fenetre de maintenance, apres essai sur une restauration de production.
- **Le schema de production.** Le banc rejoue la *chaine de migrations*, qui n'est pas la production :
  celle-ci a ete construite avec `prisma db push` (voir plus bas). Une descente nomme les objets que sa
  migration a crees ; si leur nom differe en production, elle echouera **sans rien detruire**, la
  transaction etant annulee.
- **La conservation de donnees que la descente ne detruit pas par construction.**

### La chaine de migrations ne se rejoue pas depuis une base vide

`20260702140000_decomptes` declare `marcheId` en `UUID` alors que `20260702110000` cree `marches.id`
en `TEXT` : PostgreSQL refuse la cle etrangere (`docs/phase5/MIGRATIONS-NON-REJOUABLES.md`).

Le banc franchit ce defaut par un **pont** (`ponts/20260702110000_marches_bailleurs_avancement.sql`),
qui amene `marches.id` et ses colonnes filles au type de production, apres le test de la descente de
la migration fautive. **Il ne corrige pas l'historique** : le choix appartient a AGEROUTE.

**Constat du 22/10/2026 :** avec ce seul pont, les **69 migrations s'appliquent de bout en bout**. Le
defaut est donc localise sur `marches` : aucun autre objet n'empeche le rejeu. Cela precise la portee
de ce qu'il faudrait reparer, sans trancher le remede (options A, B et C de la decision D-10, dont
`DECISIONS_PENDING.md` explique pourquoi une migration de reparation placee apres est impossible).

### Ce que le banc a trouve

Trois des 19 descentes ecrites avant lui laissaient des ecarts que rien ne declarait :
`taches_internes` (qui affirmait un aller-retour verifie le 14/10) et `main_courante` conservent des
tables de vocabulaire, par un choix documente dans leur texte mais invisible d'une machine ;
`praticabilite_p1_p4_provisoire` laissait un commentaire de table devenu faux. Les deux premieres
declarent maintenant leur residu (`-- RESIDU-ACCEPTE:`), la troisieme le corrige. Les 19 passent
desormais le banc.

## Ajouter la descente d'une nouvelle migration

1. Ecrire `descentes/<migration>.sql`, du dernier objet cree au premier.
2. Si elle detruit des donnees : une **garde** `DO $garde$ ... $garde$;` qui refuse sans
   `bdri.perte_autorisee`, et une ligne `-- GARDE-TEST: <INSERT ou UPDATE>` qui fabrique la donnee que
   la descente detruirait (`-- GARDE-TEST-SANS-DEROGATION:` si l'autorisation ne doit rien changer).
3. Si elle ne peut pas etre reversible : `-- IRREVERSIBLE` et un `RAISE EXCEPTION 'DESCENTE REFUSEE ...'`.
4. Lancer le banc. **N'ecrire « execute et verifie » qu'apres l'avoir fait.**
