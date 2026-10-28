# Derive entre schema.prisma et les migrations

Chantier C2 du Lot 1. Document du 26/10/2026. Outil : `backend/scripts/verifier-derive-schema.ts`
(40 tests Vitest dans `backend/scripts/verifier-derive-schema.test.ts`).

## 1. En bref

- Le schema Prisma et la base que produisent les 83 migrations **ne sont pas identiques**. Sur la chaine complete
  rejouee dans une base neuve : **87 ecarts de derive** et 42 exceptions documentees (limites de Prisma).
- Un seul ecart est fonctionnel au sens ou une ecriture peut echouer : **les valeurs `ENVIRONNEMENT` et `AUTRES` de
  l'enumeration `ComposanteRci`** sont dans le schema et dans le code (`src/engines/condition.ts`), mais aucune migration
  ne les ajoute. C'est la meme famille de defaut que `medias_observation` au Lot 0.
- Le plus dangereux a terme n'est pas un manque, c'est un **excedent** : la table `limites_admin` (limites
  administratives, lue en SQL brut par `contour.service.ts`, `chantiers.service.ts` et `qualite.routes.ts`) et 17 cles
  etrangeres n'existent que dans les migrations. Un `prisma db push` sur une base qui les porte les **supprimerait**.
  La regle 4 d'`AGENTS.md` l'interdit ; ce document dit pourquoi elle est vitale.
- La base `replay` est **en retard d'une migration** sur la chaine (`20261026100000_conflit_sync_verification`,
  3 colonnes et 1 contrainte CHECK de `conflits_sync`). Elle n'a pas de table `_prisma_migrations` : on ne peut pas
  l'interroger pour savoir ou elle en est. L'outil sait donc reconstruire une base neuve depuis les migrations
  (`--reconstruire`), ce qui est la reference fiable.
- La **production n'est pas verifiee** : elle est construite en partie par `db push`, en partie par `migrate deploy`
  (depuis le 21/10/2026). Section 7 : la comparaison en lecture seule que la DSI doit lancer.

## 2. Pourquoi cette derive existe

Deux sources de verite coexistent : `schema.prisma` (ce que le client Prisma attend) et `prisma/migrations/` (ce que
`migrate deploy` cree). Rien ne les compare. Prisma ne le fait que dans `migrate dev`, avec une base fantome, que ce depot
n'utilise pas. Les ecarts naissent dans trois situations observees ici :

1. une colonne ou une valeur est ajoutee au schema, sa migration est oubliee (`ComposanteRci`, `medias_observation` au Lot 0) ;
2. une migration ecrite a la main cree un objet que Prisma ne sait pas decrire (index partiel, GiST, `timestamptz` choisi
   a la main) : le schema declare la version approchee ;
3. une migration cree une table ou des cles etrangeres que le schema ne modelise pas (`limites_admin`, tables du roulage).

La production, elle, a ete **construite par `db push`** puis suivie par `migrate deploy` (voir
`backend/prisma/descentes/README.md`, `docs/phase5/MIGRATIONS-NON-REJOUABLES.md`). Aucun document ne dit a partir de quelle
migration. Son schema reel est donc inconnu de ce depot.

## 3. L'outil

### 3.1 Executer en local

Prerequis : conteneur `bdri-dev-db` demarre (port 127.0.0.1:5434), dependances du backend installees.

```bash
cd backend
# URL de la base locale jetable : jamais ecrite dans un fichier du depot. Hote local obligatoire.
export DATABASE_URL="postgresql://utilisateur:motdepasse@127.0.0.1:5434/replay"

# Reference fiable : cree essai_derive, y rejoue les 83 migrations (+ le pont D-10), compare, la detruit.
npx tsx scripts/verifier-derive-schema.ts --reconstruire

# Comparer la base indiquee par DATABASE_URL telle qu'elle est (replay ou essai_<nom>).
npx tsx scripts/verifier-derive-schema.ts
```

