# Aide à la décision : sécurité, droits et audit (lot AD-7)

Branche `feat/aide-decision`. Ce document fixe ce que le serveur applique au module, ce qui reste à décider, et comment le rejouer. Il complète `docs/securite/CONTROLE-ACCES.md` (matrice des routes) et le contrat `CONTRAT-AD.md` (sections 1.8, 1.9 et 2). Tout ce qui est étiqueté PROVISOIRE est un choix de conduite réversible, pas une règle officielle.

## 1. Le modèle existant, et ce que ce lot n'a pas créé

Le serveur décide avec quatre éléments, relus en base à chaque requête : le **rôle** (`ADMIN`, `GESTIONNAIRE`, `INSPECTEUR`, `LECTEUR`), les **modules** du compte (`decision`, `programmation`, `marches`, `chantiers`, `rapports`...), le **périmètre territorial** (régions rattachées ; aucun rattachement vaut national) et, depuis ce lot, la **séparation auteur / approbateur**. Aucun système de permissions par action n'a été créé : la matrice cible ci-dessous s'exprime avec ces quatre éléments.

## 2. Matrice cible (cahier 3.1) et état réel

| Action | Qui (PROVISOIRE) | Mécanisme appliqué | État |
|---|---|---|---|
| Consultation | module `decision` (écran), `programmation`, `marches` selon la donnée | `requireModuleAccess`, périmètre régional, totaux nationaux refusés aux comptes régionaux | Appliqué sur le moteur v2, les prévisions et les routes héritées (section 5). Non appliqué : `/api/dashboard/kpis`, `/alertes`, `/activity` (section 8). `/api/simulateur/budget` applique le périmètre du compte depuis la revue du 27/10/2026 (section 10) |
| Proposition | ADMIN, GESTIONNAIRE | `requireRole`, auteur pris sur la session, jamais sur le corps | Appliqué (création de poids, simulation, figeage de fiches, saisie de prévision) |
| Validation / approbation | ADMIN pour les poids ; GESTIONNAIRE ou ADMIN pour `APPROUVE` et `RETENU` (rôle inchangé) | `approbationPermise` : l'approbateur n'est aucun intervenant précédent, code `AUTO_VALIDATION` (403) | Appliqué (section 3). Le rôle exigé pour `APPROUVE` et `RETENU` reste celui d'avant : décision à prendre |
| Programmation | ADMIN, GESTIONNAIRE | `requireRole`, région du tronçon, calcul national refusé au compte régional | Appliqué avant ce lot (chantier C1) |
| Paramétrage (poids, barèmes) | proposer : ADMIN, GESTIONNAIRE ; approuver : ADMIN | versions immuables ; poids : appliqué ici. Barèmes : lot 6, même règle et même code `AUTO_VALIDATION` | Poids appliqués. Barèmes : voir lot 6 |
| Export | module `rapports` + ADMIN ou GESTIONNAIRE, journal, périmètre | lot 6 (`export.routes.ts`) | Hors lot. Seul `/api/chantiers/export` est durci ici : module `chantiers` exigé, périmètre régional appliqué |

Ce qui **manque** et demande une décision : un rôle ou une permission « valideur » distincte de GESTIONNAIRE ; une permission d'export distincte de la lecture ; la désignation d'un validateur par domaine pour les objets de programmation (les domaines de délégation `DOMAINES_VALIDATION` ne couvrent pas ces objets, voir 3.3).

## 3. Séparation des tâches (constat 1)

### 3.1 Règle

Celui qui approuve n'est jamais celui qui a produit, quel que soit son rôle (un ADMIN n'y échappe pas). Fonction pure : `backend/src/governance/separation-taches.ts` (`approbationPermise`), qui reprend le code et le texte de `validationPermise` (`AUTO_VALIDATION`, 403). Un objet **sans auteur identifié** (version de poids amorcée par migration) n'a personne à opposer : tout ADMIN peut l'approuver, comme pour un import sans auteur dans `validationPermise`.

