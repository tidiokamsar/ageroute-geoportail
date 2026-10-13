# Tableau de conformité du cahier des charges

Mesuré le 13/10/2026 contre le code réel. Chaque ligne porte sa preuve, vérifiable dans le
dépôt. Les états suivent le vocabulaire demandé par le mandat.

**Règle de lecture** : un écran visible n'est jamais une preuve. Chaque état ci-dessous
s'appuie sur du code, un test, une migration ou une mesure en base, nommés.

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

| Exigence | État | Preuve | Écart | Action | Prio | Dépend de | Test d'acceptation |
|---|---|---|---|---|---|---|---|
| GPS → tronçon, abscisse locale, PK facultatif | **T** | `geo/appariement.ts`, `geo/appariement.test.ts` | — | — | — | — | Position précise sur RN : tronçon et abscisse rendus |
| Confiance tenant compte de la séparation entre candidats | **T** | `confiance()`, deux facteurs multipliés | — | — | — | — | Deux routes parallèles : confiance s'annule |
| Refus de rattacher sous seuil | **T** | `CONFIANCE_MINIMALE = 0.35` | — | — | — | — | GPS à 15 m en urbain : `apparie: false` |
| Candidats proposés en cas d'ambiguïté | **T** | `candidats()`, drapeau `ambigu` | — | — | — | — | Intersection : `ambigu: true` |
| Continuité du déplacement (cap, position précédente) | **A** | mesuré : `heading` absent du dépôt | l'appariement ignore la direction | ajouter cap et point précédent à `OptionsAppariement` | moyenne | — | Trajet le long de deux parallèles : pas de saut |
| Contexte terrain en une requête | **T** | `api-v2/field.routes.ts`, 10 tests | — | — | — | portions | `GET current-context` rend tronçon, portion, couverture, actifs |
| Portions homogènes : modèle et règles | **T** | `reseau/portions.ts`, 40 tests | — | — | — | — | Tronçon à 4 portions : répartition exacte, trous nommés |
| Portions : table et migration | **IT** | migration `20261013180000`, non appliquée | non déployée | appliquer après validation | haute | — | Banc d'essai sur copie : passé le 13/10 |
| Écriture : créer, découper, fusionner, requalifier | **T** | `reseau/portions.service.ts`, 17 + 12 tests | — | — | — | table | Découpe : original remplacé, deux morceaux, lignage |
| Référentiels configurables | **IT** | migration `20261013200000`, non appliquée | non déployée | appliquer, puis `npm run referentiels:seed` | haute | — | Code inventé refusé par la clé étrangère |
| Praticabilité | **B** | `referentiel_praticabilites` sort vide | **le cahier n'énonce aucune valeur** | **décision AGEROUTE** | haute | décision | Une portion peut porter une praticabilité |
| Écran de terrain | **A** | aucun composant ne consomme `current-context` | l'API existe, rien ne l'appelle | écrire la page et ses tests | **haute** | contexte | Un agent voit sa position, sa portion, et qualifie |

## Défauts et actifs

| Exigence | État | Preuve | Écart | Action | Prio | Dépend de | Test d'acceptation |
|---|---|---|---|---|---|---|---|
| Défaut indépendant du PK | **T** | `defauts` + `geom` + `emprise` | — | — | — | — | Défaut créé sans PK, localisé par abscisse |
| Catalogue administrable | **T** | `catalogue_defauts`, 13 types | — | — | — | — | Un type ajouté apparaît sans déploiement |
| Gravité et étendue séparées | **T** | `EtendueDefaut` + gravité | — | — | — | — | Nid-de-poule grave et ponctuel |
| Métré depuis les dimensions | **T** | `field/defauts.regles.ts`, `MethodeQuantite` | coefficient multiplicateur absent | ajouter `quantite = nombre x coefficient` | basse | — | Surface = longueur x largeur |
| Ouvrages : 15 familles | **P** | `TypeOuvrage` = 9 valeurs | manquent fossés, caniveaux, signalisation, glissières | migration additive de l'enum | moyenne | — | Un fossé peut être inventorié |
| Recherche d'actifs à proximité | **T** | `contexte.prisma.ts`, `ST_DWithin` | — | — | — | — | Ouvrage à 40 m rendu, trié par distance |

