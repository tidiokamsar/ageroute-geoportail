# Blocages, dépendances externes et risques

> Exigé par le § 4 du mandat v2.1. Chaque entrée porte : cause, impact, action requise, qui.
> Le § 3 impose, en cas de blocage, de faire tout le travail préparatoire possible puis de
> **passer au lot suivant non bloqué**.

## Décisions institutionnelles — elles ne se contournent pas techniquement

| # | Blocage | Impact | Action requise | Qui |
|---|---|---|---|---|
| B-01 | **Valeurs de praticabilité** non énoncées par le cahier | `referentiel_praticabilites` est vide ; aucune portion ne peut porter de praticabilité ; T-07 (§ 14.1, priorité M) est bloqué | Arrêter la liste des statuts et leurs critères | AGEROUTE |
| B-02 | **Barèmes de coût sans millésime ni largeur** | Les 9 coûts (350 M à 3,5 Md GNF/km) ne sont ni comparables ni actualisables ; aucune estimation publiable | Fixer l'année de référence, la largeur de chaussée supposée, et approuver | AGEROUTE / FER |
| B-03 | **Rattachement des `RES-nnnn` aux axes régionaux** | Aucun PK régional calculable sur 1 029 segments ; 79 % d'entre eux sont dans des sous-réseaux où les axes ne se devinent pas | Fournir le répertoire du réseau classé ou les arrêtés de classement | AGEROUTE |
| B-04 | **Règle de périmètre hors territoire** | 7 tronçons de RN4 et RN1, 72,0 km, comptent dans les 21 156,6 km publiés | Trancher : ne rien exclure, exclure les 7, ou un seuil de distance | AGEROUTE |
| B-05 | **Arbitrage des 42 doublons géométriques** | Chaque paire est une route enregistrée deux fois (inventaire de juin / import OSM de septembre) ; 2 paires opposent une RN à une « voie résidentielle » | Dire lequel fait foi, par paire ; les 2 paires RN demandent une vérification de terrain | AGEROUTE |
| B-06 | **Référentiel administratif officiel** | La table `regions` porte **11 lignes** dont `Siguiri`, `Beyla` et `Non renseigné`, alors que le § 1.1 énonce 8 régions et 33 préfectures. `limites_admin` niveau 1 porte les mêmes 10 entités et couvre bien le pays (244 785 km²), mais ce n'est pas le découpage officiel annoncé | Confirmer le découpage de référence et la clé de rattachement | AGEROUTE |
| B-07 | **Codification nationale des tronçons** (§ 7.14.1) | Les codes actuels sont hétérogènes (`RN4-OSM-7`, `GNL-OSM-w…`, `RES-857`, `DI 002`) ; aucun n'est aligné sur un classement officiel du type `GN-RN01-T03` | Fournir la codification officielle | AGEROUTE / Ministère |
| B-08 | **Migration des modules contractuels vers DigitalRoad** | `chantiers` (496 lignes), `marches`, `ordres_travaux`, `decomptes` vivent dans le dépôt alors que le § 1.2 les exclut. Gelés (ADR-003), mais leur sort reste ouvert | Décider du transfert et du devenir des 496 chantiers | AGEROUTE |
| B-09 | **Hébergement et résidence des données** (§ 1.1) | Conformité à la loi L/2016/037/AN non établie | Confirmer avec le service juridique | AGEROUTE |
| B-27 | **Les routes communautaires n'existent pas dans le modèle.** `ClasseRoute` porte RN, RR, RU, PISTE, NON_CLASSEE — **aucune valeur `RC`**. Les ≈ 20 000 km annoncés par le § 1.1 n'ont nulle part où être enregistrés | Près de la moitié du réseau national annoncé est hors du modèle de données ; aucune saisie ne peut l'y mettre | Confirmer la nomenclature officielle, puis ajouter la valeur (`ALTER TYPE ADD VALUE`, irréversible) et décider si `RR` devient `RP` (migration sur 1 029 tronçons) | AGEROUTE / Ministère |
| B-28 | **Le réseau régional manque d'un sixième** : 13 295,6 km mesurés contre ≈ 16 000 km de préfectorales annoncés | Soit 2 700 km non saisis, soit une différence de définition entre « régionale » et « préfectorale » | Établir laquelle des deux | AGEROUTE |

