# Les migrations ne reconstruisent pas la base

**Date** : 2 septembre 2026
**Découvert** : en montant un environnement de vérification locale
**Statut** : **MEASURED** — reproductible en une commande
**Corrigé** : non. Ce document établit le fait, il ne propose pas encore de remède.

---

## Le fait

`prisma migrate deploy` sur une base **vierge** échoue.

```
Migration name: 20260702140000_decomptes
Database error code: 42804

ERROR: foreign key constraint "decomptes_marcheId_fkey" cannot be implemented
DETAIL: Key columns "marcheId" and "id" are of incompatible types: uuid and text.
```

Le dépôt ne sait donc pas reconstruire sa propre base de données.

---

## La cause

Trois sources décrivent la même colonne, et elles se contredisent.

| Source | `marches.id` | `decomptes.marcheId` | `marches_chantiers.marcheId` |
|---|---|---|---|
| Migration `20260702110000` | `TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text` | — | `TEXT` |
| Migration `20260702140000` | — | **`UUID`** | — |
| `schema.prisma` | `@db.Uuid` | `@db.Uuid` | `@db.Uuid` |
| **Production** | `uuid` | `uuid` | — |

Les migrations se contredisent **entre elles** : deux tables filles référencent
`marches.id`, l'une en `TEXT`, l'autre en `UUID`. Sur une base vierge, `marches.id`
naît en `TEXT`, les clés `TEXT` passent, et la clé `UUID` échoue.

La production, elle, porte `uuid` partout et fonctionne — elle a donc été amenée à
sa forme actuelle par un autre chemin que cette chaîne de migrations, très
probablement `prisma db push`, l'historique ayant été marqué comme appliqué
après coup. Les 27 lignes de `_prisma_migrations` en production décrivent un
historique qui n'a jamais été rejoué tel quel.

---

## Ce que cela coûte

| Conséquence | Portée |
|---|---|
| Aucun environnement neuf ne peut être créé depuis le dépôt | développeur, préproduction, formation |
| L'intégration continue ne peut pas monter une base de test | tests d'intégration impossibles |
| La reprise après sinistre dépend **entièrement** de la restauration d'une sauvegarde | il n'existe pas de second chemin |
| Le schéma versionné n'est plus la description de la production | toute revue de migration est faussée |

Le dernier point est le plus sérieux. Une migration se relit pour comprendre ce
que la base contient ; ici, la lecture donne une réponse fausse.

La sauvegarde chiffrée quotidienne et sa restauration vérifiée restent valides —
elles ne dépendent pas des migrations. C'est aujourd'hui le seul chemin de
reconstruction, et il est éprouvé. Mais c'est un chemin unique.

---

## Pourquoi cela n'avait pas été vu

Trois filets auraient dû l'attraper, et aucun ne le pouvait.

Le test de migrations de la Phase 4 (`infra/tester-migrations-phase4.sh`) part
d'une **restauration de production**, puis applique les migrations *nouvelles*. Il
vérifie donc que les cinq migrations de la Phase 4 s'appliquent sur la structure
réelle — ce qu'elles font — mais jamais que la chaîne complète rejoue depuis zéro.

L'intégration continue (`.github/workflows/ci.yml`) compile et lance les tests
unitaires ; elle ne crée aucune base.

Et la production fonctionne, ce qui ne prouve rien sur la reproductibilité.

---

## Ce qui n'est pas affecté

Les cinq migrations de la Phase 4 sont saines : elles ont été éprouvées sur une
restauration de production — appliquées, rejouables, réversibles sans perte — et
le schéma qu'elles décrivent est bien celui que `db push` produit. Le défaut est
antérieur et localisé sur `marches` / `decomptes`.

---

## Remèdes possibles, non tranchés

| Piste | Effet | Risque |
|---|---|---|
| Corriger `20260702110000` pour créer `marches.id` en `UUID` | la chaîne rejoue | réécrit un historique déjà appliqué en production — à ne faire que si personne ne l'a rejoué ailleurs |
| Ajouter une migration de rattrapage qui convertit le type | la chaîne rejoue sans réécriture | ne s'applique pas en production, où le type est déjà bon : il faut la rendre conditionnelle |
| Repartir d'une migration de référence unique (`baseline`) reflétant la production | historique propre, réplayable | perd la granularité de l'historique |
| Ne rien changer et documenter | coût nul | le dépôt reste incapable de se reconstruire |

**Le choix appartient à AGEROUTE.** Les deux premières touchent un historique de
migrations partagé, ce qui n'est pas une décision technique isolée.

---

## Reproduire

```bash
docker run -d --name test-migrations -e POSTGRES_PASSWORD=x \
  -e POSTGRES_DB=console_bdri -p 55432:5432 postgis/postgis:17-3.5

cd backend
DATABASE_URL="postgresql://postgres:x@localhost:55432/console_bdri" \
  npx prisma migrate deploy
```

L'échec survient à `20260702140000_decomptes`.

En attendant un arbitrage, `infra/verifier-en-local.sh` contourne le problème en
construisant le schéma avec `prisma db push`, qui part de `schema.prisma` et
produit la même forme que la production.
