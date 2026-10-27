# Bancs d'integration PostGIS

Ces bancs exercent le code **contre une vraie base PostgreSQL/PostGIS**, là où les tests Vitest
simulent la base. Ils sont la preuve derrière les mentions « vérifié contre PostGIS réel » de
`REQUIREMENTS_TRACEABILITY.md` et de `AUTONOMOUS_EXECUTION_TRACKER.md`.

Ils ne sont **pas lancés par la CI** (la CI n'a pas de base PostGIS pour ces bancs) et ne sont pas
vérifiés par `tsc` (hors de `src/`). Ils ne font pas partie de `npm test`, sauf les tests de leurs deux
modules d'appui (`lib/garde.test.ts`, `lib/verdict.test.ts`).

## Prérequis

- Une base PostGIS **locale** dont les 69 migrations sont appliquées et qui s'appelle `replay`
  (rejeu des migrations, sans donnée). Sur ce poste : conteneur `bdri-dev-db`, port 5434. Les 69
  migrations ne s'appliquent de bout en bout sur une base vierge qu'avec le pont décrit dans
  `backend/prisma/descentes/README.md` (défaut D-10 sur `marches`). **La fabrication de `replay` n'est
  pas automatisée par ces bancs** : à scripter si la base doit être reconstruite sur un autre poste.
- `DATABASE_URL` pointant sur cette base. Les identifiants ne sont jamais écrits dans ces fichiers.
- Les dépendances du backend installées (`tsx` est une devDependency).

## Bancs qui exigent des migrations récentes

Le banc `eo-workflow` (et le banc `teledetection`, dont le service a changé) exige que les migrations
`20261028100000_eo_produits_sources`, `20261028110000_eo_propositions_workflow` et
`20261028120000_eo_qualite_methodes` soient appliquées à la base cible. `replay` n'est **jamais modifiée durablement** par
ces bancs : pour les lancer avant que `replay` ait reçu ces migrations, passer par un **clone jetable** (`essai_<nom>`,
accepté par la garde), puis le détruire :

```bash
# depuis backend/, conteneur bdri-dev-db ; le mot de passe vient de l'environnement du conteneur, il n'est jamais écrit
docker exec bdri-dev-db psql -U bdri_dev -d postgres -c "CREATE DATABASE essai_eo_workflow TEMPLATE replay"
for m in 20261028100000_eo_produits_sources 20261028110000_eo_propositions_workflow 20261028120000_eo_qualite_methodes; do
  docker cp prisma/migrations/$m/migration.sql bdri-dev-db:/tmp/m.sql
  docker exec bdri-dev-db psql -U bdri_dev -d essai_eo_workflow -X -q -v ON_ERROR_STOP=1 -1 -f /tmp/m.sql
done
DATABASE_URL="postgresql://utilisateur:motdepasse@127.0.0.1:5434/essai_eo_workflow" npx tsx tests-integration/eo-workflow.integration.ts
docker exec bdri-dev-db psql -U bdri_dev -d postgres -c "DROP DATABASE essai_eo_workflow WITH (FORCE)"
```

Sous Git Bash (Windows), préfixer `MSYS_NO_PATHCONV=1` aux commandes `docker` qui portent un chemin.

Le banc `eo-api` (`eo-api.integration.mts`) crée lui-même son clone `essai_eo_api` à partir de `replay` et y applique les trois migrations ci-dessus
(`DATABASE_URL` pointe sur `replay`) ; il détruit le clone à la fin :

```bash
DATABASE_URL="postgresql://utilisateur:motdepasse@127.0.0.1:5434/replay" npx tsx tests-integration/eo-api.integration.mts
```

## La garde

`lib/garde.ts` est importé par chaque banc et **termine le processus (code 3)** si la cible n'est pas
à la fois :

- sur la machine locale (`127.0.0.1`, `localhost`, `::1`) ;
- une base nommée `replay` ou `essai_<nom>`.

Une variable `DATABASE_URL` laissée dans un terminal et pointant ailleurs ne peut donc pas être
atteinte. La garde est testée (`lib/garde.test.ts`, lancée par `npm test`).

## Lancer

```bash
DATABASE_URL="postgresql://utilisateur:motdepasse@127.0.0.1:5434/replay" bash tests-integration/run.sh
```

ou `npm run test:integration` avec la variable posée, ou un seul banc :
`npx tsx tests-integration/trace.integration.ts`.

## Ce que chaque banc affirme

Chaque banc nomme ses vérifications, les compte, et sort en **code 1** si une seule est fausse.
`lib/verdict.ts` fait aussi échouer un banc qui n'a fait **aucune** vérification (testé dans
`lib/verdict.test.ts`) ; le banc `curseur` tient son propre décompte (41 vérifications).