## Gouvernance et qualité

| Exigence | État | Preuve | Écart | Action | Prio | Dépend de | Test d'acceptation |
|---|---|---|---|---|---|---|---|
| Validation par un tiers, pas d'auto-validation | **T** | `governance/validation.ts`, 75 tests | — | — | — | — | Auteur validant son relevé : 403 AUTO_VALIDATION |
| Contrôle **côté serveur** | **T** | `portions.routes.test.ts` : `statutValidation` client ignoré | — | — | — | — | `statutValidation: VALIDE` au POST : ignoré |
| Validateur désigné par domaine | **T** | `governance/delegation.ts` | 5 domaines sur 8 sans route | lier `TRONCON`, `OUVRAGE`, etc. | moyenne | décision | Hors délégation : 403 |
| Audit de toute écriture | **T** | `logAuditTransactionnelle` dans la transaction | — | — | — | — | Découpe : 3 lignes d'audit, même transaction |
| Chevauchements signalés, non corrigés | **T** | `chevauchements()`, contrainte d'exclusion | — | — | — | — | Deux validées chevauchantes : refus base |
| Moteur de qualité des données | **P** | `valeurs_qualite`, `conflits_sync`, `chevauchements()` | pas de moteur consolidé : doublons, géométries invalides, inspections périmées | écrire `qualite/controles.ts` | **haute** | aucune | 9 familles d'anomalies classées sans suppression |

## Décision et pilotage

| Exigence | État | Preuve | Écart | Action | Prio | Dépend de | Test d'acceptation |
|---|---|---|---|---|---|---|---|
| Indicateur d'état (RCI) configurable et explicable | **IT** | `engines/condition.ts`, 26 tests | **coefficients non approuvés** | **décision AGEROUTE** | **haute** | décision | Score publiable une fois la règle approuvée |
| Couche de collecte du RCI | **A** | `calculerRci` n'est appelé que par ses tests | rien ne produit les 8 composantes | écrire la collecte | haute | décision | Un tronçon reçoit un score depuis ses données |
| Longueurs par revêtement, état, critique | **T** | `indicateurs()`, 6 tests | — | — | — | référentiels | « Inconnu » jamais compté comme « non bitumé » |
| Couverture à l'échelle du réseau | **P** | `couverture()` par tronçon | 261 387 tronçons : calcul en mémoire exclu | agrégation SQL ou vue matérialisée | moyenne | portions | Couverture par région en moins d'une seconde |
| Moteur de risque | **A** | aucune occurrence | — | après le RCI | basse | RCI | — |
| Moteur de traitements | **A** | mesuré : « traitement » = mot français, 14 fois | — | après le RCI | basse | RCI | — |
| Prix unitaires et coûts | **A** | aucune table de prix | — | après les traitements | basse | traitements | — |
| Programmation | **A** | aucune occurrence | — | après les coûts | basse | coûts | — |
| État avant / intervention / après | **A** | `etatAvant`/`etatApres` : zéro occurrence | — | relation via `portions_lignage` | moyenne | portions | Un OT lie deux versions de portion |
| Tableau de bord national | **P** | `modules/dashboard` | ne connaît ni portions ni qualité | étendre après les portions | moyenne | portions | Chiffres égaux aux données stockées |
| Alertes | **P** | `jobs/alertes-contractuelles.ts` | contractuelles seulement, pas patrimoniales | après les indicateurs | basse | RCI | — |

## Mobile et hors ligne