| Objet | Acte refusé | À qui | Où |
|---|---|---|---|
| Version de poids | `POST /parametres/:id/approuver` | au compte qui a créé la version | `moteur.service.ts` `approuverParametres` |
| Fiche d'intervention | passage à `APPROUVE` | à l'auteur du scénario, à celui qui a figé la fiche, à celui qui l'a proposée ou arbitrée | `moteur.service.ts` `changerStatutFiche` |
| Prévision budgétaire | passage à `RETENU` | à l'auteur de la saisie (`createdById`) **et à tout compte qui a modifié son contenu** (relu dans l'audit, voir 3.4) | `api-v2/programmation.routes.ts` |

Le refus porte `{ error, code: "AUTO_VALIDATION" }` : l'explication nomme l'étape en cause (par exemple « Ce compte a figé cette fiche : un autre compte doit approuver »). Les autres étapes (proposer, arbitrer, reporter, annuler, corriger un montant, reculer avec motif) ne sont pas gelées : seule l'approbation est un arbitrage. Un recul motivé n'est pas une production et ne ferme pas l'approbation à celui qui renvoie une fiche.

### 3.2 Contrat de test modifié, et pourquoi

Les tests de `programmation.moteur.routes.test.ts` qui menaient une fiche de `BROUILLON` à `APPROUVE` avec **un seul compte** (cinq tests de la frontière DigitalRoad) font maintenant approuver par un second compte (aide `jusquaApprouve`). Le cycle de vie n'a pas changé ; le test d'avant exprimait précisément la faille. Dans `programmation.routes.test.ts`, le test « révise montant et statut » posait `RETENU` avec le compte auteur de la ligne : il utilise maintenant un second compte. Rien d'autre n'a été modifié.

### 3.3 Pourquoi `ENTITES_VALIDABLES` et `DOMAINES_VALIDATION` ne sont pas étendus

`validationPermise` juge une décision sur un objet qui porte un `statutValidation` ; chaque entité y est aussi un domaine de délégation (un test impose autant de domaines que d'entités) et l'écran de gouvernance invite à y désigner un validateur. Les objets de programmation n'ont pas ce statut : désigner un validateur sur ces domaines n'aurait aucun effet. Un ensemble distinct (`ENTITES_A_DOUBLE_CONTROLE`, qui inclut `BaremeIntervention` pour le lot 6 et ne liste QUE les objets qui ont un point d'approbation réel : poids, barèmes, fiches, prévisions ; un scénario n'a aucun statut d'approbation et n'y figure plus depuis la revue du 27/10/2026) et une fonction qui ne reprend que le rôle, la séparation et le code évitent d'afficher une case qui ne change rien. Si le métier veut une désignation par domaine pour la programmation, c'est une décision (section 7).

### 3.4 Limites connues

- **Corrigé par la revue du 27/10/2026** (ancienne limite : un compte B, différent du créateur, pouvait envoyer `{ montantPrevuGnf: X, statut: "RETENU" }` d'un seul geste, ou modifier le montant puis retenir en deux requêtes, et une prévision `RETENU` voyait son contenu changer sans repasser par `PROPOSE`). Règles appliquées par `PATCH /api/v2/programmation/:id` : (1) **modifier le contenu et retenir dans la même requête est refusé** (422 `MODIFICATION_ET_APPROBATION`) ; le contenu est l'année, l'intitulé, le montant, le tronçon, le bailleur, le type d'intervention et la priorité, une valeur renvoyée à l'identique n'est pas une modification, le commentaire n'en est pas une ; (2) **celui qui retient n'est ni le créateur ni aucun compte qui a modifié le contenu** (403 `AUTO_VALIDATION`, l'explication nomme l'étape) : les modificateurs sont relus dans `audit_logs` (drapeau `contenuModifie`, ou à défaut année ou montant avant/après différents pour les entrées plus anciennes), sur les 500 dernières écritures de la ligne ; (3) **modifier le contenu d'une prévision `RETENU` la renvoie à `PROPOSE`** (`reouverte` dans l'audit), sauf statut explicite dans la requête (report, annulation, réalisation). Conséquence : une prévision saisie par A et corrigée par B ne peut être retenue que par un troisième compte. Aucun écran ne modifie une prévision aujourd'hui (la page de saisie ne fait que créer), le changement n'affecte donc que l'API. **Non couvert** : une course entre deux requêtes simultanées (B modifie pendant que C retient) : pas de verrou optimiste sur cette route.
- L'audit des prévisions garde le statut et le montant avant/après mais pas la liste des intervenants intermédiaires ; l'auteur est `createdById`.
- Le rôle de l'approbateur est celui que la route exige déjà ; `Contexte.role` (facultatif) permet au service de ne plus compter sur cette hypothèse quand le routeur le renseigne (modification demandée hors périmètre, section 6).

## 4. Audit lisible, avec valeurs (constats 2 et 7)

`MODULE_PAR_ENTITE` (`lib/access.ts`) contient maintenant : `ParametresProgrammation`, `ScenarioProgrammation`, `FicheIntervention`, `PlanPluriannuel`, `ProgrammeBudgetaire` → module `programmation` ; `BaremeIntervention` → module `decision` (celui de `/api/v2/baremes`). Un compte lit l'historique d'une entité s'il a le module de cette entité, comme pour tout le reste ; un compte sans module, ou avec le module voisin, reçoit 403 ; un type inconnu reste refusé pour tous.

L'audit des poids porte les valeurs : `CREATE` (`after.valeurs`), `VALIDATE` (`before.valeurs` et `after.valeurs`, égales puisqu'une version est immuable, mais ce que l'approbateur a réellement validé). `before.creeParId` y figure aussi.

Effet de bord à connaître : `/api/qualite/repartition` et `/api/qualite/:type/:id` valident le type d'entité avec la même table. Les six types ajoutés y sont maintenant acceptés et rendent des comptages vides (aucune valeur de qualité n'existe pour eux) : aucune donnée sensible.

