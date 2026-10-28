# Aide à la décision : rapport des lots 1 à 7 (construction)

Branche `feat/aide-decision` (worktree `F:\ageroute-ad`, issue de `lot/03-map-matching` au commit `1af3e6e`). Date : 27/10/2026. **Rien n'est commité, poussé ni déployé.** Aucune donnée de production n'a été lue. Ce rapport distingue ce qui a été exécuté de ce qui a été lu, et signale ce qui n'a pas été vérifié. Les chiffres des agents sont rapportés comme tels ; ceux marqués « rejoué » ont été relancés par l'orchestrateur.

Convention de nommage : les rapports de lot individuels demandés par le prompt maître sont regroupés ici (lots 1 à 7), le lot 0 est dans `LOT-AD-00-RAPPORT.md`. Les contrats et règles de chaque lot sont dans `docs/aide-decision/` (CONTRAT-AD, DICTIONNAIRE-KPI, API-SYNTHESE, PRIORISATION, SIMULATEUR, CONTRACTUEL, BAREMES, EXPORTS, SECURITE).

## 1. Ce qui est livré

| Lot | Contenu | Où |
|---|---|---|
| 1 UX/UI | Shell de page (en-tête, mention consultative, filtres de page, 6 onglets WAI-ARIA, KPI cliquables avec définition, états chargement/erreur/vide/refus/périmé), titre non tronqué, valeurs fictives retirées | `pages/DecisionPage.tsx`, `components/decision/*`, `lib/decision.ts`, `lib/aideDecisionApi.ts` |
| 2 Indicateurs et qualité | Dictionnaire des KPI, synthèse backend sur le registre, non évalués séparés, couverture, fraîcheur, qualité | `backend/src/aide-decision/*`, `api-v2/aide-decision.synthese.routes.ts` |
| 3 Carte et priorités | Moteur de priorité explicable (score sur 100, « score incomplet », « non classée »), liste et carte synchronisées, fiche d'intervention | `backend/src/programmation/priorite.*`, `api-v2/aide-decision.interventions.routes.ts`, `components/decision/carte/*` |
| 4 Simulateur | Contraintes (obligatoires, non divisibles, plafonds, équilibre), déficit toujours dit, comparaison, enregistrement, rejeu, export | `backend/src/programmation/{contraintes,deficit,comparaison,logiques,export-scenario}.*`, `api-v2/aide-decision.scenarios.routes.ts`, `components/decision/simulation/*` |
| 5 Suivi contractuel | Montants séparés (contractuel, décaissé, prévisionnel), relations manquantes, indicateurs partiels | `backend/src/aide-decision/contractuel.*`, `components/decision/contractuel/*` |
| 6 Barèmes, rapports, exports | Historique des barèmes en ajout seul, export gouverné journalisé (CSV/JSON), rapport par région | migration `20261029300000_ad_baremes_historique`, `export.*`, `pages/BaremesPage.tsx`, `components/decision/rapports/*` |
| 7 Sécurité | Séparation des tâches (auteur différent de l'approbateur), lecture de l'audit, masque financier, filtres territoriaux, permissions | `governance/separation-taches.ts`, `modules/chantiers/chantiers.confidentialite.ts`, `lib/access.ts`, `docs/aide-decision/SECURITE.md` |

Intégration faite par l'orchestrateur : cinq routeurs montés sous `/api/v2/aide-decision` (`api-v2/index.ts`), bouton d'export gouverné dans la page, `ExportJournal` rattaché au module `rapports`, deux POST en lecture documentés dans l'inventaire d'accès, recherche mobile en pleine largeur, `NaN` écarté de la longueur saisie (`indicateurs.registre.ts`).

## 2. Revues indépendantes et corrections

Deux revues par des agents distincts de ceux qui ont construit, en lecture seule, avec exécution de scripts sur de vraies réponses des fonctions backend.

**Frontend (4 défauts critiques, tous corrigés).**
- Les panneaux Répartition, Régions, Budget et Qualité ne s'affichaient jamais avec la vraie réponse du backend : les fixtures de test reprenaient les hypothèses du code client, d'où des tests verts. Corrigé à la source : fixtures remplacées par un JSON capturé des vraies fonctions backend (`reponses-reelles.testdata.json`), 4 mutations de contrôle attrapées.
- `couverture_etat_part` affiché « 0,5 part » ; texte de couverture incohérent (« 700 km évalués sur 200 km éligibles ») ; recherche globale absente de 768 à 1535 px. Corrigés, mesurés dans Chromium (titre non coupé de 375 à 1536 px).
- Moyens corrigés : dictionnaire (conditions, décisions métier non tranchées), montant exact au-delà de 2^53, prix des barèmes arrondis en nombre (désormais exact, en chaînes), ratio indéfini affiché « 0 % » (désormais « non calculable »), export proposé à des rôles refusés, erreurs d'export illisibles (blob), pagination des scénarios, relances sur 4xx, filtres d'URL invalides, longueur métier absente affichée « 0 km ».

**Backend (2 défauts élevés, tous corrigés).**
- Les exports de scénario ne retiraient aucun montant sans droit financier, et les colonnes de justification en texte contenaient des montants : un seul chemin d'export gouverné, mention consultative commune, champs retirés dits dans le fichier.
- Trois définitions du droit financier selon les modules : une seule fonction (`droitMontantsContractuels` : ADMIN, module `marches` ou `chantiers` ; `decision` seul = aucun montant contractuel ; estimations de programmation = module `programmation`). **Règle provisoire, décision D-C1-1 à faire trancher.**
- Moyens corrigés : séparation des tâches des prévisions contournable en un seul PATCH (modifier puis retenir) ; ancien `/api/simulateur/budget` national pour un compte régional ; simulateur et liste donnaient deux risques différents au même tronçon (une seule règle, empreintes scellées inchangées) ; zéro inventé par bailleur sans montant (désormais `null`) ; comparaison de scénarios sans contrôle de périmètre ; `versionAttendue` obligatoire à l'approbation d'un barème, identifiant hors plage, e-mails d'auteurs masqués.

## 3. Preuves

Exécutées par les agents (comptes rapportés) :
- Backend : `vitest run --dir src --pool=threads` 222 fichiers, 4505 tests verts ; `tsc` 0 erreur.
- Bancs PostGIS (base `replay` locale, clones jetables détruits) : priorités 76/76, scénarios 72/72, programmation 106/106, PPE 80/80, sécurité 61/61, barèmes et exports 55/55, contractuel 75/75, KPI 147/147, contrôle d'accès 81/81.
- Migration : `descentes/verifier.sh` pour `20261029300000` 6/6 (descente, aller-retour, gardes), rejoué par la revue backend.
- Frontend : tests par lot verts (lot 1 : 208 sur le périmètre rejoué après le dernier correctif ; lot 3 : 147 ; lot 4 : 163 ; lot 6 : 108), `tsc` 0 erreur, `eslint` sans erreur sur les zones touchées.
- Chromium réel (API interceptée, réponses issues des vrais noyaux) à 1440, 768 et 375 px : 0 débordement horizontal, axe-core WCAG A/AA 0 violation sur les vues mesurées. Défaut trouvé et corrigé : chaque tracé Leaflet était un arrêt de Tab (environ 1 700 avec le réseau classé).
- Mutations de contrôle réellement rejouées (code altéré puis restauré, restauration vérifiée) dans chaque lot, y compris : indicateur indisponible affiché 0, ratio indéfini à 0, `scoreIncomplet` rendu comme score, déficit masqué, bailleur sans montant lu comme 0.

Rejoué par l'orchestrateur sur l'état final (27/10/2026) :
- Backend : `vitest run --dir src` 222 fichiers, 4505 tests verts ; `tsc` 0 erreur. Sans `--dir src`, vitest ramasse la jonction parasite `backend/node_modules_partage` (artefact du worktree, hors dépôt) et des fichiers de dépendances échouent : sans rapport avec le code.
- Frontend, répertoire par répertoire (la suite entière ne se termine pas sur ce poste, arrêtée par délai après 40 minutes) : `components/decision` 18 fichiers, `components/layout` 6, `pages` 45, `lib` 57, `components/session` 4, `styles` 1, autres composants, `features`, `hooks`, `roulage` 42 fichiers (970 tests), `session` 12 fichiers (447 tests) verts avec un seul fil. Avec 3 fils, 12 tests de `src/session` échouent par délai dépassé (calcul de clé PBKDF2 sous charge, durées de 30 à 160 s) : code non modifié par ce travail. `tsc` frontend 0 erreur.
- Suite sécurité 284/284.

## 4. Ce qui n'est PAS vérifié

- Aucune donnée réelle, aucun backend en marche derrière le frontend : les captures Chromium utilisent une API interceptée ; la forme des réponses est alignée sur le code backend (JSON capturé), pas sur un échange HTTP réel.
- Aucune mesure de performance sur le volume réel (environ 1 700 tronçons classés). Le classement est recalculé à chaque appel (environ 4,9 s médiane pour 3 000 candidats selon `PRIORISATION.md` §11) sans cache ni limiteur dédié : **suivi ouvert**.
- Sur la base réelle, la plupart des tronçons seront probablement écartés `RISQUE_NON_CALCULABLE` tant que seul l'état est renseigné et que le registre de points noirs d'une région n'est pas exploité : c'est voulu (jamais de valeur inventée), mais l'écran paraîtra pauvre au premier déploiement.
- Le fond de carte réel n'a pas été rendu (tuile grise en test). Pas de test tactile réel. Pas de test Firefox/WebKit.
- Le PDF n'est pas fourni (CSV et JSON seulement) : aucune bibliothèque PDF côté serveur.
- Route héritées `/api/dashboard/decision`, `/programmation`, `/programmation/lignes` : non retirées, l'ancien écran en dépend ; elles servent encore bailleur et montant au module `programmation`. Retrait après recette.
- Course entre deux requêtes simultanées sur une prévision (pas de verrou optimiste).
- Scénarios scellés avant le changement de règle des points noirs : rejeu identique, mais l'ordre peut différer de la liste.

## 5. Décisions métier à faire trancher (rien n'a été inventé)

Toutes les valeurs ci-dessous sont **provisoires et étiquetées** dans l'interface et dans `DICTIONNAIRE-KPI.md` / `SECURITE.md`.

1. Définitions de « réseau dégradé » (MAUVAIS+CRITIQUE par convention de code) et de « critique ».
2. Source de la longueur du réseau (D-06) ; l'état valide (`OBSERVE_SEULEMENT` ou `NON_CONTESTE`).
3. Critères et poids du moteur de priorité (D-01) ; urgence ; « non divisible » ; équilibre territorial ; péremption d'un barème.
4. Barèmes et millésime (D-07) ; qui peut les approuver ; les 9 lignes d'origine sans auteur sont approuvables par tout ADMIN.
5. Source de « budget engagé » (B-08, ADR-003).
6. Droit sur les montants contractuels (D-C1-1) : règle provisoire `marches` ou `chantiers` ; écart entre l'écran de simulation (lisible avec `decision` + `programmation`) et son export.
7. Module et rôle d'export de `/api/v2/export/selection` (un LECTEUR avec le module exporte aujourd'hui).
8. Rôles de validation ; une prévision corrigée par un compte doit-elle être retenue par un tiers ; rattachement des comptes à une région (D-11) : un compte non ADMIN sans ligne `perimetres_comptes` est national.
9. Seuil de fraîcheur (30 jours provisoire) ; minimum de points noirs du registre par région (5, provisoire) ; plafond d'export (10 000 lignes, provisoire).
10. Score incomplet : il reçoit un rang dans l'ordre total (documenté `PRIORISATION.md` §5.5) ; un tronçon à 65 % de couverture peut passer devant un tronçon complet. Garder ce comportement ou séparer les deux listes.
11. Libellé « RR » (préfectorale ou régionale) ; la synthèse sous l'onglet Carte seulement ou sous tous les onglets.
12. Affichage des parts : valeur exacte du serveur (54,55 %) ou un chiffre après la virgule ; en-tête de 133 px de 768 à 1279 px (recherche en icône ?) ; filtres état, chantier et période affichés mais non appliqués à la synthèse (le serveur le dit) : les désactiver visuellement ?