Options : `--garder` (conserve `essai_derive` pour l'examiner), `--verbeux` (detaille exceptions et ecarts connus),
`--json fichier.json` (detail complet, utile pour la reference), `--connues fichier.json` (voir 6.2), `--aide`.

Codes de sortie : **0** aucune derive hors exceptions, **1** derive (liste imprimee), **2** erreur technique, **3** cible
refusee par la garde.

### 3.2 Ce qu'il fait

1. Importe `tests-integration/lib/garde.ts` : la cible doit etre **locale** et nommee `replay` ou `essai_<nom>`, sinon le
   processus s'arrete avec le code 3 (verifie : `console_bdri_dev`, `db.example.org` et l'absence d'URL donnent tous 3).
2. Lance `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma
   --script --exit-code` avec `DATABASE_URL` dans l'environnement. Syntaxe lue dans `prisma migrate diff --help` (Prisma
   5.22.0). On n'utilise **pas** `--from-url` : le mot de passe serait visible dans la liste des processus. Le resultat est
   identique octet pour octet (comparaison faite sur `replay`). La commande est en lecture seule d'apres son aide.
3. Decoupe le script SQL en ecarts elementaires (un ALTER TABLE a plusieurs clauses donne plusieurs ecarts).
4. Interroge le catalogue (`pg_index`, `pg_constraint`) pour classer chaque ecart : un `DROP INDEX` sur un index GiST,
   partiel ou d'expression est une exception ; sur un index btree ordinaire, c'est une derive.
5. Imprime les ecarts par sens (manque en base, ecart de definition, excedent en base) et gravite, puis les **comptes de
   l'angle mort** (section 3.4). Sort en 1 s'il reste une derive.

### 3.3 Exceptions : ce que Prisma ne sait pas representer

Chaque exception a un identifiant, une raison, et au moins un cas de test (le test verifie meme que la liste des
identifiants declares est exactement celle des cas testes).

| Identifiant | Cas | Pourquoi ce n'est pas compte comme derive | Observe sur la chaine |
|---|---|---|---|
| `EX-GIST` | `DROP INDEX` d'un index non btree | Index GiST des colonnes geometry crees par SQL. `type: Gist` est **accepte** par `prisma validate` sur une colonne `Unsupported` (essai fait en 5.22), mais le depot ne les declare pas. Un `db push` les supprimerait. | 12 |
| `EX-PARTIEL` | index `WHERE` : `DROP INDEX`, ou `CREATE INDEX` d'un nom qui existe en base sous forme partielle | `where:` est **refuse** par la validation de Prisma 5.22 (`No such argument`). Prisma ne voit pas l'index partiel et propose de le recreer sous le meme nom. | 3 (`regions_code_key`, `plans_pluriannuels_debut_idx`, `scenarios_programmation_annee_idx`) |
| `EX-EXPRESSION` | index sur expression | Aucune syntaxe du schema ne decrit une expression. Aucun cas ne se presente aujourd'hui dans la sortie de Prisma ; la regle est testee sur un cas synthetique. | 0 |
| `EX-DEFAUT-CLIENT` | `DROP DEFAULT` sur `id` ou `updatedAt` | `@default(uuid())` et `@updatedAt` sont produits par le client, sans defaut en base. La base garde le sien. Sans effet applicatif. Un defaut sur toute **autre** colonne reste une derive. | 27 |
| `EX-EXTENSION` | `CREATE/DROP/ALTER EXTENSION` de postgis, btree_gist, pg_trgm, unaccent, plpgsql | Extensions des migrations non toutes declarees dans le datasource. Prisma 5.22 n'en a emis aucune ici ; la regle protege d'un changement de version. | 0 |
| `EX-TABLE-OUTIL` | `DROP TABLE` de `_prisma_migrations` ou `spatial_ref_sys` | Tables de l'outillage, sans modele. | 0 |

Le test garantit aussi qu'une exception **ne masque pas** une derive voisine, et qu'un ecart de la reference connue ne
transforme jamais une exception en "connue".

