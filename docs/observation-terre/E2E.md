# Observation de la Terre : tests de bout en bout (Playwright)

Harnais : `e2e-eo/` (10 specs, 48 tests). Il ouvre l'ecran REEL (`frontend/src`, servi par Vite) dans un Chromium reel, contre l'API
REELLE du depot (`backend/src/server.ts`, port 3401) et une base PostgreSQL/PostGIS REELLE, SANS aucune interception de l'API du module.
Ce qu'il prouve est donc ce que l'utilisateur verrait : un ecran, un serveur et une base qui disent la meme chose.

## Lancement

```bash
cd frontend
npx playwright test --config ../e2e-eo/playwright.config.ts          # tout (mesure : 17 a 19 minutes sur un poste charge a 100 % de CPU par d'autres travaux, 7 minutes quand il est calme)
npx playwright test --config ../e2e-eo/playwright.config.ts specs/03  # une spec (les suivantes dependent de l'etat des precedentes)
E2E_LOGS=1 ...                                                        # journaux de l'API et de Vite (silence par defaut)
E2E_CONSERVER=1 ...                                                   # garde la base et les identifiants apres le lancement
```

Un seul lancement a la fois : ports fixes 3401 (API) et 5410 (Vite), un seul worker, une seule base.

## Prerequis

- Docker Desktop demarre et le conteneur `bdri-dev-db` (PostgreSQL 17 + PostGIS, `127.0.0.1:5434`). Les identifiants sont lus dans l'environnement
  du conteneur (`docker inspect`), jamais ecrits ; `E2E_PG_URL` (URL locale), `E2E_PG_CONTENEUR` et `E2E_PG_PORT` permettent de les fournir autrement.
