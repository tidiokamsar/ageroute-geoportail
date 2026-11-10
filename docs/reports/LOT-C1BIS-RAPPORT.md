# Lot C1 bis : scénarios de bout en bout multi-territoires (Playwright) du module « Projets de voirie et réseaux »

Date : 10/11/2026. Worktree `C:\ageroute-secours\w-e2e`, branche `test/e2e-module-voirie` (lot C1, puis fusion de `feat/vague3-integration` à `207b79c`). Agent : Claude (Opus 5.5). Références : `C:\ageroute-secours\mandat\PROMPT-MAITRE-V2.txt` (section TESTS), `C:\ageroute-secours\mandat\DECISION-ARCHITECTURALE-2.md` (sections 2 à 8 et précisions T1, T1+S1), contrats `CONTRAT-TERRITOIRES.md`, `CONTRAT-SOURCES.md`, `CONTRAT-DOCUMENTS.md`, `CONTRAT-EXPORTS.md`, `API.md` et le code réel des routes. Périmètre : **tests et outillage de test seulement** ; aucun fichier de `backend/src` ni de `frontend/src` n'a été modifié ; aucun push, aucun déploiement, aucun accès à la production, aucun réseau sortant.

## 1. Ce qui a été fait

### 1.1 Outillage (commit `082ae8f`)

