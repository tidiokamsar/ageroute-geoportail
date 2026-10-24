# Tableau de bord, Control Tower et Fiche 360

Rédigé le 22/10/2026. Couvre A12 (« chaque indicateur égal à sa requête de contrôle »), le § 7.12
(tableau de bord) et les volets portion et programmation de la Fiche 360° de
`MAINTENANCE_PROGRAMMING_DESIGN.md`.

Rien n'est déployé. Aucune migration : tout se lit sur les tables existantes.

## 1. Ce qui est livré

| Élément | Où |
|---|---|
| Registre d'indicateurs (31), périmètre obligatoire, calcul et contrôle indépendants | `backend/src/tableau-de-bord/indicateurs.registre.ts`, règles pures dans `indicateurs.noyau.ts` |
| Évaluation, rapprochement calcul / contrôle | `tableau-de-bord.service.ts` |
| Control Tower (5 modules lus sur le registre) | `control-tower.service.ts` |
| Volets de la Fiche 360 (portions, programmation) | `fiche360.service.ts` |
| API v2 | `backend/src/api-v2/tableau-de-bord.routes.ts`, montée sur `/api/v2/tableau-de-bord` et `/api/v2/fiche-360` |
| `GET /api/dashboard/kpis` (v1) | les nombres partagés viennent du registre ; la route reste nationale |
| Banc d'intégration PostGIS | `backend/tests-integration/tableau-de-bord.integration.mts` (116 vérifications) |
| Pages et composants | `ControlTowerPage`, `IndicateursControles` (tableau de bord), `Fiche360Volets` (deux onglets de `TronconFicheModal`) |
| Types et phrases | `frontend/src/lib/tableauDeBord.ts` |

`couvertureReseau` (reseau/couverture.reseau.ts) accepte désormais un dépôt en troisième paramètre
(par défaut le client applicatif) : seul changement à un module existant, sans effet sur ses appelants.

## 2. Le registre

Un indicateur déclare : un code, un libellé, un groupe, une unité, **un périmètre** (code, libellé,
définition, tous affichés), une requête de **calcul**, une requête de **contrôle** indépendante, et s'il
**se ventile par région**. `defautsRegistre` refuse un registre où un indicateur n'a pas de périmètre,
pas de contrôle, un contrôle identique au calcul, un code en double, ou un libellé qui dirait « réseau
national » (décision D-06). Le test `indicateurs.registre.test.ts` l'exige sur le registre réel.

