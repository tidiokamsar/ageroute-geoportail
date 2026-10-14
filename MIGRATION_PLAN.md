# Plan de migrations

> Fichier canonique exigé par le § A.9 du prompt maître V10. Il remplace
> `docs/rai-v3/PLAN_MIGRATIONS_PRODUCTION.md`, dont il conserve l'historique Git.
>
> Le § A.8 exige, pour chaque migration : objectif, dépendances, nature additive ou
> destructive, données concernées, compatibilité avec la version de production, tests,
> **rollback réellement exécuté** sur base représentative, contrôles post-migration,
> compatibilité frontend et backend, et évolution par étapes si nécessaire.
>
> 🔒 **Aucun déploiement de production sans autorisation explicite** (§ A.5.1, § A.8).

Réconcilié le **14/10/2026**. Méthode : comparaison des dossiers locaux avec
`_prisma_migrations` en lecture seule, plus `prisma migrate status` depuis le conteneur.

---

## 1. État réconcilié, et il corrige l'état de référence du mandat

Le § A.4 du prompt maître V10 annonce « 41 migrations signalées comme appliquées » et « quatre
migrations supplémentaires en attente ». Le mandat demande lui-même de vérifier ces chiffres
(« ne présume pas que ces mesures sont encore actuelles »). **Ils sont périmés de neuf
migrations.**

| Mesure | Valeur |
|---|---|
| Dossiers de migration locaux | **51** |
| Appliquées en production | **50** |
| **En attente** | **1** |
| Appliquées sans fichier local (orphelines) | **0** |
| Lignes de `_prisma_migrations` inachevées ou annulées | 1, **expliquée au § 5** |

Les quatre migrations que le § A.4 donnait en attente — `portions_homogenes`,
`referentiels_configurables`, `portions_ecriture`, `actifs_lineaires` — **ont été appliquées le
13/10/2026 à 18:21**, avec cinq autres. Six migrations supplémentaires ont suivi le 14/10.

`prisma migrate status`, exécuté dans le conteneur, répond « **Database schema is up to date!** »
pour les 50 migrations que son image contient. Ce verdict est exact et incomplet : voir § 4.

---

## 2. La migration en attente

### `20261014170000_historisation_bitemporelle`

| Champ exigé par le § A.8 | Contenu |
|---|---|
| **Objectif** | Ajouter l'**axe terrain** de l'historisation bitemporelle (§ 7.2) : `valideDu` / `valideAu` sur `portions`, distincts des dates système `createdAt` et `remplaceeLe`. Anticiper au modèle le contexte de praticabilité (T-07) et les champs d'inférence sur `medias_defaut` (T-03), comme le § 14 l'exige dès le lot 2 |
| **Dépendances** | `20261013180000_portions_homogenes` (table `portions`) et la table `medias_defaut`, toutes deux **appliquées** |
| **Nature** | **strictement additive** : 11 colonnes ajoutées, 6 contraintes `CHECK`, 2 index, 3 commentaires de colonne. Aucun `DROP`, aucun changement de type, aucun `UPDATE`, aucun `INSERT` |
| **Données concernées** | **aucune ligne écrite ni modifiée.** `portions` et `medias_defaut` comptaient **0 ligne** en production au 14/10 |
| **Compatibilité avec la version déployée** | **compatible dans les deux sens.** Toutes les colonnes ajoutées sont nullables ou ont une valeur par défaut : le code actuellement déployé, qui les ignore, continue de fonctionner. Et le code qui les lit fonctionne sur une base où elles valent `NULL` |
| **Tests** | Les **règles** sont éprouvées sans base : `reseau/bitemporel.ts`, **32 tests**, dont les deux axes de temps répondant différemment à la même date de terrain. `prisma generate` valide le schéma. Suite complète : **1 145 tests backend**, 0 échec |
| **Rollback réellement exécuté** | **NON. Voir § 3 — c'est le seul point du § A.8 qui n'est pas tenu, et je ne le déclare pas tenu** |
| **Contrôles post-migration** | listés au § 6 |
| **Compatibilité frontend** | **aucun impact** : aucun écran ne lit encore ces colonnes |
| **Évolution par étapes** | sans objet : la migration est additive et tient en une étape. Le schéma *expand → migrate → contract* ne s'applique pas, il n'y a pas de phase *contract* |