### 3.4 L'angle mort, et comment le couvrir

`migrate diff` ne rapporte **jamais** les contraintes CHECK, les declencheurs, les fonctions ni les vues : Prisma ne les
connait pas. Le depot en depend beaucoup. Mesure sur la chaine reconstruite (imprimee par l'outil a chaque passage) :
209 CHECK, 17 declencheurs, 22 fonctions, 5 vues, 23 index partiels, 30 index non btree, 13 index d'expression.
Une derive sur l'un d'eux est **invisible** a l'outil.

Le couvrir demande l'instantane `backend/prisma/descentes/instantane-schema.sql` (un objet par ligne, tri deterministe) :

```bash
# base de reference
docker exec -i bdri-dev-db psql -U bdri_dev -d essai_derive -X -At -v ON_ERROR_STOP=1 \
  < backend/prisma/descentes/instantane-schema.sql > instantane-chaine.txt
# base a comparer
... psql ... -d <autre base> ... > instantane-autre.txt
diff instantane-chaine.txt instantane-autre.txt
```

Verification faite pour ce document : l'instantane de `replay` et celui d'`essai_derive` different par **exactement 4
lignes** (les 3 colonnes de `conflits_sync` et la contrainte `conflit_verification_porte_son_auteur`), ce qui confirme
que `replay` est en retard d'une migration et de rien d'autre.

## 4. Resultats reels (executes le 26/10/2026)

| Execution | Commande | Resultat |
|---|---|---|
| `replay` telle quelle | `verifier-derive-schema.ts` | code 1 : **90** derives, 42 exceptions (10 manque en base, 53 ecart, 27 excedent) |
| Chaine rejouee en base neuve | `verifier-derive-schema.ts --reconstruire` | code 1 : **87** derives, 42 exceptions (7 manque, 53 ecart, 27 excedent). 83 migrations rejouees, pont D-10 applique apres `20260702110000` |
| Reference acceptee | `--connues` avec les 87 signatures de la chaine | code 0, "Derive : 0, connues : 87" |
| Contre-epreuve | clone de la chaine, `DROP COLUMN` de `medias_observation.analyseConfiance` et `analyseModele`, puis l'outil | code 1, **exactement ces deux colonnes** signalees ("declaree par le schema, absente de la base") ; les 87 autres restent "connues" |
| Garde | `console_bdri_dev`, hote `db.example.org`, `DATABASE_URL` absente | code 3 trois fois |
| Tests | `npx vitest run scripts/verifier-derive-schema.test.ts` | 40 reussis, 0 echec. Mutation (ajout de colonne reclasse en exception) : **4 echecs**, donc les tests voient ce defaut |
| Typage | `tsc -p tsconfig.scripts.json --noEmit`, sortie filtree sur le script | aucune erreur |

Les 3 colonnes de `conflits_sync` expliquent seules la difference 90 contre 87 : ce n'est pas une derive du schema, c'est
un retard de `replay`.

## 5. Constats de derive (chaine contre schema), par gravite

Legende : **S** = correction dans `schema.prisma` seul (aucune migration, aucune base touchee) ; **M** = migration
idempotente + descente. Aucun de ces changements n'est applique ici (hors perimetre). Decision de l'architecte necessaire
quand le sens de la correction n'est pas evident.

### 5.1 Elevee : `ComposanteRci` n'a pas ses deux dernieres valeurs (M)

Preuve : le schema declare `ENVIRONNEMENT` et `AUTRES` (commentaire du 13/10/2026) ; `condition.ts` lignes 88-123 et
`condition.collecte.ts` ligne 91 les emploient ; la migration `20261013160000_condition_engine` cree le type avec 8 valeurs
et aucune migration ne l'altere. Une evaluation qui porte une composante `ENVIRONNEMENT` echouerait sur une base
reconstruite par migrations (`invalid input value for enum`). La production construite par `db push` les a probablement :
**a verifier par la DSI** (section 7).

Migration proposee, `prisma/migrations/<horodatage>_composante_rci_valeurs/migration.sql` :

```sql
-- Derive de schema : ComposanteRci declare ENVIRONNEMENT et AUTRES (schema.prisma, 13/10/2026) sans migration.
-- Idempotent : IF NOT EXISTS. Aucune ligne n'est touchee.
ALTER TYPE "ComposanteRci" ADD VALUE IF NOT EXISTS 'ENVIRONNEMENT';
ALTER TYPE "ComposanteRci" ADD VALUE IF NOT EXISTS 'AUTRES';
```

Descente, `prisma/descentes/<horodatage>_composante_rci_valeurs.sql` : reprendre **tel quel** le fichier
`20260903030000_revetement_non_renseigne.sql` (fonction temporaire `pg_temp.retirer_valeurs_enum`, qui reconstruit le type
et **refuse** si une ligne porte la valeur) et remplacer son dernier appel par :

```sql
SELECT pg_temp.retirer_valeurs_enum('ComposanteRci', ARRAY['ENVIRONNEMENT','AUTRES']);
```

A ajouter dans l'en-tete pour le banc : une ligne `-- GARDE-TEST-SANS-DEROGATION:` qui insere une ligne de
`composantes_evaluation` portant `ENVIRONNEMENT` (non ecrite ici : elle exige les cles etrangeres de cette table).

**Execute** sur un clone jetable de `replay` (`psql -1`) : valeurs avant `CHAUSSEE...INCIDENTS` (8) ; migration appliquee
**deux fois** sans erreur (2e passage : notices "already exists, skipping") ; valeurs apres : 10, `ENVIRONNEMENT,AUTRES` en
fin comme dans le schema ; descente : retour aux 8 valeurs ; remontee : 10. L'outil de derive ne signale plus ces deux
valeurs sur ce clone. **Non execute** : le banc `verifier.sh` de la descente (a lancer avant de commiter), et la
production.

### 5.2 Elevee : `programmes_budgetaires`, type et index differents (decision)

La migration `20261021160000_programmation_saisie` cree `createdAt`, `updatedAt`, `deletedAt` en **`timestamptz`** et
deux index **partiels** (`annee`, `statut` `WHERE "deletedAt" IS NULL`). Le schema declare `DateTime` (donc
`TIMESTAMP(3)` sans fuseau) et deux index composites ordinaires `(annee, deletedAt)`, `(statut, deletedAt)` que la base
n'a pas.

- Option A, aligner le schema sur les migrations (S) : `@db.Timestamptz(6)` sur les trois champs ; retirer ou remplacer
  les deux `@@index` composites. Ne change rien a la base.
- Option B, aligner la base sur le schema (M) : `ALTER COLUMN ... TYPE timestamp(3)` : **change la valeur des dates**
  selon le fuseau de session, a ne pas faire sans decision. Non recommandee.

Recommandation : A, apres lecture du type reel en production (`\d programmes_budgetaires`). Si la table de production a ete
creee par `migrate deploy` (migration du 21/10), elle est en `timestamptz`.

### 5.3 Moyenne : 8 cles etrangeres dont le comportement a la suppression differe (S)

Base : `ON DELETE RESTRICT` (`main_courante` x4, `taches_internes` x4). Schema : relation optionnelle sans `onDelete`,
donc `SET NULL` par defaut de Prisma. Sur une base reconstruite, la suppression physique d'un tronçon encore reference est refusee ;
sur une base produite par `db push`, elle annulerait le lien. Comme les entites patrimoniales ne se suppriment
que logiquement (regle 2), l'effet pratique est faible, mais les deux bases se comportent differemment.
Correction (S), exemple pour `EntreeMainCourante.troncon` :

```diff
-  troncon   Troncon?                              @relation(fields: [tronconId], references: [id])
+  troncon   Troncon?                              @relation(fields: [tronconId], references: [id], onDelete: Restrict)
```

Idem `sourceRef`, `typeRef`, `rectifie` (main_courante) et `troncon`, `ouvrage`, `defaut`, `clotureePar`
(`TacheInterne`). Les 16 autres cles (base `NO ACTION`, schema `SET NULL` ou `RESTRICT` avec `ON UPDATE CASCADE` : `ordres_travaux` x7,
`signalements_citoyens` x3, `programmes_budgetaires` x2, `ot_photos`, `ot_historique`, `marches`, `marches_chantiers`)
et 6 cles ou seul `ON UPDATE` differe sont listees une par une par l'outil. Pour les cles de `marches`,
`decomptes`, `avancement_marche` et `marches_chantiers`, une partie de l'ecart vient du **pont D-10** (il recree les cles
sans `ON UPDATE CASCADE`) : artefact du pont, pas de la production.

