# Plan de déploiement des cinq migrations en attente

Préparé le 13/10/2026. **Les cinq restent en attente : rien ne part sans votre autorisation**
(`AGENTS.md` règle 5).

## Le contrôle de compatibilité, fait contre la base vivante

Le contrôle le plus fort disponible n'est pas de relire les fichiers : c'est de demander à
Prisma ce qui sépare **la base de production réelle** du schéma cible. Fait en lecture seule,
depuis le conteneur applicatif :

```bash
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel <schema cible> --script
```

399 lignes, et leur décompte dit l'essentiel :

| Opération | Nombre |
|---|---:|
| `AddForeignKey` | 29 |
| `DropForeignKey` | 20 |
| `DropIndex` | **13** |
| `CreateIndex` | 11 |
| `AlterTable` | 9 |
| `CreateTable` | 5 |
| `AlterEnum` | 3 |
| **`DropTable`** | **2** |
| `CreateEnum` | 1 |

## Une dérive préexistante, et le piège qu'elle tend

Des `DropTable` et treize `DropIndex` apparaissent, alors que **mes cinq migrations n'en
contiennent aucun** — vérifié : zéro `DROP TABLE`, zéro `DROP COLUMN`, zéro `DROP INDEX`,
zéro `DELETE`, zéro `TRUNCATE`, zéro `UPDATE` sur des lignes existantes.

Ce que le diff veut supprimer :

| Objet | Pourquoi il n'est pas dans le modèle Prisma |
|---|---|
| `limites_admin`, `limites_admin_archive` | couche de référence interrogée en SQL brut, jamais modélisée |
| `defauts_geom_gist`, `defauts_emprise_gist` | index **GiST**, que Prisma ne sait pas déclarer |
| `observations_geom_idx`, `traces_geom_idx`, `points_trace_geom_idx` | idem |
| `voirie_locale_geom_idx`, `missions_emprise_idx` | idem |
| `bailleurs_deletedAt_idx`, `decomptes_deletedAt_idx`, `ot_photos_deletedAt_idx` | index créés en SQL |
| `chantiers_statutLocalisation_idx`, `propositions_statut_section_idx`, `regions_validite_idx` | idem |

La dérive est donc **entièrement constituée d'objets créés en SQL brut que le modèle Prisma
ne peut pas exprimer**. Le dépôt le documente déjà comme un choix assumé : les géométries ne
sont pas gérées nativement par Prisma.

**Le piège, et il est sérieux.** `prisma migrate dev` ne doit **jamais** être lancé contre la
production ni contre une copie : il proposerait de supprimer `limites_admin` et treize index
spatiaux. Le site continuerait de répondre, et les requêtes cartographiques passeraient de
quelques millisecondes à des balayages de table sur 261 387 lignes — une panne de performance
sans message d'erreur, donc difficile à relier à sa cause.

Seul `prisma migrate deploy` est à utiliser : il exécute les fichiers de migration dans
l'ordre, et **n'utilise pas le diff**. Le diff ci-dessus est un instrument de mesure, pas un
plan de déploiement.

## Ce que les cinq accomplissent réellement

Tout le reste du diff — hors dérive — correspond exactement à leur contenu :

| Migration | Apport |
|---|---|
| `20261013180000_portions_homogenes` | 2 tables, enum `OriginePortion`, 7 index, GiST, `EXCLUDE`, 11 `CHECK` |
| `20261013200000_referentiels_configurables` | 3 tables, 3 clés étrangères, `ALTER COLUMN TYPE` sur table **vide** |
| `20261013220000_portions_ecriture` | `DomaineValidation += PORTION`, `clientOperationId`, index unique |
| `20261013240000_actifs_lineaires` | `TypeOuvrage += 4`, 3 colonnes, 2 index, 4 `CHECK` |
| `20261013260000_praticabilite_approbation` | 2 colonnes, clé étrangère, `SET NOT NULL` sur table **vide**, 2 `CHECK` |

Les deux `ALTER COLUMN` et le `SET NOT NULL` ne portent que sur des tables créées par la même
série et donc **vides au moment du déploiement**. Sur une table peuplée, il aurait fallu une
valeur de repli, et aucune n'aurait eu de sens.

**Trois `ALTER TYPE ADD VALUE` sont définitifs** : `PORTION`, puis `FOSSE`, `CANIVEAU`,
`SIGNALISATION`, `GLISSIERE`, plus `ENVIRONNEMENT` et `AUTRES` sur `ComposanteRci`.
PostgreSQL n'a pas de `DROP VALUE`. Sans conséquence — une valeur que personne n'écrit ne
coûte rien — mais le retour arrière ne rend pas la base à son état d'origine au sens strict.

## Ce qui a été éprouvé, et sur quoi

`infra/tester-migrations-socle.sh`, dernière exécution du 13/10/2026 sur la sauvegarde
chiffrée restaurée dans un conteneur jetable :