- La base MODELE `essai_eo_workflow` (schema complet jusqu'a la migration `20261028130000`, sans donnee). Elle n'est que LUE. Procedure de creation :
  `backend/tests-integration/README.md` (clone de `replay` plus les migrations Observation de la Terre).
- `frontend/node_modules` (contient `@playwright/test`) et un Chromium installe pour cette version de Playwright. Dans un worktree, `node_modules`
  est une jonction vers le depot principal : rien a installer.
- Acces Internet sortant (voir Limites) : catalogue public Copernicus (recherche anonyme), tuiles de fond Esri/OpenStreetMap pour les captures.

## Base clonee

Au lancement, `scripts/lancer-api.ts` detruit puis recree `essai_eo_e2e` par `CREATE DATABASE ... TEMPLATE essai_eo_workflow`, y pose un ADMIN et deux
regions de test, puis demarre l'API du depot telle quelle (aucune copie du code). Le nom de la base est une constante qui doit respecter `essai_<nom>` et
l'hote doit etre local : le harnais ne peut ni toucher `replay`, ni une base de production, ni un autre clone. A la fin, `global-teardown.ts` detruit
`essai_eo_e2e` (`DROP DATABASE ... WITH (FORCE)`) et les identifiants generes ; seules les sorties de test (captures, traces des echecs) sont gardees.
Nettoyage manuel apres un arret brutal :
`cd frontend && node ../backend/node_modules/tsx/dist/cli.mjs --tsconfig ../e2e-eo/tsconfig.json ../e2e-eo/scripts/nettoyer.ts [--tout]`.

Les mots de passe des sept comptes sont tires au hasard a chaque lancement et ecrits dans `<tmp>/bdri-eo-e2e/run.json` (hors du depot).
Sorties : `<tmp>/bdri-eo-e2e/sorties/` (`resultats/` : captures et traces des tests en echec ; `captures/` : captures de l'ecran avec les vraies donnees).

## Donnees de test (a ne pas confondre avec des observations)

- Comptes : sept, crees par les routes d'administration (ADMIN, gestionnaire national, gestionnaire regional de la region A, inspecteur, lecteur, compte sans le
  module `teledetection`, compte a liste de modules vide).
- Produits : de VRAIES metadonnees, par l'adaptateur reel du catalogue Copernicus (STAC, recherche anonyme, une requete).
- Troncons : routes reelles extraites de `frontend/public/osm-routes.geojson`, recoupees a l'emprise des produits, nommees « FIXTURE DE TEST ».
- Propositions : des FIXTURES (methode `fixture-e2e-eo`), deposees par `POST /propositions`. Aucune detection satellitaire n'a ete calculee.
  Le drapeau `synthetique` reste faux (consigne du chantier) ; le harnais verifie qu'aucune autre methode n'existe en base.

## Ce que chaque spec prouve

Toutes les valeurs de l'ecran sont comparees a l'API (jeton du meme compte) ET a un comptage SQL direct ; aucune constante.

| Spec | Preuve |
|---|---|
| 00-pile | La base, les comptes et les fixtures sont ceux que le semis annonce ; connexion par l'interface. Defaut connu hors module (E2E-EO-D, jeton de rafraichissement), marque `test.fail`. |
| 01-ecran-admin | Indicateurs = `GET /synthese` = base ; carte (marqueurs, vue d'ouverture, troncature dite) ; liste 25 par page et « Charger plus » ; filtres ; detail = API, limites et provenance ; selection carte/liste. Les defauts E2E-EO-1 (lignes comptees illisibles par la carte) et E2E-EO-2 (recherche par nom de region) sont corriges : leurs tests ne portent plus `test.fail` (voir « Defauts reels reveles »). |
| 02-apercu-reel | Seule spec qui laisse l'apercu aller jusqu'au fournisseur : l'ecran dit ce que le serveur et le fournisseur ont repondu (404 `APERCU_INDISPONIBLE` constate, ou image si le fournisseur en rend une). |
| 03-decisions | Chaque geste de decision par l'ecran, puis relecture de la BASE : statut, journal (une ligne par transition, auteur authentifie, motif), constat cite (`constatRef`), motif d'attente, mission creee avec region et emprise, compteurs et taux (avec « echantillon insuffisant »). Bouton inactif et raison dite sans motif ou sans constat, aucune requete envoyee ; double clic et trois clics du meme tick = une seule transition ; un verdict ne se reprend pas (409 `VERDICT_DEFINITIF`) ; audit par le compte authentifie. |
| 04-sources | Les quatre sources dans l'etat enregistre en base, AUCUNE « Active » (tableau, compteur, carte de synthese, API) ; « Verifier » Sentinel-2 appelle le vrai catalogue et l'ecran affiche l'etat et le message enregistres (jamais « Active ») ; source a identifiants : aucune requete reseau, double clic = un appel ; gestionnaire : aucun bouton, API 403. |
| 05-droits | Gestionnaire regional : seulement sa region (liste, GeoJSON, totaux, compteurs) ; hors perimetre = 404 identique a un identifiant inconnu ; qualite par methode absente (ni erreur ni vide) ; inspecteur et lecteur : consultation seule, 403 serveur, base inchangee ; compte sans le module : menu absent, 403 `MODULE_NON_AUTORISE`. Defaut connu E2E-EO-3 (liste de modules vide), marque `test.fail`. |
| 06-erreurs | API injoignable (route coupee), 500 sur la synthese seule, donnees perimees, 401/403 : chaque panneau dit son erreur avec un bouton « Reessayer : <panneau> », aucun faux zero, aucun faux vide, le retablissement se voit sans recharger. |
| 07-largeurs-et-captures | 1440, 768 et 375 px : captures, pas de defilement horizontal, ordre du DOM = ordre de lecture, cibles tactiles de 44 px sous 1280 px, retour liste/detail. |
| 08-integrite | Empreinte SHA-256 des troncons, portions et ouvrages identique avant et apres tout le scenario (et un temoin prouve que la sonde detecte une modification) ; aucune suppression physique ; journal coherent avec les statuts ; verdicts signes, dates, motives et cites ; vue de coherence vide ; ecritures auditees avec un auteur. |
| 09-api-arretee | Le PROCESSUS de l'API est tue pendant que l'ecran est ouvert : chaque panneau dit sa panne, les chiffres d'avant sont dits perimes, rien ne tombe a zero. Doit rester la derniere spec. |

## Regles d'ecriture des specs

- Les specs se suivent dans l'ordre des fichiers sur une base partagee : chacune relit en base ce qu'elle attend, mais le parcours 3 pose les verdicts
  que le parcours 8 controle. Une spec en echec interrompt les suivantes du meme fichier ; `08-integrite` echoue alors par cascade, pas par defaut propre.
- Aucune assertion d'integrite ne s'assouplit pour faire passer un test : un test rouge est d'abord lu comme un defaut possible de l'application.
- Noms accessibles : `getByRole(..., { name })` est une recherche de sous-chaine insensible a la casse. Les boutons « Reessayer : Propositions » et
  « Reessayer : propositions de la carte » coexistent VOLONTAIREMENT (noms distincts exiges par la relecture) : toujours `exact: true`.
- Le texte « Active » apparait dans la legende repliee « Echelle d'etat des sources » comme NOM d'etape : un test d'etat vise les cellules du tableau, pas la section.
- Reseau du navigateur (`lib/fixtures.ts`) : les routes Playwright s'executent dans l'ordre INVERSE de leur declaration ; la feuille Leaflet (copie locale de la
  1.9.4) doit etre declaree APRES le filet generique d'unpkg, sinon elle est masquee et la carte n'est plus mise en page. La spec 07 garde ce point par une assertion.

## Defauts reels reveles (constats)

Un defaut non corrige est porte par un test `test.fail` qui previent quand il est corrige (Playwright dit alors « le test devait echouer » : retirer la ligne). Aucun n'est contourne dans les assertions. Etat au 26/10/2026 : E2E-EO-1, E2E-EO-2 et E2E-EO-6 sont CORRIGES dans le code (tests unitaires qui echouaient avant et passent apres ; la spec 01 n'a plus de `test.fail`) ; E2E-EO-3 et E2E-EO-D (hors module) restent a traiter.

| Ref | Gravite | Constat | Reproduction et lieu probable | Correctif propose |
|---|---|---|---|---|
| E2E-EO-1 | Haute, CORRIGE | La carte declarait « illisibles » les propositions dont la geometrie deposee est une LIGNE (nouvelle route, coupure) : 18 sur 42 dans le semis (`{Point:6, LineString:18, Polygon:18}` servis, 24 marqueurs). Elles restaient dans la liste, pas sur la carte. | Cause : `frontend/src/lib/teledetectionCarte.ts` `lireProposition` ne lisait que Point et Polygon, alors que le depot (`api.noyau.ts`) accepte six types et que `api.lecture.ts` sert `ST_AsGeoJSON(pt.geom)` tel quel. | CORRECTION (cote carte, le serveur n'a pas change) : `lireProposition` lit tout GeoJSON valide (Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon, GeometryCollection). `PropositionCarte` porte `surfaces` et `lignes` (anneaux et traits en [lat, lon]) a la place de `contour` ; `CarteObservationTerre` trace chaque trait (`Polyline`) et chaque surface (`Polygon`), cliquables. Repere : le point lui-meme, le milieu (a mi-longueur) de la plus longue ligne, ou le centre de l'emprise des surfaces. Reste « illisible » (comptee et dite) : geometrie absente, de type inconnu, ou aux coordonnees invalides (ligne a un seul sommet, sommet hors bornes, anneau de moins de 3 positions, collection ou multi-geometrie vide). Tests : `teledetectionCarte.test.ts` (cas LineString, MultiLineString, MultiPolygon, MultiPoint, GeometryCollection, invalides) et `CarteObservationTerre.test.tsx` (trait et repere dessines, aucun « illisible »). |
| E2E-EO-2 | Faible, CORRIGE | La recherche annonce « Rechercher une zone, un troncon » et la liste affiche la region comme « zone », mais chercher le nom de la region ne trouvait rien. | Cause : `api.lecture.ts` `conditionsPropositions` : `q` ne portait que sur code et nom du troncon, methode, debut d'identifiant. | CORRECTION : `r."nom" ILIKE` ajoute au groupe `q` (jointure `regions` deja presente dans la liste et le comptage, aucune seconde jointure) ; le filtrage territorial reste une condition `AND` separee, jamais desserree par la recherche. Test : `api.lecture.test.ts` (texte SQL et valeurs liees, liste et comptage, perimetre regional conserve, texte litteral). |
| E2E-EO-3 | Moyenne (hors module) | Un compte dont la liste de modules est VIDE : le serveur dit « aucun module » (403 `MODULE_NON_AUTORISE`), le frontend dit « tout autorise » : entree de menu visible, ecran ouvert, panneaux en « acces refuse ». | `frontend/src/lib/modules.ts` `hasModuleAccess` l.35 (`length === 0` renvoie vrai) contre `backend/src/lib/access.ts` (correction du 05/09/2026). | Aligner le frontend : liste vide = aucun module (hors ADMIN). |
| E2E-EO-4 | Moyenne, CORRIGE dans le worktree | Apres un verdict, le message « Decision enregistree » disparaissait : la fiche bascule (detail relu) avant que le composant ne rende le succes ; seul un toast fugitif restait. | `frontend/src/components/observation-terre/ActionsProposition.tsx` (correction et test `PanneauDetail.test.tsx` presents). | Verifier qu'elle est dans le commit. |
| E2E-EO-5 | Faible | L'ecriture du lien `propositions_teledetection.missionId` (affectation a une inspection) n'a pas de ligne d'audit sous l'identifiant de la proposition ; elle est tracee par la ligne `Mission/CREATE`, dont `after.propositionTeledetectionId` cite la proposition. | `teledetection.service.ts` ~l.535-540. | Une ligne `PropositionTeledetection/UPDATE` (`missionId`) dans la meme transaction, ou documenter que la trace est celle de la mission. |
| E2E-EO-6 | Moyenne, CORRIGE | Sous forte charge, une decision echouait : « Transaction already closed ... timeout 5000 ms, 5253 ms passed » (500 `ERREUR_INTERNE`). Constate pendant un lancement ou la machine etait a 100 % de CPU (semis 716 s au lieu de 25 a 50 s). | Cause : `backend/src/teledetection/teledetection.service.ts` : `$transaction` de `changerStatut` sans delai explicite (5 s par defaut de Prisma). | CORRECTION : `OPTIONS_DECISION = { timeout: 15_000, maxWait: 10_000 }` passe a `changerStatut` ; `dansTransaction` prend maintenant les options (les lots gardent `OPTIONS_LOT`). Verrou, journal, preuves, mise a jour conditionnee, audit et relecture restent dans la meme transaction (atomicite et audit inchanges). Aller-retours non reduits : aucun ne se supprime sans changer la semantique (la relecture finale rend l'etat reel apres la mise a jour conditionnee). Test : `teledetection.service.test.ts` (delai explicite d'au moins 15 s). Les autres transactions courtes du service (preuves, affectation a une inspection) gardent le delai par defaut : a traiter si le meme symptome y apparait. |
| E2E-EO-D | Moyenne (hors module) | Deux connexions du MEME compte dans la meme seconde : la seconde rend 409 « Une entree avec cette valeur unique existe deja » ; un rechargement de page dans la seconde suivant la connexion renvoie sur /login (le rafraichissement regenere le meme jeton). | `backend/src/modules/auth/auth.service.ts` l.79 `signRefreshToken` : JWT sans identifiant (`jti`), contrainte d'unicite de `refresh_tokens.tokenHash`. Test : `00-pile.spec.ts` (`test.fail`). | Ajouter un `jti` aleatoire au jeton. |

Constats d'interface sans test bloquant : la carte « Derniere acquisition » affiche le code de la source (`SENTINEL2 · 10 m`) alors que le tableau des sources dit « Sentinel-2 » (`derniereAcquisition.source` = `coalesce(sourceCode, source)`, `teledetection.service.ts` ~l.602) ; a 768 px l'en-tete de l'application (hors ecran) coupe le badge de role et le bouton « Deconnexion » ; la feuille de style Leaflet est chargee depuis unpkg par `frontend/index.html` (sans reseau public, la carte n'est pas mise en page : le harnais la sert depuis la copie locale de la meme version).

## Resultats mesures (26/10/2026, worktree `feat/observation-terre`)

Deux executions COMPLETES consecutives, sur la meme pile, chacune depuis une base fraiche : **48 tests, 48 reussis** (dont 4 tests `test.fail` qui echouaient comme prevu : E2E-EO-D, E2E-EO-1, E2E-EO-2, E2E-EO-3 ; le bilan Playwright les compte parmi les reussis). Mesure AVANT les corrections de E2E-EO-1 et E2E-EO-2. APRES (27/10/2026, spec 01 seule, base fraiche, `test.fail` retire des deux tests) : 8 tests sur 8 reussis en 6,7 min (semis 118 s, prechauffage Vite 89 s) ; geometries servies `{Polygon:18, LineString:18, Point:6}`, marqueurs dessines 42 sur 42 (24 sur 42 avant) ; la recherche par nom de region renvoie le total SQL. La suite complete (specs 00 a 09) n'a pas ete rejouee apres ces corrections.

| Execution | Duree totale | Semis (base, comptes, catalogue reel, depots) | Prechauffage Vite | Bilan |
|---|---|---|---|---|
| 1 | 1 091 s (18 min 11 s) | 302 s | 32 s | 48 reussis |
| 2 | 1 135 s (18 min 55 s) | 70 s | 15 s | 48 reussis |

Les durees sont celles d'un poste dont le processeur etait a 100 % (d'autres travaux : tests unitaires, compilateur) : le semis est passe de 25 s a 716 s selon la charge. Valeurs relevees dans les executions : semis 42 propositions (region A : 22, region B : 14, non rattachees : 6) sur 9 produits reels du catalogue Copernicus ; apercu reel : 404 `APERCU_INDISPONIBLE` en 16 s (produit apres) et 19 s (produit avant) ; verification reelle de Sentinel-2 : HTTP 200 en 1,8 s, etat `PRODUIT_DISPONIBLE`, message du catalogue enregistre ; panne reelle de l'API : 500 du proxy, message « Erreur du serveur », rien a zero ; ecritures auditees du parcours 3 : `Mission/CREATE=1`, `PropositionTeledetection/UPDATE=5, VALIDATE=1, REJECT=1`. Cibles tactiles sous 44 px : 0 a 768 et 375 px ; a 1440 px 16 (hors exigence, liste dans la sortie).