### 5.4 Moyenne : `limites_admin` et 17 cles etrangeres sans modele (S ou accepter)

- Table `limites_admin` (8 regions, 34 prefectures, 340 sous-prefectures, migration `20260905110000`) : **aucun modele**,
  lue en SQL brut. `db push` ou `migrate dev` la supprimerait avec ses geometries. Correction (S) : declarer un
  `model LimiteAdmin` mappe sur `limites_admin` avec `geom Unsupported("geometry(MultiPolygon,4326)")`, **ou** accepter
  l'ecart dans la reference connue et interdire definitivement `db push`.
- 17 cles etrangeres absentes du schema (champs sans `@relation`) : `evenements_roulage` (1),
  `evenements_roulage_portions` (3), `fiches_intervention` (2), `fiches_intervention_statuts` (1), `marqueurs_roulage` (2),
  `parametres_programmation` (2), `plans_pluriannuels` (2), `scenarios_programmation` (1), `sessions_roulage` (3). Elles
  garantissent l'integrite referentielle. Sur une base issue de `db push` elles **n'existent probablement pas** : a
  verifier (section 7).

### 5.5 Moyenne : 9 index btree ordinaires crees par migration, non declares (S)

A ajouter dans `schema.prisma` pour que `db push` ne les supprime pas :

