# Aide à la décision : rapport du Lot 0 (audit)

Branche `feat/aide-decision` (worktree `F:\ageroute-ad`), issue de `lot/03-map-matching` au commit `1af3e6e`. Date : 26/10/2026. Rien n'est déployé, aucune donnée de production n'a été lue. Ce rapport distingue ce qui est prouvé (exécuté) de ce qui est lu dans le code ou dans la documentation.

Sources : cahier des charges V1.0 du 25/10/2026, maquette illustrative (chiffres non officiels), quatre audits en lecture seule menés par des agents distincts (backend et formules ; interface ; droits et données financières ; moteur de priorisation, carte et simulateur). Plusieurs agents ont été interrompus par des coupures réseau ou le redémarrage de l'application et relancés ; seul ce qui a été ré-exécuté est rapporté.

## 1. Constat central

Le module n'est pas à créer : il existe en **trois chaînes parallèles de fiabilité inégale**.

| Chaîne | Contenu | Verdict |
|---|---|---|
| A (héritée) | `GET /api/dashboard/decision` + `frontend/src/pages/DecisionPage.tsx` (789 lignes) : la plus proche de la maquette | la moins fiable |
| B (héritée) | `/api/priorisation/scores`, `/api/simulateur/budget` (`modules/marches/marches.routes.ts`) | à retirer |
| C (v2) | moteur de programmation `/api/v2/programmation/moteur` (paramètres versionnés immuables, scénarios scellés SHA-256, fiches figées, PPE), registre d'indicateurs `/api/v2/tableau-de-bord`, détecteurs de qualité (26 codes) | saine, mais sans interface qui couvre la maquette |

Décision d'architecture : **bâtir sur la chaîne C**, retirer A et B de l'écran, ne créer aucun second moteur ni second référentiel.

## 2. Fonctions du cahier : état réel

| Fonction (cahier §2.1) | État | Preuve |
|---|---|---|
| Tableau exécutif (KPI) | PARTIEL | registre sain ; aucun KPI « % dégradé » ni « % critique » propre ; l'écran lit la chaîne A |
| Carte de priorisation | PRÉSENTE NON VALIDÉE | carte du Géoportail ; aucune couche « priorités », un seul mode (état) |
| Liste des interventions | PARTIEL | lignes justifiées du moteur v2 dans un écran séparé |
| Moteur de priorisation | PRÉSENT, NON VALIDÉ | `engines/risque.noyau.ts`, `programmation/scenario.noyau.ts` ; poids sans source |
| Simulateur budgétaire | PARTIEL | API v2 complète (enveloppe, scénarios, rejeu, PPE) ; ni comparaison, ni export, ni contraintes obligatoires/non divisibles, ni déficit global |
| Suivi contractuel | PARTIEL / BLOQUÉ | tables `Marche`, `Decompte`, `AvancementMarche` ; source de vérité DigitalRoad non intégrée (ADR-003, B-08) |
| Barèmes de coût | PRÉSENTS NON VALIDÉS | 9 lignes `standard_initial`, 0 approuvée (D-07) |
| Qualité des données | PARTIEL | 26 codes, banc 98/98 ; contradictions inter-modules absentes |
| Rapports / exports | PARTIEL | `/dashboard/rapport-regions` ; export sans filtres, sans date, sans journal |
| Dictionnaire des indicateurs | ABSENT en tant que document | définitions dans le code du registre ; « dégradé » et « critique » définis nulle part |

## 3. Défauts constatés (priorisés)

**Intégrité des chiffres (chaîne A).**
- Le « réseau dégradé » a un numérateur sur tous les tronçons (voirie promue incluse, environ 185 000 km) et un dénominateur sur le réseau classé : un pourcentage peut dépasser 100 %. Les non évalués restent au dénominateur (contraire au §9.1). « Dégradé » = MAUVAIS+CRITIQUE par convention de code, sans décision.
- Chantiers en cours et en retard calculés sur `take: 50` : tronqués.
- « Budget engagé » est la somme de `montantGnf` de tous les chantiers, tous statuts ; « marchés recensés » compte des chantiers. C'est la confusion que le cahier §8.2 interdit.
- Données vides affichées « 0,0 % », « 0 GNF » ; erreurs 500 et 403 : squelette de chargement indéfini sans alerte ni nouvel essai ; réponse sans `kpis` : plantage.
- Valeurs fictives dans la page : courbe en S inventée, barème 800/500/150 M GNF/km retiré du serveur mais affiché, « 1 690 » en dur, « Stade 2/5 », « PIARC < 20 % », « Données réelles de production ».
- Origine de « 7 933 km » : somme des longueurs saisies sur 662 des 1 690 tronçons classés au 01/09 ; le dépôt a déjà retiré ce chiffre ailleurs car trompeur. Les valeurs 37,1 %, 18,0 %, 20,2 T, 486, 2 943 km n'existent nulle part dans le dépôt.

**Moteur.**
- Trois scoreurs qui divergent ; le client donne 20 à un tronçon NON_EVALUE (contraire au cahier).
- Un tronçon « 0 point noir » est traité comme une valeur 0 dès que le registre n'est pas vide : il peut descendre silencieusement.
- Le ratio coût/impact classe un tronçon CRITIQUE dernier s'il est cher : il faut séparer la priorité technique de l'ordre d'arbitrage coût-efficacité.
- Sur la base réelle, la plupart des tronçons seraient probablement écartés faute de facteurs (refus motivés, jamais de valeur inventée).

