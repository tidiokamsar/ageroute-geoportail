# Dossiers de conflit : contrat d'interface (lot RC-3)

Statut : contrat de départ du 06/11/2026, commun au backend et au frontend. Complète `CONTRAT.md` (socle) et `API.md`. Référence : cahier des charges v2.0, sections 6, 7, 12.1 (AT-05, AT-08, AT-09, AT-13, AT-14), 20 et 21. Base : `feat/reseaux-integration` (commit `2809abc`).

## 1. Principe

Le socle calcule une analyse 2D indicative à la demande. Ce lot **persiste** le résultat : chaque analyse est reproductible (versions des données, des règles, de l'algorithme), chaque résultat devient un **conflit** suivi par un dossier (mesure, règle, sources, statut, responsable, échéance, preuves, décisions, historique). Garde-fous du cahier : un conflit géométrique est un signal de vérification, jamais un ordre ; « aucun conflit détecté » ne prouve pas l'absence de réseau ; la proposition, la validation et la clôture sont des actes distincts ; aucun ordre de déplacement n'est créé par le système.

## 2. Règles non négociables

Celles de `CONTRAT.md` section 2 (aucune donnée réelle dans le dépôt, suppression logique, écritures auditées, migration additive avec descente, confidentialité), plus :
1. Aucune écriture dans le référentiel officiel (tronçons, ouvrages). La superposition avec le référentiel est en lecture seule.
2. L'historique d'un conflit est **append-only** (triggers refusant UPDATE et DELETE), comme les autres journaux du dépôt.
3. Aucune route ni aucun champ ne crée d'ordre, de déplacement ou de décision automatique. Les coûts estimés et réels sont des champs distincts, jamais calculés ni inventés.
4. Une nouvelle analyse ne supprime ni ne ferme jamais un conflit : un conflit non retrouvé est marqué `aReexaminer`, un verdict humain n'est jamais écrasé par un recalcul.
5. Migration additive `20261031100000_conflits_projets_voirie` (+ descente `backend/prisma/descentes/20261031100000_conflits_projets_voirie.sql`), identifiants uuid.

## 3. Modèle de données

- `RegleConflit` (`regles_conflit_projet`) : `id`, `projetId?` (null = règle générale), `famille?` (enum `TypeReseauTiers`, null = toutes), `code`, `version` (entier croissant par `(projetId, famille, code)`), `toleranceProximiteM` (bande de proximité à vérifier, au-delà de l'emprise), `margeIncertitude` (facteur appliqué à la précision déclarée du jeu pour élargir la zone à vérifier, défaut 1), `statut` (`BROUILLON`, `APPROUVEE`, `RETIREE`), `justification`, `creeParId`, `approuveParId?`, `approuveLe?`, `createdAt`. Une règle approuvée est immuable (nouvelle version pour la changer). Règle par défaut : version 0 `RC-2D-0.1` (celle du socle), `APPROUVEE` par construction, sans seuil inventé : tolérance de proximité 0.
- `AnalyseConflitProjet` (`analyses_conflit_projet`) : `id`, `projetId`, `numero` (séquence par projet), `statut` (`TERMINEE`, `ECHEC`), `largeurEmpriseM`, `largeurChausseeM` (valeurs utilisées), `regles` (JSON : id et version de chaque règle appliquée), `jeux` (JSON : `jeuId`, `sha256`, `version`, `role`, `statut` de chaque jeu pris en compte), `versionAlgorithme`, `resume` (JSON : totaux, nombre de conflits par type et par statut, nouveaux, retrouvés, disparus), `declencheParId`, `duree`, `createdAt`. Immuable.
- `ConflitProjet` (`conflits_projet`) : `id`, `projetId`, `cle` (empreinte stable : projet, axe, objet réseau, type, cellule de localisation arrondie ; unique par projet), `type` (enum `TypeConflit` : `INTERSECTION_CHAUSSEE`, `INTERSECTION_EMPRISE`, `PROXIMITE`, `TRAVERSEE`, `COUVERTURE_INSUFFISANTE`, `DIVERGENCE_SOURCES`), `axe`, `jeuReseauId?`, `objetId?`, `concessionnaireId?`, `mesure` (JSON : `longueurChausseeM`, `longueurEmpriseM`, `distanceMinM`, `nbCroisements`), `geom` (`geometry(Geometry,4326)` : tronçon de réseau en conflit ou points de croisement), `statut` (enum `StatutConflit` : `A_INVESTIGUER`, `POTENTIEL`, `CONFIRME`, `INFIRME`, `TRAITEMENT_DECIDE`, `CLOTURE`), `risque?` (`FAIBLE`, `MOYEN`, `ELEVE`, `INCONNU`), `responsableId?`, `echeance?` (date), `actionProposee?` (texte), `classePrecision?` (copiée du jeu), `verticalEvalue` (booléen, faux tant que profondeur et altitude manquent), `premiereAnalyseId`, `derniereAnalyseId`, `aReexaminer` (booléen), `motifReexamen?` (`NON_RETROUVE`, `MESURE_MODIFIEE`, `NOUVELLE_VERSION_DONNEES`), `tronconsProches` (JSON : code et nom des tronçons du référentiel à moins de la demi-largeur d'emprise, lecture seule), `createdAt`, `updatedAt`.
- `ConflitHistorique` (`conflits_projet_historique`, append-only) : `id`, `conflitId`, `action` (`CREATION`, `RETROUVE`, `MESURE_MODIFIEE`, `STATUT`, `ATTRIBUTION`, `PREUVE`, `DECISION_PROPOSEE`, `DECISION_APPROUVEE`, `DECISION_REFUSEE`, `REEXAMEN`), `ancienStatut?`, `nouveauStatut?`, `justification?`, `acteurId?` (null si calcul), `analyseId?`, `donnees` (JSON), `createdAt`.
- `ConflitPreuve` (`conflits_projet_preuves`, append-only) : `id`, `conflitId`, `type` (`NOTE`, `REFERENCE_DOCUMENT`, `CONTACT_CONCESSIONNAIRE`, `RELEVE_TERRAIN`), `texte`, `reference?` (texte libre : numéro de courrier, nom de plan ; aucun fichier dans ce lot), `auteurId`, `createdAt`.
- `DecisionConflit` (`conflits_projet_decisions`) : `id`, `conflitId`, `option` (`PROTEGER`, `ADAPTER_PROJET`, `DEPLACER_RESEAU`, `SANS_INTERVENTION`, `A_ETUDIER`), `justification`, `contraintes?`, `coutEstime?` (Decimal, avec `deviseCout?`) et `coutReel?` (distincts, jamais calculés), `dateDebutPrevue?`, `dateFinPrevue?`, `statut` (`PROPOSEE`, `APPROUVEE`, `REFUSEE`, `ANNULEE`), `proposeParId`, `approuveParId?`, `approuveLe?`, `motifDecision?`, `derogationSeparation?` (texte), `createdAt`.

## 4. Machine à états du conflit

| De | Vers | Qui | Exigences |
|---|---|---|---|
| (calcul) | `A_INVESTIGUER` | système | précision D, E ou inconnue, vertical non évalué, couverture ou divergence |
| (calcul) | `POTENTIEL` | système | intersection ou proximité sur données de classe A, B ou C |
| `A_INVESTIGUER` | `POTENTIEL`, `INFIRME` | ADMIN, GESTIONNAIRE | justification d'au moins 10 caractères |
| `POTENTIEL` | `CONFIRME`, `INFIRME`, `A_INVESTIGUER` | ADMIN, GESTIONNAIRE | justification ; au moins une preuve pour `CONFIRME` |
| `CONFIRME` | `TRAITEMENT_DECIDE` | ADMIN, GESTIONNAIRE | une décision `APPROUVEE` existe |
| `CONFIRME`, `TRAITEMENT_DECIDE` | `INFIRME` | ADMIN | justification |
| `TRAITEMENT_DECIDE` | `CLOTURE` | ADMIN | motif, acteur identifié ; pour `DEPLACER_RESEAU`, mention explicite que le récolement reste à valider (le récolement n'est pas géré dans ce lot) |
| `INFIRME` | `A_INVESTIGUER` | ADMIN, GESTIONNAIRE | justification (réouverture) |

Toute autre transition : 409 `TRANSITION_INTERDITE`. Chaque transition écrit une ligne d'historique avec acteur, ancien et nouveau statut, justification. Un verdict humain (`CONFIRME`, `INFIRME`, `TRAITEMENT_DECIDE`, `CLOTURE`) n'est jamais modifié par un recalcul : seul `aReexaminer` peut changer.

**Séparation des tâches** : la décision `DEPLACER_RESEAU` et la clôture ne peuvent pas être approuvées par la personne qui les a proposées : 409 `SEPARATION_DES_TACHES`, sauf dérogation d'un `ADMIN` avec un motif (`derogation`), tracée dans l'historique et l'audit. Les autres options (`PROTEGER`, `ADAPTER_PROJET`, `SANS_INTERVENTION`, `A_ETUDIER`) peuvent être approuvées par un `ADMIN` ou `GESTIONNAIRE`, avec la même règle de séparation quand il existe au moins deux comptes habilités (sinon dérogation motivée).

## 5. Analyse persistée (calcul)

Entrées : jeux `AUTORISE` du projet (axes de travaux et réseaux de tiers), largeurs du projet, règles approuvées applicables (la plus récente version approuvée par famille, sinon la règle générale, sinon la règle par défaut). Sortie : lignes de conflit créées ou mises à jour **par clé stable**.
- **Types calculés** : `INTERSECTION_CHAUSSEE` (réseau dans la bande de chaussée), `INTERSECTION_EMPRISE` (dans l'emprise hors chaussée), `PROXIMITE` (hors emprise mais à moins de `toleranceProximiteM` + précision déclarée × `margeIncertitude`), `TRAVERSEE` (croisement de l'axe), `COUVERTURE_INSUFFISANTE` (un axe sans aucun jeu réseau autorisé dont l'emprise englobante le recouvre : zone à investiguer, jamais « absence de réseau »), `DIVERGENCE_SOURCES` (deux jeux de la même famille qui se recouvrent avec des tracés distants de plus que la tolérance : dossier de divergence, chaque source préservée). La divergence est facultative dans ce lot (à faire si le temps le permet, sinon consigné).
- **Rejeu** : un conflit retrouvé (même clé) met à jour `derniereAnalyseId`, la mesure et `aReexaminer` selon le cas ; un conflit non retrouvé reste en base avec `aReexaminer = true`, `motifReexamen = NON_RETROUVE` ; un nouveau conflit est créé. Aucun statut humain n'est modifié. `AT-13` : une nouvelle analyse après changement de plan est versionnée et les conflits affectés sont identifiables.
- **Comparaison** : `GET analyses/:aid/comparaison?avec=:bid` rend `apparus`, `disparus`, `modifies`, `identiques` (comptes et listes de clés).
- **Reproductibilité** : l'analyse enregistre les empreintes et versions des jeux, les versions des règles, les largeurs et la version de l'algorithme ; rejouer avec les mêmes entrées doit redonner les mêmes conflits (test).
- Plafonds, délais et limiteurs : ceux du socle (`config.ts`), `ANALYSE_TROP_LONGUE` en 504, etc. Une seule analyse à la fois par projet (503 `PROJET_OCCUPE`). Superposition avec le référentiel : `tronconsProches` en lecture seule.

## 6. API (préfixe `/api/v2/projets-voirie`, `requireAuth`, `requireModuleAccess("projets-voirie")`, contrôle territorial du projet comme le socle)

| Route | Rôle | Contenu |
|---|---|---|
| `GET /:id/regles` | lecture | règles du projet et générales, versions, statuts |
| `POST /:id/regles` | ADMIN, GESTIONNAIRE | crée une règle `BROUILLON` (`famille?`, `code`, `toleranceProximiteM`, `margeIncertitude`, `justification`) |
| `POST /:id/regles/:regleId/approuver` | ADMIN | passe en `APPROUVEE` (justification) ; l'auteur ne peut pas approuver sa propre règle sans dérogation |
| `POST /:id/analyses` | ADMIN, GESTIONNAIRE | lance et persiste une analyse ; réponse : analyse et résumé |
| `GET /:id/analyses` | lecture | historique des analyses |
| `GET /:id/analyses/:aid` | lecture | détail (versions, règles, résumé) |
| `GET /:id/analyses/:aid/comparaison?avec=:bid` | lecture | différences entre deux analyses |
| `GET /:id/conflits` | lecture | liste filtrable : `statut`, `type`, `axe`, `concessionnaireId`, `responsableId`, `aReexaminer`, `echeanceDepassee`, `q` ; curseur ; compteurs par statut |
| `GET /:id/conflits/:cid` | lecture | fiche complète : mesure, règle, versions et sources, `tronconsProches`, historique, preuves, décisions, transitions possibles pour le compte |
| `PATCH /:id/conflits/:cid` | ADMIN, GESTIONNAIRE | `responsableId`, `echeance`, `risque`, `actionProposee` (historisé) |
| `POST /:id/conflits/:cid/statut` | selon le tableau 4 | `{ vers, justification, derogation? }` |
| `POST /:id/conflits/:cid/preuves` | ADMIN, GESTIONNAIRE | `{ type, texte, reference? }` |
| `POST /:id/conflits/:cid/decisions` | ADMIN, GESTIONNAIRE | propose une décision |
| `POST /:id/conflits/:cid/decisions/:did/approuver` et `/refuser` | ADMIN, GESTIONNAIRE (règle de séparation) | `{ motif, derogation? }` |
| `GET /:id/conflits/export.csv` | ADMIN, GESTIONNAIRE, audité | un conflit par ligne (agrégats, aucune géométrie) |

Les conflits portent sur des jeux confidentiels : la lecture de leur géométrie (`geom`) suit les règles d'audit de consultation du socle. Les identifiants d'URL sont des uuid (400 `IDENTIFIANT_INVALIDE`). Erreurs typées : 409 `TRANSITION_INTERDITE`, 409 `SEPARATION_DES_TACHES`, 409 `DECISION_REQUISE`, 409 `PREUVE_REQUISE`, 422 `JUSTIFICATION_REQUISE`, 409 `REGLE_IMMUABLE`.

## 7. Interface

Troisième onglet **Conflits** de la page projet. Bandeau permanent : « Un conflit est un signal de vérification : aucun déplacement n'est décidé ni ordonné par le système. L'absence de conflit détecté ne prouve pas l'absence de réseau. » Liste filtrable (statut, type, axe, concessionnaire, responsable, à réexaminer, échéance dépassée) avec badges (texte et motif, pas la couleur seule), tri, compteurs, sélection d'un conflit : zoom et surbrillance sur la carte, fiche latérale (mesure, règle et sa version, sources et versions des jeux, précision, tronçons proches du référentiel, historique, preuves, décisions) avec uniquement les actions valides pour le compte et l'état (boutons de transition avec justification obligatoire, ajout de preuve, proposition et approbation de décision avec rappel de la séparation des tâches). Bouton « Lancer une analyse » (ADMIN et GESTIONNAIRE), historique des analyses, comparaison de deux analyses (apparus, disparus, modifiés), écran des règles (liste, création, approbation ADMIN). Export CSV masqué pour les lecteurs. Aucune action « déplacer » ou « ordonner ». Accessibilité, états vide, chargement, erreurs typées comme le socle.

## 8. Tests exigés

Backend : noyau de classification et de machine à états (toutes transitions valides et interdites), clé stable, rejeu idempotent, `aReexaminer`, aucun statut humain écrasé, séparation des tâches avec et sans dérogation, historique append-only (triggers), règles immuables et versionnées, couverture insuffisante, reproductibilité, comparaison, routes (rôles, périmètre, 409), banc PostGIS sur cas de résultat connu (AT-05, AT-06, AT-07, AT-08, AT-09, AT-13, AT-14), inventaire des accès, descente rejouée, `depot-sans-secret`, isolation (aucune écriture dans le référentiel). Frontend : onglet, filtres, fiche, transitions, séparation des tâches, comparaison, règles, axe-core, rien de stocké hors ligne.