Executions intermediaires ecartees (disent ce que la charge fait a un banc) : une avec la feuille Leaflet masquee (corrigee), deux ou une decision a echoue par le delai de transaction de 5 s du serveur (E2E-EO-6, 08 en cascade), une ou la connexion par l'interface a depasse 30 s (delai porte a 120 s).

Nettoyage verifie apres chaque execution : ports 3401 et 5410 libres, base `essai_eo_e2e` supprimee, `run.json` supprime, aucun processus du harnais restant (`lib/ports.ts` arrete au besoin les serveurs orphelins). Aucun mot de passe, jeton ni adresse de serveur n'est ecrit dans le depot.

## Ce qui est couvert, ce qui ne l'est pas

Couvert : connexion UI et cookie, indicateurs vs API vs base, carte (marqueurs, vue d'ouverture, troncature), liste et pagination, filtres, detail, onglets, apercu reel, decisions (toutes, journal, audit, mission, double clic), sources (etats reels, verification reelle), droits (national, regional, inspecteur, lecteur, sans module, modules vides), etats d'erreur (coupure, 500, donnees perimees, 403, panne reelle), integrite du referentiel (empreinte SHA-256 avant/apres), 1440/768/375 px.

Non couvert : ajout de preuves de terrain par l'inspecteur sur une mission affectee (observations de test absentes : seul le refus `MISSION_NON_AFFECTEE` est prouve), liaison d'observations a un verdict (le verdict passe par une reference de constat), synchronisation du catalogue par l'ecran (aucun bouton : seulement par l'API, au semis), filtre par troncon (selecteur partage), plein ecran de la carte, clavier et lecteur d'ecran (couverts par les tests unitaires du frontend), Firefox et WebKit, navigateur tactile reel, comptes a perimetre de plusieurs regions.

