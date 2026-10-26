# Observation de la Terre : tests de bout en bout (Playwright)

Harnais : `e2e-eo/` (10 specs, 48 tests). Il ouvre l'ecran REEL (`frontend/src`, servi par Vite) dans un Chromium reel, contre l'API
REELLE du depot (`backend/src/server.ts`, port 3401) et une base PostgreSQL/PostGIS REELLE, SANS aucune interception de l'API du module.
Ce qu'il prouve est donc ce que l'utilisateur verrait : un ecran, un serveur et une base qui disent la meme chose.

## Lancement

```bash
cd frontend
npx playwright test --config ../e2e-eo/playwright.config.ts          # tout (comptez 8 a 10 minutes)
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
| 01-ecran-admin | Indicateurs = `GET /synthese` = base ; carte (marqueurs, vue d'ouverture, troncature dite) ; liste 25 par page et « Charger plus » ; filtres ; detail = API, limites et provenance ; selection carte/liste. Defauts connus E2E-EO-1 (lignes comptees illisibles par la carte) et E2E-EO-2 (recherche par nom de region), marques `test.fail`. |
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

## Limites

- Les propositions sont des fixtures : le harnais prouve l'ecran, le serveur, les droits et l'integrite des donnees, pas la qualite d'une detection satellitaire.
- Reseau externe reel : le catalogue Copernicus (anonyme, une requete au semis, une a « Verifier » Sentinel-2, 1 a 4 par apercu de la spec 02) et les tuiles de fond
  des captures. Une indisponibilite de ces services change le contenu de la spec 02 et 04 (les deux issues sont verifiees) ou le semis (il echoue alors franchement).
- Un seul navigateur (Chromium bureau), un seul worker ; aucun test sous Firefox/Safari ni sur un appareil tactile reel (les largeurs sont emulees).
- Le jeton de rafraichissement (E2E-EO-D) impose d'espacer les connexions (`lib/api.ts`, `lib/fixtures.ts`) ; le plafond de connexion (10 par 15 min et par adresse) est
  contourne par une adresse `X-Forwarded-For` par contexte, sans modifier le serveur.
- Les apercus sont remplaces par le 404 que rend le serveur dans toutes les specs sauf la 02 (pour ne pas solliciter le fournisseur a chaque test).
- Le typage du dossier `e2e-eo` (`tsc -p e2e-eo/tsconfig.json`) signale quelques erreurs de declaration (paquet `pg` sans types) : sans effet a l'execution (Playwright et tsx ne verifient pas les types), non corrige.
