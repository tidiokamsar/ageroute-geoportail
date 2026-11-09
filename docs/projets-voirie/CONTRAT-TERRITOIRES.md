# Territoires hiérarchiques, référentiels configurables et configuration nationale : contrat d'interface (lot T1)

Statut : contrat de départ du 08/11/2026, commun au backend, au frontend (lot UI-C) et aux lots D1 (documents), S1 (sources) et X1 (exports, tableaux de bord). Complète `CONTRAT.md` (socle), `CONTRAT-CONFLITS.md`, `CONTRAT-IMPORT.md` et `API.md`. Référence : `C:\ageroute-secours\mandat\DECISION-ARCHITECTURALE-2.md` (sections 1, 2, 3 et 10) et instruction du DSI du 08/11/2026 : **Kissidougou est un pilote, pas une limite ; aucune ville, aucun concessionnaire, aucun CRS, aucun type de réseau n'est codé en dur ; une ville s'ajoute par administration, jamais par code.** Branche : `feat/territoires-referentiels` (issue de `feat/vague2-integration`). Migration : `20261103100000_territoires_referentiels` (additive, descente, idempotente).

## 1. Principe

Le socle portait le territoire d'un projet en texte libre (`commune`, `prefecture`), les types de réseau dans une énumération, l'emprise de plausibilité et la règle du CRS métrique dans des constantes. Ce lot remplace ces constantes par des **données administrables** :

1. un référentiel territorial unique et hiérarchique (`territoires_voirie`) ; chaque projet pointe vers un territoire ;
2. une table générique de référentiels configurables (`referentiels_voirie`) : types de réseau, catégories de projet, types de document attendu, méthodes d'acquisition, statuts de qualité ;
3. une configuration nationale (`configuration_voirie`) : emprise de plausibilité, règle du CRS métrique par bandes de longitude, liste blanche des CRS d'import, valeurs de protection administrables.

Les noms de lieux ne vivent que dans les **données** : la migration crée la nation et la chaîne du pilote (Faranah, Kissidougou) ; la graine de démonstration (script, jamais en migration ni en production) crée d'autres villes marquées `DEMO`. Le code ne connaît aucun nom.

## 2. Règles non négociables

Celles de `CONTRAT.md` section 2, plus :

1. **Suppression logique** (`deletedAt`) sur les territoires et les valeurs de référentiel ; aucune suppression physique (déclencheurs) ; historique en **ajout seul** pour les trois familles de tables.
2. **Toute écriture est ADMIN et auditée** dans `audit_logs` (`TerritoireVoirie`, `ReferentielVoirie`, `ConfigurationVoirie`), sans géométrie dans l'audit (l'emprise d'un territoire n'est tracée que par son empreinte et sa boîte englobante).
3. **Le périmètre régional des comptes reste la base du contrôle d'accès** : un territoire dont la région effective (la sienne ou celle du plus proche ancêtre) n'est pas dans les régions du compte **n'existe pas** pour lui (404 identique à l'inexistant) ; un territoire sans région effective (nation, territoire non rattaché) n'est visible que des comptes nationaux ; ADMIN voit tout.
4. **Un territoire ne change ni de parent, ni de niveau, ni de code** après sa création (déclencheur). On en crée un autre ; l'ancien se désactive ou se retire.
5. **Une valeur de référentiel désactivée ou retirée reste lisible sur les objets qui la portent** (le code est conservé) ; elle n'est plus proposée pour une nouvelle saisie (la base refuse un code retiré à l'insertion ou au changement).
6. **Variables d'environnement prioritaires** sur la configuration en base, elle-même prioritaire sur le défaut codé (compatibilité : un réglage de production existant ne change pas de comportement).
7. Aucune valeur métier n'est inventée : les valeurs de départ des référentiels sont celles du code actuel (énumération, largeurs 15 m / 7 m, rôles de jeux, couleurs de la légende) ou des libellés sans seuil ; les emprises de territoire sont **approximatives** et dites telles (`source`).

