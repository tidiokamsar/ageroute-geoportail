# Aide à la décision : contrat API, interface et périmètres

Branche `feat/aide-decision` (worktree `F:\ageroute-ad`). Ce document est le CONTRAT que les agents respectent en parallèle. Toute évolution se fait ici d'abord. PROVISOIRE = choix de conduite réversible, jamais une règle officielle.

## 1. Principes (cahier, non négociables)

1. Une donnée inconnue n'est pas égale à zéro. Aucun KPI fictif, aucune valeur de repli, aucun `|| 0` sur une absence. Les chiffres de la maquette ne sont pas des données.
2. Un indicateur est présenté avec : unité, période, périmètre, source, date de mise à jour, définition accessible, statut de la définition (`PROVISOIRE` tant que le métier ne l'a pas validée), couverture si pertinente.
3. Une estimation n'est pas une donnée officielle ; une priorité calculée n'est pas une décision ; une simulation n'est pas un engagement. Chaque écran, rapport et export portant des recommandations ou des simulations dit « consultatif, non engageant ».
4. Longueur métier (`longueurKm`) et longueur géométrique sont conservées et affichées séparément ; la géométrique ne remplace jamais la métier ; une divergence au-dessus du seuil du détecteur est signalée, jamais corrigée.
5. Tronçons non évalués : comptés et affichés à part, exclus du dénominateur des taux. Jamais assimilés à « bon ».
6. Marché recensé ≠ marché actif ; contractuel ≠ engagé ≠ décaissé ≠ prévisionnel ; avancement déclaré ≠ constaté ; état physique ≠ avancement financier ≠ priorité.
7. Le module ne modifie aucune donnée officielle (budgets, marchés, référentiel). Il n'écrit que dans ses propres tables (paramètres, scénarios, fiches, plans, historiques) et l'audit.
8. Tout contrôle d'accès est côté serveur (module, rôle, périmètre territorial) ; un compte régional ne reçoit jamais de totaux nationaux ; ressource hors périmètre ou inexistante = même 404.
9. Toute écriture sensible est auditée dans la même transaction, avec valeurs avant/après.

## 2. Droits (PROVISOIRE, à valider par le métier)

Clé de module existante : `decision` (lecture du module), `programmation` (moteur, scénarios), `marches` (données contractuelles), `rapports` (rapports). Permissions par action, appliquées côté serveur :

| Action | Qui (provisoire) | Règle supplémentaire |
|---|---|---|
| consulter | module `decision` | périmètre territorial du compte ; totaux nationaux réservés aux comptes nationaux |
| proposer (scénario, intervention, barème) | ADMIN, GESTIONNAIRE | auteur enregistré |
| valider / approuver (poids, barèmes, scénarios, prévisions retenues) | ADMIN | **jamais l'auteur de la proposition** (`AUTO_VALIDATION` refusée, réutiliser `governance/validation.ts`) |
| paramétrer (poids, barèmes) | ADMIN, GESTIONNAIRE (proposer) ; ADMIN (approuver) | version immuable, historique lisible |
| exporter | module `rapports` + rôle ADMIN, GESTIONNAIRE | journal d'export, périmètre, filtres, date, définitions, mention consultative |

L'attribution de la clé `decision` aux comptes reste un geste d'administration. Aucune migration de données n'octroie un accès.

## 3. Filtres partagés (même périmètre pour KPI, carte, liste, exports : AD-11)

`FiltresDecision` : `{ regionId?: number; classe?: string[]; etat?: string[]; statutChantier?: string[]; depuis?: string (ISO date); jusqua?: string (ISO date) }`. Filtres PAS disponibles faute de données structurées (affichés désactivés avec la raison, jamais retirés en silence) : préfecture (texte libre sur le tronçon), axe (aucune entité), bailleur/financement (texte libre sur `Chantier`, clé étrangère sur `Marche` : trois formes), gravité, type d'intervention (tant que le moteur ne l'expose pas). Sérialisation en paramètres de requête identiques sur tous les endpoints ci-dessous ; une seule fonction (`serialiserFiltres`) côté frontend.

## 4. Endpoints (préfixe `/api/v2/aide-decision`, module `decision`)

Montage dans `backend/src/api-v2/index.ts` par l'orchestrateur ; chaque lot fournit son routeur dans un fichier propre.