| Fichier | Ajout |
|---|---|
| `e2e/lib/voirie.ts` | `creerProjet` rattache le projet à un territoire (obligatoire depuis T1) : la nation par défaut, un territoire de niveau REGION créé par un ADMIN dédié quand seul `regionId` est donné ; `creerTerritoire`, `territoireNational`, `territoireDeRegion` passent par l'API (`POST /territoires`, écriture ADMIN auditée), jamais par la base ; `comparer` (respecte la cadence 429 comme `analyser`) ; `getBinaire` (archive ZIP) ; `pdfSynthetique`, `dwgSynthetique` (pièces inventées : une page PDF vide, la seule signature `AC1032`) ; `attendreQue` (effet consigné après la réponse) ; champs `methode`, `typeReseauCode` et `classe: null` de l'assistant. |
| `e2e/lib/voirie-geo.ts` | `boiteWgs84`, `polygoneDeBoite` (emprises synthétiques en mètres locaux, converties par l'oracle de Krüger) ; `lireZip`, lecteur ZIP **indépendant de l'application** (répertoire central, stocké et deflate, CRC vérifié, noms dangereux refusés). |
| `e2e/global-setup.ts` | Le projet de préchauffage porte la nation ; la page `/projets-voirie/parametres` est préchauffée. |
| `e2e/scripts/lancer-api.ts` | `PROJETS_VOIRIE_COMPARAISON_INTERVALLE_S=3` (défaut 60 s), même raisonnement que la cadence des analyses du lot C1 : la cadence reste **active**, le client la respecte. Aucune autre valeur du module n'est touchée. |

### 1.2 Spécifications (commits `9b07556`, `e8c10c8`, `2f39b2b`, `68306d2`, `340b42c`)

| Fichier | Scénario de la consigne | Tests | Mode |
|---|---|---|---|
| `specs/17-voirie-territoires.spec.ts` | a (nouvelle ville sans code), b (corridor interpréfectoral), f (tableaux de bord) | 6 | navigateur + API |
| `specs/18-voirie-sources.spec.ts` | c (multi-sources) | 4 | navigateur + API |
| `specs/19-voirie-documents.spec.ts` | d (documents) | 4 | API (aucun écran) |
| `specs/20-voirie-export.spec.ts` | e (export du dossier technique) | 4 | API (aucun écran) |
| `specs/21-voirie-accessibilite.spec.ts` | g (accessibilité) | 3 | navigateur |

Données **100 % synthétiques** : noms « synthétique » suivis d'un suffixe tiré au hasard, codes `E2E-…`, types de réseau `FIBRE_SYNTH_…`, concessionnaires « Operateur synthetique … », géométries inventées en mètres autour de l'origine arbitraire du lot C1 ; aucun nom de ville réelle n'est créé (seule la nation « Guinée » de la migration est utilisée comme parent), aucune coordonnée de réseau réel, aucun fichier des dossiers `Downloads` lu.

Ce que chaque scénario prouve, en se fiant à la **base** et à l'API, pas seulement à l'écran :

**a. Nouvelle ville sans code (17, trois tests).** Un ADMIN ouvre « Paramètres du module » depuis la liste ; onglet Territoires ; « Sous-territoire de Guinée » : crée une région (rattachée à une région administrative créée pour l'essai), puis, par la recherche, une préfecture sous elle, puis une commune sous la préfecture avec une emprise approximative saisie par ses quatre bornes. En base : parent, niveau, profondeur 1, 2, 3, **région effective propagée** de la région à la préfecture et à la commune (qui n'ont pas de région propre), emprise présente, auteur ; audit `TerritoireVoirie` `CREATE` par l'ADMIN pour chacun, **sans coordonnée** ; référentiel officiel et tronçons inchangés. Un gestionnaire de cette région crée un projet par le sélecteur (le territoire d'une autre région n'y est pas proposé) : région, commune et préfecture **dérivées** du territoire (aucune saisie). Dépôt d'axes et d'un réseau dans l'emprise (aucun `ELEMENTS_HORS_TERRITOIRE`), autorisation, analyse 2D (`EPSG:32629`, règle nationale par bandes), analyse persistée et dossiers de conflit ; un jeu à 3 km, hors de l'emprise approximative mais dans le pays, est **signalé et conservé** (1 objet). L'ADMIN impose ensuite `EPSG:32628` à la commune dans l'écran : l'analyse suivante calcule en `EPSG:32628`. Un compte d'une **autre région** : dix lectures (projet, jeux, analyse, conflits, sources, complétude, documents, deux territoires, tableau du territoire) répondent 404 avec **exactement le même corps** qu'une ressource inexistante ; dépôt, analyse et création d'un projet sur la commune refusés (la création répond comme pour un territoire inexistant) et rien n'est écrit ; les listes ne portent ni le projet ni les trois territoires ni la nation ; son tableau national ne porte que sa région ; l'écran du projet dit « introuvable » sans montrer le code ni la commune.

**b. Projet linéaire (17, deux tests).** Une région, trois préfectures adjacentes (emprises de 10 km x 4 km) et un corridor de niveau `ZONE` **frère** des préfectures, dont l'emprise les traverse toutes (`ST_Intersects`, vérifié en base) ; région effective dérivée. Deux projets sur le même corridor, emprise/chaussée 30/12 m et 20/8 m, un troisième dans la préfecture du milieu : commune et préfecture **nulles** pour les projets du corridor (rien n'est inventé). Même axe de 28 km et même câble parallèle à 5 m : la chaussée de 12 m le compte en chaussée (plus de 990 m), celle de 8 m non (0 m) mais dans l'emprise de 20 m. Filtre `?territoireId=` : le corridor donne ses deux projets, la préfecture traversée seulement le sien (le corridor n'est pas sous elle), la région les trois ; la fiche porte le corridor. Dans l'écran, « Filtrer par territoire » sur le corridor montre ses deux projets et pas celui de la préfecture, puis « Retirer le filtre ».