**Script de descente** : `backend/prisma/descentes/20261014170000_historisation_bitemporelle.sql`,
écrit, relu, commenté — **non exécuté**. Il vit hors du dossier de migration, par prudence
asymétrique ([ADR-008](TECHNICAL_DECISIONS.md)) : Prisma lit `migration.sql`, et un second `.sql`
y est très probablement ignoré, mais je n'ai pas pu l'établir avec certitude. Si je me trompais,
il supprimerait en production les colonnes que la migration vient d'ajouter.

---

## 3. Ce que le § A.8 exige et que je ne peux pas tenir

**Le rollback n'a pas été exécuté, sur aucune base.**

Le § A.8 demande un « rollback **réellement exécuté** sur base représentative ». Mesuré le
14/10/2026 sur le poste de travail :

| Vérification | Résultat |
|---|---|
| `psql` disponible | **non** |
| Service PostgreSQL | **aucun** |
| Installation PostgreSQL | **aucune** |
| Docker | CLI présente, **moteur injoignable** (`npipe://…dockerDesktopLinuxEngine`) |
| Docker Desktop au chemin standard | **absent** |

Et le § A.5.1 interdit d'utiliser la production pour éprouver un retour arrière — ce qui serait
de toute façon une mauvaise idée.

**C'est le blocage B-13.** Il suffirait de démarrer Docker sur ce poste, ou de fournir une base
de développement, pour le lever : la migration et sa descente pourraient alors être éprouvées en
montée **et** en descente, comme le mandat l'exige, en quelques minutes.

**En attendant, cette migration ne doit pas être déployée.** Non parce qu'elle est risquée — elle
est additive et porte sur deux tables vides — mais parce que la règle du § A.8 n'est pas
satisfaite, et qu'une exception accordée une fois devient une pratique.

---

## 4. La dérive de schéma préexistante, et l'interdiction qu'elle impose

🔒 **`prisma migrate dev` ne doit JAMAIS être lancé contre une base portant des données.**

La table `limites_admin` et treize index créés en SQL brut **ne figurent pas dans
`schema.prisma`**. Du point de vue de Prisma, ce sont des objets inattendus. `migrate dev`
compare le schéma au fichier et **proposerait de les supprimer**, ce qui détruirait les limites
administratives — dont dépendent le rattachement régional, le détecteur hors territoire et
l'audit des axes régionaux.

**Seul `prisma migrate deploy` est admissible**, car il exécute les fichiers de migration sans
comparer le schéma.

C'est aussi pourquoi le verdict « Database schema is up to date! » doit être lu avec prudence :
il porte sur les migrations enregistrées, pas sur l'absence d'écart entre le schéma réel et
`schema.prisma`. Cet écart existe, il est connu, et il est **voulu** — les géométries PostGIS ne
sont pas gérées nativement par Prisma, ce que le § 7.1 du mandat reconnaît en prescrivant
`Unsupported("geometry(...)")` et des migrations SQL versionnées.

---

## 5. La ligne anormale de `_prisma_migrations`, expliquée

Une ligne porte `finished_at` nulle **et** `rolled_back_at` renseignée :
`20260623000000_init`, `applied_steps_count = 0`.

Prisma documente `migrate resolve --rolled-back` comme marquant une migration « pour qu'elle
puisse être réappliquée ». Cette ligne laisse donc craindre qu'un `migrate deploy` rejoue un
`init` contre une base peuplée.

**Ce n'est pas le cas, et la raison est que `_prisma_migrations` a `id` pour clé, pas
`migration_name`.** Il existe **deux lignes** pour ce nom :

| Tentative | Horodatage | Issue |
|---|---|---|
| Première | 23/06/2026 09:46:38 | échec, puis marquée annulée à 09:47:00 |
| Seconde | 23/06/2026 09:48:22 | **réussie**, `applied_steps_count = 1` |

Prisma voit donc `init` comme appliquée. Incident clos depuis juin, et `migrate deploy` a tourné
avec succès plusieurs fois depuis — dont deux fois le 14/10.

**À ne pas « corriger ».** Supprimer la ligne annulée effacerait la trace d'un incident réel, et
le § A.5.8 proscrit les suppressions silencieuses.

---