## 3. Modèle de données

Tables en `snake_case` (`@@map`), identifiants `uuid` texte, géométrie en `Unsupported`, SQL brut paramétré pour l'emprise.

### 3.1 `TerritoireVoirie` (`territoires_voirie`)

| Colonne | Type | Règle |
|---|---|---|
| `id` | texte | uuid |
| `parentId` | texte, nul | nul si et seulement si `niveau = NATION` (CHECK) ; **immuable** |
| `niveau` | enum `NiveauTerritoireVoirie` | `NATION`, `REGION`, `PREFECTURE`, `COMMUNE`, `QUARTIER`, `SECTEUR`, `ZONE` (rangs 0 à 6) ; le parent est de rang **strictement inférieur** (déclencheur : un niveau peut être sauté, par exemple une commune directement sous une région quand la préfecture n'est pas renseignée) ; **immuable** |
| `code` | texte | unique, motif `^[A-Z0-9][A-Z0-9_-]{1,63}$` (majuscules imposées par le serveur) ; **immuable** |
| `nom` | texte | 1 à 200 caractères |
| `chemin` | texte | chemin matérialisé des identifiants, `/id_nation/id_region/.../id/`, calculé par la base ; les descendants d'un territoire sont les lignes dont `chemin` commence par le sien |
| `profondeur` | entier | 0 pour la nation, calculé par la base |
| `emprise` | `geometry(Geometry, 4326)`, nul | polygone ou multipolygone WGS 84, valide, non vide (CHECK) ; **approximatif** sauf mention contraire dans `source` |
| `crsMetriqueEpsg` | entier, nul | CRS métrique imposé pour les calculs des projets du territoire ; doit figurer dans la liste blanche des CRS (configuration) et n'est jamais 4326 ; nul = règle nationale par bandes |
| `regionId` | entier, nul | `Region` du référentiel administratif (périmètre des comptes) |
| `regionEffectiveId` | entier, nul | calculé par la base : `regionId`, sinon celui du parent ; propagé aux descendants qui n'ont pas de région propre |
| `source` | texte, nul | provenance (« migration 20261103100000, emprise approximative », « graine de démonstration DEMO », texte de l'administrateur) |
| `actif` | booléen | un territoire inactif reste lisible, n'est plus proposé à la création d'un projet |
| `version` | entier | +1 à chaque modification |
| `creeParId` | texte, nul | nul pour une ligne de migration |
| `createdAt`, `updatedAt`, `deletedAt` | | suppression logique |

Déclencheurs : parent existant et non retiré, rang du niveau, calcul de `chemin`, `profondeur` et `regionEffectiveId` à l'insertion ; refus de modifier `parentId`, `niveau`, `code` ; recalcul et propagation de `regionEffectiveId` à la modification ; `DELETE` et `TRUNCATE` refusés. Une seule nation active à la fois (409 `NATION_DEJA_DEFINIE`, contrôle du service).

**Contenance des emprises** : quand l'enfant et le parent portent tous deux une emprise et que celle de l'enfant n'est pas couverte par celle du parent (`ST_Covers`), le serveur **avertit** (`EMPRISE_HORS_PARENT`) sans refuser : les emprises sont approximatives. Même avertissement (`EMPRISE_HORS_EMPRISE_NATIONALE`) si l'emprise sort de l'emprise de plausibilité configurée.

`TerritoireVoirieHistorique` (`territoires_voirie_historique`, ajout seul) : `id` (bigint), `territoireId`, `action` (`CREATION`, `MODIFICATION`, `RETRAIT`, `MIGRATION`), `version`, `avant`, `apres` (JSON : la ligne sans la géométrie ; l'emprise y figure par sa boîte englobante et son empreinte MD5), `acteurId` (nul pour la migration), `createdAt`.

### 3.2 `ReferentielVoirie` (`referentiels_voirie`)

| Colonne | Règle |
|---|---|
| `id` | uuid |
| `domaine` | enum `DomaineReferentielVoirie` : `TYPE_RESEAU`, `CATEGORIE_PROJET`, `TYPE_DOCUMENT`, `METHODE_ACQUISITION`, `STATUT_QUALITE` |
| `code` | unique par domaine, motif `^[A-Z0-9][A-Z0-9_-]{1,63}$` ; **immuable** |
| `libelle` | 1 à 200 caractères |
| `ordre` | entier 0 à 100 000, ordre d'affichage |
| `actif` | booléen |
| `parametres` | JSON objet, **validé par le schéma zod du domaine** (section 5) ; la base vérifie en plus la famille d'un type de réseau et la cohérence des largeurs d'une catégorie |
| `version` | +1 à chaque modification |
| `approuveParId`, `approuveLe` | l'ADMIN qui a écrit la version courante et quand ; nuls pour une ligne de migration (valeur « système ») |
| `creeParId`, `createdAt`, `updatedAt`, `deletedAt` | suppression logique |

`ReferentielVoirieHistorique` (`referentiels_voirie_historique`, ajout seul) : `id`, `referentielId`, `action` (`CREATION`, `MODIFICATION`, `RETRAIT`, `MIGRATION`), `version`, `avant`, `apres`, `acteurId`, `createdAt`.

### 3.3 `ConfigurationVoirie` (`configuration_voirie`)

`cle` (clé primaire, motif `^[A-Z][A-Z0-9_]{1,63}$`), `valeur` (JSON validé par le schéma de la clé, section 6), `version`, `approuveParId`, `approuveLe`, `justification`, `createdAt`, `updatedAt`. Historique `configuration_voirie_historique` (ajout seul) : `id`, `cle`, `version`, `avant`, `apres`, `acteurId`, `justification`, `createdAt`.

### 3.4 Colonnes ajoutées aux tables du socle

- `projets_voirie.territoireId` (texte, nul en base pour l'additivité, **obligatoire à la création d'un nouveau projet** par l'API ; renseigné pour tous les projets existants par la migration), `projets_voirie.categorieCode` (texte, nul ; code du domaine `CATEGORIE_PROJET`, vérifié par la base à l'écriture).
- `projets_voirie_jeux.typeReseauCode` et `concessionnaires_reseau.typeReseauCode` (texte, nul ; code du domaine `TYPE_RESEAU`, vérifié par la base à l'écriture ; renseigné par la migration avec la valeur de l'énumération). **L'énumération `TypeReseauTiers` reste la famille technique** (règles de conflit, couleurs, totaux par type) : quand `typeReseauCode` est fourni, la famille est **dérivée** du référentiel (`parametres.famille`) ; sans code, la famille déclarée est utilisée telle quelle (repli).
- `commune` et `prefecture` du projet restent lisibles : à la création ou au changement de territoire, elles sont **dérivées** du nom des ancêtres de niveau `COMMUNE` et `PREFECTURE` (ou du territoire lui-même) quand ils existent ; sinon les valeurs envoyées sont conservées.

## 4. Hiérarchie et périmètre

- Descendants de `T` : `chemin LIKE T.chemin || '%'`. Ancêtres : les identifiants du chemin.
- Région effective : `regionId`, sinon celle du parent, récursivement. Les projets héritent la région à la création (`regionId` du projet = région effective du territoire si le corps ne la donne pas ; s'il la donne et qu'elle diffère : 400 `TERRITOIRE_REGION_INCOHERENTE`).
- Visibilité d'un territoire pour un compte régional : `regionEffectiveId` dans ses régions. La nation (sans région) n'est donc visible que des comptes nationaux : un compte régional voit sa région et ce qui est au-dessous. Les listes sont filtrées côté serveur ; une ressource désignée hors périmètre répond 404 `TERRITOIRE_INTROUVABLE` (même corps que l'inexistant).
- Création d'un projet par un compte régional : la région touchée est celle du corps, sinon la région effective du territoire (403 `HORS_PERIMETRE` ou `REGION_INCONNUE`, comme aujourd'hui).
- Changement de territoire d'un projet (`PATCH`) : la région effective du nouveau territoire doit être celle du projet (ou nulle pour un projet national) : 400 `TERRITOIRE_REGION_INCOHERENTE` sinon. Le périmètre du compte ne change donc jamais par un déplacement de projet.
- **Projet linéaire (précision du 09/11/2026)** : un projet qui traverse plusieurs préfectures d'une même région (route de plusieurs centaines de kilomètres) se rattache à un territoire de niveau `ZONE` (corridor) placé **directement sous la région** : les préfectures traversées restent ses sœurs dans l'arbre (la hiérarchie n'est pas un pavage), l'emprise approximative du corridor peut les couvrir (`ST_Covers`), et plusieurs projets distincts (largeurs différentes) peuvent partager le même corridor. `commune` et `prefecture` du projet restent alors nulles (rien n'est inventé). Un corridor qui traverserait **plusieurs régions** n'a pas de région effective unique : il se place sous la nation sans région, et n'est donc visible que des comptes nationaux (décision à confirmer par le DSI, voir le rapport du lot).

## 5. Référentiels : domaines et schémas des paramètres

| Domaine | `parametres` (zod, `strict`) | Valeurs de départ (migration, « système ») |
|---|---|---|
| `TYPE_RESEAU` | `{ famille: TypeReseauTiers, couleur?: "#rrggbb" }` | `TELECOM`, `EAU_POTABLE`, `ELECTRICITE`, `ASSAINISSEMENT`, `GAZ_HYDROCARBURES`, `AUTRE` (famille = eux-mêmes, couleurs de `CONTRAT.md` section 6) |
| `CATEGORIE_PROJET` | `{ largeurEmpriseM: 0 < x ≤ 200, largeurChausseeM: 0 < y ≤ x }` | `VOIRIE_URBAINE` (15 m / 7 m : les défauts actuels du socle) |
| `TYPE_DOCUMENT` | `{ obligatoire: boolean, fonctionsDebloquees: string[] (codes `^[A-Z0-9_]{2,64}$`, 20 au plus) }` | `PLAN_AXES` (obligatoire : `ANALYSE_2D`, `CONFLITS`), `RESEAU_CONCESSIONNAIRE` (obligatoire : `ANALYSE_2D`, `CONFLITS`, `COMPARAISON_SOURCES`), `LIMITES_ROUTE`, `AUTRE` (facultatifs, sans fonction). Le lot D1 complète (DWG, PDF, LandXML…) par **données**, pas par code |
| `METHODE_ACQUISITION` | `{ precisionTypiqueM?: number > 0 ≤ 100 000 \| null }` | `INCONNUE`, `LEVE_TOPOGRAPHIQUE`, `GNSS`, `NUMERISATION_PLAN`, `RELEVE_TERRAIN` : libellés sans précision typique (aucune précision n'est inventée ; à renseigner par le DSI) |
| `STATUT_QUALITE` | `{ description?: string ≤ 500 }` | `INCONNUE`, `DECLAREE`, `VERIFIEE_TERRAIN` (les trois états que le socle et le récolement distinguent déjà) |

Les listes de choix de l'interface se chargent depuis `GET /referentiels/:domaine`. Les codes de fonctions débloquées (`ANALYSE_2D`, `CONFLITS`, `COMPARAISON_SOURCES`, `RECOLEMENT`, `EXPORT_DOSSIER`) sont des **constantes du contrat** (lot D1), pas des données de territoire.

## 6. Configuration nationale

| Clé | Valeur (zod, `strict`) | Défaut codé (identique à aujourd'hui) | Variable d'environnement prioritaire |
|---|---|---|---|
| `EMPRISE_PLAUSIBILITE` | `{ nom: string ≤ 100, bbox: [ouest, sud, est, nord] }` (degrés, ouest < est, sud < nord) | `{ nom: "Guinee", bbox: [-15.2, 7.1, -7.5, 12.8] }` | aucune |
| `CRS_METRIQUE_BANDES` | `{ bandes: [{ jusquaLongitude: number, epsg: entier }] (0 à 20, triées croissantes), epsgDefaut: entier }` ; chaque `epsg` est dans la liste blanche et n'est pas 4326 | `{ bandes: [{ jusquaLongitude: -12, epsg: 32628 }], epsgDefaut: 32629 }` (lecture : la première bande dont `longitude < jusquaLongitude`, sinon le défaut) | aucune |
| `CRS_IMPORT_LISTE_BLANCHE` | `{ epsg: entier[] }` (1 à 20 codes à 4 à 6 chiffres, 4326 obligatoire, chacun connu de `spatial_ref_sys`) | `{ epsg: [4326, 32628, 32629] }` | `PROJETS_VOIRIE_CRS_SOURCE_AUTORISES` |
| `PROTECTIONS` | `{ analyseIntervalleS?, conflitsMax?, sommetsParObjet?, sommetsParFichier?, delaiAnalyseMs?, delaiCarteMs?, delaiDepotMs? }` (chaque valeur dans les bornes de `config.ts`) | les défauts de `config.ts` | `PROJETS_VOIRIE_ANALYSE_INTERVALLE_S`, `PROJETS_VOIRIE_CONFLITS_MAX`, `PROJETS_VOIRIE_SOMMETS_PAR_OBJET`, `PROJETS_VOIRIE_SOMMETS_PAR_FICHIER`, `PROJETS_VOIRIE_DELAI_ANALYSE_MS`, `PROJETS_VOIRIE_DELAI_CARTE_MS`, `PROJETS_VOIRIE_DELAI_DEPOT_MS` |

**Résolution** d'une valeur : variable d'environnement définie et valide > valeur en base > défaut codé. La réponse de l'API dit la **source** de chaque valeur effective (`ENV`, `BASE`, `DEFAUT`). **Cache** : la configuration est lue en base au plus une fois par fenêtre courte (défaut 30 s, `PROJETS_VOIRIE_CONFIG_CACHE_MS`, 1 s à 10 min) par processus et invalidée immédiatement à l'écriture dans le même processus ; une autre instance la relit à l'expiration de sa fenêtre. Les lecteurs synchrones du socle (`config.ts`) lisent la dernière valeur chargée ; les services asynchrones rafraîchissent le cache avant tout calcul.

**Territoire du projet** : s'il porte une emprise, celle-ci devient la **zone attendue** de la plausibilité de ses dépôts (`resume.crs.plausibilite.zoneAttendue`, avertissement `ELEMENTS_HORS_TERRITOIRE`, confirmation `CONFIRMATION_HORS_ZONE_REQUISE` dans les mêmes conditions que le socle) ; l'emprise **nationale** configurée reste la limite au-delà de laquelle un élément est écarté (`ELEMENTS_HORS_GUINEE`, `HORS_GUINEE` : codes conservés pour la compatibilité, messages génériques). Un élément hors de l'emprise approximative du territoire n'est jamais écarté : il est compté et signalé. S'il porte un `crsMetriqueEpsg`, l'analyse 2D, l'analyse de conflits et les propositions d'association l'utilisent au lieu de la règle par bandes.

## 7. API (préfixe `/api/v2/projets-voirie`, mêmes gardes que le socle, dans le même ordre)

Lecture : tout compte ayant la clé de module (territoires filtrés par périmètre). Écriture : **ADMIN** seul, auditée. Erreurs `{ error, code, ... }`. Identifiants d'URL en UUID (400 `IDENTIFIANT_INVALIDE`), octet NUL (400 `PARAMETRES_INVALIDES`), corps `strict`.

| Route | Rôle | Contenu |
|---|---|---|
| `GET /territoires` | lecture | `?niveau=&parentId=&q=&actifs=true|false&limite=(1..500, 200)&curseur=` : `{ territoires: [vue], curseurSuivant }`, ordre du chemin (arbre), filtrés par périmètre ; `actifs` omis = actifs et inactifs, retirés jamais |
| `GET /territoires/comptes` | lecture | `?territoireId=` : `{ comptes: [ { territoireId, code, nom, niveau, parentId, profondeur, projets, jeux: { <statut>: n }, conflits: { <statut>: n } } ], tronque }` : agrégats sur le territoire **et ses descendants**, filtrés par périmètre (projets des régions du compte ; un lecteur ne compte que les jeux `AUTORISE` et les conflits dont le jeu de réseau est `AUTORISE`) ; 2 000 territoires au plus (`tronque`) ; base du tableau de bord du lot X1 |
| `POST /territoires` | ADMIN | `{ code, nom, niveau, parentId? (obligatoire sauf NATION), regionId?, crsMetriqueEpsg?, emprise? (GeoJSON Polygon ou MultiPolygon, 10 000 sommets au plus), source? }` : 201 `{ territoire, avertissements: [ { code, message } ] }` |
| `GET /territoires/:tid` | lecture | `{ territoire: { ...vue, ancetres: [ { id, code, nom, niveau } ], nbEnfants } }` ; 404 masqué |
| `PATCH /territoires/:tid` | ADMIN | `{ nom?, regionId?, crsMetriqueEpsg?, emprise? (ou null), actif?, source? }` : `{ territoire, avertissements }` ; `parentId`, `niveau`, `code` refusés (400 `CHAMPS_INVALIDES`) |
| `DELETE /territoires/:tid` | ADMIN | retrait logique : `{ id, retire: true }` ; 409 `TERRITOIRE_UTILISE` s'il a des enfants non retirés ou des projets non retirés |
| `GET /referentiels` | lecture | `{ domaines: [ { domaine, nb, nbActifs } ] }` |
| `GET /referentiels/:domaine` | lecture | `?tous=true` pour inclure les inactifs : `{ domaine, valeurs: [vue] }` par `ordre` puis `libelle` ; domaine inconnu : 404 `DOMAINE_INCONNU` |
| `GET /referentiels/:domaine/:code` | lecture | `{ valeur }` (inactive comprise ; retirée : 404 `VALEUR_INTROUVABLE`) |
| `POST /referentiels/:domaine` | ADMIN | `{ code, libelle, ordre?, actif?, parametres }` : 201 `{ valeur }` ; 409 `CODE_DEJA_UTILISE` ; 400 `PARAMETRES_INVALIDES` (détails zod) |
| `PATCH /referentiels/:domaine/:code` | ADMIN | `{ libelle?, ordre?, actif?, parametres? }` : `{ valeur }` (version +1) |
| `DELETE /referentiels/:domaine/:code` | ADMIN | retrait logique `{ code, retire: true }` ; 409 `VALEUR_UTILISEE` si un jeu, un concessionnaire ou un projet non retiré la porte (désactivez-la plutôt) |
| `GET /configuration` | lecture | `{ configuration: [ { cle, valeur, source, valeurBase, valeurDefaut, version, approuvePar, approuveLe, updatedAt } ] }` (`PROTECTIONS` : `valeur` et `sources` par sous-clé) |
| `GET /configuration/:cle` | lecture | une entrée ; 404 `CLE_INCONNUE` |
| `PUT /configuration/:cle` | ADMIN | `{ valeur, justification? }` : `{ configuration }` (version +1, cache invalidé) ; 400 `VALEUR_INVALIDE` (détails) ; `CRS_NON_AUTORISE` pour une bande hors liste blanche ; 422 `CRS_NON_DISPONIBLE` pour un code absent de `spatial_ref_sys` |

Vue d'un territoire : `{ id, code, nom, niveau, parentId, chemin, profondeur, regionId, regionEffectiveId, crsMetriqueEpsg, emprise (GeoJSON ou null), bbox ([ouest, sud, est, nord] ou null), source, actif, version, creePar, createdAt, updatedAt }`. Vue d'une valeur de référentiel : `{ id, domaine, code, libelle, ordre, actif, parametres, version, systeme (créée par la migration), approuvePar, approuveLe, createdAt, updatedAt }`.

**Routes du socle modifiées** (compatibles) :

- `POST /` : `territoireId` **obligatoire** (400 `TERRITOIRE_REQUIS` s'il manque, `TERRITOIRE_INTROUVABLE` s'il n'existe pas, est retiré ou inactif), `categorieCode?` (largeurs par défaut de la catégorie si `largeurEmpriseM` et `largeurChausseeM` ne sont pas envoyées), `regionId?` (dérivé du territoire sinon). `commune` et `prefecture` restent acceptés, dérivés quand le territoire le permet.
- `PATCH /:id` : `territoireId?`, `categorieCode?`.
- `GET /` : `?territoireId=` (le territoire **et ses descendants**) ; chaque projet porte `territoireId`, `categorieCode` et `territoire: { id, code, nom, niveau }`.
- `GET /:id` : `territoire: { id, code, nom, niveau, ancetres }`.
- `POST /:id/jeux` : `typeReseauCode?` (code `TYPE_RESEAU` ; la famille `typeReseau` en est dérivée ; les deux ensemble doivent concorder : 400 `TYPE_RESEAU_INCOHERENT`). Les vues de jeu portent `typeReseauCode`.
- `POST /concessionnaires` : `typeReseauCode?` ; `typeReseau` devient facultatif si le code est donné.
- `GET /:id/import/options` : `crs.sourcesAutorises` et `crs.zoneAttendue` viennent de la configuration et du territoire du projet.

## 8. Codes d'erreur ajoutés

`TERRITOIRE_REQUIS`, `TERRITOIRE_INTROUVABLE`, `TERRITOIRE_PARENT_INTROUVABLE`, `TERRITOIRE_PARENT_REQUIS`, `NIVEAU_INCOMPATIBLE`, `NATION_DEJA_DEFINIE`, `TERRITOIRE_UTILISE`, `TERRITOIRE_REGION_INCOHERENTE`, `EMPRISE_INVALIDE`, `DOMAINE_INCONNU`, `VALEUR_INTROUVABLE`, `VALEUR_UTILISEE`, `TYPE_RESEAU_INCOHERENT`, `CLE_INCONNUE`, `VALEUR_INVALIDE`, `CRS_NON_AUTORISE` (réutilisé), `CRS_NON_DISPONIBLE` (réutilisé), `CODE_DEJA_UTILISE` (réutilisé), `PARAMETRES_INVALIDES`, `CHAMPS_INVALIDES`. Avertissements : `EMPRISE_HORS_PARENT`, `EMPRISE_HORS_EMPRISE_NATIONALE`, `ELEMENTS_HORS_TERRITOIRE` (lecture des fichiers).

## 9. Migration et graine

**Migration `20261103100000_territoires_referentiels`** (additive, idempotente, descente `backend/prisma/descentes/20261103100000_territoires_referentiels.sql`) :

1. types, tables, déclencheurs, index, colonnes ;
2. nation `GN` (« Guinée »), région `GN-REG-FARANAH` (rattachée à la `Region` « Faranah » du référentiel administratif si elle existe), préfecture `GN-PREF-KISSIDOUGOU`, commune `GN-COM-KISSIDOUGOU` avec une emprise **approximative** (rectangle d'environ 13 km autour du centre de la ville, `source` le dit) ; **rien d'autre** ;
3. projets existants : territoire `COMMUNE` retrouvé par le nom (sans accents ni casse) ou créé depuis `commune` (code `MIG-COM-…`, sous la préfecture retrouvée ou créée depuis `prefecture`, sinon sous la nation, `regionId` = celui du projet) ; sans commune, la préfecture ; sans l'une ni l'autre, le territoire `NON_RENSEIGNE` (niveau `ZONE`, sous la nation) ;
4. référentiels de la section 5, `typeReseauCode` des jeux et des concessionnaires = valeur de l'énumération ;
5. configuration de la section 6 aux défauts, version 1.

La descente retire colonnes, tables, déclencheurs, fonctions et types ; elle **refuse** (garde `bdri.perte_autorisee`) si une ligne a été créée ou modifiée par un administrateur (territoire ou valeur avec `creeParId`, version supérieure à 1, ligne d'historique avec acteur). Ce qui est perdu, même autorisé : le rattachement des projets à un territoire (les colonnes `commune` et `prefecture` restent), les codes de type de réseau (la famille reste).

**Graine de démonstration** `backend/scripts/graine-demo-territoires.ts` : refuse de s'exécuter sans `GRAINE_DEMO=OUI` et sous `NODE_ENV=production` ; crée, sous la nation, les régions, préfectures et communes de démonstration **marquées `DEMO`** (codes `DEMO-…`, `source` « graine de démonstration DEMO, emprise approximative ») pour sept villes, avec emprises approximatives ; rejouable (ne recrée pas un code existant). Elle ne vaut pas référentiel officiel. Elle écrit une ligne d'historique sans acteur et **aucune ligne d'audit** (script sans compte, comme `prisma/seed.ts`) ; ses lignes n'ont ni `creeParId` ni version supérieure à 1 : la descente ne les protège donc pas par sa garde (données de démonstration, recréées en rejouant la graine). Garde supplémentaire : la base visée doit s'appeler `essai_*`, `replay*`, `demo*` ou `dev*`.

**Écart entre le contrat et la mise en œuvre de la migration** : les territoires créés depuis les projets existants ont les codes `MIG-COM-<NOM>` et `MIG-PREF-<NOM>` (suffixe d'empreinte en cas de collision) ; une préfecture créée depuis un projet est rattachée à la nation (la région administrative du projet est portée en `regionId`, elle n'est pas rapprochée d'un territoire de région : rapprochement à faire par l'administrateur).

## 10. Tests exigés

Unitaires (noyaux purs) : rangs et admissibilité des niveaux, chemin et descendance, région effective, validation des emprises GeoJSON, boîtes englobantes ; schémas des paramètres par domaine ; résolution env > base > défaut ; choix du CRS par bandes (bornes exactes, bandes vides, défaut) ; repli de type de réseau ; cache et invalidation. Routes (supertest, vrais gardes, services simulés) : matrice des rôles, 404 masqué, validations, codes. Banc PostGIS `territoires-referentiels.integration.mts` (clone de `replay`, migration appliquée au clone) avec le scénario **« nouvelle ville sans code »** : un ADMIN crée une région, une préfecture et une commune par l'API (emprise approximative, aucune ligne de code), un projet dans la commune (région dérivée), un dépôt synthétique en WGS 84 dans l'emprise, l'analyse 2D et les conflits fonctionnent, le CRS métrique retenu est celui attendu par les bandes puis celui imposé par le territoire, un compte d'une autre région reçoit 404 sur le projet et le territoire, une valeur de référentiel désactivée reste lisible sur le jeu qui la porte, la configuration écrite s'applique à l'analyse suivante, descente rejouée par `verifier.sh --seulement`. Non-régression des bancs socle, conflits, import, réseaux, workflow (migration T1 appliquée au clone).

## 11. Ce que ce lot ne fait pas (décidé)

Pas d'interface (lot UI-C) ; pas de règles de conflit par territoire (la décision 2 le prévoit, la table des règles n'a pas changé : à faire quand une règle territoriale sera demandée) ; pas de calcul géodésique sur l'emprise des territoires au dépôt (la plausibilité par territoire est un test de boîte englobante, sans PostGIS, sur une emprise approximative) ; pas d'import de limites administratives officielles dans `territoires_voirie` (la table `limites_administratives` du socle reste indépendante : rapprochement à décider) ; pas de workflow brouillon/approbation à deux personnes sur les référentiels et la configuration (chaque écriture ADMIN vaut approbation immédiate, versionnée et historisée ; la séparation des tâches est une décision à prendre, voir le rapport).