**c. Multi-sources (18, quatre tests).** Un ADMIN crée deux types configurables `TYPE_RESEAU` de la même famille ; un concessionnaire créé par son code de type (famille dérivée). Une méthode d'acquisition absente du référentiel est refusée au dépôt (422 `METHODE_ACQUISITION_INCONNUE`). Source A (`GNSS_RTK`, 0,5 m) ; un second type de la même famille, même concessionnaire : **autre réseau** (version 1, rien de remplacé ; comparer A à lui : 409 `JEUX_NON_COMPARABLES`, motif `RESEAU_DIFFERENT`). Pour le lecteur, chaque réseau est « Source unique : comparaison indisponible », « C'est l'état normal », sans alerte ni bouton. Source B du même réseau (`NUMERISATION_PLAN`, 1 m) en quarantaine : nouvelle **source** (version 1, pas une version de A) ; pour un lecteur, rien de B (ni identifiant ni nom de fichier dans les sources, la liste des jeux ou la carte, 403 sur la quarantaine), le réseau reste à source unique ; le décideur ne peut pas comparer A à B tant que B n'est pas autorisé (409). B autorisée : A **reste** autorisée, le réseau est `COMPARABLE`, la complétude rend `COMPARAISON_SOURCES` disponible. Dans l'écran (gestionnaire) : « Comparer deux sources », « Lancer la comparaison », résultats par objet ; en base : mode `SOURCES`, A = le dépôt le plus ancien, algorithme `S1-CORRIDOR-UTM-1`, `EPSG:32629`, S1 `CONCORDANCE` (Hausdorff 0,3 m), S2 `DIVERGENCE` (corridor 2 m = max(0,5 ; 1) + 1, Hausdorff 3 m, part hors corridor 1), S4 `SANS_CORRESPONDANCE_A`, S5 `SANS_CORRESPONDANCE_B`. « Ouvrir un dossier de divergence » est inactif sans justification, puis ouvre un dossier `DIVERGENCE_SOURCES` `A_INVESTIGUER` ; doublon 409 `DOSSIER_DEJA_OUVERT`, concordance 409 `RESULTAT_NON_DIVERGENT`, lecteur 403. **Empreinte des géométries des deux jeux identique avant et après** (rien de modifié ni de fusionné), aucun ordre, référentiel intact, audit sans géométrie. Version candidate de B (même méthode : version 2) comparée avant autorisation (`VERSION_CANDIDATE`, A = B v1) : pour le lecteur, la comparaison et ses objets répondent 404 comme une comparaison inexistante, sa liste ne porte que la comparaison des deux sources autorisées, la candidate n'apparaît ni dans l'API ni dans l'écran, aucun bouton d'écriture.

**d. Documents (19, quatre tests, API).** Projet vide : seules les fonctions sans condition sont disponibles (`EXPORT_DOSSIER`) ; la pièce « plan d'axes » dit les fonctions qu'elle exige et qu'elle ne suffirait pas seule. Projet aux axes et réseau autorisés : deux documents `ATTENDU` (types du référentiel), un PDF déposé sur l'un (`RECU`, format `PDF`, empreinte et taille exactes, avertissement `PDF_REFERENCE`), un DWG (`RECU`, `exploitable.possible = false`, `DWG_NON_EXPLOITABLE`, `EXPLOITABLE` refusé 409 `DOCUMENT_NON_EXPLOITABLE`) ; aucune colonne d'octets dans la table ; à l'import, le PDF répond 422 `CONTENU_NON_RECONNU` et le DWG 415 `FORMAT_NON_SUPPORTE` (aucun jeu créé) ; un faux PDF 415 `FORMAT_DOCUMENT_NON_PRIS_EN_CHARGE`. Séparation des tâches : le déposant passe la pièce en analyse puis exploitable, mais **ne la valide pas** (409 `SEPARATION_DES_TACHES`) ; un second gestionnaire la valide (en base `deposeParId` ≠ `valideParId`) ; historique écrit par la base, audit `CREATE`, `UPDATE`, `VALIDATE` sans contenu de fichier. Complétude : `ANALYSE_2D` et `CONFLITS` **disponibles** malgré la pièce attendue et le DWG inexploitable, `SECONDE_SOURCE` suffirait pour `COMPARAISON_SOURCES`, le document attendu ne rend indisponible aucune fonction qui l'était ; l'analyse persistée tourne (201). Lecteur : seul le PDF `VALIDE` ; DWG et pièce attendue en 404 identiques à l'inexistant ; aucun document en cours compté ; aucune écriture.

