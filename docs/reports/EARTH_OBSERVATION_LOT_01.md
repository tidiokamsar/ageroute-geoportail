# Observation de la Terre : rapport de fin de lot 1 (audit, interface cible, API, sources, workflow)

Branche `feat/observation-terre` (worktree `F:\ageroute-eo`, issue de `lot/03-map-matching` au commit `dad9695`). Commits : `1e7d3b7` (module), `59ddd32` (corrections de la relecture frontend). Rien n'est poussé, rien n'est déployé, aucune donnée de production n'a été lue.
Date : 26/10/2026. Destinataire : architecte principal. Ce rapport distingue ce qui est prouvé de ce qui ne l'est pas.

## 1. Résumé

L'écran `/teledetection` était un squelette honnête mais vide (trois onglets, un registre sans ligne, un taux affiché sans garde d'échantillon, aucun lien avec la carte, aucun contrôle territorial). Il est devenu une interface en trois zones (indicateurs, carte, propositions et détail, sources) branchée sur de vrais endpoints, un registre de sources à échelle d'état, un workflow à cinq statuts avec journal, et deux adaptateurs de catalogues satellitaires testés sur de vraies réponses.

Ce qui **n'existe pas** et ne doit pas être présenté comme existant : aucun traitement raster, aucun moteur de détection de changement, aucune image avant/après issue du satellite, aucune proposition réelle (le registre de production est vide ; les jeux de test sont marqués synthétiques). Le lot livre l'infrastructure de preuve, pas la détection.

## 2. Agents réellement exécutés

Audit (Lot 0) : backend et données, sources satellitaires réelles, interface et sécurité, référentiel routier et zone pilote (quatre agents en lecture seule).
Construction : EO-DB (schéma, workflow), EO-SOURCES (adaptateurs), EO-CARTE (carte, comparaison), EO-UI (écran), EO-API (endpoints, accès), EO-INTEG-FRONT (intégration écran-carte).
Revues indépendantes (agents distincts des auteurs) : relecture backend, relecture frontend. Corrections : EO-FIX-BACK, EO-FIX-FRONT.
Plusieurs agents ont été interrompus par des erreurs réseau et relancés ; ce qui est rapporté ici est ce qui a été re-exécuté et vérifié.

## 3. Sources réellement interrogées (requêtes anonymes, aucun compte créé)

| Source | Résultat réel (25 et 26/10/2026) |
|---|---|
| Copernicus Data Space, catalogue STAC | recherche anonyme 200 ; état de la source `PRODUIT_DISPONIBLE` ; zone de Boké, 30 jours, nuages de tuile <= 50 % : 7 produits Sentinel-2 L2A enregistrés, 0 nouveau au second appel (déduplication) |
| Earth Search (Element 84) | recherche anonyme 200 ; 19 produits Sentinel-2 identiques à ceux du CDSE sur la même fenêtre (déduplication entre catalogues prouvée) |
| Planetary Computer, USGS | mesurés à l'audit seulement, aucun adaptateur écrit |
| PlanetScope, SPOT | façades sans appel réseau : `EN_ATTENTE_CONFIGURATION`, aucune commande |

Disponibilité optique mesurée à l'audit (12 mois, tuile entière) : de juin à septembre, 0 à 6 dates par zone à moins de 20 % de nuages ; la couverture nuageuse de tuile n'est qu'un pré-filtre (25,8 % de tuile pour 0 % local, 82 % pour 100 % local à Boké). Sentinel-1 n'est pas affecté par la saison. Aucune vignette CDSE n'a pu être lue sans compte : l'aperçu répond `APERCU_INDISPONIBLE`.

## 4. Fichiers

Migrations `20261028100000` à `20261028130000` (et descentes). Backend : `backend/src/teledetection/**`, `backend/src/api-v2/teledetection*.ts`, `lib/modules.ts`, indicateurs et veille. Frontend : `pages/TeledetectionPage.tsx`, `components/observation-terre/*`, `lib/teledetection*.ts`, `pages/geoportail/RechercheZoneTroncon.tsx`. Documentation : `docs/observation-terre/` (contrat, API, modèle de données, sources, frontend).

## 5. Tests réellement exécutés (rejoués par l'orchestrateur)