| Route | Lot | Contenu |
|---|---|---|
| `GET /dictionnaire` | 2 | dictionnaire des KPI : code, libellé, définition, formule, unité, périmètre, source, conditions, limites, responsable métier à confirmer, `statutDefinition` |
| `GET /synthese` | 2 | `{ kpis: Kpi[], repartitionEtat, degradationParRegion (part du réseau dégradé par région : ce n'est PAS un score de priorité), budget: { contractuel, engage, decaisse, previsionnel (chacun avec son etat de disponibilite) }, fraicheur, couverture, avertissements }` |
| `GET /qualite` | 2 | anomalies du périmètre (détecteurs de `backend/src/qualite`), couverture et taux de non évalués par région |
| `GET /interventions` | 3 | liste paginée par curseur : intervention candidate, rang, score ou `scoreIncomplet`, contributions par critère, critères absents, coût estimé (unité, source, validité) ou `coutNonEstimable`, localisation (valide ou non) |
| `GET /interventions.geojson` | 3 | emprise bornée (bbox obligatoire), plafond avec `tronque` et `total`, propriétés minimales |
| `GET /interventions/:id` | 3 | fiche : motif, contributions, état physique et date du dernier constat, confiance et complétude, coût, actions possibles, historique |
| `GET /priorites/parametres`, `POST /priorites/parametres`, approuver/désapprouver | 3, 7 | jeux de critères et poids versionnés (étendre `programmation/moteur` existant), approbation par un autre compte que l'auteur |
| `POST /scenarios/comparer`, `GET /scenarios/:id/export` | 4 | comparaison de scénarios, export portant « simulation non engageante » |
| `GET /contractuel` | 5 | marchés et chantiers : montants séparés, avancement déclaré et constaté, retards, relations manquantes ou ambiguës, sources |
| `GET /baremes`, `GET /baremes/:id/historique` | 6 | barèmes (unité, prix, devise, source, validité, version, statut) et historique |
| `POST /exports`, `GET /exports` | 6 | export gouverné (voir §6) et journal |

Les endpoints existants du moteur v2 (`/api/v2/programmation/moteur/*`) restent la source de vérité des scénarios, paramètres et fiches ; `/api/dashboard/decision`, `/api/priorisation/scores` et `/api/simulateur/budget` sont dépréciés et plus appelés par l'écran (suppression après recette).

## 5. Formes

`Kpi` : `{ code, libelle, valeur: number | null, unite, etat: "DISPONIBLE" | "NON_DISPONIBLE" | "PARTIEL" | "PERIME" | "DEFINITION_NON_VALIDEE", statutDefinition: "PROVISOIRE" | "VALIDEE", periode: { depuis, jusqua } | null, perimetre: { libelle, regionId: number | null }, source: string, calculeLe: string, couverture: { evalueKm, eligibleKm, nonEvalueKm, partNonEvaluee } | null, definition: string, formule: string, avertissements: string[], ouvre: { onglet: string, filtres: FiltresDecision } }`. `valeur` est `null` quand l'état n'est pas `DISPONIBLE` ou `PARTIEL` : jamais 0.

KPI de la maquette et leur traitement honnête :

| KPI | Code | Règle |
|---|---|---|
| Réseau dégradé (%) | `reseau_degrade_pct` | longueur (métier) des tronçons à état validé dans les classes « dégradées » ÷ longueur éligible ; numérateur et dénominateur sur LE MÊME périmètre ; non évalués à part ; classes « dégradées » = paramètre PROVISOIRE nommé (par défaut MAUVAIS + CRITIQUE), `statutDefinition: "PROVISOIRE"` |
| Réseau critique | `reseau_critique_km` et `reseau_critique_pct` | longueur à état CRITIQUE validé ; définition de « critique » = paramètre PROVISOIRE versionné |
| Chantiers en cours / en retard | `chantiers_en_cours`, `chantiers_en_retard` | reprendre le registre (`indicateurs.registre.ts`) ; pas de `take`; le retard ignore suspensions et avenants : dit dans `avertissements` |
| Budget engagé | `budget_engage_gnf` | **état `NON_DISPONIBLE`** tant que la source financière et la définition ne sont pas validées (B-08, ADR-003) ; ne jamais le remplacer par la somme des chantiers ; le montant contractuel des marchés est un AUTRE indicateur, étiqueté « contractuel » |
| Marchés | `marches_recenses` | nombre de lignes de `marches` (pas de chantiers), libellé « recensés », jamais « actifs » |
| Données à confirmer | `donnees_a_confirmer` | tronçons non évalués + anomalies du périmètre |

## 6. Exports

Un export (PDF/CSV/JSON selon le lot 6) contient : date de génération, auteur, filtres appliqués, périmètre, unités, sources et dates de référence, définitions des indicateurs, avertissements sur les données partielles, mention « consultatif, non engageant ». Journal d'export (qui, quand, filtres, périmètre, nombre de lignes). Périmètre territorial appliqué ; aucune colonne financière pour un compte sans droit financier.

## 7. États d'écran obligatoires

Pour chaque panneau : chargement (`role="status"`), vide explicite (jamais un zéro), résultat, erreur API (`role="alert"` et « Réessayer »), permission refusée (message dédié, pas un vide), données périmées (date), données partielles (couverture dite), traitement en cours. Statuts de donnée distingués visuellement et par texte : validé, provisoire, estimé, inconnu, en cours de traitement.

## 8. Interface : structure (la maquette est une cible visuelle, jamais une source de données)