## 6. Suivis hors module (à porter par l'équipe concernée)

- **Règle de modules** : `frontend/src/lib/modules.ts` traite une liste vide comme « tout autorisé », le serveur (`backend/src/lib/access.ts`) comme « aucun module ». Un essai d'alignement a cassé une douzaine de tests de session hors ligne et de menu : annulé, à traiter avec le propriétaire de la session hors ligne.
- **Tabulation Leaflet** : le correctif `tabindex=-1` sur les tracés vaut probablement aussi pour le Géoportail et la carte Observation de la Terre (non mesuré).
- **Observation de la Terre** : `E2E-EO-3` (règle de modules ci-dessus), `E2E-EO-D` (`auth.service.ts` : jeton de rafraîchissement sans `jti`, 409 sur deux connexions dans la même seconde), `E2E-EO-5` (audit du lien `missionId`).
- **Client Prisma du dépôt principal** à régénérer quand plus aucun processus ne verrouille le moteur : `cd F:\ageroute-geoportail\backend && npx prisma generate`.
- `error.middleware.ts` renvoie 500 sans `code` pour un JSON mal formé ou trop gros.
- Charge CPU du classement : cache court et limiteur dédié.

## 7. Intégration et déploiement

La branche contient une migration additive (`20261029300000`, tables en ajout seul, descente testée). Avant tout déploiement : sauvegarde vérifiée, `infra/deployer-console.sh`, `descentes/verifier.sh` complet, `tests-integration/run.sh`, validation humaine explicite (DSI). **Aucun déploiement n'a eu lieu et aucun n'est autorisé à ce stade.**

