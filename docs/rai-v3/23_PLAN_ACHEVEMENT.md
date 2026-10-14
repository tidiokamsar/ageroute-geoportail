# Plan d'achèvement

Écrit le 14/10/2026. Il couvre tout ce qui reste du cahier des charges, du prompt maître, de
l'exigence vision nationale et de l'addendum V4.1.

**Il est ordonné par dépendances, pas par thème.** Chaque phase ne peut commencer que quand la
précédente est levée, et les phases 0 et 5 sont parallèles à tout le reste.

## Ce qui est déjà fait, pour ne pas le replanifier

Toute la chaîne amont est écrite, testée et en production depuis le 13/10 : appariement GPS,
contexte terrain, portions homogènes avec découpe, fusion, requalification et lignage,
idempotence hors ligne, écran de terrain, écran de validation, moteur de qualité à 9 familles,
PWA renforcée, 4 familles d'actifs linéaires, fiche 360°, et le RCI complet côté code
(moteur, collecte, normalisation, classes). 48 migrations appliquées, 1 329 tests verts.

Les 7 livrables de l'addendum V4.1 sont écrits.

---

## Phase 0 — ce qui ne dépend de personne

Faisable immédiatement, sans décision ni accès supplémentaire. **C'est la seule phase que je
peux mener seul de bout en bout.**

| # | Tâche | Pourquoi maintenant | Effort |
|---|---|---|---|
| 0.1 | ~~Fiches de comparaison des 42 doublons géométriques~~ | **fait le 14/10** — [AUDIT_DOUBLONS_GEOMETRIQUES.md](AUDIT_DOUBLONS_GEOMETRIQUES.md) | — |
| 0.2 | ~~Référentiel provisoire des 1 029 axes régionaux~~ | **fait le 14/10** — [REFERENTIEL_AXES_REGIONAUX.md](REFERENTIEL_AXES_REGIONAUX.md) | — |
| 0.3 | ~~Seed des référentiels états de chaussée et revêtements~~ | **fait le 14/10**, 8 revêtements et 5 états en production, praticabilité laissée vide | — |
| 0.4 | ~~Index GiST planaire sur `troncons.geom`~~ | **abandonné le 14/10 : la mesure a démenti mon diagnostic.** Remplacé par 0.4bis | — |
| 0.4bis | ~~Restructurer le détecteur hors territoire~~ | **fait le 14/10 : 58,2 s → 14,2 s**, sans aucun nouvel index | — |
| 0.5 | **Agrégation SQL de la couverture réseau** | `couverture()` est par tronçon ; 261 387 lignes interdisent le calcul en mémoire | moyen |
| 0.6 | **Continuité dans l'appariement** (cap, position précédente) | `heading` compte 0 occurrence ; améliore un module déjà bon | moyen |
| 0.7 | **Coefficient multiplicateur dans le métré** | écart nommé le 13/10, jamais traité | faible |
| 0.8 | **Lier les 5 domaines de validation sans route** | `TRONCON`, `OUVRAGE`, `DEFAUT`, `OBSERVATION`, `POINT_NOIR` | moyen |
| 0.9 | **Nettoyer les avertissements `act()`** de `TerrainPortionsPage` | 21 tests passent mais bruyamment ; le bruit masque les vraies régressions | faible |
| 0.10 | **Rafraîchir `AGENTS.md`** | il donne la PWA et l'API publique comme non déployées, et annonce 21 routes | faible |

**0.4 mérite un mot, parce que j'avais tort.** J'avais inscrit l'ajout d'un index GiST
planaire sur `troncons.geom`, en raisonnant que l'index existant porte sur `(geom)::geography`
et que toute comparaison planaire dégénère donc en balayage.

La mesure l'a démenti. Les deux seules comparaisons planaires du backend sont dans le
détecteur hors territoire, et sa forme corrélée **utilise déjà** l'index de `limites_admin` :
le balayage des 261 387 tronçons est voulu, puisqu'il faut un verdict par ligne. Un index sur
`troncons.geom` n'aurait rien changé, et aurait coûté un verrou en production pour rien.

Le vrai problème n'était pas un index manquant, c'était **le sens du parcours**. En partant des
limites découpées pour entrer dans l'index géographique **existant**, la requête passe de
**58,2 s à 14,2 s**. Mesuré avant et après, sans ajouter un seul index.

## Phase 1 — vos neuf arbitrages

**Aucun ne demande du code.** Tous bloquent une mise en service. Rangés par ce qu'ils libèrent.

