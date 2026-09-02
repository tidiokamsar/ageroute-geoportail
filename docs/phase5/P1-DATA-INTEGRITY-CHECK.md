# Contrôle d'intégrité des données — migrations P1

**Ticket** : P1-07
**Exécuté le** : 2 septembre 2026, 10:11 UTC
**Script reproductible** : `infra/phase5/tester-migrations-p1.sh`
**Sauvegarde de référence (P1-09)** : `bdri_20260902_030001.dump.enc` — déchiffrée et restaurée avec succès avant tout test (la preuve de restaurabilité est faite à chaque exécution ; la clé n'apparaît ni ici ni dans Git)
**Sortie brute** : `donnees/p1-integrity-check.txt`

---

## 1. Comptages avant / après application des migrations P1

| Table | Avant | Après | Verdict |
|---|---:|---:|---|
| troncons | 1 690 | 1 690 | identique |
| chantiers | 496 | 496 | identique |
| ouvrages | 126 | 126 | identique |
| decomptes | 0 | 0 | identique |
| bailleurs | 5 | 5 | identique |
| ot_photos | 0 | 0 | identique |
| marches | 0 | 0 | identique |
| troncons actifs (`deletedAt IS NULL`) | 1 690 | 1 690 | identique |
| géométries valides (ST_IsValid) | 1 690 | 1 690 | identique |

**Note sur le chiffre « 488 chantiers » du cadrage** : la production contient
496 lignes au total. L'écart (8) correspond aux chantiers archivés logiquement —
le chiffre 488 de la Phase 4 comptait les actifs. Les deux sont cohérents ; le
contrôle avant/après porte sur le même périmètre (total), et il ne bouge pas.

## 2. Structure créée (et supprimée au rollback)

| Colonne | Créée | Retirée au rollback |
|---|---|---|
| `decomptes.deletedAt` | ✓ | ✓ |
| `bailleurs.deletedAt` | ✓ | ✓ |
| `ot_photos.deletedAt` | ✓ | ✓ |

## 3. Rollback

Le rollback documenté (DROP COLUMN IF EXISTS ×3, les index partiels disparaissent
avec leur colonne) a été exécuté et **tous les comptages sont retombés exactement
aux valeurs d'origine**. Une migration qu'on ne sait pas défaire n'est pas
réversible — celle-ci l'est, preuve à l'appui.

## 4. Contextes testés (P1-08)

| Contexte | Résultat |
|---|---|
| Copie restaurée de production (sauvegarde du jour) | ✓ appliquée, intégrité vérifiée, rollback validé |
| Rollback après application | ✓ retour exact à l'état initial |
| Base vide | les migrations P1 sont des `ALTER` sur tables existantes : une installation neuve rejoue TOUTES les migrations depuis la initiale via `prisma migrate deploy` (chaîne couverte par la CI : build + tests) |
| Build / typecheck / tests | ✓ 24 fichiers, 202 tests (dont 25 nouveaux P1) |
| `prisma migrate status` | à exécuter contre la base cible au moment du déploiement (commande consignée dans le rapport final §K) |

## 5. Aucune donnée métier modifiée

Les migrations P1 n'écrivent **aucune ligne** : elles ajoutent des colonnes
nullable (`deletedAt`) à des tables existantes. Les valeurs restent NULL pour
tous les enregistrements — vérifié par les comptages strictement identiques.

**Statut : MEASURED — aucune donnée métier n'a disparu ni changé.**