## 5. Montants nationaux et périmètre régional (constat 3)

Choix par route, documenté : les routes **agrégées sans colonne de région** sont refusées aux comptes régionaux (403 `PERIMETRE_NATIONAL_REQUIS`, aucune lecture de donnée) ; celles qui ont une région par ligne sont **filtrées**. Un compte national (ADMIN ou sans rattachement) garde exactement le comportement d'avant. Ces routes sont dépréciées (l'écran n'en dépend plus) : elles sont sécurisées, pas étendues.

| Route | Avant | Après |
|---|---|---|
| `/api/dashboard/decision`, `/programmation`, `/tendances` | totaux nationaux pour tout compte ayant le module | refusée au compte régional (403) ; `tendances` valide `periode_*` (400) |
| `/api/dashboard/programmation/lignes` | tous les chantiers | filtre `regionId` du compte ; `annee` et `statut` validés (400) |
| `/api/dashboard/rapport-regions` | toutes les régions | seules les régions du compte |
| `/api/priorisation/scores` | la région venait du client | `regionId IN` du compte ; `region` ne fait que restreindre davantage |
| `/api/chantiers/geo`, `/sans-localisation`, liste, `/stats`, `/export`, `/:id` | tous les chantiers | filtre de région ; `/:id` d'une autre région = 404 identique à un inconnu |

Validation d'entrée (constat 6) : avec le vrai Prisma, une valeur invalide donnait **déjà** un 400 générique (« Paramètre de requête invalide ») via le gestionnaire d'erreurs, pas un 500 : le banc PostGIS le montre sur le code d'avant. Le lot remplace ce 400 par un 400 explicite, sans appel à la base. `fiche-360/troncons/:id/*` : un tronçon d'une autre région répond maintenant 404 avec le même corps qu'un tronçon inconnu (avant : 403 `HORS_PERIMETRE`, qui révélait l'existence).

## 6. Confidentialité financière, D-C1-1 (constat 4)