**e. Export du dossier technique (20, quatre tests, API).** L'archive est **relue** par `lireZip` : en-têtes (`Content-Disposition`, `X-Export-Id`, `X-Fichiers`, `X-Jeux-Geojson`), `X-Empreinte-Sha256` = SHA-256 des octets reçus, chaque fichier du manifeste présent avec sa taille et son empreinte, `manifeste.sha256` vérifié ligne à ligne (manifeste compris), fichiers attendus présents, PDF de la fiche. GeoJSON : **le plan d'axes seulement** ; le réseau `CONFIDENTIEL_CONCESSIONNAIRE` est écarté (`CONFIDENTIALITE`), le jeu en quarantaine aussi (`NON_AUTORISE`) ; coordonnées identiques à l'oracle synthétique, propriétés limitées à `objetId`, `nom`, `typeGeom`, `longueurM`, `ordre` (aucun attribut source) ; journal `REMIS` avec l'empreinte. Lecteur : 403 sur l'export, le journal et les dérogations ; un gestionnaire ne déroge pas (403). Dérogation : l'ADMIN ne se l'accorde pas (409 `SEPARATION_DES_TACHES`) ; inutile pour un jeu exportable (409 `DEROGATION_INUTILE`) ; refusée pour un jeu en quarantaine (409 `JEU_NON_AUTORISE`) ; justification courte 400 ; accordée au gestionnaire bénéficiaire. Citée par l'ADMIN ou par un autre gestionnaire : 404 identique à une dérogation inconnue, rien consommé. Le bénéficiaire exporte : le réseau confidentiel est dans l'archive, `derogation: true` au manifeste et au GeoJSON (6 objets) ; la dérogation passe `UTILISEE` (avec l'identifiant de l'export) ; **second usage : 409 `DEROGATION_INDISPONIBLE`, état `UTILISEE`** ; sans dérogation, le réseau est de nouveau écarté ; une seule ligne d'export porte la dérogation en base ; audits de la dérogation et des remises sans géométrie, avec l'empreinte de l'archive. `geojson=false` : aucun GeoJSON ; la fiche JSON porte l'empreinte du fichier d'origine, les jeux non retirés, ni `resume` ni avertissements.

**f. Tableaux de bord (17, un test, API).** Tableau du territoire (région du corridor) pour un gestionnaire national : 3 projets (sous-arbre), jeux `AUTORISE` 4 et `CONTROLE` 1, 0 projet rattaché directement, agrégats par enfant (corridor 2, préfecture du milieu 1, autres 0), pièces en attente et référents présents, **aucun nom** de fichier, d'objet ni de concessionnaire. Lecteur national : `AUTORISE_SEULEMENT`, aucun autre statut de jeu compté, pièces en attente et référents nuls. Tableau national : la région porte ses 4 projets. Gestionnaire régional : son périmètre seulement (une région), même total ; tableau du corridor : 2 projets. Un paramètre : 400. Compte d'une autre région : 404 masqué (scénario a).