**Droits et séparation des tâches.**
- Un ADMIN crée puis approuve ses propres poids et barèmes ; un gestionnaire fige et fait avancer un scénario seul (AD-07 non satisfait).
- L'historique d'audit des paramètres, barèmes et scénarios est écrit mais illisible : `/api/audit` répond 403 à tous, ADMIN compris.
- Montants et totaux nationaux lisibles par un compte régional (`/api/dashboard/decision`, `/programmation`, `/rapport-regions`, `/priorisation/scores`, `/chantiers/geo`) : même famille de fuite que la précision d'Observation de la Terre.
- D-C1-1 toujours ouverte : un lecteur sans module lit `/api/chantiers/geo` (montants, bailleur, entreprise).
- Export non gouverné : sans périmètre territorial, toutes colonnes, pas de journal ni de filtres ni de date.
- Barèmes modifiés sur place (tout PATCH remet l'approbation à zéro), pas de table d'historique.
- Aucune permission par action (consultation, proposition, validation, programmation, paramétrage, export).

**Interface.**
- Titre tronqué (`Header.tsx`, `truncate`) ; KPI inertes ; aucune alerte `role` sur erreur ; axe réel : étiquettes manquantes, contraste, noms de boutons ; cibles < 44 px ; pas de lien d'évitement.
- Aucune carte, aucun filtre, aucun export dans la page ; onglets différents de la maquette.

## 4. Ce qui est réutilisable tel quel

Registre d'indicateurs et son contrôle indépendant, périmètre « réseau classé saisi » (`lib/reseau.ts`), moteur v2 (paramètres, scénarios scellés, rejeu, fiches, PPE), barèmes et leurs refus de coût inconnu, détecteurs de qualité, `validationPermise` (auto-validation refusée), cartes et légendes du Géoportail (`LegendeEtat`, symbologie), composants d'état du module Observation de la Terre (branche `feat/observation-terre`, à reprendre ou à fusionner).

## 5. Exécutions réelles (rejouées par les agents, base `replay` locale vide : 0 tronçon)

Backend ciblé : 572 tests verts (32 fichiers) ; programmation et sécurité : 433 verts ; essais d'accès : 32/32 ; bancs PostGIS `programmation` 106/106, `ppe` 80/80, `qualite-detecteurs` 98/98 ; scénario sans écriture dans budgets, marchés, décomptes, chantiers (empreintes identiques, AD-08 prouvé) ; frontend ciblé : 128 et 59 tests verts ; rendu réel en Chromium à 1440, 768 et 375 px avec données synthétiques. Un banc (`tableau-de-bord`) échoue pour une cause d'environnement : voir §6.

## 6. Incident d'environnement corrigé en cours de route

Le client Prisma généré (`node_modules/.prisma/client`) était partagé par jonction entre le dépôt principal et le worktree d'Observation de la Terre, dont la génération y avait écrit des modèles que la base `replay` n'a pas : le banc `tableau-de-bord` du dépôt principal échouait (`earth_observation_products.sourceCode`). Les worktrees `feat/observation-terre` et `feat/aide-decision` ont maintenant chacun leur propre client. La régénération du client du dépôt principal est en attente (le moteur de requêtes est verrouillé par un processus en cours) : à faire depuis `F:\ageroute-geoportail\backend` par `npx prisma generate` lorsqu'aucun processus ne l'utilise.

## 7. Décisions métier bloquantes (cahier §14.2), à ne pas inventer

Définitions officielles de « réseau dégradé » et « critique » ; périmètre et source de la longueur du réseau (D-06) ; critères et poids du moteur (D-01) ; barèmes et millésime (D-07) ; source financière et définition de « budget engagé » (B-08, ADR-003) ; unité du bailleur (texte libre sur `Chantier`, clé étrangère sur `Marche`) ; rôles de validation et séparation des tâches ; confidentialité financière (D-C1-1) ; seuils de fraîcheur ; rattachement des comptes à une région (D-11). Les décisions du 23/10 prises sur délégation du DSI sont réversibles, pas des approbations officielles. Les mécanismes sont construits paramétrables, avec des valeurs PROVISOIRES étiquetées.

## 8. Plan d'exécution par lots (non destructif, sans déploiement)

| Lot | Contenu | Dépendances |
|---|---|---|
| 1 | UX/UI : shell de page, onglets de la maquette, KPI cliquables, états, titre non tronqué, retrait des valeurs fictives | contrat |
| 2 | KPI et qualité : dictionnaire, synthèse backend sur le registre, non évalués séparés, couverture, fraîcheur | contrat |
| 3 | Carte et priorités : endpoint de priorités explicable, mode carte « priorités », liste synchronisée, « score incomplet » | contrat |
| 4 | Simulateur : comparaison, contraintes, déficit, export, enregistrement | lot 3 pour les entrées |
| 5 | Suivi contractuel : montants séparés, relations manquantes, indicateurs partiels | contrat |
| 6 | Barèmes, rapports, exports : historique des barèmes, export gouverné | contrat |
| 7 | Sécurité : séparation des tâches, lecture de l'audit, filtres territoriaux, permissions | contrat |

Les périmètres de fichiers disjoints et les formes d'API sont fixés dans `docs/aide-decision/CONTRAT-AD.md`.