En-tête de page (titre complet, jamais tronqué ; description), 4 à 6 KPI cliquables (chaque KPI ouvre l'onglet ou la liste qui l'explique), barre d'onglets : **Carte et priorisation**, **Liste des interventions**, **Simulation budgétaire**, **Suivi contractuel**, **Scénarios**, **Rapports** ; bouton d'export selon droits. Onglet Carte : carte (Géoportail), légende, panneau de filtres, panneau d'insights/recommandations explicables ; zone inférieure : répartition de l'état du réseau (km par classe + non évalué), priorités par région, budget par bailleur (montants contractuels, étiquetés), scénario rapide. Composants dans `frontend/src/components/decision/`. Les onglets sont des composants à export nommé placés dans `components/decision/onglets/` : `OngletCarte`, `OngletListe`, `OngletSimulation`, `OngletContractuel`, `OngletScenarios`, `OngletRapports`, chacun reçoit `{ filtres: FiltresDecision; onFiltres(f): void }` (types dans `components/decision/types.ts`). Le shell (lot 1) ne dépend d'aucun détail interne de ces onglets.

## 9. Périmètres de fichiers (pas de modification concurrente)

| Chantier | Fichiers autorisés |
|---|---|
| Lot 1 UX/UI (shell) | `frontend/src/pages/DecisionPage.tsx` (remplacé par le shell), `frontend/src/components/decision/{KpiDecision,EtatsDecision,BarreOnglets,types,...}.tsx` et `lib/decision*.ts` (noyau pur), `components/layout/Header.tsx` (titre non tronqué, correctif partagé), tests |
| Lot 2 KPI et qualité (backend) | `backend/src/aide-decision/{kpi,dictionnaire,synthese,qualite}*.ts`, `backend/src/api-v2/aide-decision.synthese.routes.ts`, `docs/aide-decision/DICTIONNAIRE-KPI.md`, bancs `aide-decision-kpi.integration.*` |
| Lot 2 (frontend de la synthèse) | `components/decision/onglets/` : aucun ; fournit `lib/aideDecisionApi.ts` (types et appels de synthèse, dictionnaire, qualité) |
| Lot 3 carte et priorités | backend : `backend/src/programmation/priorite*.ts`, `api-v2/aide-decision.interventions.routes.ts`, migration `20261029*_ad_priorites*` ; frontend : `components/decision/onglets/{OngletCarte,OngletListe}.tsx`, `components/decision/carte/*`, `lib/aideDecisionCarte.ts` (noyau pur) |
| Lot 4 simulateur | backend : `backend/src/programmation/{comparaison,contraintes,export-scenario}*.ts` (le noyau `scenario.noyau.ts` n'est étendu que par ce lot), `api-v2/aide-decision.scenarios.routes.ts` ; frontend : `onglets/{OngletSimulation,OngletScenarios}.tsx`, `components/decision/simulation/*` |
| Lot 5 contractuel | backend : `backend/src/aide-decision/contractuel*.ts`, `api-v2/aide-decision.contractuel.routes.ts` ; frontend : `onglets/OngletContractuel.tsx`, `components/decision/contractuel/*` |
| Lot 6 barèmes, rapports, exports | backend : `api-v2/baremes.routes.ts` (historique, séparation auteur/approbateur), `api-v2/export.routes.ts` (gouvernance), `backend/src/aide-decision/export*.ts`, `api-v2/aide-decision.exports.routes.ts`, migration `20261029*_ad_baremes_historique*` ; frontend : `onglets/OngletRapports.tsx`, `components/decision/rapports/*`, `pages/BaremesPage.tsx` si nécessaire |
| Lot 7 sécurité | `backend/src/lib/access.ts` (MODULE_PAR_ENTITE : lecture de l'audit des paramètres, barèmes, scénarios, fiches, plans), `programmation/moteur.service.ts` et `api-v2/programmation.routes.ts` (séparation des tâches), `backend/src/modules/dashboard/dashboard.routes.ts` (filtres territoriaux sur les routes héritées), `backend/src/securite/*` (tests), `docs/securite/CONTROLE-ACCES.md` |

Règles : migrations `20261029*` et suivantes, idempotentes, avec descente testée par `descentes/verifier.sh`. `schema.prisma` : une seule édition atomique par agent (relire le fichier juste avant), modèles ajoutés en bloc à la fin, jamais de renommage ni de retrait ; `npx prisma generate` une seule fois à la fin des éditions de schéma (réessayer après 30 s si le moteur est verrouillé). Le client Prisma du worktree est PROPRE à ce worktree. Le montage dans `api-v2/index.ts`, `App.tsx` et `Sidebar.tsx` est fait par l'orchestrateur.

## 10. Honnêteté des données en test

Les jeux de test sont marqués `synthetique` et n'apparaissent jamais dans les vues de production. Aucun fichier de démonstration n'est livré dans le code de production.
