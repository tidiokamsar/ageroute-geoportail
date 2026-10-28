# Inventaire des migrations, réconcilié avec la production

Relevé le 13/10/2026, en lecture seule sur la base de production. Aucune écriture.

## La correction qui doit passer avant tout le reste

L'addendum V4.1 énonce : « Quarante-cinq migrations sont écrites mais non appliquées. Seules
les six migrations exécutées ce matin sont signalées comme appliquées en production. »

**Les deux moitiés de cette phrase sont fausses**, et il demandait précisément de les
vérifier. Mesure dans `_prisma_migrations` :

| | Mesure |
|---|---|
| Migrations **appliquées** en production | **41** |
| Migrations en échec (ni terminées ni annulées) | **0** |
| Lignes dans `_prisma_migrations` | 42 |
| Dossiers de migration dans le dépôt | 46 |
| **En attente** (dans le dépôt, pas en production) | **5** |
| **Dérive** (en base, absentes du dépôt) | **0** |

La 42ᵉ ligne est `20260623000000_init`, enregistrée comme **annulée** (`rolled_back_at`
renseigné, `applied_steps_count = 0`). C'est un artefact historique : la base a été créée
autrement puis réconciliée. Elle ne bloque pas `migrate deploy`, et `prisma migrate status`
ne la signale pas.

**Conséquence pratique :** lancer les 45 migrations sur cette base échouerait. Quarante et
une existent déjà. L'instruction « ne lance jamais automatiquement les 45 migrations en
attente » est donc juste, mais pour une raison plus simple que celle supposée : il n'y en a
que cinq.

## Les six de ce matin, et la preuve de leur application

Toutes appliquées le **13/10/2026 à 07:20**, dans cet ordre :

| Migration | Horodatage |
|---|---|
| `20261007140000_socle_terrain` | 13/10 07:20 |
| `20261007180000_audit_validation` | 13/10 07:20 |
| `20261007200000_gouvernance_defauts` | 13/10 07:20 |
| `20261013120000_delegation_validation` | 13/10 07:20 |
| `20261013140000_droit_de_deleguer` | 13/10 07:20 |
| `20261013160000_condition_engine` | 13/10 07:20 |

Preuves conservées, vérifiées après coup le même jour : 261 387 tronçons, 1 172 ouvrages et
1 488 lignes d'audit **inchangés** ; zéro statut de validation écrit, zéro droit de déléguer
accordé — les six étaient additives et n'ont rien écrit ; `/api/health` à `status: ok` et
`audit.echecsDepuisDemarrage` à **0** avant comme après.

Un retour arrière reste disponible sur le serveur : un dump d'avant déploiement et un
instantané du répertoire déployé, tous deux horodatés.

## Les cinq en attente

| Migration | Nature | Objets touchés | Réversible |
|---|---|---|---|
| `20261013180000_portions_homogenes` | additive | 2 tables, 1 enum, 7 index, 11 `CHECK`, 1 GiST, 1 `EXCLUDE` | oui |
| `20261013200000_referentiels_configurables` | additive + `ALTER COLUMN TYPE` sur table vide | 3 tables, 3 clés étrangères | oui |
| `20261013220000_portions_ecriture` | additive + **`ALTER TYPE ADD VALUE`** | `DomaineValidation`, 1 colonne, 1 index unique | **non** pour l'enum |
| `20261013240000_actifs_lineaires` | additive + **4 `ALTER TYPE ADD VALUE`** | `TypeOuvrage`, 3 colonnes, 2 index, 4 `CHECK` | **non** pour l'enum |
| `20261013260000_praticabilite_approbation` | additive + `SET NOT NULL` sur table vide | 2 colonnes, 1 clé étrangère, 2 `CHECK` | oui |

**Dépendances** : strictement séquentielles. `referentiels_configurables` altère des colonnes
créées par `portions_homogenes` ; `portions_ecriture` et `praticabilite_approbation`
dépendent des deux précédentes ; `actifs_lineaires` est indépendante mais numérotée après.

**Trois `ALTER TYPE ADD VALUE` sont définitifs.** PostgreSQL n'a pas de
`ALTER TYPE ... DROP VALUE`. Les valeurs ajoutées — `PORTION`, puis `FOSSE`, `CANIVEAU`,
`SIGNALISATION`, `GLISSIERE` — survivront à tout retour arrière. Sans conséquence, une
valeur d'enum que personne n'écrit ne coûte rien, mais le rollback ne rend pas la base à son
état d'origine au sens strict et le prétendre serait faux.