**g. Accessibilité (21, trois tests).** axe-core 4.14.0 (celui du frontend) dans Chromium, WCAG 2.0/2.1 A et AA, **contraste compris**, carte Leaflet exclue : Paramètres (onglets Territoires, Référentiels, Configuration nationale ; dialogue de création d'un territoire en mode « bornes » ; navigation au clavier des onglets), liste des projets avec le filtre par territoire ouvert, dialogue de création d'un projet (sélecteur, puis erreur « territoire obligatoire » annoncée), onglet Sources (source unique, puis comparaison et résultats, puis dialogue d'ouverture d'un dossier, refermé sans écriture). La fiche n'a que cinq onglets (Analyse, Couches, Conflits, Réseaux, Sources) : **aucun écran** de documents, d'export ni de tableau de bord n'existe à parcourir.

### 1.3 Ce qui n'a pas d'écran (couvert par l'API, comme demandé)

Le lot UI-C a livré l'administration des territoires, des référentiels et de la configuration, le sélecteur de territoire et l'onglet Sources, mais **pas** d'écran pour les documents du projet et la complétude (D1), ni pour l'export du dossier et les tableaux de bord (X1) (`docs/reports/LOT-UIC-RAPPORT.md`, section D, point 2). Les scénarios d, e et f sont donc des tests d'API contre la vraie base, et le test g le constate sur la fiche du projet.

## 2. Exécution : chiffres réels

Poste partagé avec d'autres travaux ; aucun garde-fou n'a été relâché (aucune reprise, `retries: 0`, délais du harnais inchangés, `E2E_FACTEUR_DELAI` non défini) ; seule la cadence des comparaisons a été ramenée à 3 s (section 1.1).

| Lancement (mode normal : base `essai_e2e` recréée, API et Vite relancés par Playwright) | Résultat | Durée des tests |
|---|---|---|
| Mise au point : `11`, `12` (après correction) et `17` à `21`, premier lancement | 31 réussis, 1 échec : mon test d'accessibilité attendait la clé `EMPRISE_PLAUSIBILITE` à l'écran, qui affiche un libellé humain (corrigé : il attend les quatre fiches de configuration) | 8,3 min |
| Mise au point : `21` seul | 3 réussis | 2,7 min |
| **Passage complet 1** (suite entière : `01` à `08`, `session-hors-ligne`, C1 `10` à `16`, C1 bis `17` à `21`) | **112 réussis, 0 échec, 0 ignoré, 0 instable** ; dont C1 bis 21 réussis | 37,9 min (murale 38,1 min, préchauffage de Vite 72 s) |
| **Passage complet 2**, consécutif | **112 réussis, 0 échec, 0 ignoré, 0 instable** ; dont C1 bis 21 réussis | 35,8 min (murale 36,2 min, préchauffage 93 s) |

Les 21 tests C1 bis sont passés du premier coup au premier lancement, à l'exception du test d'accessibilité ci-dessus : aucune erreur de test due à un libellé ou à une forme de réponse supposée, les contrats `CONTRAT-*.md` et `API.md` décrivant fidèlement le code (vérifié en lisant les routes avant d'écrire les tests).

## 3. Vérification par mutation des gardes du lot C1 bis

Même méthode que le lot C1, le 10/11/2026 : une mutation à la fois dans le code de l'application, motif présent une seule fois exigé, **mode normal** (base recréée, API relancée par Playwright sur le code muté), puis fichier remis par `git checkout` et `git status` vide vérifié sur le fichier (consigné dans chaque journal) ; arbre propre à la fin ; **aucune mutation commitée**.

| Garde visée | Mutation | Spécification lancée | Résultat |
|---|---|---|---|
| **Périmètre territorial** | `backend/src/projets-voirie/territoires/territoires.service.ts`, `filtrePortee` : `(portee === null ? {} : { regionEffectiveId: { in: [...portee] } })` devient `({})` (la liste des territoires ignore les régions du compte) | `17` | **échec détecté** : dans le sélecteur de création, le gestionnaire régional voit le territoire d'une autre région (« Aucun territoire ne correspond » attendu) ; 1 réussi, 1 échec, 4 non exécutés (série) |
| **Masquage du jeu B** non autorisé | `backend/src/projets-voirie/sources/comparaison.service.ts`, `comparaisonVisible` : `if (!dossierVisible(...)) throw COMPARAISON_INTROUVABLE()` devient `if (false && ...)` (un lecteur lit une comparaison dont un jeu est en quarantaine) | `18` | **échec détecté** : le lecteur reçoit **200** sur la comparaison de la version candidate, au lieu de 404 identique à l'inexistant ; 3 réussis, 1 échec |
| **Usage unique de la dérogation** (consommation) | `backend/src/projets-voirie/exports/dossier.service.ts`, remise : la mise à jour qui consomme la dérogation reçoit `WHERE false AND ...` (la dérogation n'est jamais consommée) | `20` | **échec détecté** : après la remise, la dérogation est encore `DISPONIBLE` au lieu de `UTILISEE` ; 2 réussis, 1 échec, 1 non exécuté |
| Usage unique (vérification de l'état, défense en profondeur) | `backend/src/projets-voirie/exports/confidentialite.noyau.ts`, `verifierDerogationCitee` : le refus d'une dérogation non disponible est retiré | `20` | **échec détecté**, mais **l'usage unique tient** : le second usage est toujours refusé (409 `DEROGATION_INDISPONIBLE`) par la réservation conditionnelle en base (`"utiliseeLe" IS NULL`), avec l'état `RESERVEE` au lieu de `UTILISEE` ; aucune seconde archive n'est remise. Le test le détecte parce qu'il exige l'état exact |

Contrôles négatifs intégrés aux tests (toujours actifs) : un territoire inexistant comme témoin de chaque 404 masqué ; la comparaison et le dossier lus par le lecteur seulement quand les deux jeux sont autorisés ; l'export sans dérogation après la consommation.

## 4. Défauts de l'application constatés

**Aucun défaut de l'application n'a été constaté par ces scénarios** : aucun `test.fixme` n'a été nécessaire. Les comportements décrits par les contrats T1, S1, D1 et X1 (et leurs correctifs de revue) sont ceux que l'on observe de bout en bout, dans le navigateur et contre la vraie base.

Écarts et observations (pas des défauts au sens du contrat) :

| Réf. | Constat | Où |
|---|---|---|
| C1B-O1 | **Pas d'écran** pour les documents du projet et la complétude, l'export du dossier technique, ni les tableaux de bord : la décision architecturale 2 (section 10) confiait au lot UI-C « documents du projet, comparaison, tableau de bord, export » ; UI-C n'a livré que la comparaison et les territoires (son rapport, section D, point 2). Ces fonctions ne sont utilisables que par l'API. | `docs/reports/LOT-UIC-RAPPORT.md` ; scénarios d, e, f couverts par l'API |
| C1B-O2 | La dérogation et l'export étant sans écran, un gestionnaire bénéficiaire ne peut ni voir qu'une dérogation lui est accordée, ni la citer, sans outil tiers. | idem |
| C1B-O3 | Sous mutation seulement (voir aussi O-5 du rapport C1) : quand la vérification de service d'une dérogation est retirée, la base refuse encore le second usage, avec l'état `RESERVEE` au lieu de `UTILISEE` ; message moins exact, sécurité intacte. | section 3 |
| C1B-O4 | La cadence des comparaisons (60 s entre deux comparaisons terminées d'un projet) impose une minute d'attente entre la comparaison des sources et celle d'une version candidate du même projet ; le harnais la ramène à 3 s. À mesurer avec les utilisateurs avant de la garder. | `PROJETS_VOIRIE_COMPARAISON_INTERVALLE_S` |

## 5. Ce qui n'a pas été exécuté, et pourquoi

- Le projet Playwright `build` (`@froid`) : `E2E_SANS_BUILD=1`, il ne concerne pas le module.
- Dessin d'emprise sur la carte (mode « Dessiner un rectangle ») : la saisie par bornes a été parcourue ; le dessin dépend de tuiles refusées par le harnais.
- Référentiels créés par l'écran : les types de réseau sont créés par l'API ADMIN (l'onglet Référentiels est parcouru par axe, pas en écriture).
- Règles de rapprochement à barème approuvé (séparation des tâches de l'approbation) : couvertes par les bancs du lot S1, pas ici.
- Corridor interrégional sous la nation (décision encore attendue du DSI, `CONTRAT-TERRITOIRES.md`, section 4) ; connectivité `CONNECTE_A` ; LandXML ; conversion GDAL (désactivée par défaut) ; `GET /territoires/comptes`.
- Dérogation expirée (durée minimale d'une heure : non attendue en temps réel) et deux consommations concurrentes (couvertes par le banc d'intégration X1).

## 6. Sécurité, données, périmètre

- Aucune donnée réelle ; aucun nom de ville, de concessionnaire ni de coordonnée réelle ; seule la nation de la migration sert de parent.
- Aucun secret dans le dépôt : comptes et mots de passe tirés au hasard (dans `%TEMP%\bdri-e2e\run.json` et en mémoire) ; mot de passe du conteneur jetable lu par `docker inspect` par le harnais (`E2E_PG_CONTENEUR=e2e-c1-db`, `E2E_PG_PORT=5479`), jamais affiché ni écrit.
- Seule base touchée : `essai_e2e` (et `replay`, refaite par `fabriquer-replay.sh`) du conteneur jetable `e2e-c1-db` ; `bdri-dev-db` et `v3-postgis` non touchés.
- Sorties (traces, captures) dans `%TEMP%\bdri-e2e\sorties`, hors dépôt. Fichiers créés sans octet NUL, fins de ligne LF.

## 7. Décisions à prendre (DSI, coordinateur)

1. **Écrans manquants** (C1B-O1, C1B-O2) : programmer un lot d'interface pour les documents et la complétude, l'export du dossier (avec la citation d'une dérogation par son bénéficiaire) et les tableaux de bord, ou acter que ces fonctions restent réservées à l'API dans un premier temps.
2. **Corridor interrégional** sous la nation (visible des seuls comptes nationaux) : toujours à confirmer (non testé).
3. **Cadence des comparaisons** (C1B-O4) : garder 60 s ou la réduire.
4. **Niveaux exportables** (`RESTREINT_PROJET` compris par défaut) : le test le fige tel quel ; à confirmer par le DSI (`CONTRAT-EXPORTS.md`, 4.3).

## 8. Commits

Au-dessus de `b45bd0e` (fusion de la vague 3) : `082ae8f` (outillage), `9b07556` (17), `e8c10c8` (18), `2f39b2b` (19), `68306d2` (20), `340b42c` (21), puis le commit de ce rapport (avec le rapport C1 complété). Aucun push.