| Modele | Declaration a ajouter |
|---|---|
| `Bailleur` | `@@index([deletedAt], map: "bailleurs_deletedAt_idx")` |
| `Chantier` | `@@index([statutLocalisation], map: "chantiers_statutLocalisation_idx")` |
| `Decompte` | `@@index([deletedAt], map: "decomptes_deletedAt_idx")` |
| `MediaDefaut` | `@@index([analyseeLe], map: "medias_defaut_analyseeLe_idx")` |
| `MediaObservation` | `@@index([analyseeLe], map: "medias_observation_analyseeLe_idx")` (index ajoute par la migration du Lot 0, non declare) |
| `OtPhoto` | `@@index([deletedAt], map: "ot_photos_deletedAt_idx")` |
| `Ouvrage` | `@@index([tronconId, abscisseDebutM], map: "ouvrages_tronconId_abscisseDebutM_idx")` |
| `PropositionLocalisation` | `@@index([statut, sectionPk], map: "propositions_statut_section_idx")` |
| `Region` | `@@index([validFrom, validTo], map: "regions_validite_idx")` |

### 5.6 Moyenne : 2 index manquants et 3 defauts differents (S ou M)

- `programmes_budgetaires` : voir 5.2.
- `outbox_evenements.createdAt`, `updatedAt`, `prochaineTentativeLe` : la base porte `(now() AT TIME ZONE 'UTC')`, le schema
  `@default(now())` (donc `CURRENT_TIMESTAMP`). Identiques tant que le fuseau de session est UTC. Correction (S) :
  `@default(dbgenerated("(now() AT TIME ZONE 'UTC'::text)"))`. **Non essaye** : il faut verifier que l'outil ne voit
  plus d'ecart apres ce changement.

### 5.7 Faible : 20 index dont le nom differe (S)

