# Tableau de conformité du cahier des charges

**Rafraîchi le 14/10/2026.** Première rédaction le 13/10, avant le déploiement : plusieurs
lignes y donnaient comme absent ou non appliqué ce qui est désormais en production. Chaque
état ci-dessous porte sa preuve, vérifiable dans le dépôt ou mesurée en base.

**Règle de lecture** : un écran visible n'est jamais une preuve. Et **un module déployé n'est
pas un module alimenté** : plusieurs lignes marquées T portent sur des tables vides, ce que la
colonne « Écart » dit explicitement.

## Barème

| État | Signification |
|---|---|
| **T** | TERMINÉE ET TESTÉE |
| **IT** | IMPLÉMENTÉE MAIS À TESTER |
| **P** | PARTIELLEMENT IMPLÉMENTÉE |
| **M** | MAQUETTE OU SIMULATION |
| **A** | ABSENTE |
| **B** | BLOQUÉE PAR UNE DÉPENDANCE OU UN ACCÈS |

## Chaîne de qualification terrain

| Exigence | État | Preuve | Écart | Action | Prio |
|---|---|---|---|---|---|
| GPS → tronçon, abscisse locale, PK facultatif | **T** | `geo/appariement.ts` + tests | — | — | — |
| Confiance tenant compte de la séparation entre candidats | **T** | `confiance()`, deux facteurs multipliés | — | — | — |
| Refus de rattacher sous seuil | **T** | `CONFIANCE_MINIMALE = 0.35` | — | — | — |
| Candidats proposés en cas d'ambiguïté | **T** | `candidats()`, drapeau `ambigu` | — | — | — |
| Continuité du déplacement (cap, position précédente) | **A** | mesuré le 14/10 : `heading` **0 occurrence** | l'appariement ignore la direction | ajouter cap et point précédent à `OptionsAppariement` | moyenne |
| Contexte terrain en une requête | **T** | `api-v2/field.routes.ts`, 10 tests ; **401 en production** | — | — | — |
| Portions homogènes : modèle et règles | **T** | `reseau/portions.ts`, **40 tests** | — | — | — |
| Portions : table et migration | **T** | migration `20261013180000` **appliquée le 13/10 à 18:21** | **table vide : 0 ligne** | alimenter par la collecte | — |
| Écriture : créer, découper, fusionner, requalifier | **T** | `portions.service.ts` **17 tests**, `api-v2/portions.routes.ts` **19 tests** | — | — | — |
| Référentiels configurables | **P** | migration `20261013200000` **appliquée** ; `api-v2/referentiels.routes.ts` **401** | **les 3 tables sont vides** | lancer le seed des états de chaussée et des revêtements | **haute** |
| Praticabilité | **B** | migration `20261013260000` appliquée, table vide | **le cahier n'énonce aucune valeur** | **décision AGEROUTE** | haute |
| Écran de terrain | **T** | `TerrainPortionsPage.tsx` **21 tests**, `PortionsValidationPage.tsx` **16 tests** | avertissements `act()` dans les tests | nettoyer les enveloppes `act` | basse |
| Position GPS continue côté client | **T** | `hooks/usePositionGps.ts`, **15 tests** | — | — | — |

## Défauts et actifs

| Exigence | État | Preuve | Écart | Action | Prio |
|---|---|---|---|---|---|
| Défaut indépendant du PK | **T** | `defauts` + `geom` + `emprise` | **table vide : 0 ligne** | alimenter par la collecte | — |
| Catalogue administrable | **T** | `catalogue_defauts`, 13 types ; `/api/v2/defauts/catalogue` **401** | — | — | — |
| Gravité et étendue séparées | **T** | `EtendueDefaut` + gravité | — | — | — |
| Métré depuis les dimensions | **T** | `field/defauts.regles.ts`, **49 tests** | coefficient multiplicateur absent | ajouter `quantite = nombre x coefficient` | basse |
| Familles d'ouvrages | **T** | `TypeOuvrage` = **13 valeurs** en production | les 4 manques nommés le 13/10 sont **comblés** (`FOSSE`, `CANIVEAU`, `SIGNALISATION`, `GLISSIERE`) | vérifier si le cahier en exige davantage que 13 | basse |
| Recherche d'actifs à proximité | **T** | `contexte.prisma.ts`, `ST_DWithin` | — | — | — |

## Gouvernance et qualité

| Exigence | État | Preuve | Écart | Action | Prio |
|---|---|---|---|---|---|
| Validation par un tiers, pas d'auto-validation | **T** | `governance/validation.ts`, 75 tests | — | — | — |
| Contrôle **côté serveur** | **T** | `portions.routes.test.ts` : `statutValidation` client ignoré | — | — | — |
| Validateur désigné par domaine | **T** | `governance/delegation.ts` ; `PORTION` ajouté à `DomaineValidation` | 5 domaines sur 8 sans route | lier `TRONCON`, `OUVRAGE`, etc. | moyenne |
| Audit de toute écriture | **T** | `logAuditTransactionnelle` dans la transaction | — | — | — |
| Chevauchements signalés, non corrigés | **T** | `chevauchements()` + contrainte d'exclusion `btree_gist` | — | — | — |
| **Moteur de qualité des données** | **T** | `qualite/anomalies.ts` **23 tests**, `api-v2/qualite.routes.ts` **14 tests** ; **401 en production** | — | — | — |

Le moteur de qualité était marqué **P** le 13/10 avec la mention « pas de moteur consolidé ».
Il existe depuis, avec **9 familles d'anomalies**, une agrégation (un détecteur par objet
émettrait plus d'un million de lignes) et un test vérifiant qu'**aucune correction proposée ne
dit « supprimer »**, sur les neuf familles.