```
0. Preconditions   Docker, 11 fichiers, archive, cle               OK
1. Restauration    261 387 troncons, 33 tables, 410 colonnes, 31 enums
2. Historique      aucune des 11 appliquee — le chemin est net
3. Application     les ONZE, dans l'ordre, sans erreur
4. Structure       tables, colonnes, index spatial, contraintes     OK
                   les 3 referentiels sortent VIDES
                   les 3 cles etrangeres de referentiel sont posees
5. Donnees         261 387 troncons et 1 488 audits INCHANGES
                   0 statut de validation ecrit, 0 droit accorde
6. Rollback        33 tables et 410 colonnes a l'identique, sans perte
```

Le banc part de la structure et du **volume réels**, mais il ne reproduit ni la charge ni les
accès concurrents. Il n'y a pas de préproduction : c'est une limite à connaître, pas un
détail.

Deux comportements ont été éprouvés séparément, parce que la présence d'une contrainte ne
prouve pas son effet :

**La contrainte d'exclusion** accepte deux propositions contradictoires, deux validées
adjacentes, une validée et son ancienne version, la même emprise sur un autre tronçon — et
**refuse** deux validées qui se chevauchent.

**Les clés étrangères de référentiel** acceptent un code déclaré et `NULL`, **refusent** un
code inventé, laissent les portions intactes sur `actif = false`, et mettent la qualification
à nul sur `DELETE` sans perdre la portion.

## La séquence, si vous autorisez

Chaque étape s'arrête en cas d'échec. Rien n'enchaîne automatiquement.

**0. Faire de la place.** `docker builder prune` sur le serveur. La construction a consommé
~6 Go le 13/10 au matin, et le disque est à 84 %. À 7,9 Go libres, elle aurait pu remplir le
disque d'un hôte qui porte aussi trois autres applications.

**1. Sauvegarder et vérifier la restauration.** `infra/backup/sauvegarde-bdri.sh` puis
`infra/backup/verifier-restauration-bdri.sh`. Une sauvegarde jamais restaurée est une
intention, pas une sauvegarde.

**2. `npx prisma migrate status`** sur la base visée, en lecture seule. Doit annoncer les cinq
en attente et **aucune** migration éditée après application.

**3. `bash infra/tester-migrations-socle.sh`** sur le serveur, sur la sauvegarde du jour.

**4. Transférer le code** par `git archive`, en préservant les deux `.env` qui ne sont pas
dans Git, et en vérifiant leurs empreintes avant et après.

**5. Vérifier la syntaxe nginx** là où Docker tourne. `host not found in upstream` est le
résultat attendu hors réseau Compose, pas une erreur.

**6. `docker compose up -d --build`**, puis
**`docker compose exec backend npm run prisma:deploy`**. Cinq migrations, dans l'ordre. **Pas
`prisma:seed`** : la base n'est pas neuve.

**7. Contrôles d'après déploiement**, et ce sont les chiffres à comparer :

| Contrôle | Valeur attendue |
|---|---|
| Tronçons vivants | **261 387**, inchangé |
| Ouvrages | **1 172**, inchangé |
| Lignes d'audit | ≥ 1 488, en hausse seulement |
| Tronçons avec `statutValidation` | **0** |
| Comptes avec droit de déléguer | **0** |
| Les 3 référentiels | **vides** |
| `audit.echecsDepuisDemarrage` | **0** |
| `https://carte.ageroute.gov.gn/` | **HTTP 200** |

**8. Peupler les référentiels**, séparément et explicitement :
`npm run referentiels:seed` crée les huit revêtements et les cinq états. La **praticabilité
reste vide** : ses valeurs attendent votre approbation.

## Retour arrière

**Si une migration échoue**, `migrate deploy` s'arrête sur elle et les précédentes restent
appliquées. L'état est donc partiel mais cohérent, et la suivante peut être relancée après
correction. Aucune ne porte de `DROP`, donc aucun échec ne détruit de données.

**Si une anomalie fonctionnelle apparaît après coup**, le rollback SQL éprouvé par le banc
d'essai rend les 33 tables et 410 colonnes à l'identique. Les valeurs d'enum ajoutées
survivent, sans effet.

**En dernier recours**, le dump d'avant déploiement et l'instantané du répertoire déployé,
tous deux horodatés et conservés sur le serveur.

## Ce que je ne peux pas faire, et qui vous revient

- **Autoriser le déploiement.** `AGENTS.md` règle 5.
- **Fournir une préproduction représentative.** Il n'en existe pas.
- **Mesurer le coût d'un import en masse** avant que les portions soient utilisées. Chaque
  ligne ouvre une transaction interactive, et la table porte 261 387 lignes — mon estimation
  initiale de « 1 700 » était fausse de deux ordres de grandeur.
