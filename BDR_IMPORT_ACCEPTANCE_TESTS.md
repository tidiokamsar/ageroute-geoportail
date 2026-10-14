# Tests d'acceptation d'un import BDR / ANASUR Collect

> Livrable 14 du § B.6, fondé sur le **pilote d'intégration non destructif** du § B.4 et sur le
> critère **A28** : « import idempotent, **100 % des lignes dans un statut** ». **Rédigé le
> 14/10/2026.**
>
> 🔒 Aucun de ces tests n'a été exécuté : **il n'existe aucun export à importer**. Ce document
> fixe ce qui devra passer, pour que l'importateur soit écrit contre des critères et non
> l'inverse.

## 0. Préconditions, toutes institutionnelles

1. **Autorisation écrite** de la source et **échantillons approuvés** (§ B.4).
2. Un **environnement de test** — il existe depuis le 14/10 : base PostGIS 17-3.5 isolée.
3. **Aucune modification de production** pendant toute la séquence.
4. Le schéma source et les règles de qualité reçus **avant** le premier import.

## 1. La séquence du § B.4, étape par étape

| Étape | Test | Critère de passage |
|---|---|---|
| 1 | Schéma et règles de qualité | chaque champ source est décrit dans `BDR_FIELD_MAPPING_TEMPLATE.csv` ; **aucune colonne inconnue** n'est importée en silence |
| 2 | Mapping des champs et des identifiants | chaque ligne du mapping a un statut `VALIDE` ; les identifiants suivent `BDR_ID_CROSSWALK_SPEC.md` |
| 3 | Import en environnement de test | se termine ; rapport produit |
| 4 | Comparaison d'un échantillon | routes, tronçons, dégradations, photos, dates : **écart documenté ligne à ligne** sur l'échantillon approuvé |
| 5 | Doublons, manquants, géométries, SRID, conflits | chaque cas **compté et listé**, aucun résolu automatiquement |
| 6 | **Idempotence** | **le même lot importé deux fois** : seconde passe sans aucune écriture, rapport identique |
| 7 | Rapport de rapprochement et de qualité | exportable, reproductible avec la version de mapping |
| 8 | Validation métier | signée par un rôle habilité |
| 9 | Déploiement | **seulement après autorisation distincte** |

## 2. Les critères du § B.4 et d'A28, un test chacun

| # | Critère | Test | Preuve attendue |
|---|---|---|---|
| T-01 | **Aucun écrasement silencieux** | importer un lot dont 5 lignes contredisent le référentiel | les 5 deviennent des **propositions** `A_VALIDER` ; le référentiel est **inchangé**, octet pour octet |
| T-02 | **100 % des lignes dans un statut** (A28) | lot de *n* lignes dont certaines invalides | `importées + rejetées + en_conflit + ignorées = n`, et aucune ligne dans deux statuts |
| T-03 | **Provenance conservée** | n'importe quelle ligne importée | porte système source, identifiant source, lot, empreinte du fichier, date, version de mapping — le contrat d'`ROAD_SURVEY_IMPORT_SPEC.md` |
| T-04 | **Erreurs exportables** | lot avec 3 lignes invalides | fichier d'erreurs en pivot ouvert, une ligne par erreur, avec la règle violée |
| T-05 | **Conflits visibles** | même objet présent avec deux valeurs | ligne dans `conflits_sync` ou équivalent, **les deux charges** conservées, aucune résolution automatique |
| T-06 | **Idempotence** (A28) | même lot importé deux fois | zéro écriture à la seconde passe, vérifié par **compteurs avant/après** et par `audit_logs` |
| T-07 | **Aucune modification de production** | toute la séquence | compteurs de production identiques avant et après — la méthode du § 6 de `MIGRATION_PLAN.md` |
| T-08 | **Rejeu reproductible** (B12) | régénérer l'export en version *n* après dix changements de mapping | octets identiques |
| T-09 | **Rapprochement jamais sur le seul nom** | lot contenant une route dont le nom seul correspond | aucune correspondance automatique ; **revue humaine** demandée |
| T-10 | **Aucune fusion ni suppression** | lot contenant un doublon géométrique évident | les deux objets subsistent ; proposition de rapprochement, score, pas de fusion |
| T-11 | **SRID** | lot en UTM 28N | converti en 4326 à l'import, longueurs recalculées en `geography`, écart < 0,1 % sur l'échantillon |
| T-12 | **Médias** | photos jointes | stockées avec empreinte, géoréférencement et horodatage d'origine conservés ; aucune photo sans ligne parente |

## 3. Ce que le dépôt sait déjà faire, et qui servira

- **Idempotence** : `clientOperationId` unique, `field/portions.sync.ts`, 13 tests. Le lot
  d'import en est la généralisation : une clé par (lot, ligne).
- **Propositions non officielles** : `statutValidation = A_VALIDER` par défaut, 75 tests.
- **Conflits conservés** : `conflits_sync` avec `payloadLocal` et `payloadServeur`.
- **Compteurs avant/après** : la procédure de déploiement les exige déjà.

Rien n'est à inventer dans les principes ; tout est à écrire dans l'importateur.