## Accès et outillage manquants

| # | Blocage | Impact | Action requise | Qui |
|---|---|---|---|---|
| B-10 | **Aucune chaîne Android** sur le poste de travail : ni `adb`, ni `gradle`, ni `java` | Aucun APK compilable ni testable ici. Les livrables mobiles du § 7.8 s'arrêtent au code source et aux instructions | Fournir un poste outillé ou une CI Android | AGEROUTE / DSI |
| B-11 | **Aucun accès aux API DigitalRoad** | Les contrats du § 7.10 ne peuvent être qu'implémentés avec des bouchons testés, jamais vérifiés | Documentation et accès de recette | AGEROUTE / éditeur |
| B-12 | **Aucun accès SharePoint / Entra ID** | La fédération OIDC du § 7.10 reste théorique | Accès de recette et confirmation du fournisseur d'identité | AGEROUTE / DSI |
| ~~B-13~~ | ✅ **LEVÉ le 14/10/2026.** Docker Desktop démarré sur le poste, base `postgis/postgis:17-3.5` isolée sur `127.0.0.1:5434` — la même image que la production. PostgreSQL 17.5, PostGIS 3.5 | **Le § 9.4 est satisfait pour la migration en attente** : descente exécutée et remontée vérifiée, 20 objets → 0 → 20, états identiques. Au 14/10 il restait que 50 migrations sur 51 n'avaient aucun script de descente : **réglé le 22/10/2026**, 69 descentes pour 69 migrations, vérifiées par le banc `verifier.sh` (238 vérifications, 0 échec), limites dans `backend/prisma/descentes/README.md` | — | — |
| **B-16** | **La chaîne de migrations ne se rejoue pas sur une base vierge.** Mesuré le 14/10 : **49 des 51** passent ; `20260702140000_decomptes` échoue (`marcheId` en `uuid` contre `marches.id` en `text`), et la suivante par ricochet. Le `CREATE TABLE IF NOT EXISTS` de la migration de `marches` a masqué la divergence. **Mesure du 22/10 : avec la seule conversion de `marches.id` en `uuid` (un « pont », hors historique), les 69 migrations s'appliquent** : le défaut est localisé sur `marches`, et reste à arbitrer (D-10) | **Aucun environnement neuf ne peut être monté par `migrate deploy`.** La reprise après sinistre repose entièrement sur `pg_dump` — les archives ne sont plus un filet, elles sont le seul chemin | Arbitrage **D-10**. Le corriger exige une écriture dans `_prisma_migrations` en production, car Prisma vérifie une empreinte par fichier | AGEROUTE / DSI |
| B-14 | **Signature de production et comptes stores** | Pas de distribution possible | Compte Play Console ou MDM | AGEROUTE |
| B-15 | **Imagerie haute résolution** (§ 1.1) | Les fonds imagerie du § 7.14 se limitent aux sources libres | Dépense à autoriser si l'imagerie commerciale est voulue | AGEROUTE |

## Risques de sécurité ouverts

Mesurés le 13/10/2026, consignés dans `../rai-v3/AUDIT_SECURITE_DEPOT_PUBLIC.md`.
**Un seul des cinq est traité.**

| # | Risque | État |
|---|---|---|
| B-16 | Compte de test détenant `ADMIN` en production | **traité** le 13/10, rétrogradé et audité |
| B-17 | **Dépôt public** portant une IP de serveur de production et un chemin de clé de sauvegarde | **ouvert** — `AGENTS.md` règle 1 l'interdit |
| B-18 | **Mot de passe ADMIN** transmis en clair, jamais changé | **ouvert** |
| B-19 | **`bdri_app` est SUPERUSER PostgreSQL et le seul rôle de connexion** | **ouvert** — réduire ses privilèges sans rôle de secours couperait le service. L'ordre est contraint : créer le rôle de secours d'abord |
| B-20 | **Quatre comptes `ADMIN` actifs** en production | **ouvert** — à revoir au titre du moindre privilège |
| B-21 | Clé de chiffrement des sauvegardes sans copie hors serveur | **ouvert** — une sauvegarde dont la clé vit sur la machine sauvegardée n'est pas une sauvegarde |