Le contrôle emprunte un autre chemin que le calcul : autre requête, autre agrégation, ou une fonction de
domaine déjà éprouvée (`chevauchements()` de `reseau/portions.ts` ; le prédicat « réseau classé » relu par
`starts_with` sur `PREFIXES_HORS_RESEAU_CLASSE` ; l'échéance de patrouille recalculée en SQL contre le
noyau `echeance()` ; les événements actifs reconstruits depuis le journal `main_courante` contre la vue
`evenements_exploitation` ; la couverture recalculée par balayage d'intervalles contre la fusion SQL).

Les montants en GNF sont des chaînes de chiffres de bout en bout (le banc teste 9 007 199 254 740 993,
au-delà de 2^53).

| Groupe | Indicateurs (périmètre) | Ventilé par région |
|---|---|---|
| Réseau | tronçons classés, longueur géométrique, longueur saisie hors valeurs dérivées, tronçons mauvais ou critique (réseau classé saisi) ; ouvrages inventoriés, ouvrages mauvais ou critique (inventaire de référence) ; points noirs ; péages et pesages ; chantiers en cours | oui |
| Réseau | documents | non |
| Portions | portions validées, kilomètres d'état constaté (portions VALIDE, non remplacées, non supprimées) ; part du réseau classé couverte par une portion | oui |
| Qualité | paires de portions courantes qui se chevauchent ; tronçons classés à géométrie invalide | oui |
| Qualité | valeurs qualifiées, valeurs observées (`valeurs_qualite`) | non |
| Veille | événements actifs, non pris en compte, escaladés, trous de permanence (main courante non close) | oui |
| Veille | règles d'escalade actives | non |
| Patrouilles | programmes actifs, patrouilles en retard | oui (un programme sans région est exclu pour un compte régional) |
| Télédétection | propositions en attente de verdict | oui (une proposition non rattachée est exclue pour un compte régional) |
| Programmation | prévisions retenues et réalisées (nombre et montant), chantiers en retard, montant de marché des chantiers | oui (une prévision sans tronçon est exclue pour un compte régional) |

Aucune cible, aucun seuil, aucun taux de réalisation n'est calculé. Un indicateur dont la table source est
vide dans la portée porte `aucuneDonnee` ; une valeur non calculable est `null`, jamais 0.

## 3. API

| Route | Rôle | Contenu |
|---|---|---|
| `GET /api/v2/tableau-de-bord/indicateurs?groupes=` | module `dashboard` | indicateurs évalués (défaut : réseau, portions, qualité), périmètre de chacun, portée du compte |
| `GET /api/v2/tableau-de-bord/control-tower` | module `dashboard` | cinq modules, indicateurs, `aucuneDonnee`, `indisponible`, ce qui n'est pas couvert |
| `GET /api/v2/tableau-de-bord/controle` | ADMIN, GESTIONNAIRE | rapproche chaque indicateur de sa requête de contrôle (égal, écart, erreur, indisponible) |
| `GET /api/v2/fiche-360/troncons/:id/portions` | authentifié, territoire | version courante, historique des versions (remplacées, lignage), comptes |
| `GET /api/v2/fiche-360/troncons/:id/programmation` | module `programmation`, territoire | prévisions du tronçon, totaux par statut, chantiers, interventions figées (indisponibles) |

L'état à une date n'est pas recalculé : le volet appelle le curseur temporel existant
(`GET /api/v2/portions/a-la-date?tronconId=`), seule définition de « vrai à cette date ».

Lecture seule : rien n'est écrit, donc rien n'est audité.

## 4. Contrôle territorial (A10)

- La portée vient du compte (`perimetreDe`), jamais de la requête : `?regions=`, `?national=` ou
  `?regionId=` n'ont aucun effet (testé).
- Compte régional : les indicateurs ventilables sont calculés sur ses régions ; un indicateur non
  ventilable est `INDISPONIBLE` (valeur `null`, jamais le national à sa place).
- Fiche 360 : un tronçon d'une autre région, ou de région inconnue, répond 403 sans appeler le service ;
  un tronçon inconnu, 404.
- Une entité sans région (événement sans tronçon, programme de patrouille sans région, proposition non
  rattachée, prévision sans tronçon) n'est pas communiquée à un compte régional, par la même règle que les
  écritures (`territoire.noyau.ts`, « REGION_INCONNUE »).
- Limite : `GET /api/dashboard/kpis` (v1) reste national, comportement conservé. Rendre les lectures v1
  régionales est une décision de produit (D-11 : tant que les comptes ne sont pas rattachés, tous sont
  nationaux de toute façon).

## 5. Fiche 360

Deux onglets s'ajoutent à la fiche tronçon, sans toucher aux onglets existants :

- **Historique des portions** : version courante, historique complet (versions remplacées, date de
  remplacement, lignage, date d'effet ou « non renseignée »), puis « État à une date » (champ date borné à
  aujourd'hui, case « inclure les propositions », phrases du curseur temporel).
- **Programmation** : prévisions budgétaires du tronçon avec totaux par statut, chantiers rattachés, et
  l'indication que les interventions figées n'existent pas (aucune table : `cycle-vie.noyau.ts` est une
  règle sans table).

Pas de volet sur la fiche ouvrage : une prévision se rattache à un tronçon, pas à un ouvrage.

## 6. Preuves

| Commande | Résultat |
|---|---|
| `cd backend && npx tsc --noEmit -p .` | sans erreur |
| `cd backend && npx vitest run` | 127 fichiers, 1 797 tests |
| `DATABASE_URL=...replay bash tests-integration/run.sh` ou `npx tsx tests-integration/tableau-de-bord.integration.mts` | 116 / 116 vérifications |
| `cd frontend && npx tsc --noEmit` | sans erreur |
| `cd frontend && npm run lint` | 0 erreur (4 avertissements `exhaustive-deps` antérieurs) |
| `cd frontend && npx vitest run --poolOptions.forks.maxForks=2 --poolOptions.forks.minForks=1` | 42 fichiers, 537 tests. Avec tous les coeurs, 1 à 4 tests anciens (Gouvernance, Imports, Relevé, Défauts) échouent par délai sous charge et passent seuls |
| `cd frontend && npm run build` | construit |

Ce que le banc affirme, par indicateur et sur trois portées (national, région 1, région 2) :
calcul = contrôle = valeur attendue calculée à la main. Les longueurs viennent d'une intégrale du rayon de
courbure méridien WGS84 écrite dans le banc, hors de PostGIS. Il vérifie aussi : le refus d'un indicateur
non ventilable à un compte régional ; une région sans donnée ; les échéances de patrouille à deux dates (dont
une saison à cheval sur deux années) ; le recoupement avec `longueurReseau` et `couvertureReseau` ; une
contre-épreuve (un calcul décalé d'une unité est signalé en écart) ; la Control Tower ; les deux volets.

Accessibilité : axe-core (WCAG 2.1 A et AA) sur `ControlTowerPage`, `IndicateursControles`, `VoletPortions`,
`VoletProgrammation`, dans `Accessibilite.test.tsx`, avec données, avec état vide, avec erreur, après le
rapprochement et avec une date choisie ; 0 violation, et une contre-épreuve qui injecte un défaut dans le DOM
de la Control Tower pour prouver que l'instrument le voit.

## 7. Ce qui n'est pas vérifié

- **Le volume de production.** Le banc tourne sur une base vide plus des fixtures. Les contrôles de
  `couverture_qualifiee_part` et `portions_chevauchantes` chargent les portions en mémoire : sans importance
  tant que `portions` est quasi vide, à mesurer avant le premier relevé de masse. `GET /controle` relance
  chaque requête deux fois ; il est demandé, pas automatique.
- **Le contraste** et l'usage au lecteur d'écran (jsdom ne les calcule pas).
- **Le rendu dans un navigateur réel** des nouveaux écrans (aucune capture ; les tests sont sous jsdom).
- **`perimetreDe` contre la base** : les tests de route le simulent ; la règle elle-même est éprouvée par
  `territoire/*.test.ts`. Le banc couvre le SQL des portées régionales, pas la lecture de `perimetres_comptes`.
- **Les doublons de géométrie** (balayage national de 261 387 tronçons) ne sont pas dans la Control Tower ;
  elle l'affiche. Les « anomalies bloquantes » couvertes sont les géométries invalides et les portions
  chevauchantes du réseau classé.
- **Le réalisé physique** : il viendra de DigitalRoad (X-18, bloqué B-11). Le « réalisé » affiché est le
  statut posé à la main sur les prévisions.
- **Le sens métier** des seuils « à traiter » : l'écran dit « à traiter » dès qu'une valeur positive
  apparaît sur sept indicateurs de traitement, sans jugement de gravité.
- `/api/v2/portions/a-la-date`, appelée par le volet, n'a pas de contrôle territorial en lecture (hors du
  périmètre de cette livraison).
