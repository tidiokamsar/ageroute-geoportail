# Postes de péage et de pesage récupérés — Phase 4

**Ticket** : T9
**Source** : `audit_logs`, entrées `entityType = 'Poste'`, `action = 'DELETE'`
**Script** : `backend/scripts/recuperer-postes-audit.ts`, à blanc par défaut
**État** : script écrit et testé, **non exécuté en production**

---

## 1. Ce que le journal d'audit a révélé

La table `postes` compte 0 ligne et passait pour n'avoir jamais été alimentée. Le
journal d'audit contient pourtant **dix suppressions du 1er juillet 2026**, toutes par
le même compte, toutes le même jour.

Ces dix enregistrements se réduisent à **six sites distincts** :

| Site | Type | Statut | Région | Doublon supprimé |
|---|---|---|---|---|
| Péage de Kilissi | PEAGE | EN_SERVICE | 3 | oui — « Peage » / « Péage » |
| Péage de Kilomètre 36 | PEAGE | EN_SERVICE | 3 | non |
| Péage de Maférinyah | PEAGE | EN_SERVICE | 9 | oui — « Maferinyah » / « Maférinyah » |
| Pesage de Mamou | PESAGE | EN_SERVICE | 4 | non |
| Poste de pesage de Kissidougou | PESAGE | HORS_SERVICE | 6 | oui — même orthographe, deux fois |
| Poste de pesage de Linsan | PESAGE | EN_SERVICE | 3 | oui — même orthographe, deux fois |

Les quatre doublons ne différaient que par les accents, ou pas du tout. **La suppression
était justifiée** : elle retirait de vrais doublons. L'absence de reprise ensuite ne
l'était pas — le module est resté vide depuis.

---

## 2. Ce qui est récupéré

Le site, et rien d'autre : nom, type, statut, région.

Chaque poste récupéré porte :

| Champ | Valeur |
|---|---|
| `historicalRecovered` | `true` |
| `recoveredFrom` | `AUDIT_LOG` |
| `recoveryStatus` | `PENDING_VALIDATION` |

Un site récupéré n'est pas un site confirmé. Il attend qu'un agent le valide, et une
reprise d'audit reste identifiable comme telle — elle ne se confond jamais avec un
relevé.

---

## 3. Ce qui n'est PAS récupéré, et pourquoi

Quatre postes portaient une valeur de trafic, deux une recette mensuelle :

| Site | Trafic JMA | Recettes mensuelles |
|---|---:|---:|
| Péage de Kilissi | 3 200 | 285 000 000 GNF |
| Péage de Maférinyah | 2 100 | 198 000 000 GNF |
| Poste de pesage de Kissidougou | 1 500 | — |
| Poste de pesage de Linsan | 3 200 | — |

**Ces valeurs ne sont pas restaurées comme des mesures.** Trois indices vont contre :

1. Kilissi et Linsan portent **exactement la même valeur**, 3 200 ;
2. tous les montants sont ronds, à la centaine ou au million ;
3. aucun de ces postes n'avait de coordonnées — `pk` et géométrie vides.

C'est la signature d'un jeu de démonstration, pas d'une campagne de comptage. Les
restaurer remplirait de fiction un module aujourd'hui vide, ce que le §41 interdit.

Elles restent consultables dans le journal d'audit, et le script les reporte en note
lors de la récupération pour que la trace ne se perde pas. Le jour où un comptage réel
sera retrouvé, il remplacera ces valeurs par une donnée `OBSERVED`, datée et sourcée.

**Ce que cela apporte malgré tout au §6 du cadrage** : le modèle de trafic existe déjà
dans le schéma (`postes.traficJma`), et le réseau compte six points de mesure
identifiés nominativement. C'est un point de départ pour une collecte, pas un module
à concevoir de zéro.

---

## 4. Protection contre le retour du doublon

La migration `20260902140000_poste_recuperation` pose une contrainte d'unicité
**insensible aux accents et à la casse** sur le nom des postes actifs :

```sql
CREATE UNIQUE INDEX "postes_nom_normalise_key"
  ON "postes" (lower(translate("nom", 'àáâãäçèéêëìíîïñòóôõöùúûü', 'aaaaaceeeeiiiinooooouuuu')))
  WHERE "deletedAt" IS NULL;
```

Le défaut qui a motivé la suppression d'origine ne peut donc plus se reproduire.

Le dédoublonnage du script utilise la même règle, portée par `lib/dedoublonnage.ts`,
pour que les deux implémentations ne divergent pas. Neuf tests vérifient, sur les dix
noms réels du journal, qu'ils se réduisent bien à six.

---

## 5. Procédure de récupération

```bash
# 1. À blanc — montre les six sites, n'écrit rien
npm run recuperer:postes

# 2. Sauvegarde préalable (obligatoire)
bash ~/bdri-infra/backup/sauvegarde-bdri.sh

# 3. Écriture
npm run recuperer:postes -- --apply
```

Le script est idempotent : un poste déjà présent est ignoré, pas dupliqué.

---

## 6. Ce qui reste à faire, et par qui

| Action | Qui | Nature |
|---|---|---|
| Valider les six sites | un agent | décision métier |
| Localiser chaque poste | terrain ou plan | aucune coordonnée n'existe |
| Retrouver l'origine des valeurs de trafic | AGEROUTE | enquête, pas code |
| Le cas échéant, saisir un vrai comptage | exploitant | donnée `OBSERVED`, datée |

Aucune de ces quatre actions n'est technique.