| Exigence | État | Preuve | Écart | Action | Prio | Dépend de | Test d'acceptation |
|---|---|---|---|---|---|---|---|
| Hors ligne : file, idempotence, conflits | **T** | `operations_sync`, `conflits_sync`, `api-v2/sync.routes.ts` | — | — | — | — | Coupure réseau : reprise sans doublon |
| Idempotence des portions | **IT** | `clientOperationId`, migration `20261013220000` | non appliquée | appliquer | haute | — | Même clé rejouée : portion existante rendue |
| Application mobile | **A** | mesuré : aucun `app.json`, `build.gradle`, `metro.config` | **seule une PWA existe** | voir la décision ci-dessous | **haute** | — | Un APK s'installe et collecte hors ligne |
| Compilation et test d'un APK | **B** | mesuré : `adb`, `gradle`, `java` absents de cet environnement | aucune chaîne Android disponible | écrire le code et la procédure ; **compilation à faire ailleurs** | — | accès | — |

### Décision documentée sur le mobile

Le mandat demande de choisir la solution la plus cohérente avec les technologies du projet
et de justifier. Trois options, et une seule est vérifiable ici.

| Option | Coût | Vérifiable dans cet environnement |
|---|---|---|
| Android natif (Kotlin) | tout réécrire | **non** : ni SDK, ni Java |
| React Native | nouvelle base, duplication du code carte | **non** : build Android requis |
| **PWA renforcée + enveloppe Capacitor** | réutilise React/Vite/Leaflet déjà là | **oui pour la PWA**, non pour l'APK |

**Retenu : la troisième.** La PWA existe déjà avec son service worker et sa file de
synchronisation ; la renforcer est réutilisable immédiatement, s'installe depuis le
navigateur sur Android, et se teste ici (`vitest`, `vite build`). Capacitor enveloppe
ensuite exactement le même code pour produire un APK, sans réécrire la carte ni l'offline.

Le §9 du cahier disait « Android-first », et un APK reste nécessaire pour la distribution
hors navigateur et pour l'accès caméra fiable. **La production de l'APK est donc préparée
et documentée, mais non exécutée : cet environnement n'a pas de chaîne Android.** C'est un
blocage d'accès, pas un choix.

## Les obstacles qui exigent une décision, et non du code

Le mandat demande de signaler explicitement ce qui requiert une intervention. Trois choses,
et aucune ne se contourne techniquement.

1. **Les coefficients du RCI.** Le mécanisme est écrit et la règle `rci-2026.1` existe, non
   approuvée. Sans approbation, aucun score n'est publiable, donc pas de risque, pas de
   traitement, pas de programmation. C'est le verrou de toute la moitié aval.
2. **Les valeurs de praticabilité.** Le référentiel existe et sort vide, parce que le cahier
   n'en énonce aucune. Aucune portion ne peut en porter avant qu'elles soient fixées.
3. **Le répertoire des routes régionales.** 1 029 tronçons régionaux portent 1 029 noms
   distincts sans structure de route : leurs PK ne sont pas calculables. L'abscisse locale
   contourne le problème pour la qualification, pas pour la restitution officielle.

Et quatre points de sécurité, hérités, qui ne sont pas des décisions techniques :

- **Le dépôt est public** et contient une IP de serveur de production ainsi que le chemin de
  la clé de chiffrement des sauvegardes. `AGENTS.md` règle 1 l'interdit explicitement.
- **Le mot de passe ADMIN** transmis en clair n'a jamais été changé.
- **Un compte de test détient `ADMIN`** en production.
- **`bdri_app`, le compte applicatif, est superuser PostgreSQL** : une injection SQL
  donnerait les pleins pouvoirs sur l'instance. Se corrige sans rien casser.

## Ordre d'exécution retenu

Les dépendances ci-dessus imposent cet ordre, et non une préférence.

1. **L'écran de terrain** qui consomme `current-context` et l'écriture de portions. C'est le
   seul maillon manquant du parcours complet, et tout le reste s'appuie sur des portions
   réellement saisies.
2. **Le moteur de qualité des données**, qui ne dépend d'aucune décision et travaille sur ce
   qui existe déjà.
3. **Les quatre familles d'actifs manquantes**, migration additive indépendante.
4. **La PWA renforcée** en application de terrain, puis l'enveloppe Capacitor préparée.
5. **L'agrégation SQL de la couverture**, premier endroit où 261 387 tronçons contraignent
   la conception.
6. **La continuité dans l'appariement**, qui améliore un module déjà bon.
7. Le reste attend les trois décisions.