La base porte des noms ecrits a la main (`ot_statut_idx`), Prisma attend ses noms par defaut
(`ordres_travaux_statut_idx`). Aucun effet fonctionnel ; `db push` les renommerait. Correction (S) : `map: "<nom en base>"`
sur chaque `@@index`/`@@unique` concerne. L'outil imprime les 20 paires (tables `conditions_traitement`,
`fiches_intervention`, `lignes_import`, `lots_import`, `main_courante`, `ordres_travaux`, `ot_historique`, `ot_photos`,
`programmes_budgetaires`, `signalements_citoyens`).

### 5.8 Ecart de processus : `replay`

- Retard d'une migration (`20261026100000`) : les bancs qui en dependent la rejouent sur leur clone, d'autres non.
- Pas de `_prisma_migrations` : on ne sait pas lire son etat. Recommandation (hors perimetre) : produire `replay` par le
  meme code que `--reconstruire` (rejouer la chaine et le pont), ce qui solde la decision D-10 sur le plan outillage
  sans trancher la reparation de l'historique.

## 6. Brancher en CI

### 6.1 Etat de la CI

`.github/workflows/ci.yml` n'a **jamais tourne** (compte GitHub verrouille). Le job `descentes` dispose deja d'un service
`postgis/postgis:17-3.5` en authentification `trust` (pas de mot de passe). Le controle de derive peut s'y ajouter sans
nouvelle infrastructure. A ajouter (fichier hors perimetre, non applique) :

```yaml
  derive-schema:
    name: Derive schema.prisma / migrations
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgis/postgis:17-3.5
        env:
          POSTGRES_USER: bdri_dev
          POSTGRES_HOST_AUTH_METHOD: trust
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U bdri_dev"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 12
    env:
      # trust : aucun mot de passe. La garde exige un hote local et une base replay ou essai_<nom>.
      DATABASE_URL: postgresql://bdri_dev@127.0.0.1:5432/replay
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: backend/package-lock.json
      - run: npm ci
      # Le service est arrive vide : --reconstruire cree essai_derive depuis les migrations.
      - run: npx tsx scripts/verifier-derive-schema.ts --reconstruire --connues prisma/derive-connue.json
```

`CREATE DATABASE` demande un role ayant ce droit : `bdri_dev` est le superutilisateur du service. **Non essaye en CI.**
Localement, l'equivalent exact a ete execute (section 4).

### 6.2 Ne pas commencer rouge : la reference d'ecarts connus

Avec 87 ecarts, un controle strict serait rouge des le premier jour et on apprendrait a l'ignorer. L'option `--connues`
lit un tableau JSON de signatures (le texte SQL normalise de chaque ecart) : ces ecarts sont listes mais ne font pas
echouer ; **tout ecart neuf fait echouer**, et une entree de la reference qui ne correspond plus a rien est signalee
("reference obsolete") pour etre retiree.

```bash
# produire la reference une fois, apres l'avoir relue ligne par ligne
npx tsx scripts/verifier-derive-schema.ts --reconstruire --json /tmp/derive.json
node -e 'const j=require("/tmp/derive.json");require("fs").writeFileSync("prisma/derive-connue.json",JSON.stringify(j.derive.map(d=>d.signature),null,1))'
```

Politique : la reference ne s'allonge jamais sans decision ; chaque correction de la section 5 la raccourcit. Le fichier
`backend/prisma/derive-connue.json` est un fichier **a creer hors de ce chantier** (perimetre). Verifie ici avec une
reference equivalente stockee hors du depot (section 4).

### 6.3 Pour qu'un oubli de migration ne passe plus

La regle a faire respecter par la CI : toute modification de `schema.prisma` qui ajoute une colonne, une valeur
d'enumeration ou une table doit s'accompagner d'une migration ; sinon l'outil sort en 1 avec "declaree par le schema,
absente de la base". C'est exactement le cas `medias_observation`, reproduit en contre-epreuve (section 4).

## 7. La production : pourquoi la DSI doit comparer, et la commande

L'outil **refuse** toute cible non locale (garde, code 3) : c'est voulu. Il ne peut donc pas etre lance contre la
production. Ce qu'on sait de la production :

