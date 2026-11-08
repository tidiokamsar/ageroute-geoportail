# Rapport du lot de corrections de la vague 1 (A1 import, B1 réseaux, B3 workflow)

Branche `feat/vague1-corrections` (issue de `feat/vague1-integration` @ `7bb5589`), worktree `C:\ageroute-secours\w-v1-fix`. Entrée : `C:\ageroute-secours\REVUE-VAGUE1.md` (1 majeur, 7 mineurs, 11 observations). Backend et documentation uniquement. Aucun push, aucune connexion à un serveur, aucun déploiement. **Aucune migration, `schema.prisma` inchangé, client Prisma non régénéré.**

## 1. Commits (10)

| Hash | Objet |
|---|---|
| `86055319a9c6436541ca61aff9ac55164f4eeb80` | M1 et O1 : revue des suppressions non contournable, refus définitif |
| `f035c3b8a39e93661e2591738b88ac00e1b0829e` | m1 : limites multer |
| `3e258effa4b8d1dc91aa793301867b75398881e3` | O5 : plafond de cellules CSV |
| `87ec1d41e325ed49ec2aa5e7494ddbf063d8fad7` | m2 (CSV UTF-16) et O6 (couches bornées) |
| `296bd6e269844bb228709045703a871f497f72e4` | docs import : CONTRAT-IMPORT 14.3 à 14.7, API.md, références |
| `02619315b1ff18ae35a63b428df2e815e329b2f6` | m3 et m4 (réseaux) |
| `397452d203833d7beb7f77b199ea71de69b634be` | m5 (flux d'activité) |
| `368b3a524b39e340b40dda6767008a4bb46cdc08` | m6 (verrou du workflow : commentaire, doc, banc) |
| `c8323a77dc2ba32321f5b597f748f712781cb19c` | m7 (test dynamique du référent, délégués d'isolation, contrôle d'accès) |
| `28bc95ac8168a9f03250beeb87b2e690a03b36cc` | DEPLOIEMENT-MODULE.md, constats O8, O9, O11 |

## 2. Constat par constat

| Constat | État | Ce qui a été fait | Test qui échoue avant et passe après |
|---|---|---|---|
| **M1** contournement de la revue des suppressions | **corrigé** | Deux gardes cumulées. (1) `retirerJeu` : un jeu `AUTORISE` ne se retire pas (409 `DEPOT_EN_ATTENTE`, avec `jeuId` du dépôt) tant qu'un jeu `RECU` ou `CONTROLE` de même projet, rôle et concessionnaire existe. (2) Référence de la revue = jeu `AUTORISE` de même clé, à défaut le jeu que le dépôt devait remplacer (`remplaceId`), même retiré : utilisée par `decider`, `revueSuppressions` et le statut de `GET .../delta` (le jeu retiré reste invisible : `comparaison` nulle, aucun identifiant ni échantillon). Documenté dans `CONTRAT-IMPORT.md` 14.1. | 13 tests de service `projets.service.suppressions.test.ts` (5 échouent avant). Banc PostGIS `import-formats` section 11 bis sur le **scénario exact** : avant, `DELETE` 200 puis autorisation 200 avec `remplaces: []` ; **84/89 avant, 89/89 après**. |
| **O1** ACCEPTER après REFUSER | **corrigé** (décision : un refus est définitif) | 409 `SUPPRESSIONS_REFUSEES` sur `ACCEPTER` quand le statut est `REFUSEES` (même empreinte). `REFUSER` après `ACCEPTER` et après `REFUSER` restent permis ; un autre ensemble retiré rouvre la revue. Sortie d'un refus : rejeter le dépôt. Séparation des tâches (même personne dépose, accepte, autorise) : **documentée comme décision DSI** (14.2). | Mêmes tests de service et banc (section 11 bis). Le test du banc qui acceptait après refus (section 10) a été adapté en conséquence. |
| **m1** limites multer | **corrigé** | `fields: 40`, `parts: 45` (le dépôt porte 26 champs texte). 14.3. | `projets-voirie.routes.test.ts` : 26 champs passent (201), plus de 40 donnent 400 `TELEVERSEMENT_INVALIDE` ; échoue avec 20/25. |
| **m2** CSV UTF-16 inatteignable | **corrigé** | Contenu à BOM UTF-16 : le premier caractère utile décodé décide (`<`, `{` ou blanc : branche texte structuré ; sinon CSV). 14.4. | `lecture-import.noyau.test.ts` : CSV UTF-16LE et BE avec BOM, accents, CRS toujours exigé ; KML, GeoJSON, GPX en UTF-16 inchangés ; blanc et HTML. Échoue avant. |
| **m3** supports dépendants du rôle | **corrigé** | La cible d'un support doit être dans un jeu `AUTORISE`, pour tous les rôles (comptage et `cibleDesObjets`). Le paramètre `role` de `cibleDesObjets` est conservé mais inutilisé. `CONTRAT-RESEAUX.md` 11.1. | Banc `reseau-physique-logique` section 9 bis : support dans un jeu `REMPLACE`, 3 rôles, même chiffre (0). Avant : 1 pour l'administrateur et le gestionnaire, 0 pour le lecteur. |
| **m4** consultation non tracée (relations, comptage) | **corrigé** | `tracerConsultation` (route `reseau`) avant la remise : liste des relations (jeux des deux bouts), fiche d'un objet (jeu de l'objet et de l'autre bout de ses relations, que le code ne traçait pas), comptage (jeux retenus). Nouveau fichier `reseaux/consultation-reseau.ts`. 11.2. | 4 tests de service (2 échouent avant) ; banc section 9 bis (5 des 8 vérifications échouaient avant : m3 deux fois, m4 trois fois ; **125/130 avant, 130/130 après**). |
| **m5** `GET /api/dashboard/activity` | **corrigé** | Filtre par les types d'entité des modules autorisés (nouvelle `typesEntiteVisibles` en fin de `lib/access.ts`) : type inconnu ou réservé à l'ADMIN jamais montré, module Projets de voirie exclu pour un compte rattaché. ADMIN inchangé. `CONTROLE-ACCES.md` mis à jour. | `dashboard.activity.test.ts` : 6 tests, 5 échouent avant. |
| **m6** commentaire faux sur les verrous | **corrigé** (commentaire, doc) | `communs.ts`, `CONTRAT-WORKFLOW.md` 9 bis, `API.md` : le verrou du workflow n'est pas indépendant de celui des dépôts (clé étrangère, `FOR KEY SHARE` contre `FOR UPDATE`) ; retry du client sur 503 `PROJET_OCCUPE`, rien n'est écrit. | Banc `workflow-roles` section 11 bis : écriture pendant un `FOR UPDATE` du projet, 503 après 590 ms pour un délai de 500, réessai 201, aucune ligne écrite par la tentative refusée (mesure, pas seulement lecture du code). |
| **m7** doc et tests | **corrigé** | `API.md` (KMZ, GPX, CSV ne sont plus en 415 ; règle de CRS à jour) ; références `CONTROLE-ACCES.md` qualifiées `docs/securite/CONTROLE-ACCES.md` dans les rapports A1 et B3 (le seul fichier existant ; je n'ai trouvé aucune autre référence erronée dans le dépôt) ; `isolation.test.ts` : délégués `reseauObjetDescripteur` et `reseauRelation` ajoutés ; test du référent énuméré dynamiquement (pile du routeur, 47 routes hors `/workflow`, critère d'exclusion indépendant de la garde). | Le test dynamique **ne peut pas échouer avant** (la garde était déjà correcte) : contre-épreuve faite, garde ouverte à `/import`, le test échoue (`GET /:id/import/options` rend 200) ; garde restaurée. Les délégués d'isolation sont une liste blanche élargie, aucun code ne les utilisait encore : pas de test qui échoue avant. |
| **O5** amplification mémoire CSV | **corrigé** | `PROJETS_VOIRIE_CSV_CELLULES_MAX` (défaut 5 000 000, bornes 10 000 à 100 000 000, **à valider**), 422 `CSV_TROP_DE_CELLULES`. 14.6. | `csv.noyau.test.ts` et `charge.test.ts` (30 000 lignes de 200 colonnes vides) : échouent sans le plafond. La borne mémoire du test (400 Mo) est large : ce n'est pas une mesure de production. |
| **O6** liste des couches | **corrigé** | 200 couches au plus, `nbCouches`, `couchesTronquees`, avertissement `COUCHES_TRONQUEES` ; les couches au-delà restent choisissables par leur identifiant. 14.5. | `lecture-import.noyau.test.ts` : échoue avant. |
| **O2** retour arrière sans nouvelle revue | **documenté** | `CONTRAT-IMPORT.md` 14.7. | |
| **O3** `sha256Attendu` et `confirmerHorsZone` facultatifs | **documenté** (décision DSI) | 14.7. | |
| **O4** fichier d'origine sans purge | **documenté** (décision DSI) | 14.7. | |
| **O7** descripteur sans quatre yeux | **documenté** (décision DSI) | `CONTRAT-IMPORT.md` 14.7 et `CONTRAT-RESEAUX.md` 11.3. | |
| **O8** dérogation ADMIN à soi-même | **documenté** (déjà l'était) | `CONTRAT-WORKFLOW.md` 11 renvoie au point 6 de la section 10. | |
| **O9** `GET /api/audit` rend before/after du workflow | **documenté** (décision DSI) | `CONTRAT-WORKFLOW.md` 11. | |
| **O10** ordre de déploiement | **documenté** | `DEPLOIEMENT-MODULE.md` (nouveau) : migrations avant code, ordre et descentes des cinq migrations, contrôles après déploiement, retrait de la clé de module aux référents avant la descente du workflow. | |
| **O11** statut `RETIRE` aux décideurs | **documenté** | `CONTRAT-WORKFLOW.md` 11. | |
| Remarque B1 : 504 d'association tient le verrou 20 s | **documenté**, non corrigé | `CONTRAT-RESEAUX.md` 11.3 (décision à prendre : cadence sur les échecs ou verrou consultatif propre). | |

## 3. Résultats d'exécution (chiffres réels)

Base de test : conteneur jetable `postgis/postgis:17-3.5`, port 5474, base `replay` reconstruite par les **100 migrations** (avec le pont de dérive `ponts/20260702110000_marches_bailleurs_avancement.sql` appliqué après la migration `20260702110000`, comme le fait le banc des descentes), donc avec `20261101100000`, `20261101200000` et `20261101300000`. Conteneur et volume supprimés à la fin (le conteneur `bdri-dev-db` n'a pas été touché).

- `npx tsc --noEmit` : 0 erreur.
- `npx vitest run` (backend complet) : **303 fichiers, 6 407 tests, tous réussis** (368 s). Il comprend l'inventaire des accès (`securite/inventaire-acces.test.ts`) et l'isolation du module (`projets-voirie/isolation.test.ts`), aucune route n'ayant été ajoutée.
- Bancs PostGIS (tous exit 0) : `import-formats` **89/89** ; `projets-voirie` (socle) **141/141** ; `conflits-projets-voirie` **169/169** ; `reseau-physique-logique` **130/130** ; `workflow-roles` **132/132**.
- Avant correction (mêmes bancs, code d'origine restauré le temps de l'essai) : `import-formats` 84/89 (les 5 vérifications nouvelles), `reseau-physique-logique` 125/130 (5 vérifications nouvelles). `workflow-roles` : la vérification 11 bis décrit une propriété qui existait déjà (le comportement n'a pas changé, seul le commentaire et la doc étaient faux) ; elle a servi à **mesurer** ce que le commentaire niait, pas à tester une correction de code.
- Octets NUL : scannés (`tr -cd '\000'`) sur tous les fichiers touchés (sources, tests, bancs, docs) : 0.

## 4. Non exécuté

- Le banc des descentes (`prisma/descentes/verifier.sh`) : aucune migration ni descente n'a été ajoutée ou modifiée, donc non relancé.
- Les bancs PostGIS hors module (le reste de `tests-integration/run.sh`), le frontend (tsc, vitest, eslint, build), l'outil de dérive de schéma : hors périmètre, non relancés.
- Aucun essai sur une base de production ou une copie : les affirmations de `DEPLOIEMENT-MODULE.md` sur les effets d'un code déployé avant une migration (sauf la garde du référent, qui lit `referents_concessionnaire` à chaque requête) viennent de la lecture du code et sont signalées comme telles dans le document.
- Les 5 bancs ont été lancés en série, pas par `run.sh`.

## 5. Décisions hors contrat (prises prudemment)

1. **O1 : un refus de revue est définitif** (au lieu de corriger seulement le message). Conséquence : le banc `import-formats` section 10 n'enchaîne plus refus puis acceptation ; ce parcours est éprouvé section 11 bis sur un projet à part.
2. **M1 : les deux pistes sont cumulées** ; la garde de retrait s'applique à toute nouvelle version en attente (`RECU` ou `CONTROLE`) de même clé, pas seulement à celle dont `remplaceId` est le jeu retiré (plus prudent, cohérent avec `evaluerRetourArriere`).
3. **m3 touche aussi la qualification des cibles de conflit** (`cibleDesObjets`, extension RC-3) : un administrateur voit désormais le même nombre de supports que le lecteur. Effet visible : après remplacement de l'infrastructure par une nouvelle version, les relations de l'ancienne ne comptent plus (11.1).
4. **m4 trace aussi la fiche d'un objet** pour les jeux de l'autre bout de ses relations (la revue ne citait que la liste et le comptage).
5. **m5 est fail-closed** : un compte non `ADMIN` ne voit plus que les types de `MODULE_PAR_ENTITE` de ses modules ; les types d'audit absents de cette table (s'il y en a) disparaissent du flux d'accueil pour les non-ADMIN, comme ils sont déjà refusés par `GET /api/audit`. À signaler à l'équipe d'exploitation : le flux d'accueil d'un compte qui n'a que la clé `dashboard` sera vide.
6. **O5 : valeur par défaut 5 000 000 de cellules**, valeur de protection non validée métier, configurable.
7. **O6** : borne à 200 couches (constante, comme les entrées d'archive), non configurable.
8. Le frontend n'a pas été modifié : il devra afficher les nouveaux messages (409 `DEPOT_EN_ATTENTE` sur le retrait d'un jeu, 409 `SUPPRESSIONS_REFUSEES` sur l'acceptation) et peut exploiter `nbCouches` et `couchesTronquees`.

## 6. Décisions que le DSI doit prendre (documentées, non prises)

Séparation des tâches pour la revue des suppressions (même personne qui dépose, accepte et autorise) ; rétention et purge du fichier d'origine (O4) ; exiger `sha256Attendu` et la confirmation hors zone (O3) ; droits de descripteur et double validation (O7) ; lecture par un lecteur de l'historique d'audit du workflow (O9) ; valeur du plafond de cellules CSV (O5) ; cadence ou verrou propre pour les associations en échec (remarque B1) ; retirer automatiquement la clé de module à la révocation d'un rattachement (déjà `CONTRAT-WORKFLOW.md`, section 10, point 7).
