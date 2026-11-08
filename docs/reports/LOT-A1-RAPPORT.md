# Rapport du lot A1 : formats d'import simples, choix du CRS, inventaire des couches et mapping de champs (backend)

Module « Projets de voirie et réseaux », Console BDRI, AGEROUTE Guinée. Date : 08/11/2026. Branche `feat/import-formats-simples` (issue de `feat/rc3-integration`), worktree `C:\ageroute-secours\w-a1-import`. Aucune donnée réelle (Orange, MC GROUPE, plan de Kissidougou) n'a été lue ni copiée : toutes les fixtures sont synthétiques, créées pour ce lot. Aucun push, aucun déploiement, aucun accès au serveur de production, disque F: non touché.

Contrat écrit et commité **avant** le code : `docs/projets-voirie/CONTRAT-IMPORT.md` (commit `715db87`), pour l'agent d'interface (lot A2).

## 1. Agents et méthode

Un seul agent (ce lot), sans sous-agent : le lot est un enchaînement de dépendances (types partagés, noyau pur, services, routes, bancs). Chaque comportement a un test ; les protections critiques ont été vérifiées par **mutation** (voir 5.4).

## 2. Ce qui est fait

| # | Mission | État |
|---|---|---|
| 1 | KMZ : archive ZIP bornée | **fait et testé** (lecture du répertoire central sans décompression, zip-slip, chemins absolus et antislash, liens symboliques, entrées spéciales, chiffrement, méthodes, doublons, archives imbriquées, taille décompressée par entrée et totale, taux de compression, recouvrement des données, profondeur, nombre d'entrées, CRC et taille vérifiés ; seule l'entrée KML principale est décompressée, en mémoire ; plusieurs KML : inventaire puis choix `entreeKml`) |
| 2 | CSV/TSV/TXT | **fait et testé** (encodage UTF-8/UTF-16 avec BOM reconnu, tout autre octet : `ENCODAGE_AMBIGU` sauf déclaration ; délimiteur détecté seulement s'il est le seul cohérent, sinon `DELIMITEUR_AMBIGU` ; virgule décimale ; colonnes X/Y ou WKT désignées par l'utilisateur ; CRS explicite obligatoire ; bornes lignes, colonnes, cellule ; injection de formules sans effet ; points, lignes par clé d'axe avec colonne d'ordre numérique, WKT) |
| 3 | GPX | **fait et testé** (waypoints, routes, traces à segments ; XML sans entité via `xml.noyau.ts` ; horodatages et précisions ignorés et signalés, sauf le `time` d'un waypoint conservé en attribut) |
| 4 | CRS source en liste blanche, `ST_Transform`, plausibilité | **fait et testé sur PostGIS réel** (liste blanche configurable, défaut 4326, 32628, 32629 ; transformation par la base ; `resume.crs` complet dans l'aperçu, la simulation, le dépôt, la fiche du jeu et l'audit ; contrôle de zone avec confirmation explicite ; CRS manquant, ambigu, hors liste ou incohérent : erreur typée ; cas obligatoire plan UTM 29N contre KML WGS 84 avec fixtures synthétiques) |
| 5 | Inventaire des couches, aperçu borné, mapping, statistiques, validation géométrique | **fait et testé** (inventaire sans coordonnées contrôlées ; aperçu en transaction `READ ONLY`, échantillon de 20 objets au plus, jamais tout le fichier ; mapping à liste blanche de champs cibles ; statistiques ; rapport par objet borné à 50 : `ST_IsValid`, vide, auto-intersection ; éléments écartés avant la base : hors zone, coordonnées invalides) |
| 6 | Quarantaine, delta, idempotence, rollback | **fait et testé** (statuts du socle inchangés, `sha256` => 409 `JEU_DEJA_CHARGE` conservé ; delta détaillé ajoutés/modifiés/retirés/identiques ; **les suppressions ne sont jamais appliquées sans revue humaine** : 409 `SUPPRESSIONS_A_REVOIR` à l'autorisation, revue auditée ; retour arrière d'une version, sans perte, audité) |
| 7 | Conservation du fichier d'origine | **fait et testé** derrière `PROJETS_VOIRIE_CONSERVER_ORIGINAL` (défaut `non` = comportement du socle : empreinte et taille seules) ; décision de rétention à prendre (section 9) |
| 8 | Traitement hors processus | **non construit, par décision** : aucune file ni worker réutilisable dans le dépôt (`backend/src/jobs/` = deux planificateurs `setInterval`) ; plafonds stricts synchrones, budgets de temps du socle respectés ; contrat d'un futur job documenté (`CONTRAT-IMPORT.md` section 13) |
| 9 | Contrat d'API | **fait** : `CONTRAT-IMPORT.md` commité en premier ; `API.md` et `docs/securite/CONTROLE-ACCES.md` mis à jour ; `CONTRAT.md` annoté |

## 3. Routes (6 ajoutées, toutes `ADMIN` et `GESTIONNAIRE`, lectures comprises)

`GET /:id/import/options`, `POST /:id/import/inventaire`, `POST /:id/import/apercu`, `GET /:id/jeux/:jeuId/delta`, `POST /:id/jeux/:jeuId/revue-suppressions`, `POST /:id/jeux/:jeuId/retour-arriere`. Modifiées : `POST /:id/jeux` (options d'import, nouveaux champs de réponse) et `POST .../autoriser` (garde des suppressions). Un projet inexistant ou retiré répond 404 `PROJET_INTROUVABLE` à tous les comptes, nationaux compris, sur les six routes (point corrigé pendant le lot : la garde territoriale seule laissait passer un compte national).

## 4. Fichiers

Nouveaux, dans `backend/src/projets-voirie/formats/` : `zip.noyau.ts`, `csv.noyau.ts`, `wkt.noyau.ts`, `gpx.noyau.ts`, `puits.noyau.ts`, `crs.noyau.ts`, `crs.service.ts`, `mapping.noyau.ts`, `lecture-import.noyau.ts`, `delta-detaille.noyau.ts`, `validation.noyau.ts`, `versions.depot.ts`, `revue-versions.service.ts`, `apercu.service.ts`, `import.config.ts`, `zip.fixtures.ts` (tests seulement) ; routes `backend/src/api-v2/projets-voirie.import.routes.ts` ; migration `backend/prisma/migrations/20261101100000_import_formats_versions/` et descente `backend/prisma/descentes/20261101100000_import_formats_versions.sql` ; bancs `backend/tests-integration/import-formats.integration.mts` ; tests : `zip.noyau.test.ts`, `csv.noyau.test.ts`, `lecture-import.noyau.test.ts`, `delta-validation.noyau.test.ts`, `charge.test.ts`, `projets-voirie.import.routes.test.ts` ; documentation : `CONTRAT-IMPORT.md`, ce rapport.

Fichiers partagés modifiés (risque de fusion avec les autres lots, modifications minimales) : `backend/prisma/schema.prisma` (3 valeurs d'enum dans `FormatJeuProjet`, 2 modèles et 1 enum **en fin de fichier**), `backend/src/api-v2/projets-voirie.routes.ts` (un `.merge(champsImport)`, deux lignes dans le gestionnaire de dépôt, le montage **en fin de fichier**), `backend/src/projets-voirie/projets.service.ts` (import et 2 lignes dans `decider`), **`backend/src/projets-voirie/import.service.ts` (réécriture des fonctions de dépôt : le plus gros risque de conflit si un autre lot l'a touché)**, `lecture.types.ts` (types et codes en plus), `lecture.noyau.ts` (exports, paramètre `admettreZip`), `lecture.kml.noyau.ts` et `lecture.geojson.noyau.ts` (traverseurs extraits, `lireKml` et `lireGeoJson` inchangés pour l'appelant), `collecteur.noyau.ts` (rapport des éléments écartés), `isolation.test.ts`, `inventaire-acces.test.ts`, `tests-integration/projets-voirie.integration.mts` et `run.sh`.

**`npx prisma generate` a été exécuté une fois** après la modification de `schema.prisma` : le client Prisma de `node_modules` est partagé avec les autres worktrees (jonction vers `w-pv`) ; il est un sur-ensemble (valeurs d'enum et modèles ajoutés), mais si un autre lot régénère depuis un schéma sans ces ajouts, `tsc` de ce lot échouera jusqu'à une nouvelle génération.

## 5. Preuves (chiffres réels)

### 5.1 TypeScript et tests unitaires
- `npx tsc --noEmit` (backend) : exit 0, passage final après tous les changements (environ 2 min 30 sur ce poste).
- Suite backend complète `npx vitest run` : **284 fichiers, 6 091 tests, tous réussis** (passage final après tous les changements de code ; les traces d'erreur visibles dans la sortie sont des erreurs attendues, journalisées par des tests qui les provoquent).
- Tests ajoutés par ce lot (unitaires, sans base) : zip 21, CSV et WKT 27, lecture-import 34, delta et validation 16, charge 12, routes d'import 16 : **126**.

### 5.2 Bancs PostGIS (PostGIS 17-3.5, PROJ 7.2.1, 96 migrations rejouées + la migration du lot, conteneur jetable port 5471)
- `import-formats.integration.mts` (nouveau) : **81/81 vérifications** (passage final).
- `projets-voirie.integration.mts` (socle, mis à jour pour la garde des suppressions, KMZ devenu lisible, CRS projeté confirmé, deux tables ajoutées à la liste des tables du module) : **141/141** (passage final, rejoué seul : une première exécution enchaînée juste après l'autre banc avait signalé la liste des tables du module, mise à jour depuis).
- `conflits-projets-voirie.integration.mts` (RC-3) : 169/169 (une première exécution lancée en même temps que le banc des descentes a donné 165/169 pour cause de délais d'analyse dépassés sous charge ; rejouée seule : 169/169).
- Banc des descentes `verifier.sh --seulement 20261101100000_import_formats_versions` : 8 vérifications, 0 échec, 0 migration sans descente (descente identique au schéma d'avant, aller-retour, deux gardes avec dérogation, une garde sans dérogation).
- Mesures : aperçu de 20 000 points UTM (transformés par la base) 6,0 à 6,3 s ; dépôt de 20 000 points 10,6 à 14,5 s ; CSV de 50 000 lignes lu en 3,9 s ; GPX de 100 000 points en 3,0 s ; KMZ de 4 Mo de KML décompressé en 0,34 s. Poste lent (Docker Desktop sur Windows) : ordres de grandeur, pas des garanties.

### 5.3 Ce que le banc `import-formats` prouve sur PostGIS réel
Exactitude de la transformation **contre un oracle indépendant** (séries de Krüger en JavaScript, sans PROJ) : sommet par sommet à moins de 1e-6 degré, longueur égale à la distance de Vincenty à 5 cm près, trois points témoins d'un plan de 20 000 points retrouvés à 1 cm après aller-retour ; **superposition** du plan d'axes UTM 29N importé et du KML WGS 84 des mêmes axes à moins de 5 cm (distance de Hausdorff) ; erreurs de fuseau détectées dans les deux sens ; inventaire, aperçu et simulation ne changent le nombre de lignes d'**aucune** table ; seules les tables du module et `audit_logs` changent sur tout le banc ; aucune réponse de dépôt ne contient de géométrie ; l'audit conserve le CRS source et cible, les unités, la méthode, la version de PROJ, sans géométrie ; événements et fichiers d'origine en ajout seul (UPDATE, DELETE, TRUNCATE refusés par la base).

### 5.4 Contre-épreuve (mutation)
Sur le noyau ZIP, quatre protections neutralisées (zip-slip, taux de compression, liens symboliques, recouvrement) : 4 tests passent au rouge. Sur le banc : garde des suppressions à l'autorisation, `CRS_REQUIS` pour un CSV et garde « projet retiré » neutralisés : 9 vérifications passent au rouge (72/81). Sources restaurées ensuite.

### 5.5 Autres contrôles
- `npm run securite:balayer` (balayage de secrets du dépôt) : 2 048 fichiers lus, 0 trouvaille non excusée.
- Octets NUL : aucun dans les fichiers du lot (contrôle fait sur tous les fichiers modifiés ou créés).
- Migration : appliquée deux fois de suite sur la base de rejeu (idempotente) ; descente éprouvée par le banc des descentes (5.2).
- Nettoyage : conteneur `a1-postgis` et son volume supprimés à la fin du lot ; le conteneur `bdri-dev-db` n'a jamais été touché.

## 6. Sécurité

Aucun code n'est exécuté depuis un fichier : ni extraction sur disque (le module ZIP n'importe pas `node:fs`, un test le vérifie), ni évaluation de formule, ni ressource externe (`NetworkLink`, `Icon`, `link` ignorés). XXE : le lecteur XML du socle (sans DTD ni entité) sert KML, GPX et le KML d'un KMZ ; testé dans un GPX et dans un KMZ. Type réel par le contenu (un KMZ nommé `.kml` est lu comme KMZ, un KML nommé `.csv` comme KML, HTML/PDF/exécutable/NUL refusés quelle que soit l'extension, y compris `.csv`). Ressources : tailles, entrées, taux, lignes, colonnes, cellules, sommets bornés ; CSV de 3 millions de délimiteurs refusé en moins de 3 s. Erreurs sans fuite : `TRANSFORMATION_ECHEC` ne recopie pas le message de la base ; `ARCHIVE_INVALIDE` pour toute exception de lecture binaire ; erreur interne = 500 générique (testé). Aucune donnée d'un jeu non autorisé dans les réponses : le delta ne rend que des noms d'objets, à `ADMIN` et `GESTIONNAIRE`, jamais pour un jeu retiré ; l'aperçu ne rend que le fichier envoyé, borné. Journal : l'audit ne porte jamais de géométrie (moins de 4 ko vérifié).

## 7. Décisions prises hors contrat (prudentes, documentées)

1. **Wizard sans session serveur** : le client renvoie le fichier à chaque étape, garde `sha256Attendu` au dépôt (409 `EMPREINTE_DIVERGENTE`). Avantage : aucune décision de conservation d'un fichier non accepté. Coût : jusqu'à 25 Mo renvoyés plusieurs fois.
2. **Garde de l'autorisation** : `autoriser` répond 409 `SUPPRESSIONS_A_REVOIR` pour une version qui retire des objets. C'est un changement de comportement du socle, voulu par la gouvernance (« les suppressions ne sont jamais appliquées sans revue »). Le lot A2 doit gérer ce 409 et proposer la revue.
3. **Delta** : `ajoutes` et `retires` n'incluent plus les objets rapprochés par une clé (identifiant du mapping, sinon nom) ; `modifies` est nouveau. Une clé en double est ambiguë : jamais rapprochée.
4. **Confirmation hors zone** : exigée pour un CSV et pour toute source dont le CRS est choisi par l'utilisateur ; KML, KMZ, GPX, GeoJSON WGS 84 gardent le comportement du socle (éléments écartés avec avertissement). Un fichier **entièrement** hors zone est toujours refusé (la base refuse de toute façon un objet hors Guinée).
5. **Couche absente = toutes les couches** (comportement historique) avec avertissement `COUCHES_MULTIPLES`.
6. **Retour arrière** : la version retirée du service passe `REMPLACE` (elle l'a été au sens courant : remplacée par la précédente), la précédente repasse `AUTORISE` avec ses données de décision d'origine ; refusé si un dépôt de même clé attend (409).
7. **Mapping** : les champs du jeu (type de réseau, concessionnaire, classe, précisions, méthode, dates, nature) ne sont appliqués que sur valeur **unique** d'une colonne et seulement si le champ du formulaire est absent ; un concessionnaire n'est jamais créé par un import.
8. **Même fichier, autre CRS** : l'empreinte identique donne 409 `JEU_DEJA_CHARGE`, même avec un autre `epsgSource` ; pour refaire, rejeter ou retirer le premier dépôt (un jeu rejeté ou retiré peut être redéposé).
9. **TSV et TXT sont des `CSV`** (le délimiteur est dans `resume.import.csv`) ; valeurs d'enum ajoutées : `KMZ`, `GPX`, `CSV`.

## 8. Erreurs connues, limites, non fait

- Avec un choix de couche, les compteurs d'avertissement `OBJETS_SANS_GEOMETRIE` et `ELEMENTS_KML_IGNORES` peuvent inclure des éléments des autres couches (le lecteur ne dit pas la couche au compteur).
- `ELEMENTS_HORS_GUINEE` compte des membres de géométrie, pas des objets.
- CSV : pas de fichier sans en-tête, pas de séparateur de milliers, pas de délimiteur espace, pas de polygones construits depuis des points, pas de clés d'axe imbriquées, pas de détection de rupture de chaînage d'une ligne reconstruite.
- Le fichier d'origine, s'il est conservé, n'est relu par aucune route et n'a pas de voie de purge (la table refuse la suppression physique, comme les autres tables du module).
- Lecture synchrone : un XML de 25 Mo se parse dans la boucle d'événements (une à quelques secondes), comme le socle ; limité par les limiteurs de réception.
- La version de PROJ du conteneur de test est 7.2.1 ; la production peut en avoir une autre. Les trois CRS par défaut partagent le datum WGS 84 (pas de grille de datum) ; un CRS à datum local exigerait de valider la précision (grilles PROJ) avant de l'ajouter à la liste blanche.
- Non exécuté : frontend, E2E, `run.sh` complet (seuls les bancs concernés ont été rejoués : `import-formats`, `projets-voirie`, `conflits-projets-voirie`, banc des descentes), lint (le backend n'a pas de script de lint), build de production, tout fichier réel d'un tiers, GDAL, déploiement.
- Hors lot, non fait par consigne : GeoPackage, Shapefile, DXF, raster, DWG, IFC, LAS, interface, conflits.

## 9. Décisions que le DSI doit prendre

1. **Rétention du fichier d'origine** : conserver ou non (`PROJETS_VOIRIE_CONSERVER_ORIGINAL`), durée, voie de purge si un tiers retire son accord, effet sur la taille de la base (jusqu'à 25 Mo par jeu, en `bytea`). Défaut actuel : non (empreinte seule).
2. **Liste blanche des CRS** : valider EPSG:4326, 32628 et 32629 (les fuseaux 28N et 29N couvrent toute la Guinée) ; dire si un CRS national ou à datum local doit être ajouté, avec validation de la transformation (grilles PROJ).
3. **Valeurs de protection** (aucune n'est un seuil métier validé) : 100 entrées et 100 Mo décompressés par archive, taux 100, 500 000 lignes CSV, échantillon de 20, délai d'aperçu 30 s.
4. **Revue des suppressions** : un second compte doit-il être exigé pour accepter des suppressions (aujourd'hui l'audit note `memePersonne`, sans bloquer, comme l'autorisation) ?
5. **Traitement asynchrone** : décider si les gros fichiers (chaîne GDAL) justifient le job décrit à la section 13 du contrat, avant le branchement du conteneur GDAL.
6. **Confirmation hors zone** pour KML, KMZ et GPX : étendre la règle du CSV à tous les formats, ou garder le comportement du socle.

## 10. Commits de la branche `feat/import-formats-simples`

| Commit | Contenu |
|---|---|
| `715db87270e1cfb918eefa4e2e3dcf5209ea3c10` | contrat `CONTRAT-IMPORT.md`, écrit et commité en premier |
| `a53ac851b17781a01543a6aba3b23ff8490bed97` | lecteurs KMZ, CSV, GPX, WKT, choix du CRS, inventaire, mapping (noyau pur), migration et descente |
| `4761f522de91e3f4b35e949289bdeb43d10e2909` | wizard (6 routes), CRS par PostGIS, delta et revue des suppressions, retour arrière, original facultatif, banc PostGIS |
| `b263bd625b5ddc8b75f94d2deedcead58a866be6` | rapport des éléments écartés, tests de charge, corrections de types |
| `b9a91f44ed9c54f1241c7ce816afc28dce43253a` | API, contrôle d'accès, rapport, précisions du contrat |