- construite par `prisma db push`, puis historique marque comme applique (`descentes/README.md`) ;
- deployee le 21/10 et le 22/10/2026 par `deployer-console.sh` (`migrate deploy`) ; dernier releve du 23/10 : 79 migrations
selon `AGENTS.md`, 82 selon `LOT-00-RAPPORT.md` (les deux documents ne concordent pas) ;
- `deployer-console.sh` compare les **noms** de migrations (`_prisma_migrations`), jamais le **schema** : une colonne
  presente dans une migration mais absente de la base passerait ses controles.

Donc, pour chaque objet ancien, la production peut differer de la chaine ET du schema. Les trois verifications suivantes
sont en **lecture seule** (SELECT sur le catalogue, `migrate diff` n'ecrit pas). A lancer par la DSI, depuis
`/opt/console-bdri`. **Non lancees ici.**

```bash
# 1. Derive visible par Prisma : schema.prisma contre la base de production. Sortie vide + code 0 = aucun ecart.
docker compose exec -T -e CHECKPOINT_DISABLE=1 backend \
  npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script --exit-code > derive-prod.sql ; echo "code=$?"
# (0 = identique, 2 = ecarts dans derive-prod.sql, 1 = erreur)

# 2. Instantane complet (types, colonnes, contraintes CHECK, index, declencheurs, fonctions, vues)
docker compose exec -T db psql -U bdri_app -d console_bdri -X -At -v ON_ERROR_STOP=1 \
  < backend/prisma/descentes/instantane-schema.sql > instantane-prod.txt

# 3. Quelques points qui tranchent les constats de la section 5
docker compose exec -T db psql -U bdri_app -d console_bdri -X -At -c "
  SELECT 'composante_rci', string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE typname='ComposanteRci'
  UNION ALL SELECT 'type_programmes_budgetaires.createdAt', data_type FROM information_schema.columns WHERE table_name='programmes_budgetaires' AND column_name='createdAt'
  UNION ALL SELECT 'fk_roulage_et_programmation', count(*)::text FROM pg_constraint WHERE contype='f' AND conname IN ('sessions_roulage_userId_fkey','fiches_intervention_tronconId_fkey','plans_pluriannuels_creeParId_fkey')
  UNION ALL SELECT 'limites_admin', count(*)::text FROM limites_admin"
```

Puis, **sur le poste de developpement**, produire l'instantane de la chaine
(`verifier-derive-schema.ts --reconstruire --garder`, puis la commande de 3.4 sur `essai_derive`) et comparer :
`diff instantane-chaine.txt instantane-prod.txt`. Attendus : la ligne `ext|postgis|<version>` differe si la version de
PostGIS du serveur n'est pas 3.5.2 ; chaque autre ligne est un ecart a classer. Renvoyer `derive-prod.sql` et
`instantane-prod.txt` (ils ne contiennent aucune donnee ni secret : uniquement la structure).

Condition : le conteneur `backend` doit avoir `DATABASE_URL` dans son environnement et la CLI Prisma (`prisma` est dans
`dependencies`, l'image est construite avec `npm ci --omit=dev`) ; sinon utiliser la commande 2 seule.

## 8. Non verifie

- La production, entierement (section 7).
- Le job CI propose : jamais execute (compte GitHub verrouille).
- `npm test` complet du backend et `tsc` global : volontairement non lances (arbre partage avec d'autres agents) ; seuls
  le test du script et le typage filtre sur ses fichiers l'ont ete.
- Le banc `verifier.sh` n'a pas ete relance pour la migration proposee en 5.1 (la migration et sa descente ont ete
  executees a la main sur un clone, pas par le banc).
- Les corrections de type S : aucune n'a ete appliquee ni essayee sur le schema (pas de `prisma validate` du schema modifie).
- Le classeur ne comprend que la sortie de Prisma 5.22.0. Une autre version peut formuler les ecarts autrement : toute
  instruction non reconnue est classee derive ("a lire a la main"), jamais ignoree.