## Risques techniques

| # | Risque | Nature |
|---|---|---|
| B-30 | **Affichage des tuiles vectorielles** : Leaflet ne lit pas le format MVT sans greffon (Leaflet.VectorGrid) ou sans changer de moteur (MapLibre GL JS) | les tuiles sont servies et éprouvées (22/10), mais aucun écran ne les affiche ; la carte continue de recevoir le GeoJSON simplifié. **Décision attendue** : autoriser une dépendance d'exécution du frontend (le 20/10, seules des dépendances de développement ont été autorisées). Recommandation technique : `leaflet.vectorgrid` garde le moteur actuel et les permaliens ; MapLibre apporterait le rendu WebGL au prix d'une réécriture de la carte |
| B-22 | **Dérive Prisma préexistante** : `limites_admin` et 13 index créés en SQL brut ne figurent pas dans `schema.prisma` | `prisma migrate dev` proposerait de les supprimer. **Ne jamais le lancer contre une base portant des données.** Seul `migrate deploy` est admis |
| B-23 | **`main` est en retard de 58 commits** sur ce qui tourne en production | La production sert du code absent du tronc. Fusionner est une décision du commanditaire ; le § 2.5 interdit par ailleurs tout commit direct sur `main` |
| B-24 | ~~Aucune intégration continue~~ — **j'avais tort**. `.github/workflows/ci.yml` existe. Son défaut réel : elle ne se déclenchait que sur `push: branches: [main]` et sur les PR, or le § 2.5 impose une branche par lot et interdit les commits sur `main` — **un push sur `lot/01-socle` ne déclenchait rien** | **traité au lot 1** : déclencheurs étendus à `lot/**`, `deploy/**`, `phase*`, `audit/**`, plus deux contrôles locaux (dossiers de migration complets, scan de secrets) |
| B-25 | ~~Migrer les `$queryRawUnsafe` restants~~ — **ma formulation était fausse**. Examen du 14/10 : **trois** usages subsistent et **aucun n'interpole de valeur d'appelant**. `geo/appariement.ts` passe ses valeurs en paramètres positionnels ; `lib/reseau.ts` n'a aucun paramètre ; `lib/geo.ts` interpole un nom de table — ce qu'aucun paramètre SQL ne peut faire — sous liste blanche qui lève une exception. `troncons.service.ts` compose déjà correctement avec `Prisma.raw` dans un gabarit | **traité autrement au lot 1** : réécrire serait du brassage à risque de régression pour un gain nul. Une **garde testée** (`lib/sql-parametre.test.ts`, 6 tests) impose désormais qu'un fichier employant `$queryRawUnsafe` figure dans une liste justifiée, et qu'une justification invoquant une garde la trouve réellement dans le fichier. Ce test aurait attrapé ma violation du matin |
| B-29 | ~~**Le script `lint` du frontend n'a jamais pu fonctionner**~~ **LEVÉ le 20/10/2026** : eslint 9.39.5 et sa configuration plate installés (autorisation du 20/10), 60 erreurs corrigées (45 libellés non associés à leur champ, tiroir mobile sans fermeture au clavier, nom accessible manquant sur le code de double authentification…), lint ajouté à la CI. 4 avertissements `exhaustive-deps` laissés à dessein | `eslint` n'est pas une dépendance déclarée du projet et aucun fichier de configuration n'existe ; sous eslint 9+ il échoue en réclamant une configuration « plate ». Le backend n'a aucun eslint | Décider s'il faut une configuration plate et typescript-eslint, puis traiter les violations. **Non ajouté à la CI** : il y ferait échouer chaque build pour un outil que le dépôt n'installe pas |
| B-26 | **Aucun jeu de données de test** | Le § 2.1 coupant l'accès à la production, les points GPS annotés exigés par A2 et A18 deviennent indispensables pour éprouver quoi que ce soit |