| Banc | Travaille dans | Vérifications | Couvre |
|---|---|---|---|
| `trace` | transaction annulée | 9 | analyse d'une trace contre un réseau réel, leurre parallèle, graphe branché |
| `metadonnees` | transaction annulée, fuseau de session NZ | 9 | étendue et date de révision des métadonnées ISO 19115 |
| `geometries-invalides` | transaction annulée | 6 | compte exact des géométries invalides |
| `deviation` | transaction annulée | 8 | déviation routée, longueur comparée à un **oracle SQL** |
| `chemin` | transaction annulée | 13 | route entre deux villes : troncons dans l'ordre sur le reseau, ni route parallele ni route qui traverse, longueur comparée à un **oracle SQL**, sens inverse au retour, ville hors référentiel, trou du référentiel (aucun chemin, jamais une ligne droite), troncon archivé |
| `historique` | transaction annulée | 19 | historique d'une section et classement « à contrôler » : constats par jour, récurrences, confirmés et proposés à part, rejeté et supprimé écartés, **observation conteneur d'un défaut non comptée deux fois**, score calculé à la main, périmètre régional |
| `qualite-detecteurs` | transaction annulée sur `replay` (passée en lecture seule après l'insertion des fixtures) | 98 | détecteurs de qualité des tronçons par code stable (PK 0/0, fin < début, absent, négatif, chevauchement et trou de PK, longueur nulle et écart de longueur, géométrie nulle, vide, invalide, micro-tracé, région discordante nette ou à cheval, « Non renseigné », région sans limite, hors territoire, doublon strict, inverse, quasi, états) : 49 fixtures dont 18 **sans anomalie attendue, qui ne doivent pas être signalées** (faux positifs), **trois accords** (modèle écrit à la main, **oracle SQL indépendant** : sphéroïde par segment, milieu de segment dans le polygone, `ST_Equals`, fenêtres pour les PK ; service), longueurs déclarées des tronçons sains calculées par Vincenty en JS pur, portée par région, plafond de liste à compte exact, pagination, **aucune écriture prouvée** (`pg_stat_xact_user_tables` et empreinte des tronçons identiques avant/après, base qui refuse une écriture, forme `lancerEnLectureSeule` en `READ ONLY`), deux contre-épreuves, et les six requêtes de `docs/qualite/DETECTEURS-REQUETES-DSI.sql` (remises à la DSI) rejouées sur les fixtures. Mutations : sentinelle élargie 4 échecs, jumeau supprimé compté 6 échecs, écriture introduite refusée par la base (25006). **Constat** : GEOS 3.9.0 de `replay` rend un résultat vide pour `ST_Intersection` d'un tracé horizontal ou vertical dans un polygone rectangulaire (contourné par `ST_Covers`). **Ne prouve pas** la production (volumes, durée, précision des limites réelles) ni la pertinence des seuils (provisoires) |
| `graphe` | transaction annulée | 7 | graphe chargé depuis la base, jonction comparée à un oracle SQL |
| `info-route` | transaction annulée | 12 | publication, retrait, bulletin archivé immuable, absence de fuite de texte interne |
| `patrouilles` | transaction annulée | 10 | programmes, missions, couverture, vérification de signalement, audit |
| `teledetection` | transaction annulée | 10 | produits, propositions, tolérance, verdict unique, précision, audit |
| `eo-workflow` | transaction annulée, contraintes différées passées en IMMEDIATE | 138 | **Lot 1 EO-DB** : sources (amorce, jamais « active », échelle d'état, historique), produits (traçabilité, déduplication fournisseur + identifiant, SHA-256, cycle de vie), dépôt (rattachement avec confiance et concurrents contre un **oracle SQL geography**, région dénormalisée, centre calculé, limites obligatoires, synthétique), les **25 couples de transitions** (service ET base), journal exigé par la base dans la même transaction, preuves de terrain, périmètre régional, mission avec région et emprise, taux de confirmation à 0, 1, 2, 29 et 30 verdicts, synthèse comparée aux comptes de la table, **empreintes du référentiel avant/après** (troncons, portions, ouvrages inchangés) |
| `eo-api` (`.mts`) | clone jetable `essai_eo_api` de `replay` (les trois migrations 20261028* y sont appliquées par le banc), application réelle `createApp`, comptes et périmètres réels en base | 78 | **Lot 1 EO-API** : gardes (sans jeton, jeton forgé, sans la clé de module, lecteur, inspecteur, gestionnaire national et régional, ADMIN), périmètre régional (liste, GeoJSON, synthèse, détail : **même 404** hors périmètre, non rattachée ou inexistante, **même avec un corps invalide**), données synthétiques absentes de toute liste, pagination par curseur, GeoJSON plafonné (`tronque` et `total`), workflow bout en bout avec journal, preuves et verdict définitif, mission de vérification (région nulle si non rattachée, emprise posée), inspecteur limité à sa mission et à ses observations, sources (jamais « active », vérification et synchronisation du catalogue avec un adaptateur **injecté** sur fixtures réelles, **aucun appel réseau**, déduplication, produits sans nuages écartés, aperçu indisponible = 404), entrées hostiles (400, jamais 500, aucune écriture, refus PostGIS traduit), **empreintes du référentiel avant/après** avec témoin, audit des écritures et aucun audit des lectures, indicateur `propositions_a_verifier` et compteur de la veille |
| `veille` | transaction annulée | 10 | astreintes, escalades idempotentes, tableau de veille, audit |
| `contour` | transaction annulée | 7 | contour du pays du géoportail : frontière extérieure de l'union des régions de niveau 1 (limite commune disparue, niveau 2 exclu, absent sans limites) |
| `perf/` | clone jetable, jeu synthétique déterministe de 20 000 ou 261 387 tronçons | 45 | **seuils A15 et A20** mesurés (p50/p95/p99, service et HTTP) ; échoue si un seuil du cahier est dépassé ; `--sans-correctifs` rejoue l'origine pour la contre-épreuve. Méthode : `perf/README.md` ; lancé à part, pas par `run.sh` (durée et charge) |
| `curseur` | **clone `essai_curseur`**, créé puis détruit par le banc | 41 | curseur temporel à deux axes, requalification, découpe, fusion |
| `programmation` | **clone `essai_programmation`**, créé puis détruit par le banc ; applique au clone la migration `20261023100000` (absente de `replay` tant qu'elle n'y est pas rejouée) | 106 | moteur de risque et de programmation (§ 7.7, A22) : risque, coût et classement comparés à un **oracle SQL** (NUMERIC exact, glouton refait en BigInt), refus sans barème, étiquette PROVISOIRE, rejeu octet pour octet, fiche figée (empreinte recalculée par la base, UPDATE et DELETE refusés), frontière DigitalRoad tenue par les contraintes, audit |
| `outbox` | **clone `essai_outbox`**, créé puis détruit par le banc | 90 | outbox des intégrations sortantes (A13) : aucune donnée non validée n'entre (service et déclencheurs), idempotence, rejeu sans effet de bord, reprise, file morte, anti-double-envoi sous concurrence réelle, absence de fuite de champs internes. **Contre des simulateurs HTTP écrits par AGEROUTE sur 127.0.0.1, jamais contre DigitalRoad, SharePoint ou la BDR / L²R.** Applique la migration 20261024200000 au clone si `replay` ne la porte pas encore |
| `tableau-de-bord` | **clone `essai_tableau_de_bord`**, créé puis détruit par le banc | 116 | A12 : chacun des 31 indicateurs du registre, sur trois portées (national, région 1, région 2), est égal à sa requête de contrôle **et** à une valeur attendue calculée à la main (longueurs par intégrale du méridien WGS84) ; refus d'un indicateur non ventilé à un compte régional (A10) ; région vide ; échéances de patrouille à deux dates ; recoupement avec `longueurReseau` et `couvertureReseau` ; contre-épreuve ; Control Tower ; volets de la fiche 360 |
| `roulage` | **clone `essai_roulage`**, créé puis détruit par le banc (il y applique la migration `20261024100000` si `replay` ne l'a pas) | 50 | **simulation** d'une session de 2 h à 1 Hz produite par le vrai noyau de l'appareil : zéro doublon au rejeu, taux de rattachement mesuré, marqueurs et événements linéaires comparés à un **oracle SQL**, territoire, audit, refus |
| `roulage-consultation` | **clone `essai_roulage_consultation`**, créé puis détruit par le banc (il y applique la migration `20261024100000` si `replay` ne l'a pas) ; **l'application entière** (`createApp()`), comptes réels, jetons signés par des secrets aléatoires, modules et périmètre lus en base | 71 | **Relecture des relevés en roulage** (`GET /api/v2/roulage/sessions`, `.../:id`). Douze relevés sont ÉCRITS par le vrai service de synchronisation (`appliquer`, donc analyse HMM, portions, audit), pour trois comptes, puis LUS par l'application réelle : l'agent A voit les siens, l'ADMIN et un GESTIONNAIRE national tous, l'agent B pas ceux de A, un GESTIONNAIRE régional les siens et ceux qui traversent sa région (**oracle SQL** écrit à part), un relevé sans tronçon seulement de son auteur, un relevé supprimé de personne ; **404 au même corps** pour inexistant, supprimé, hors périmètre, identifiant mal formé et paramètres hostiles ; détail comparé aux lignes SQL (marqueurs, événements, portions, analyse telle qu'écrite) ; GeoJSON à la bonne longueur (`ST_Length` de la géométrie stockée relue par PostGIS) et au bon nombre de sommets ; **pagination par curseur** sans doublon ni saut, y compris quand deux relevés ont le même instant de début ; filtres ; 16 entrées hostiles en 400 ; **trace de 25 000 points** (géométrie simplifiée et dit, points bruts bornés à 20 000 et dit) ; lectures sans effet (audit et tables inchangés) ; suppression logique et périmètre relus en base (contre-épreuves) ; coût de la liste dans le pire cas (100 relevés de 25 000 points). **Traces synthétiques** (droite à vitesse constante, sans bruit GNSS, hors la grosse trace) ; aucun téléphone ; les temps sont ceux d'un poste de développement. Voir `docs/roulage/CONSULTATION.md` |
| `sync` | **clone `essai_sync`** ; routes réelles (`/api/v2/sync`), jetons signés | 67 | A7 et A8 : 50 observations rejouées, coupures, ordre inversé, concurrence, atomicité, PostGIS ; conflits, deux versions conservées, arbitrage |
| `import` | **clone `essai_import`** ; route multipart réelle | 39 | A28 : statut par ligne, rejeu sans écriture, lot modifié, CSV hors norme, concurrence, 20 000 lignes |
| `imports-api` | **clone `essai_imports_api`** ; routes réelles montées comme en production (`apiV2Router`), jetons signés par des secrets aléatoires, un compte par rôle (ADMIN, GESTIONNAIRE, INSPECTEUR, LECTEUR) | 72 | API additive des lots d'import (`docs/imports/CONTRAT-API-LOTS-IMPORT.md`) et durcissement de la réception : liste filtrée et paginée par curseur stable (insertion concurrente, lots de même instant), `q` sans jokers LIKE, détail enrichi (colonnes par `jsonb_object_keys`, historique lu dans `audit_logs`), aperçu borné/tronqué/`<script>` rendu tel quel, formules neutralisées dans `erreurs.csv`, 15 refus 400 sans lot persisté ni 500 (FORMAT_INCOHERENT, ENCODAGE_NON_UTF8, TROP_DE_LIGNES, autorisationRef, dateSource, NUL), NUL/substitut/profondeur rejetés ligne à ligne, métadonnées différentes et mêmes octets sous une autre source, `importeParId` falsifié ignoré, 403 des autres rôles, comptes de TOUTES les tables avant/après (lectures : aucune ne bouge ; réceptions : seules `lots_import`, `lignes_import`, `audit_logs`), rafale de 10 réceptions (201 ou 503, jamais 500 ni 409, autre utilisateur servi). Dure environ 50 secondes |
| `metre-defaut` | **clone `essai_metre`** ; applique au clone les migrations `20261024300000` et `20261024310000` | 73 | A5 : contour GPS d'un défaut mesuré en UTM, 37 figures contre un oracle écrit sans PostGIS (`lib/geodesie.ts`) |
| `contour-terrain` | **clone `essai_contour_terrain`** ; applique au clone les migrations `20261024300000` et `20261024310000` ; importe le module PUR de l'appareil `frontend/src/lib/contourDefaut.ts` ; `CONTOUR_FUZZ=600` pour un lancement court | 49 (à 4 000 polygones) | A5, ecran de releve du contour : le client est une garde, le serveur l'arbitre. 15 contours nommes + 4 000 polygones tires au hasard (graine fixe) contre `ST_IsValid` : 0 fausse acceptation, 0 refus injustifie ; le contour du client mesure 10 000 m2 a 0,02 % par `/v2/defauts` et `/v2/sync/push` ; la regle des mesures exigees est celle du serveur, unité par unité. Dure environ 10 minutes sur un poste charge (non intégré à `npm test`) |
| `taches-internes` | **clone `essai_taches`** ; écrit puis retire des photos dans `uploads/photos` | 76 | A29 : preuves avant/après, clôture, abandon, frontière DigitalRoad, rapprochement en lecture seule |
| `extension-unaccent` | **clone `essai_unaccent`**, créé puis détruit par le banc (il y retire `unaccent`, applique le `migration.sql` du dépôt, puis le rejoue) | 8 | migration `20261026400000` : sur une base reconstruite sans l'extension, `GET /api/public/carte/geo` répond **500** (contre-épreuve), puis **200** avec la migration ; jointure sans accents « Boke » / « Boké » ; rejeu sans effet. **Ne prouve pas** la production ni les droits du rôle de migration |
| `qualite-geometries` | **clone `essai_qualgeom`**, créé puis détruit par le banc (migration unaccent appliquée au clone ; la contrainte `eo_emprise_valide` y est retirée pour fabriquer une emprise invalide) | 38 | § 7.1 : validité des géométries sur **six tables** (tronçons, chantiers, portions courantes, limites administratives, emprises de télédétection, actifs linéaires) avec des géométries réellement invalides (nœud papillon, trou hors coque, LineString dégénérée) ; compte exact au-delà du plafond, périmètre par région (descente de `parentPcode`, cycle), supprimées et remplacées ignorées ; **oracle TypeScript indépendant** de PostGIS ; boucle non fermée refusée par PostGIS ; contre-épreuve. Mutation du détecteur : 12 échecs |
| `territoire` | **clone `essai_territoire`**, créé puis détruit par le banc ; routes réelles (v1 et v2 montées comme en production), jetons signés par des secrets aléatoires | 93 | A10 : **vrais comptes à périmètre régional** (une région, deux régions, national sans rattachement, ADMIN, LECTEUR) : 403 hors zone pour création, modification (région d'avant ET d'après), archivage, restauration et lots ligne à ligne sur les cinq entités de la fabrique ; routes v1 hors fabrique (géométrie, géolocalisation, inspection, conversion d'OT) ; v2 (portions, défauts, décision) ; synchronisation (opération hors zone rejetée seule, non enregistrée) ; périmètre vide, région inconnue ; effet immédiat d'un rattachement sans nouveau jeton ; lecture refusée hors périmètre (fiche 360) et portée du tableau de bord ; contre-épreuve (même jeton, même requête, avec puis sans périmètre). Mutation de deux gardes : 17 échecs. **Non couvert** : imports Excel réels, photos d'ouvrage, validation d'une proposition de localisation, observations ; **constat** : les listes v1 ne sont pas filtrées par région ; retirer toutes les régions d'un compte le rend national |
| `controle-acces` | **clone `essai_controle_acces`**, créé puis détruit par le banc ; **l'application entière** (`createApp()`), jetons signés par des secrets aléatoires, modules et périmètre lus en base | 81 | Chantier C1 : un compte à périmètre **régional** face à une ressource d'une autre région. **Lecture et écriture** des ordres de travaux (liste, fiche, statistiques ; création, modification avant ET après, assignation, statut, photos, conversion, archivage), des missions, des prévisions de programmation (région = celle du tronçon), des scénarios, fiches figées et plans pluriannuels du moteur, lecture des observations et des défauts ; refus = **404 identique à « introuvable »** sur une ressource désignée, 403 + code sur une création ; chaque refus relit la base (ligne inchangée, aucune trace d'audit, aucun fichier) ; **non-régression** (même compte dans son périmètre, compte national, ADMIN) ; un INSPECTEUR n'écrit que sur ses OT (404 sinon, identique à un OT inconnu) ; contre-épreuve (le périmètre en base décide) ; CONSTATS sur ce qui reste ouvert faute de décision (lectures v1 du patrimoine, champs financiers des chantiers, documents, exploitation, rôle des comptes de lecture sur la collecte, ordre de montage des inspections). 39 vérifications sur 74 échouent sur le code d'avant correction (copie du code de `HEAD` pour les fichiers modifiés), dont 3 par effet de cascade d'un refus qui n'a pas eu lieu ; 74/74 après le chantier C1 ; **81/81 après la relecture D9** (D-C1-9 : l'INSPECTEUR saisit, relit et modifie sa propre inspection ; oracle d'existence des OT indiscernable pour un compte régional et pour un INSPECTEUR). Sert aussi la redescente de synchronisation (`sync/pull`). **Non couvert** : main courante, patrouilles, veille, télédétection, tâches internes (décisions D-C1-4 et D-C1-7), téléversement multipart d'une photo d'OT |
| `session-appareil` | **clone `essai_session_appareil`**, créé puis détruit par le banc ; **l'application entière** (`createApp()`), **vraies connexions** (mot de passe aléatoire à chaque lancement), jetons de rafraîchissement tournés et révoqués réellement, un déclencheur de base qui refuse la trace de révocation | 75 | Chantier D4 (`docs/securite/SESSION-HORS-LIGNE-SERVEUR.md`) : un compte **désactivé, verrouillé ou supprimé** est refusé tout de suite (401 `COMPTE_INACTIF`) avec un jeton d'accès encore valide, `sync/push` compris, et n'écrit rien ; le **rôle de la base** prime sur celui du jeton (rétrogradation immédiate, faux jeton ADMIN) ; **révoquer un appareil coupe les sessions de rafraîchissement du propriétaire** (portée rendue, autres comptes intacts, trace unique, atomique) ; `APPAREIL_REVOQUE` distinct d'`APPAREIL_INCONNU` sur push, status et enregistrement, et **un appareil révoqué ne se ré-enregistre pas** ; `DROITS_MODIFIES` (périmètre, module retiré) tracé sans contenu, **idempotence avant les droits**, renvoi explicite réévalué quand les droits sont rendus ; `POST /auth/evenements-locaux` borné, fermé, **idempotent y compris sous cinq rejeux simultanés**, sans contenu, débit par compte ; `GET /auth/me` rend rôle, modules et régions lus en base. Mesure (non vérifiée) du coût de la lecture du compte. 18 des 28 premières vérifications échouent sur le code de `HEAD` (le banc s'interrompt ensuite faute de trace), 53/53 après D4 ; **75/75 après la relecture D9** : course révocation/rotation (banc déterministe dans les deux ordres, non-régression de la rotation, répétition HTTP parallèle de 100 essais : 0 jeton vivant, contre 48 sur 100 sans le verrou), refus `APPAREIL_REVOCATION_RECENTE`, `/revoke` d'autrui en 404, horodatage strict, débit court et plafond journalier des événements locaux, plafond de refus de droits tracés et type d'entité libre sans écriture. **Constat** : un jeton d'accès de téléphone révoqué reste valable jusqu'à son expiration (hors enregistrement d'un appareil neuf). **Variable `BANC_CLONE`** : nom du clone jetable, pour que deux exécutions simultanées (deux agents, deux terminaux) ne se détruisent pas le clone. **Non couvert** : le client, le cookie de rafraîchissement, la production |
| `info-route-delai` | **clone `essai_inforoute`**, routes réelles (main courante, Info Route, flux public), 8 lecteurs publics concurrents | 12 | A24 : **délai validation vers lisible par le public** mesuré sur 30 publications (p50 409 ms, max 716 ms le 26/10/2026), seuil 60 s ; disparition après retrait ; en-tête `max-age=30` pris dans la borne de bout en bout ; contre-épreuves (rien avant validation, seuil de 100 ms fait échouer). **Ne mesure pas** un relais, un CDN, un navigateur ni un consommateur réel du flux |
| `incident-hors-ligne` | **clone `essai_incident`**, routes réelles de la main courante | 16 | A24, **moitié serveur seulement** : incident daté 3 h plus tôt, heure serveur qui fait foi, rejeux et rafale de 12 envois de la même clé (1 création, 11 « déjà reçu » ; trouvait 10 erreurs 500 avant `cle-operation.ts`), chaîne dans l'ordre de réception, base en ajout seul. **Ne couvre pas la file locale de l'appareil**, absente |
| `correspondances` | **clone `essai_corresp`** (applique la migration `20261026410000`), routes réelles | 31 | A23, critère **B12** : table vide à l'arrivée, « à confirmer » jusqu'à la décision d'une autre personne, export de la version n **identique octet pour octet** après dix changements, règles tenues par la base, série de versions sans trou sous concurrence, audit. **Aucune correspondance réelle** (jetons de test) |

Soit **739 vérifications sur 18 bancs**, toutes passantes le 22/10/2026 après la fusion des six lots d'agents
(`bash tests-integration/run.sh`, code 0). Les bancs `roulage`, `outbox`, `programmation`, `tableau-de-bord`, `sync`,
`import`, `imports-api`, `metre-defaut` et `taches-internes` créent leur propre clone de `replay` et y appliquent au besoin les
migrations récentes. `roulage` est une **simulation** (voir `docs/roulage/COLLECTE-ROULAGE.md`) ; les bancs `sync`
et `import` fabriquent leurs jetons avec des secrets tirés au hasard à chaque lancement : rien n'est écrit dans le dépôt.

## Le banc de performance (hors `run.sh`)

`perf/` contient le banc des scenarios A15 et A20 : reseau synthetique deterministe de 20 000 a 261 387 troncons dans un
clone jetable `essai_perf`, 200 mesures par scenario (p50, p95, p99), verdict contre les seuils du cahier. Il dure de
dix minutes a deux heures et **n'est pas lance par `run.sh`**. Voir `perf/README.md` et
`docs/performance/MESURES-A15-A20.md`. Ses modules d'appui ont des tests Vitest (`perf/lib/*.test.ts`), lances par `npm test`.

## Limites

- Les bancs ci-dessus tournent sur une base **vide** : aucune mesure de performance ni de comportement sur le volume
  de production (261 387 tronçons au registre complet). Le banc `perf/` est le seul qui charge ce volume (synthetique).
- Les jeux de données sont des fixtures écrites pour le banc, pas des données réelles.
- Les bancs `deviation`, `graphe`, `info-route`, `patrouilles`, `teledetection` et `veille` existaient
  d'abord comme scripts qui imprimaient des valeurs sans rien affirmer ; leurs vérifications ont été
  écrites le 22/10/2026 à partir de ce qu'ils imprimaient **et de calculs indépendants** quand c'était
  possible (oracles SQL pour `deviation`, `graphe`). Les autres reposent sur des invariants lus dans le
  code : elles caractérisent le comportement actuel, elles ne prouvent pas qu'il est le bon au sens métier.
- Une vérification vraie prouve que le code fait ce que le banc attend, pas que le banc attend la bonne
  chose.
