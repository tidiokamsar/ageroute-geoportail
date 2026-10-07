# Matrice de schéma : dépôt actuel contre pack RAI V3

Phase 0, exigée par le point 45 du master prompt. Établie par comparaison automatique
des deux fichiers `schema.prisma` et par mesure des volumes en production le 07/10/2026,
pas par lecture.

## Le constat qui commande tout le reste

```
schéma actuel : 35 modèles, 36 enums
pack RAI V3   : 28 modèles, 17 enums
modèles portant le même nom : 0
```

**Aucun des 28 modèles V3 ne porte le nom d'un modèle existant.** Toutes ses tables sont
préfixées `rai_`. Il n'y a donc aucune collision, et c'est exactement le problème : le
pack ne s'intègre pas au modèle existant, il en pose un second à côté.

Onze de ses vingt-huit modèles redoublent une entité déjà en service :

| Modèle RAI V3 | Table créée | Existe déjà sous | Lignes en production |
|---|---|---|---|
| `Road`, `RoadSegment` | `rai_roads`, `rai_road_segments` | `Troncon` | **261 387** |
| `RoadAsset`, `RoadAssetType` | `rai_assets`, `rai_asset_types` | `Ouvrage`, `PointNoir`, `Poste` | 1 174 |
| `RaiUser` | (table propre) | `User` | 9 |
| `AuditEvent` | `rai_audit_events` | `AuditLog` | 1 484 |
| `Device` | `rai_devices` | `Appareil` | 0, créé le 07/10 |
| `FieldMission` | `rai_field_missions` | `Mission` | 0, créé le 07/10 |
| `Track`, `TrackPoint` | `rai_tracks`, `rai_track_points` | `Trace`, `PointTrace` | 0, créé le 07/10 |
| `FieldObservation` | `rai_field_observations` | `Observation` | 0, créé le 07/10 |
| `ObservationMedia` | `rai_observation_media` | `MediaObservation` | 0, créé le 07/10 |
| `SyncItem`, `SyncConflict` | `rai_sync_items`, `rai_sync_conflicts` | `OperationSync`, `ConflitSync` | 0, créé le 07/10 |

Le master prompt interdit lui-même ce que son pack produirait :

> NE PAS créer une deuxième architecture parallèle inutile.
> NE PAS remplacer brutalement le schema.prisma existant.

Appliquer `INTEGRATION.md` tel quel — son étape 2 est un `psql -f migration.sql` —
créerait 27 tables dont onze doublons, dont `rai_roads` à côté de 261 387 tronçons et
`rai_audit_events` à côté de 1 484 lignes d'audit réelles. Deux référentiels routiers
dans la même base, et plus personne pour dire lequel fait foi.

## Ce que le pack apporte réellement

Dix-sept modèles n'ont aucun équivalent, et ils forment une chaîne cohérente que le
dépôt ne sait pas tenir aujourd'hui :

```
Defect  →  Treatment  →  QuantityEstimate  →  CostEstimate  →  ProgramItem
défaut     traitement    quantité             coût            programmation
```

| Domaine | Modèles | Verdict |
|---|---|---|
| Dégradations | `Defect` | **ADD** |
| État | `ConditionAssessment` | **ADD** |
| Traitement | `TreatmentCatalog`, `TreatmentRule` | **ADD** |
| Quantités | `QuantityEstimate` | **ADD** |
| Coûts | `PriceBook`, `UnitPrice`, `CostEstimate`, `CostItem`, `CostScenario`, `CostScenarioItem` | **ADD** |
| Programmation | `MaintenanceProgram`, `ProgramItem` | **ADD** |
| Intégration | `ExternalReference` | **ADD** |

C'est la partie du pack qui vaut d'être reprise. Elle répond aux questions 6 et 7 des
sept que pose le master prompt — combien cela coûte, que devons-nous faire — auxquelles
le système est aujourd'hui incapable de répondre.

## Matrice de décision

| Modèle V3 | Actuel | Action | Risque | Migration | Priorité |
|---|---|---|---|---|---|
| `Road`, `RoadSegment` | `Troncon` | **DO NOT TOUCH** | 261 387 lignes, toute la carte publique | aucune | — |
| `RoadAsset`, `RoadAssetType` | `Ouvrage` | **MERGE plus tard** | 1 172 lignes, tous les écrans | `assetTypeId` sur `Ouvrage` | basse |
| `RaiUser` | `User` | **DO NOT TOUCH** | authentification, RBAC, 9 comptes | aucune | — |
| `AuditEvent` | `AuditLog` | **DO NOT TOUCH** | 1 484 lignes, traçabilité légale | aucune | — |
| `Device`…`SyncConflict` | déjà créés | **KEEP l'existant** | néant, tables vides | aucune | — |
| `Defect` | — | **ADD** | faible | additive | **haute** |
| `ConditionAssessment` | — | **ADD** | faible | additive | **haute** |
| `TreatmentCatalog`, `TreatmentRule` | — | **ADD** | faible | additive | moyenne |
| `QuantityEstimate` | — | **ADD** | faible | additive | moyenne |
| `PriceBook`, `UnitPrice` | — | **ADD** | faible | additive | moyenne |
| `CostEstimate`, `CostItem`, `CostScenario*` | — | **ADD** | faible | additive | moyenne |
| `MaintenanceProgram`, `ProgramItem` | — | **ADD** | faible | additive | basse |
| `ExternalReference` | — | **ADD** | faible | additive | basse |

## Deux écarts de fond à trancher avant d'écrire une ligne

**La langue.** Le pack est en anglais, les 35 modèles existants en français sans
exception. Mélanger les deux dans un même `schema.prisma` coûte durablement en lecture.
Reprendre les dix-sept apports en français est un travail de nommage, pas de conception.

**Le préfixe `rai_`.** Il signe l'intention de cohabiter plutôt que d'intégrer. Une fois
les doublons écartés, il n'a plus d'objet : `defauts` vaut mieux que `rai_defects` dans
une base qui n'a qu'un seul référentiel.

## Recommandation

Ne pas exécuter `INTEGRATION.md`. Reprendre le pack comme **document de conception**,
ce que son propre README annonce, et en tirer les dix-sept modèles manquants dans une
migration additive, nommés en français, sans préfixe, rattachés à `Troncon` et à
`Ouvrage` plutôt qu'à `RoadSegment` et `RoadAsset`.