## 8. Branche de livraison `release/ad-eo` (27/10/2026)

Fusion de `feat/aide-decision` et de `feat/observation-terre` (conflits résolus : `run.sh`, `Accessibilite.test.tsx`). Deux tests de sécurité d'Observation de la Terre écrits avant les durcissements de la ligne principale ont dû être alignés : base simulée qui rend le rôle du jeton (le serveur relit le compte en base), et gardes du routeur de télédétection rendues lisibles par l'inventaire des accès (nom et marque conservés par l'enveloppe `avecCode`), ce qui rend caduque l'exception `/api/v2/teledetection/` de l'inventaire (supprimée).

Preuves rejouées sur la fusion : backend 239 fichiers, 5222 tests verts (un seul processus : le mode multi-fils plante par segfault intermittent sur ce poste) ; `tsc` backend et frontend 0 erreur ; frontend par répertoire tous verts (`components/decision` 354, `observation-terre`/`layout`/`session` 412, `pages` 842, `lib`/`styles`/`features`/`hooks`/`roulage` 1568, autres composants 793, `session` 447 avec un seul fil) ; `descentes/verifier.sh` complet : 89 migrations, 320 vérifications réussies, 0 échec, 0 migration sans descente.

`infra/deployer-console.sh` : `ATTENDUES_EN_ATTENTE=7` (les deux migrations `20261027*`, quatre `20261028*` d'Observation de la Terre, une `20261029*` d'Aide à la décision) ; `PREMIERE_EN_ATTENTE` inchangée. Le script relève le nombre réel sur le serveur et s'arrête s'il diffère : si la production a déjà appliqué certaines des deux premières, il le dira.
Aucune nouvelle variable d'environnement obligatoire. Observation de la Terre interroge le catalogue Copernicus (sortie réseau du serveur vers l'extérieur requise pour cette fonction ; la page reste utilisable sans).