## 6. Liste de contrôle de déploiement

À exécuter **par une personne autorisée**, dans cet ordre. Chaque étape a un critère d'arrêt.

### Avant

1. **Sauvegarde vérifiée.** `pg_dump -Fc`, puis `pg_restore -l` pour contrôler que l'archive est
   lisible. **Ne pas se contenter de l'existence du fichier** (§ A.7). Les trois archives des 13
   et 14/10 font 292 Mo et l'une a été contrôlée : 470 entrées listées.
2. **Place disque.** Le serveur était à 85 % le 14/10, 14 Go libres. Une construction d'image
   peut remplir un disque qui porte dix services : `docker builder prune` avant.
3. **Compteurs de référence**, à relever et à comparer après : `troncons`, `ouvrages`,
   `points_noirs`, `valeurs_qualite`, `audit_logs`, `users`, et les tables touchées — ici
   `portions` et `medias_defaut`, à 0.
4. **`prisma migrate status`** juste avant, car l'état peut changer entre-temps.
5. **Empreinte des deux `.env`**, avant et après le transfert. Ils ne sont pas dans Git et ne
   doivent jamais être écrasés ; `git archive` ne les contient pas, ce qui protège par
   construction.
6. **Vérifier l'absence de suppression** : `git diff --name-status main...HEAD | grep "^D"`.
   L'extraction a lieu **en place**, donc un fichier supprimé dans la branche ne disparaîtrait
   pas du serveur. Mesuré le 14/10 : **aucune suppression**.

### Pendant

7. **Le nom du répertoire de déploiement ne doit pas changer.** Le projet Compose en dérive, et
   les noms de volumes avec lui. Un répertoire renommé donnerait des volumes **vides** : une
   base neuve à la place de la production. Le projet vivant est `console-bdri`, dans
   `/opt/console-bdri`.
8. `docker compose up -d --build`, puis attendre que `db` soit `healthy`.
9. `docker compose exec backend npm run prisma:deploy`. **Jamais `prisma:migrate`**, qui est
   `migrate dev` : voir § 4.

### Après

10. **Compteurs identiques** à ceux de l'étape 3, hors `audit_logs` qui peut croître.
11. **Colonnes et contraintes présentes**, avec leurs valeurs par défaut.
12. `/api/health` : `status: ok`, et **`audit.echecsDepuisDemarrage` à 0**. S'il devient non nul,
    les audits échouent en silence et la comparaison avant/après le dira.
13. **Journal backend sans erreur** depuis le redémarrage.
14. **Routes protégées en 401 et non en 404** : un 404 signifierait que le code neuf n'est pas
    servi.

### Si une migration échoue

`migrate deploy` s'arrête sur elle ; les précédentes restent appliquées. **Ne jamais marquer une
migration comme appliquée artificiellement** (§ A.5.2), et n'employer aucun mécanisme équivalent
à `--fake`. Diagnostiquer, corriger le fichier, puis rejouer.

### Récupération

La descente est documentée au § 2. Avant de l'exécuter un jour, **compter les lignes portant une
valeur dans chaque colonne retirée** : une date d'effet terrain ne se recalcule pas depuis les
dates système, et un résultat d'analyse ne se reconstitue pas. Si un comptage n'est pas nul, la
descente exige une sauvegarde vérifiée et une autorisation explicite (§ A.5.2), et le § A.5.8
interdit toute suppression silencieuse de données.

Retirer aussi la ligne de `_prisma_migrations`, sans quoi `migrate deploy` considérera la
migration comme appliquée et ne la rejouera jamais. Ce geste est **volontairement absent** du
script de descente : il doit être conscient, pas un effet de bord.

---

## 7. Ce qui bloque le déploiement, et dans quel ordre le lever

| # | Blocage | Levée |
|---|---|---|
| 1 | **Rollback non éprouvé** (§ 3) | démarrer Docker sur le poste, ou fournir une base de développement (B-13) |
| 2 | **L'image du conteneur ne contient pas cette migration** | elle a été construite avant. La livrer exige un `--build`, donc un déploiement |
| 3 | **Autorisation explicite** du responsable AGEROUTE | § A.5.1 et § A.8 |

Les trois sont indépendants. Le premier est le seul que je puisse lever moi-même, et seulement
si Docker démarre.