Option retenue : **masquer, ne pas fermer** (option B de `CONTROLE-ACCES.md`). Les lectures de chantiers restent ouvertes (la carte, la fiche de tronçon et le sélecteur des marchés n'en ont pas besoin) mais `montantGnf`, `bailleur`, `numContrat` et `entreprise` valent `null` pour un compte qui n'a pas le droit sur les montants contractuels. Le client traite déjà ces champs comme facultatifs (`ChantierGeoFeature`), la carte publique n'est pas concernée (elle filtre ses propres champs). **Réversible** : retirer les appels à `masquerFinancesChantiers` dans `chantiers.controller.ts` rend le comportement d'avant, sans migration.

**Une seule définition du droit, depuis la revue du 27/10/2026.** Il y avait trois listes : le masque des chantiers donnait le droit aux modules `chantiers`, `marches`, `programmation` et `decision`, alors que la synthèse, le suivi contractuel et les exports n'avaient que `marches`. Un compte `decision` ou `programmation` seul lisait donc entreprise, bailleur, numéro de contrat et montant par `/api/chantiers`, `/geo` et `/sans-localisation`. La fonction **`droitMontantsContractuels`** (`modules/chantiers/chantiers.confidentialite.ts`) est maintenant la seule source :

| Règle PROVISOIRE | Qui |
|---|---|
| Montants contractuels et identité du titulaire (montant, bailleur, numéro de contrat, entreprise ; montants des marchés et des décomptes ; toute colonne financière d'un export) | ADMIN, ou module `marches`, ou module `chantiers` |
| Estimations de programmation (prévisionnel de la synthèse, scénarios et simulations) | module `programmation` |
| `decision` seul | lecture de l'écran, **aucun montant contractuel** |

Elle est appelée par les lectures de chantiers, la synthèse (contractuel, décaissé, ventilation par bailleur), le suivi contractuel, `POST /api/v2/aide-decision/exports`, `GET /scenarios/:id/export` et `POST /api/v2/export/selection` (où `entreprise` est désormais une colonne financière au même titre que le montant). Les tests qui encodaient l'ancienne liste ont été mis à jour avec la raison (`chantiers.confidentialite.test.ts`, `aide-decision-acces.test.ts`, `export.routes.test.ts`, banc `aide-decision-baremes-exports` E3, banc `controle-acces`). Effet de bord assumé : le module `chantiers` vaut droit (il possède la donnée) ; il n'existe donc plus de compte « chantiers sans droit financier ».

**Export de scénario.** `GET /scenarios/:id/export` ne retirait aucun montant (enveloppe, consommé, reste, besoin, déficit, coûts, plafonds, prix de barème). Il applique maintenant la même règle que `POST /exports` : sans le droit, aucun montant n'est servi, ni les textes qui en citent (`justification`, détail d'un motif d'écart ou d'une contrainte, message de déficit) ; le fichier le dit (`droitFinancier`, `champsFinanciersRetires`) et porte la mention consultative commune. Dans `POST /exports` (types `scenario` et `interventions`), `justification` et `motif_exclusion_detail` sont des colonnes financières. Le retrait et le droit sont inscrits dans l'audit de l'export. **Point à trancher** : l'écran de simulation (`GET /scenarios/:id`) montre ces montants à tout compte `decision` + `programmation` ; l'export est volontairement plus strict (droit sur les montants contractuels).

Modifications demandées hors périmètre du lot AD-7 (diff exact dans `CONTROLE-ACCES.md` section 8, points 4 à 7) : `contexte(req)` du routeur du moteur (ajouter `role`) ; filtre de région du journal d'audit ; `/api/dashboard/kpis`, `/alertes`, `/activity`. Le point `POST /api/simulateur/budget` est fait (section 10).

## 7. Décisions nécessaires

1. **Rôles de validation.** Qui approuve : ADMIN seul (contrat 2) ou aussi GESTIONNAIRE pour `APPROUVE` et `RETENU` (comportement conservé) ? Faut-il un rôle « valideur » ? Faut-il une désignation par domaine pour la programmation (extension de la délégation) ?
2. **Confidentialité financière (D-C1-1-1, en attente).** Règle PROVISOIRE : montants contractuels et titulaire = ADMIN, module `marches` ou module `chantiers` ; estimations de programmation = module `programmation` ; `decision` seul = aucun montant contractuel (section 6). À confirmer : la liste des modules ; l'écart entre l'écran de simulation (lisible par `decision` + `programmation`) et son export (droit contractuel) ; `troncons.coutRehabEstime` et `postes.recettesMensuellesGnf`, dont les colonnes d'export suivent la même fonction sans que le métier l'ait décidé ; les routes héritées `/api/dashboard/decision`, `/programmation` et `/programmation/lignes`, qui servent encore entreprise, bailleur et montant des chantiers au module `programmation` (non modifiées : l'ancien écran de programmation en dépend).
3. **Rattachement des comptes à une région (D-11).** Aujourd'hui un compte sans ligne dans `perimetres_comptes` est **national**. Tant que les comptes de terrain ne sont pas rattachés, aucune des protections régionales ci-dessus ne s'applique à eux. Faut-il rattacher chaque compte, ou refuser le national par défaut ?
4. **Permission d'export.** Une permission distincte de la lecture (cahier 3.1), appliquée par le lot 6 ; en attendant, `/api/chantiers/export` exige le module `chantiers`.
5. **Prévision `RETENU` modifiable** (3.4) : tranchée provisoirement par la revue du 27/10/2026 (retour à `PROPOSE`, approbateur distinct du créateur et des modificateurs). À confirmer par le métier, notamment qu'un tiers doive retenir une prévision corrigée.

## 8. Non couvert

`/api/dashboard/kpis`, `/alertes` (chantiers en retard avec entreprise) et `/activity` (flux d'audit de toutes entités) restent nationaux ; le journal d'audit n'a pas de filtre de région ; `export.routes.ts` et `baremes.routes.ts` (lot 6). Le banc n'exerce pas l'approbation des barèmes (lot 6).

## 9. Rejouer

Depuis `backend/` (les identifiants de la base ne sont jamais écrits : les lire par `docker exec bdri-dev-db printenv`) :

```
npx vitest run src/securite src/governance src/programmation src/api-v2/programmation src/modules/dashboard src/modules/marches src/modules/chantiers
DATABASE_URL=<base replay locale> npx tsx tests-integration/aide-decision-securite.integration.mts
```

Le banc crée puis détruit le clone `essai_ad_l7_securite`. `replay` n'est jamais écrite.

## 10. Revue du 27/10/2026 : corrections du backend

Faits, chacun avec un test qui échouait avant correction (voir le rapport de la revue) :

- Export de scénario : droit sur les montants appliqué (6), `Cache-Control: no-store`, `ExportScenario` ajouté à `MODULE_PAR_ENTITE` (module `rapports`, comme `ExportJournal`), mention consultative.
- Droit sur les montants contractuels : une seule fonction (6).
- Prévisions : séparation des tâches renforcée (3.4). `ENTITES_A_DOUBLE_CONTROLE` ne contient plus `ScenarioProgrammation` (aucun point d'approbation).
- `POST /api/simulateur/budget` : le périmètre du compte (`regionsVisibles`) est appliqué comme sur `/priorisation/scores` ; `filtres.region` ne fait que restreindre.
- Barèmes : `versionAttendue` obligatoire pour approuver (400 sinon), identifiant borné à l'entier 32 bits (400 `ID_HORS_PLAGE`), adresses e-mail des auteurs et approbateurs masquées (« g*** ») pour les comptes qui ne sont ni ADMIN ni GESTIONNAIRE, y compris dans la valeur `approuvePar` des événements d'historique.

**Non fait, à signaler** : `POST /api/v2/export/selection` n'exige toujours que le module de la table (et ADMIN ou GESTIONNAIRE pour les marchés), pas le module `rapports` ni un rôle d'export comme le contrat (paragraphe 2) : l'exiger changerait le comportement des pages de listes qui exportent une sélection de patrimoine (un LECTEUR avec le module de la table exporte aujourd'hui). Décision à prendre (point 4 de la section 7).