## Décision et pilotage

| Exigence | État | Preuve | Écart | Action | Prio |
|---|---|---|---|---|---|
| Indicateur d'état (RCI) configurable et explicable | **B** | `engines/condition.ts` **38 tests** ; normalisation et classes **appliquées** | **règle non approuvée**, `regles_condition` vide | **décision AGEROUTE** | **haute** |
| Couche de collecte du RCI | **T** | `engines/condition.collecte.ts`, **20 tests** | — | — | — |
| Classes de score | **T** | `classerScore()`, migration `20261013300000` appliquée | — | — | — |
| Correspondance état → score | **T** | migration `20261013280000` appliquée, valeurs arbitrées le 13/10 | — | — | — |
| Fiche 360° du tronçon | **T** | `troncons.service.ts` `fiche()`, **11 tests** | — | — | — |
| Longueurs par revêtement, état, critique | **T** | `indicateurs()`, 6 tests | — | — | référentiels |
| Couverture à l'échelle du réseau | **P** | `couverture()` par tronçon | 261 387 tronçons : calcul en mémoire exclu | agrégation SQL ou vue matérialisée | moyenne |
| Moteur de risque | **A** | mesuré le 14/10 : `engines/risque.ts` **absent** | — | après l'approbation du RCI | haute |
| Moteur de traitements | **A** | mesuré : `engines/traitement.ts` **absent** | — | après le risque | moyenne |
| Prix unitaires et coûts | **A** | mesuré : `engines/cout.ts` **absent**, aucune table de prix | — | après les traitements | moyenne |
| Programmation | **A** | mesuré : `engines/programmation.ts` **absent**, alors que la route `/programmation` est déclarée | **une page sans moteur** | après les coûts | moyenne |
| État avant / intervention / après | **A** | mesuré le 14/10 : `etatAvant`/`etatApres` **0 occurrence** | — | relation via `portions_lignage` | moyenne |
| Tableau de bord national | **P** | `modules/dashboard` | ne connaît ni portions ni qualité | étendre | moyenne |
| Alertes | **P** | `jobs/alertes-contractuelles.ts` | contractuelles seulement, **pas patrimoniales** | après les indicateurs | basse |

## Mobile et hors ligne

| Exigence | État | Preuve | Écart | Action | Prio |
|---|---|---|---|---|---|
| Hors ligne : file, idempotence, conflits | **T** | `operations_sync`, `conflits_sync` ; `/api/v2/sync/status` **401** | — | — | — |
| Idempotence des portions | **T** | `clientOperationId`, migration `20261013220000` **appliquée** ; `field/portions.sync.ts` **13 tests** | — | — | — |
| PWA renforcée | **T** | `public/sw.js` + `sw-policy.js` ; **`/sw.js` répond 200 en production** | — | — | — |
| Application mobile native | **A** | aucun `app.json`, `build.gradle`, `metro.config` | **seule une PWA existe** | enveloppe Capacitor | haute |
| Compilation et test d'un APK | **B** | mesuré : `adb`, `gradle`, `java` absents de cet environnement | aucune chaîne Android | **compilation à faire ailleurs** | — |

Le choix retenu reste la **PWA renforcée plus enveloppe Capacitor** : elle réutilise
React/Vite/Leaflet déjà en place, s'installe depuis le navigateur, se teste ici, et Capacitor
enveloppe ensuite le même code sans réécrire la carte ni le hors-ligne. La production de l'APK
est un blocage d'accès, pas un choix.

## Ce qui est déployé et vérifié

Déploiement du 13/10/2026, images construites à 18:17:26. **48 migrations appliquées**,
« Database schema is up to date! ». `/api/health` 200, `echecsDepuisDemarrage` **0**, aucune
erreur au journal. `/api/public/carte/geo` sert 785 Ko en 0,36 s.

**1 329 tests passent** : 1 047 backend sur 76 fichiers, 282 frontend sur 22.

## Les obstacles qui exigent une décision, et non du code

1. **Les coefficients du RCI et l'approbation de la règle.** Sans elle, aucun score n'est
   publiable, donc pas de risque, pas de traitement, pas de programmation. C'est le verrou de
   toute la moitié aval.
2. **Les valeurs de praticabilité.** Le référentiel est déployé et sort vide parce que le
   cahier n'en énonce aucune.
3. **Le répertoire des routes régionales.** 1 029 tronçons régionaux portent 1 029 noms
   distincts sans structure de route : leurs PK ne sont pas calculables.
4. **La règle de périmètre hors territoire.** 7 tronçons de RN4 et RN1, 72,0 km, comptent dans
   les 21 156,6 km publiés. Voir [AUDIT_TRONCONS_HORS_TERRITOIRE.md](AUDIT_TRONCONS_HORS_TERRITOIRE.md).

Et quatre points de sécurité, dont un seul est traité :

| Point | État |
|---|---|
| Compte de test détenant `ADMIN` en production | **rétrogradé** le 13/10, audité `SECURITY_EVENT` |
| Dépôt public contenant une IP de production et un chemin de clé | **ouvert** |
| Mot de passe ADMIN transmis en clair, jamais changé | **ouvert** |
| `bdri_app` superuser PostgreSQL et seul rôle de connexion | **ouvert** — exige un rôle de secours d'abord |

## Le verrou qui n'est dans aucun tableau

Mesuré en base le 14/10 : `missions` **0**, `observations` **0**, `defauts` **0**, `portions`
**0**, les trois référentiels **0**, `regles_condition` **0**, `evaluations_condition` **0**.

Toute la chaîne amont est écrite, testée, déployée — et vide. **Le chemin critique du projet
n'est plus le code, c'est la première campagne de collecte.**