| Mesure | Résultat |
|---|---|
| Backend (`teledetection`, `api-v2/teledetection`, `securite`, `modules`, `exploitation`, `tableau-de-bord`) | 31 fichiers, 938 tests verts, `tsc` propre |
| Frontend (page, composants, lib, modules, recherche) | 19 fichiers, 616 tests verts, `tsc` propre |
| Banc PostGIS `eo-api` | 86/86 (rejoué trois fois après correction d'une assertion instable : l'ordre d'identifiants UUID aléatoires) |
| Banc PostGIS `eo-workflow` (dont section COMMIT réels) | 163/163 (rapporté par EO-FIX-BACK) |
| Banc `teledetection` | 10/10 |
| Descentes (`verifier.sh`) | 6, 8, 2 puis 2 vérifications, 0 échec, aller-retour à schéma identique |
| Balayage de secrets du dépôt | rouge sur des jetons de page de fixtures et des IP de test, corrigés (jetons retirés, IP assemblées à l'exécution) puis vert |
| Bout en bout navigateur réel contre API et base réelles | voir section 7 |

## 6. Revues indépendantes

Backend : « pas intégrable tel quel, sans bloquant » : deux constats élevés (agrégats de précision visibles d'un compte régional ; preuves citant l'observation d'une autre région avec fuite de description), quatre moyens, tous corrigés et prouvés (tests de reproduction, bancs sur COMMIT réels). 16 mutations sur 18 attrapées à la relecture, les deux survivantes couvertes ensuite.
Frontend : « intégrable avec réserves, sans bloquant » : intégrité des chiffres, états, droits, double envoi, accessibilité (0 violation axe sur 12 vues et 3 largeurs) et 18 mutants sur 18 attrapés. Un constat élevé (l'état « aperçu indisponible » jamais atteint en réel : le corps d'erreur arrive en Blob) est corrigé avec un test sur vrai Blob. La « fuite de nœuds du DOM » signalée est un artefact de mesure (éléments retenus par Playwright) : aucune croissance sur 9 allers-retours une fois la mesure corrigée, identique au Géoportail existant.

## 7. Bout en bout

Harnais `e2e-eo/` (10 specs Playwright, écran réel Vite, API réelle sur le port 3401, clone jetable `essai_eo_e2e` de `essai_eo_workflow`, Chromium réel, aucune interception d'API ; voir `docs/observation-terre/E2E.md`).

**Premier lancement réel (26/10/2026, 7,5 min) : 29 réussis, 8 échecs, 11 non exécutés.** Classement des 8 échecs, avec preuves (captures, traces, lecture du code) :
- 1 défaut d'application, mineur, corrigé : après un verdict définitif, l'écran remplaçait la section d'actions et le message de succès disparaissait (le verdict était bien enregistré : « Confirmées 1 sur 1 jugées »). Deux tests de non-régression, rouges sans le correctif.
- 4 défauts de test, corrigés sans affaiblir d'assertion : la légende « Échelle d'état » contient le mot « Active » (une étape expliquée) que le test comptait comme une source active (les quatre sources réelles sont « non configurée » ou « identifiants requis ») ; deux boutons « Réessayer » voulus et distincts, que le test désignait par sous-chaîne (`exact: true` requis) ; les « cibles trop petites » à 768 et 375 px étaient des contrôles Leaflet, la feuille de style n'étant jamais servie à cause de l'ordre de déclaration des routes de test.
- 2 cascades (specs d'intégrité) : elles dépendent de verdicts produits par des specs interrompues.
Passent en réel : indicateurs, carte, liste, filtres et détail (l'écran égale l'API), aperçu réel, droits (régional limité à sa région, 404 identique hors périmètre, qualité par méthode « absence de permission », inspecteur et lecteur sans bouton d'écriture et refusés par le serveur 403, compte sans module refusé), empreintes SHA-256 des tronçons, portions et ouvrages identiques avant/après avec un témoin.

**Après correction : AUCUN lancement complet n'a abouti.** Quatre relances ont échoué au démarrage (« Port 5410 already in use », « database essai_eo_e2e does not exist » pendant le semis) parce qu'une autre session Claude lançait le MÊME harnais sur le même worktree, avec les mêmes ports et la même base, au même moment. Ce rapport ne prétend donc pas que les 11 specs non exécutées passent, ni que les deux exécutions consécutives vertes sont obtenues. Quatre défauts connus restent déclarés `test.fail` (E2E-EO-1 : 18 propositions sur 42 non dessinées par la carte, les lignes étant comptées illisibles ; E2E-EO-2 : recherche par nom de région ; E2E-EO-3 : `hasModuleAccess` ; E2E-EO-D : jeton de rafraîchissement sans `jti`).

## 8. Exigences du prompt maître : satisfaites ou non

| Exigence | État |
|---|---|
| Recherche de produits auprès d'une source réelle | satisfaite (CDSE et Earth Search, anonyme) |
| Conservation des métadonnées et de la provenance | satisfaite (registre, licence, attribution, empreinte à calculer au téléchargement) |
| Gestion des erreurs et des quotas | partielle : reprise bornée et comptage de requêtes ; aucun 429 réel rencontré, quotas CDSE chiffrés non documentés pour la recherche STAC |
| Récupération d'observations réelles pour une zone pilote | partielle : métadonnées de Boké, aucun pixel |
| Traitement reproductible, détection d'un changement sur acquisitions réelles | **non satisfaite** : aucun traitement raster ; exige un compte CDSE et un conteneur Python (décision d'hébergement) |
| Proposition traçable, sans modification du référentiel | satisfaite et prouvée (empreintes avant/après, témoin) |
| Validation et infirmation par un agent autorisé, journal | satisfaite (cinq statuts, journal exigé sur COMMIT réel) |
| Mesures de qualité fondées sur les verdicts | satisfaite pour le taux de confirmation (formule, seuil d'échantillon 30 provisoire) ; précision et rappel d'une méthode non définis (exige un protocole terrain) |
| Tests de non-régression, de sécurité et de permissions | satisfaite sur le périmètre du module |
| Interface reliée à de vraies données | satisfaite pour l'API et la base ; aucune proposition réelle en production |
| Documentation d'installation, limites, coûts | satisfaite (docs du dossier) ; coûts CDSE gratuits dans les limites documentées |

## 9. Limites scientifiques à dire à l'utilisateur

Sentinel-2 est à 10 m, Sentinel-1 à environ 20 m de résolution réelle, Landsat à 30 m : nids-de-poule et fissures ne sont pas détectables ; grands défrichements, plateformes de chantier, plans d'eau, bâti étendu et pistes larges le sont plausiblement. Ce lot ne détecte rien : la confiance affichée est toujours un indice non calibré.

## 10. Risques restants

Le registre de production est vide et le module n'est pas déployé. La clé de module `teledetection` n'est attribuée à aucun profil (geste d'administration). Les comptes sans rattachement régional sont nationaux (choix du dépôt). La politique de sécurité de `nginx.conf` n'autorise ni Esri ni unpkg (préexistant). `ADD COLUMN ... GENERATED STORED` réécrit la table des propositions sous verrou. Le disque externe F: a disparu deux fois pendant ce lot (veille sur batterie) : tout est commité en local, rien n'est poussé.

## 11. Décisions pour l'architecte

1. Hébergement du traitement raster : conteneur Python dédié (recommandé), alternative Node limitée.
2. Compte CDSE institutionnel, client OAuth Sentinel Hub, rotation des identifiants (intervention humaine).
3. Choix du corridor pilote par critères : disponibilité optique mesurée (Boké en tête), continuité (RN1 Conakry-Mamou), référence locale lacunaire à Boké-Sangarédi.
4. Précision statistique : définir le protocole de référence terrain ; le taux de confirmation n'est pas la précision.
5. Agrégats par méthode réservés aux comptes nationaux (choix du correctif de relecture), correction exceptionnelle des produits par variables de session plutôt que par une route d'administration.
6. Seuils provisoires : échantillon 30, zoom 9, bbox 10 degrés, plafond 300 marqueurs, pondérations de sélection de source.

## 12. Prochaines tâches

Merge avec `lot/03-map-matching` (conflits probables limités : `App.tsx`, `modules.ts`, `schema.prisma`), import local de `leaflet.css` (déjà fait sur la branche principale), `error.middleware.ts` (JSON mal formé en 500 sans code), banc du tableau de bord à mettre à jour, puis Lot 2 : première analyse réelle sur la zone pilote après obtention des identifiants.