**Aucune n'est destructive.** Aucun `DROP TABLE`, aucun `DROP COLUMN`, aucun `DELETE`,
aucun `UPDATE` sur des lignes existantes. Les cinq sortent avec leurs tables vides.

## Ce qui a été éprouvé, et comment

`infra/tester-migrations-socle.sh` restaure la dernière sauvegarde chiffrée dans un
conteneur jetable, compare l'historique aux fichiers, applique, vérifie la structure,
vérifie que **rien n'a bougé**, défait, et revérifie. Il ne touche jamais la production.

Dernière exécution complète, sur la sauvegarde d'avant déploiement :

```
0. Preconditions   Docker, fichiers, archive, cle               OK
1. Restauration    261 387 troncons, 33 tables, 410 colonnes
2. Historique      aucune des migrations appliquee — chemin net
3. Application     les DIX, dans l'ordre, sans erreur
4. Structure       tables, colonnes, index spatial, contraintes  OK
5. Donnees         261 387 troncons et 1 488 audits inchanges
6. Rollback        33 tables et 410 colonnes a l'identique
```

Deux comportements ont été éprouvés séparément, dans des conteneurs jetables, parce que leur
présence ne prouve pas leur effet :

**La contrainte d'exclusion** accepte deux propositions qui se contredisent, accepte deux
validées adjacentes, accepte une validée et son ancienne version, accepte la même emprise
sur un autre tronçon, et **refuse** deux validées qui se chevauchent.

**Les clés étrangères de référentiel** acceptent un code déclaré et `NULL`, **refusent** un
code inventé, laissent les portions intactes sur `actif = false`, et mettent la
qualification à nul sur `DELETE` sans perdre la portion.

## Classement demandé

| Catégorie | Migrations |
|---|---|
| Déjà appliquée et vérifiée | les 41, dont les 6 du 13/10 avec preuves ci-dessus |
| Écrite mais non appliquée | les 5 listées ci-dessus |
| Déjà appliquée partiellement | **aucune** — 0 ligne sans `finished_at` |
| Redondante | **aucune** |
| En conflit | **aucune** — 0 dérive, 0 écart de somme de contrôle |
| Dépendante d'une antérieure | les 5, séquentiellement |
| À fusionner | **aucune** |
| À corriger | **aucune** |
| À ne pas appliquer | **aucune**, sous réserve de la décision humaine |

Un point mérite d'être rappelé : `20261007200000_gouvernance_defauts` a été **amendée** le
13/10 avant son application, en supposant qu'elle n'était pas appliquée. La supposition a été
**vérifiée** avant déploiement : elle n'était ni appliquée ni même présente sur le serveur.
Prisma stocke une somme de contrôle par migration et refuse une migration
« modified after it was applied » — vérifié dans le binaire du moteur, pas supposé.

## Ce qui reste à faire, et qui n'est pas de moi

- **L'autorisation de déployer les cinq.** `AGENTS.md` règle 5 l'exige, et la décision est
  humaine.
- **Une préproduction représentative.** Il n'en existe pas. Le banc d'essai sur conteneur
  jetable en tient lieu : il part de la sauvegarde réelle, donc de la structure et du volume
  réels, mais il ne reproduit ni la charge ni les accès concurrents.
- **Mesurer le coût d'un import en masse** après déploiement. Chaque ligne ouvre une
  transaction interactive. J'avais estimé « de l'ordre de 1 700 » ; c'était faux de deux
  ordres de grandeur, la table portant 261 387 lignes.

## Méthode reproductible

```bash
# L'etat reel, en lecture seule, depuis le conteneur applicatif
docker compose exec -T backend npx prisma migrate status
```

```bash
# Le banc d'essai complet, sur une copie jetable
bash infra/tester-migrations-socle.sh
```

Le second exige la sauvegarde et sa clé, donc le serveur. Il retire son conteneur **et son
volume** à la sortie : l'oubli du `-v` a saturé le disque de l'hôte le 13/10, et la cause est
corrigée et commentée dans le script.