| # | Décision | Ce qu'elle débloque |
|---|---|---|
| 1.1 | **Pondérations du RCI** : cahier §13 (signalisation 10) ou votre liste à neuf (environnement 5 + autres 5) | tout l'aval |
| 1.2 | **Définir « autres critères »**, ou retirer ses 5 points | sans définition, poids mort renormalisé à chaque calcul |
| 1.3 | **Fraîcheur maximale** (365 jours proposés) | — |
| 1.4 | **Confiances acceptées** (`HIGH`, `MEDIUM` proposées) | — |
| 1.5 | **Approuver la règle** | **le seul geste rendant un score publiable** |
| 1.6 | **`dateDerniereEvaluation`** : l'alimenter, et depuis quoi — **pas** `valeurs_qualite.observedAt`, qui porte des dates de reprise | la fraîcheur, aujourd'hui inopérante |
| 1.7 | **Valeurs de praticabilité** | le champ praticabilité de l'écran de terrain, désactivé |
| 1.8 | **Règle de périmètre hors territoire** : ne rien exclure, exclure les 7 (-0,340 %), ou un seuil | la justesse des 21 156,6 km publiés |
| 1.9 | **Fusionner `main`** | la production sert 52 commits absents du tronc |

## Phase 2 — après l'approbation de la règle

| # | Tâche | Dépend de |
|---|---|---|
| 2.1 | Peupler `rci-2026.1` et calculer les premiers scores | 1.1 à 1.5 |
| 2.2 | **Moteur de risque** (`engines/risque.ts`) | 2.1 |
| 2.3 | **État avant → intervention → état après**, sur `portions_lignage` | portions alimentées |
| 2.4 | Étendre le tableau de bord aux portions et à la qualité | 2.1 |

Le moteur de risque est le premier des quatre absents, et il n'a de sens qu'une fois un score
d'état disponible : un risque est un état croisé avec un enjeu.

## Phase 3 — la chaîne économique

| # | Tâche | Dépend de |
|---|---|---|
| 3.1 | **Moteur de traitements** (`engines/traitement.ts`) | 2.2 |
| 3.2 | **Table de prix unitaires** et **moteur de coûts** (`engines/cout.ts`) | 3.1 |
| 3.3 | **Moteur de programmation** (`engines/programmation.ts`) | 3.2 |
| 3.4 | **Alertes patrimoniales**, à côté des alertes contractuelles existantes | 2.1 |

**Contrainte du cahier à ne pas perdre de vue** : « Les estimations de coûts ne doivent jamais
créer automatiquement un décompte. » Le moteur de coûts produit une estimation, pas un
engagement comptable.

La route `/programmation` est déjà déclarée dans `App.tsx` sans moteur derrière. Une page sans
moteur n'est pas une fonctionnalité livrée, et c'est à 3.3 qu'elle en devient une.

## Phase 4 — mobile et intégrations

| # | Tâche | Blocage |
|---|---|---|
| 4.1 | Enveloppe **Capacitor** autour de la PWA | aucun, le code est écrivable ici |
| 4.2 | **Compiler et tester l'APK** | **ni `adb`, ni `gradle`, ni `java` ici** : à faire sur un poste outillé |
| 4.3 | Contrats d'intégration **DigitalRoad** | **aucun accès** : non vérifiable |
| 4.4 | Architecture prête pour la **vision par ordinateur** | aucun, mais à faire après les moteurs |

Pour 4.4, ce qui manque est nommé : un stockage adressable des médias, et un champ de résultat
d'inférence qui distingue « non analysé » de « analysé sans détection ». La même distinction
entre une absence et un zéro que le moteur de condition tient déjà.

## Phase 5 — sécurité, en parallèle et sans attendre

| # | Tâche | État |
|---|---|---|
| 5.1 | Compte de test `ADMIN` en production | **fait** le 13/10, audité |
| 5.2 | **Rendre le dépôt privé** | ouvert — il porte une IP de production et un chemin de clé |
| 5.3 | **Changer le mot de passe ADMIN** | ouvert — transmis en clair, jamais changé |
| 5.4 | **Créer un rôle de secours, puis réduire `bdri_app`** | ouvert — il est superuser **et** seul rôle de connexion |
| 5.5 | Statuer sur l'`ADMIN` dormant | ouvert |
| 5.6 | Copie hors serveur de la clé de sauvegarde | ouvert |

**L'ordre de 5.4 n'est pas négociable** : réduire les privilèges avant d'avoir un rôle de
secours coupe le service, puisque `bdri_app` est le seul moyen de se connecter.

---

## Le chemin critique, en une phrase

**Rien de ce qui suit la phase 2 ne peut produire un chiffre juste tant que personne n'a relevé
une portion sur le terrain et que la règle n'est pas approuvée.**

Les phases 2 et 3 représentent l'essentiel du code restant — quatre moteurs — mais elles
produiraient, sur les données actuelles, des refus bien motivés plutôt que des résultats. Les
écrire avant la première campagne de collecte est possible et utile ; les croire opérationnelles
le serait faux.

## Ce que je ne ferai pas sans vous le demander

Approuver la règle RCI, marquer un tronçon de RN4 comme hors réseau national, fusionner `main`,
peupler un référentiel avec des valeurs que personne n'a fixées, supprimer ou déplacer une
géométrie, et toucher aux privilèges de `bdri_app` avant qu'un rôle de secours existe.