## Limites

- Les propositions sont des fixtures : le harnais prouve l'ecran, le serveur, les droits et l'integrite des donnees, pas la qualite d'une detection satellitaire.
- Reseau externe reel : le catalogue Copernicus (anonyme, une requete au semis, une a « Verifier » Sentinel-2, 1 a 4 par apercu de la spec 02) et les tuiles de fond
  des captures. Une indisponibilite de ces services change le contenu de la spec 02 et 04 (les deux issues sont verifiees) ou le semis (il echoue alors franchement).
- Un seul navigateur (Chromium bureau), un seul worker ; aucun test sous Firefox/Safari ni sur un appareil tactile reel (les largeurs sont emulees).
- Le jeton de rafraichissement (E2E-EO-D) impose d'espacer les connexions (`lib/api.ts`, `lib/fixtures.ts`) ; le plafond de connexion (10 par 15 min et par adresse) est
  contourne par une adresse `X-Forwarded-For` par contexte, sans modifier le serveur.
- Les apercus sont remplaces par le 404 que rend le serveur dans toutes les specs sauf la 02 (pour ne pas solliciter le fournisseur a chaque test).
- Le typage du dossier `e2e-eo` (`tsc -p e2e-eo/tsconfig.json`) signale quelques erreurs de declaration (paquet `pg` sans types) : sans effet a l'execution (Playwright et tsx ne verifient pas les types), non corrige.
