# Observation de la Terre : API (chantier EO-API, Lot 1 EO)

Préfixe : `/api/v2/teledetection`. Le CONTRAT est `CONTRAT-API-UI.md` ; ce document dit ce qui est réellement servi, avec les droits, les codes d'erreur, les compléments au contrat et des exemples issus d'exécutions réelles (banc `eo-api`, 25/10/2026, base PostGIS locale, aucun appel réseau ; verification réelle du catalogue au §10).

Code : `backend/src/api-v2/teledetection.routes.ts` (routeur), `teledetection.schemas.ts` (corps stricts), `backend/src/teledetection/api.noyau.ts` (lecture des paramètres, entrées hostiles, mise en forme, pur), `api.lecture.ts` (SQL de lecture), `api.service.ts` (écritures composées), `api.erreurs.ts` (contrat des erreurs), `sources.service.ts` (pont adaptateurs de catalogue et base).

## 1. Ordre des gardes (identique sur toutes les routes)

1. authentification (`requireAuth`) : 401 `NON_AUTHENTIFIE` ;
2. module `teledetection` (`requireModuleAccess`) : 403 `MODULE_NON_AUTORISE` ;
3. rôle (`requireRole`) : 403 `ROLE_INSUFFISANT` ;
4. ressource désignée par `:id` : **404 identique** si elle n'existe pas, si l'identifiant est mal formé, si elle est hors du périmètre du compte, ou si elle n'est pas rattachée et que le compte est régional ;
5. validation du corps ou des paramètres : 400 `ENTREE_INVALIDE` ;
6. service : 400, 403, 404, 409 avec le code du service.

Le contrôle d'existence et de périmètre (4) précède la validation du corps (5) : un corps invalide ne permet donc pas de distinguer « hors périmètre » de « inexistant » (oracle d'existence fermé, prouvé par le banc).

## 2. Accès

### 2.1 Clé de module

`teledetection` est ajoutée à `backend/src/lib/modules.ts` ; elle figure déjà dans `frontend/src/lib/modules.ts`. Un test (`backend/src/lib/modules.test.ts`) compare les deux listes. ADMIN passe toujours la garde de module ; tout autre compte exige la clé dans `modulesAutorises` (liste vide = aucun module).

**L'attribution de la clé aux comptes existants est un geste d'administration.** Aucune migration de données ne l'octroie : en production, tant qu'un administrateur ne l'a pas donnée, les comptes non ADMIN reçoivent 403 `MODULE_NON_AUTORISE` sur toutes les routes. Les profils métier (`lib/profils.ts`) ne sont pas modifiés : y ajouter la clé est une décision d'AGEROUTE.

### 2.2 Rôles (contrat §2, complété)

| Opération | ADMIN | GESTIONNAIRE | INSPECTEUR | LECTEUR |
|---|---|---|---|---|
| Toutes les lectures (synthèse, listes, détail, GeoJSON, produits, aperçu, sources, qualité) | oui | oui | oui | oui |
| `POST /propositions/:id/transition`, `/verification` | oui | oui | non | non |
| `POST /propositions/:id/preuves` | oui | oui | seulement si la proposition est liée à une mission qui lui est affectée, avec ses propres observations | non |
| `POST /sources/:code/verifier` | oui | non | non | non |
| `POST /sources/:code/synchroniser-catalogue` | oui | oui (compte national) | non | non |
| `POST /produits`, `POST /propositions` (dépôt par un traitement) | oui | oui (compte national) | non | non |

Décision sur l'INSPECTEUR (contrat §2 : « lecture + ajout de preuves terrain sur une mission qui lui est affectée ») : la condition est stricte, `proposition.missionId` doit désigner une mission dont `assigneId` est le compte, et chaque observation citée doit avoir été saisie par lui (`agentId`). Sans mission : 403 `MISSION_NON_AFFECTEE` ; observation d'un autre agent : 403 `OBSERVATION_NON_AUTEUR`. Le droit de lire une proposition n'est pas un droit d'écrire à son dossier. La proposition doit en outre être dans son périmètre (sinon le 404 du §1).

### 2.3 Périmètre territorial

Relu en base à chaque requête (`perimetres_comptes`, via `perimetreDe`). Un compte sans rattachement est national (comportement de A10, `territoire/territoire.noyau.ts`).

**À savoir (choix du dépôt, pas de ce module).** Un compte sans ligne dans `perimetres_comptes` est NATIONAL : un inspecteur ou un gestionnaire nouvellement créé, sans région, voit donc toutes les propositions, toutes les preuves et les deux agrégats nationaux dès qu'il a la clé de module `teledetection`. Rattacher chaque compte à une région est une donnée d'organisation qu'AGEROUTE doit fournir (D-11) ; l'API n'invente aucun périmètre par défaut plus étroit.

- Un compte régional ne voit et ne décide que les propositions dont `regionId` est dans son périmètre ; la clause est dans le SQL (listes, comptage, GeoJSON, synthèse), pas appliquée après coup.
- Les propositions **non rattachées** (`regionId` nul) ne sont visibles que d'un compte national.
- Filtre `regionId` hors périmètre d'un compte régional : 403 `HORS_PERIMETRE` (liste et synthèse).
- Le dépôt de lot (`POST /produits`, `POST /propositions`) et la synchronisation du catalogue sont des opérations sur l'ensemble du territoire : refusées à un compte régional (403 `HORS_PERIMETRE`). Décision de conduite, réversible.
- **`GET /precision` et `GET /qualite-methodes` sont réservés aux comptes NATIONAUX** (403 `HORS_PERIMETRE`, avant toute lecture). Ce sont des agrégats par méthode calculés sur toutes les régions par des vues non régionalisables : servis à un compte régional, ils lui rendaient les comptes de verdicts d'autres régions (EO-FIX-BACK 1, reproduit puis corrigé). C'est le choix le plus simple et le plus sûr ; recalculer par région exigerait de nouvelles vues et un seuil d'échantillon propre à chaque région. **Le taux de confirmation d'une région se lit dans `GET /synthese`** (`tauxConfirmation`, filtré par région, avec effectif et seuil) ; le DÉTAIL PAR MÉTHODE (type x méthode) n'existe que pour un compte national. L'interface traite ce 403 comme une « absence de permission » (état dédié, contrat §7), pas comme une erreur ni comme un vide.
- **Preuves de terrain** : un compte régional ne cite (`transition`, `preuves`) et ne lit que les observations de son périmètre. La région d'une observation est celle de son rattachement, comme partout dans l'application (`territoire.v2.ts`) : le premier lien renseigné parmi tronçon, ouvrage, chantier, puis la mission. Une observation dont aucun lien n'a de région (par exemple une observation géolocalisée sans tronçon ni mission) a une région INCONNUE : seul un compte national la cite et la lit. Une observation inexistante et une observation hors périmètre donnent la MÊME réponse : 404 `OBSERVATION_INEXISTANTE`, même texte, aucun identifiant. Le détail re-contrôle à la LECTURE : il ne rend ni l'auteur, ni le type, ni la description d'une observation que le lecteur ne peut pas voir, et compte celles qu'il masque (`terrain.observationsMasquees`). Conséquence à confirmer : un inspecteur régional ne peut pas citer sa propre observation si elle n'a pas de région déterminable.
- **Trois périmètres de comptage, trois définitions de la région** (constat EO-FIX-BACK 9, comportement inchangé) : `/synthese` et les listes utilisent la région FIGÉE de la proposition (celle du tronçon au dépôt, `propositions_teledetection.regionId`) ; l'indicateur `propositions_a_verifier` du tableau de bord suit la région COURANTE du tronçon (`troncons.regionId` au moment du calcul) ; le compteur « alertes satellite » de la veille (`exploitation/veille.service.ts`) est NATIONAL pour tous les comptes. Si un tronçon change de région, ces trois chiffres peuvent diverger : aucun n'est faux, ils ne répondent pas à la même question.

## 3. Routes

Lecture (module `teledetection`, tout rôle) :

| Route | Rôle |
|---|---|
| `GET /synthese?regionId&depuis&jusqua` | compteurs de l'écran de synthèse (`calculerSynthese`), périmètre du compte |
| `GET /propositions?statut&type&source&methode&regionId&tronconId&priorite&rattachee&depuis&jusqua&q&curseur&limite` | `{ items, suivant, total }` |
| `GET /propositions.geojson?bbox&statut&type&priorite&limite` | FeatureCollection avec `tronque` et `total` |
| `GET /propositions/:id` | détail complet (contrat §6, complété §7 ci-dessous) |
| `GET /produits?source&nature&depuis&jusqua&bbox&curseur&limite` | `{ items, suivant, total }` |
| `GET /produits/:id/apercu` | image lue par le serveur, ou 404 `APERCU_INDISPONIBLE` |
| `GET /sources` | tableau des sources, état lu en base |
| `GET /precision` | conservée : `{ methode, lignes }` ; compte NATIONAL seulement (403 `HORS_PERIMETRE` sinon) |
| `GET /qualite-methodes` | `{ seuilEchantillon, definition, lignes }` (vue `qualite_methodes_eo`) ; compte NATIONAL seulement |

Écriture :

| Route | Corps | Succès |
|---|---|---|
| `POST /propositions/:id/transition` | `{ vers, motif, commentaire?, motifAttente?, observationIds?, constatRef? }` | 200 |
| `POST /propositions/:id/verification` | `{ commentaire?, assigneId?, debutPrevu? }` | 201, la mission |
| `POST /propositions/:id/preuves` | `{ observationIds[1..20] }` | 201 `{ ajoutees, dejaCitees }` |
| `POST /sources/:code/verifier` | `{}` | 200, ou 503/429 avec l'état enregistré |
| `POST /sources/:code/synchroniser-catalogue` | `{ bbox, depuis, jusqua, nuagesMax }` | 200, le rapport |
| `POST /produits` | produit + traçabilité fournisseur | 201 |
| `POST /propositions` | `{ produitId, produitReferenceId?, methodeNom, methodeVersion, toleranceRattachementM?, synthetique?, propositions[] }` | 201 |

L'ancienne route `POST /propositions/:id/verdict` est **supprimée** : elle est remplacée par `/transition` (un verdict est une transition vers `CONFIRMEE` ou `INFIRMEE`, avec constat). Aucun client du dépôt ne l'appelait.

## 4. Paramètres, bornes et filtres (PROVISOIRES sauf mention)

Tout paramètre inconnu, vide, mal formé ou hors borne donne 400 : **aucun filtre n'est ignoré**. `statut`, `type`, `priorite`, `source` acceptent une valeur, une liste séparée par des virgules, ou un tableau (`statut[]=A&statut[]=B`) ; chaque valeur doit être connue.

| Paramètre | Règle |
|---|---|
| `limite` | entier de 1 à 100 (défaut 25) ; GeoJSON : 1 à 1000 (défaut 300) |
| `curseur` | opaque, émis par `suivant` ; tri date d'observation décroissante puis identifiant. Sa date doit être canonique (relue par `Date`, elle redonne le même texte) et comprise entre l'an 2000 et l'année courante + 1 : `0000-01-01`, `2026-02-31` ou `9999-12-31` donnent 400 `ENTREE_INVALIDE` (elles donnaient 500 : erreur SQL sur `::timestamp`) |
| `bbox` | `ouest,sud,est,nord` obligatoire pour le GeoJSON, dans le globe, ouest < est, sud < nord, **côté de 10 degrés au plus** (`BBOX_COTE_MAX_DEG` de `api.noyau.ts`, PROVISOIRE : vue d'ouverture nationale de la carte, la Guinée faisant environ 7,5 x 5,7 degrés ; 9,99 passe, 10,01 est refusé) ; produits : 20 degrés |
| `depuis`, `jusqua` | `AAAA-MM-JJ` ou date-heure avec fuseau, entre le 01/01/2000 et maintenant + 1 an ; `jusqua` sans heure = fin de ce jour |
| `rattachee` | `true` ou `false` |
| `tronconId` | UUID ; `regionId` entier ; `q` 100 caractères au plus (`%`, `_`, `\` échappés) |
| plafond GeoJSON | ordre de plafonnement : priorité HAUTE, puis `A_VERIFIER`, puis identifiant |

Synchronisation du catalogue : `bbox` obligatoire (le `corridorId` du contrat est refusé en 400 explicite dans cette version), côté de 2 degrés au plus, fenêtre de 92 jours au plus, dates entre le 23/06/2015 et demain, `nuagesMax` obligatoire (0 à 100), au plus 4 pages et 200 produits par appel.

Corps : tous les schémas sont `.strict()` (champ inconnu refusé), identifiants en UUID, textes bornés (`motif` 1000, `commentaire` 2000, verification 500, limites 500 chacune sur 20 au plus), lot de 5000 propositions au plus.

Entrées hostiles refusées en 400 (prouvé par le banc, aucune ligne écrite) : `coordinates` en texte ou absentes, type de géométrie inconnu, polygone ouvert, d'aire nulle ou auto-intersecté, position hors du globe ou en 3D, `NaN`, emprise de produit hors de [-180,180] x [-90,90], dates absurdes (l'an 2999), champ inconnu (`confianceCalibree: true`), limites absentes. Un refus de PostGIS (par exemple un trou hors de l'anneau, que le contrôle JS ne voit pas) est traduit en 400 `ENTREE_INVALIDE` sur les routes de dépôt.

## 5. Contrat des erreurs

Corps : `{ "error": string, "code": string }` pour TOUTES les erreurs du module (plus des membres en supplément pour certaines : `etat`, `source`, `resultat`, `retryApresS`, `details`). L'interface se fonde sur `code`.

| HTTP | `code` | Quand |
|---|---|---|
| 400 | `ENTREE_INVALIDE` | paramètre ou corps invalide (détails dans `details` pour un corps) |
| 400 | codes du service (`CONSTAT_REQUIS`, `MOTIF_REQUIS`, `MOTIF_ATTENTE_REQUIS`, `LIMITES_REQUISES`, `NUAGES_REQUIS`, `DEPENSE_NON_AUTORISEE`, `HORS_EMPRISE`, `SYNTHETIQUE_INCOHERENT`, `FOURNISSEUR_INCOMPLET`...) | règle métier du service d'EO-DB |
| 401 | `NON_AUTHENTIFIE` | pas de jeton, jeton forgé ou expiré |
| 403 | `MODULE_NON_AUTORISE` | clé `teledetection` absente |
| 403 | `ROLE_INSUFFISANT` | rôle non autorisé pour la route |
| 403 | `HORS_PERIMETRE` | filtre de région hors périmètre ; opération ou agrégat national refusé à un compte régional (dépôt, synchronisation, `/precision`, `/qualite-methodes`) |
| 403 | `MISSION_NON_AFFECTEE`, `OBSERVATION_NON_AUTEUR` | droits de l'inspecteur (§2.2) |
| 404 | `INTROUVABLE` | ressource inexistante ou hors périmètre (corps identique) ; source inconnue |
| 404 | `APERCU_INDISPONIBLE` | aperçu absent, accès non établi, échec du fournisseur |
| 404 | `PRODUIT_INEXISTANT`, `REFERENCE_INEXISTANTE`, `ROUTE_INCONNUE` | références d'un dépôt ; route inconnue du module |
| 404 | `OBSERVATION_INEXISTANTE` | observation citée en preuve inexistante OU hors du périmètre du compte (réponse identique, aucun identifiant dans le message) |
| 409 | `TRANSITION_INTERDITE`, `VERDICT_DEFINITIF`, `MISSION_DEJA_DEPECHEE`, `STATUT_CHANGE_ENTRE_TEMPS` | état de la proposition |
| 409 | `SOURCE_NON_CONFIGUREE` | source façade (PlanetScope, SPOT) : aucune interrogation possible |
| 409 | `CONFLIT` | contrainte d'unicité ou référence |
| 429 | `LIMITE_ATTEINTE` | plafond sortant du serveur (6 vérifications ou synchronisations par minute et par source, 120 aperçus par minute) ; `retryApresS` |
| 429 | `QUOTA_SOURCE`, `SYNCHRO_EN_COURS` | limite annoncée par le fournisseur ; synchronisation déjà en cours |
| 500 | `ERREUR_INTERNE` | erreur imprévue : jamais de détail au client, jamais présentée comme un résultat vide |
| 503 | `SOURCE_INDISPONIBLE` | le catalogue ne répond pas ; l'état `EN_ERREUR` est enregistré (corps : `etat`, `source`, `resultat`) |

Limite connue, hors du module : un corps JSON mal formé, un corps JSON scalaire ou un corps de plus de 5 Mio est traité par `body-parser` **avant** le routeur, et le middleware d'erreur global (`middleware/error.middleware.ts`) le rend en `500 { error: "Erreur interne du serveur" }` sans `code` (constaté par le banc). Correction demandée dans le rapport.

## 6. Données honnêtes

- Les données **synthétiques** (`synthetique: true`) n'apparaissent dans aucune liste, aucun comptage, aucun GeoJSON, aucune synthèse, aucun indicateur ; le détail par identifiant les rend avec leur drapeau.
- `confianceDetection.calibree` vaut `false` ; le texte `signification` dit « indice non calibré » ; une valeur absente reste `null`.
- `priorite.niveau` nul : la règle dit « Priorité non évaluée » ; `rattachement.confiance` nulle = non évalué (ligne d'avant la migration), jamais « faible » ou « aucun » inventé.
- `methode` : `nom` retombe sur l'ancienne chaîne `methode` et `version` est `null` pour une ligne d'avant la migration.
- `apercuDisponible` et `apercus.*.url` : l'URL est celle du SERVEUR (`/api/v2/teledetection/produits/:id/apercu`), jamais celle du fournisseur ; `true`/non nulle signifie qu'une tentative est possible (produit de catalogue, non synthétique), pas que la vignette existe : seul l'appel le dit (404 sinon). Produit saisi à la main : `apercuDisponible: false`, `url: null`.
- Le taux de confirmation est `null` à zéro verdict, jamais 0 %.
- `limites` : `null` et `limitesNonRenseignees: true` pour une ligne d'avant la migration du workflow (colonne NULL) : « non renseignées » n'est pas « aucune limite » (EO-FIX-BACK 8 ; elle rendait `[]`). Renseignées : la liste, `limitesNonRenseignees: false`.
- `source` : les valeurs de repli sont étiquetées. `resolutionOrigine` vaut `NATIVE_PRODUIT` (résolution native du produit), `PRODUIT_LIVRE` (à défaut, résolution du produit livré, qui n'est pas la native) ou `null` ; `capteurOrigine` vaut `PRODUIT`, `SOURCE` (capteur de la ligne de source, à défaut de celui du produit) ou `null`.

## 7. Compléments au contrat (à reporter dans `CONTRAT-API-UI.md`)

1. `POST /propositions/:id/preuves` `{ observationIds[] }` (comble le manque : l'INSPECTEUR ajoute des preuves sans décider).
2. `transition` accepte `constatRef` (référence libre du constat), en plus de `observationIds` : un verdict cite l'un ou l'autre.
3. `verification` accepte `assigneId` et `debutPrevu` (champs du service) en plus de `commentaire` (journalisé dans l'audit, le service n'a pas de colonne pour lui).
4. Codes ajoutés : 401 `NON_AUTHENTIFIE`, 403 `MODULE_NON_AUTORISE`, `MISSION_NON_AFFECTEE`, `OBSERVATION_NON_AUTEUR`, 404 `INTROUVABLE`, `ROUTE_INCONNUE`, 409 `SOURCE_NON_CONFIGUREE`, 429 `LIMITE_ATTEINTE`, `QUOTA_SOURCE`, `SYNCHRO_EN_COURS`, 500 `ERREUR_INTERNE`.
5. Détail : `motifAttente`, `verdict { statut, le, motif, constatRef }`, `rattachementCandidats`, et `produitApres` / `produitAvant` définis ainsi : `{ id, code, sourceCode, source, fournisseur, identifiantFournisseur, collection, capteur, nature, niveauTraitement, scene, dateAcquisition, resolutionM, resolutionNativeM, couvertureNuagesPct, cycleVie, synthetique }`.
6. `GET /sources` : membres supplémentaires `adaptateur` (adaptateur de catalogue relié, ou `null`) et `active` (`etat === TRAITEMENT_OPERATIONNEL`). `:code` accepte le code de base (`SENTINEL2`) ou le code d'adaptateur (`cdse-stac`).
7. `GET /qualite-methodes` : forme `{ seuilEchantillon, definition, lignes[] }` ; chaque ligne porte `total`, les cinq compteurs de statut, `jugees`, `tauxConfirmation` (nul à zéro verdict), `echantillonSuffisant`, `seuilEchantillon`.
8. `POST /sources/:code/synchroniser-catalogue` rend aussi `zone`, `complet`, `pagination`, `latenceMs`, `requetes`, `diagnostics` et au plus 50 `produits`. `complet: false` = recherche arrêtée par un plafond ; jamais une liste tronquée présentée comme complète.
9. `GET /propositions.geojson` accepte aussi `priorite`.
10. Le dépôt de lot, de produit et la synchronisation sont refusés aux comptes régionaux.
11. Observations citées en preuve : 404 `OBSERVATION_INEXISTANTE` (et non plus 400, avec les identifiants dans le message) ; un compte régional ne cite et ne lit que les observations de son périmètre ; `terrain.observationsMasquees` compte celles que le détail ne montre pas au lecteur.
12. `/precision` et `/qualite-methodes` : comptes nationaux seulement (403 `HORS_PERIMETRE`). Le taux de confirmation régional vient de `/synthese`.
13. Détail : `limites` peut être `null` avec `limitesNonRenseignees: true` ; `source.resolutionOrigine` et `source.capteurOrigine` disent d'où vient la valeur.
14. Synchronisation : `pagination.raisonArret` peut valoir `PAGE_TRONQUEE` (le catalogue a rendu plus d'items que la page demandée : seuls les premiers sont lus) en plus de `FIN`, `PLAFOND_PAGES`, `PLAFOND_PRODUITS` et `PLAFOND_DECALAGE` ; `complet` n'est vrai que pour `FIN`. Le plafond de produits est tenu au produit près, même en milieu de page.
15. `GET /propositions.geojson` : l'emprise admise passe de 5 à 10 degrés de côté (la limite reste un garde contre un balayage du globe) ; `tronque` et `total` disent combien de propositions la réponse plafonnée (300 par défaut) laisse de côté.

## 8. Sources

Correspondance (`sources.service.ts`, PROVISOIRE) : `SENTINEL2` vers `cdse-stac` (collection `sentinel-2-l2a`), `LANDSAT89` vers `earth-search` (collection `landsat-c2-l2`, recherche seulement), `PLANETSCOPE` vers la façade `planetscope`, `SPOT` vers la façade `spot`. Le repli Earth Search pour Sentinel-2 n'a pas de ligne propre en base.

- **Vérifier** : appelle l'adaptateur (`verifierConnectivite`, ou une sonde sur la collection propre de Landsat) et enregistre le résultat par `changerEtatSource` : `ACCESSIBLE` ou `PRODUIT_DISPONIBLE` au plus ; **jamais `TRAITEMENT_OPERATIONNEL`** (un test de catalogue ne prouve pas un traitement) ; une source déjà opérationnelle dont le test réussit garde son état, un échec la fait descendre. Façade : `EN_ATTENTE_CONFIGURATION`, aucune requête. Catalogue en panne : l'état `EN_ERREUR` est enregistré puis réponse 503 `SOURCE_INDISPONIBLE`. Message enregistré = message du test + latence. Audit : l'écriture d'état du service, plus une ligne `VERIFIER_CONNECTIVITE` (adaptateur, état atteint, produits trouvés, latence, requête sans secret).
- **Synchroniser** : `rechercher` puis `enregistrerProduits`, dans une seule transaction avec la ligne d'audit `SYNCHRONISER_CATALOGUE`. Rapport `{ trouves, nouveaux, dejaConnus, ecartes }` avec `trouves = nouveaux + dejaConnus + somme(ecartes)`. Sont **écartés sans être enregistrés**, par raison : produit sans emprise valide (`PRODUIT_ECARTE_EMPRISE_INVALIDE` du moteur, `EMPRISE_INVALIDE` ici), optique sans couverture nuageuse (`NUAGES_REQUIS`), date absurde (`DATE_ABSURDE`), doublon de pagination, produit au-dessus du seuil de nuages. Un produit de catalogue n'enregistre qu'une référence (cycle `CATALOGUE`, aucune empreinte, aucun stockage). La licence enregistrée est le code de licence du fournisseur et son URL.
- **Aperçu** : `metadonnees` puis `urlApercu` de l'adaptateur, puis lecture de l'image par le serveur. **Hôtes admis : une liste d'hôtes EXACTS**, ceux que montrent les fixtures réelles d'EO-SOURCES : `datahub.creodias.eu` (vignette du CDSE), `zipper.creodias.eu` (destination de sa redirection, constat du 25/10/2026) et `sentinel-cogs.s3.us-west-2.amazonaws.com` (vignette Sentinel-2 d'Earth Search). Aucun suffixe (l'ancien `.amazonaws.com` acceptait le seau d'un tiers et les noms ec2) ; HTTPS seulement, port 443 seulement, pas d'adresse IP littérale, pas d'identifiants dans l'URL. Un hôte de plus se constate sur une réponse réelle puis s'ajoute à `HOTES_APERCU_ADMIS` (`sources.service.ts`). **À chaque saut** (adresse de départ et chacune des 2 redirections au plus), l'hôte doit être dans la liste ET son nom doit se résoudre uniquement vers des adresses publiques (ni boucle locale, ni réseau privé, lien local, CGNAT, multicast ; une résolution en échec ou vide est un refus). Limite : le `fetch` résout le nom de son côté, une seconde fois (fenêtre de rebond DNS de quelques millisecondes), rendue peu exploitable par la liste exacte. **Le corps est lu en flux et coupé à 1,5 Mo** même sans `Content-Length` (ou avec un faux) : le fournisseur n'est pas lu jusqu'au bout. Image jpeg, png ou webp ; délai 15 s. En-têtes : `Cache-Control: private, max-age=300`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`. Cache mémoire de 15 minutes, 30 images. Aucune clé ni URL du fournisseur dans la réponse ; aucun appel d'authentification (la recherche anonyme suffit, les accès avec jeton OIDC ou clés S3 sont du Lot suivant).
- **Variables d'environnement** : aucune n'est lue (voir `SOURCES.md` §11) ; `backend/.env.example` déclare les quatre noms `CDSE_*` avec la valeur `changeme`, en commentaire.

## 9. Audit

Toute écriture est auditée dans la transaction qui la porte (le service d'EO-DB le fait ; vérifié par le banc : `EarthObservationProduct` CREATE, `PropositionTeledetection` CREATE / UPDATE / VALIDATE / REJECT, `PropositionTeledetectionPreuve` CREATE, `Mission` CREATE, `SourceObservation` UPDATE). Ajouts d'EO-API, dans la même transaction : identifiants des propositions d'un lot (`DEPOT_LOT_IDENTIFIANTS`, 500 par ligne), commentaire de demande de vérification (`DEMANDE_VERIFICATION`), `VERIFIER_CONNECTIVITE`, `SYNCHRONISER_CATALOGUE`. **Les lectures ne sont pas auditées** (le banc vérifie que le nombre de lignes d'audit ne bouge pas après une série de GET).

## 10. Exemples (issus des exécutions du 25/10/2026)

Valeurs raccourcies (`...`) ; identifiants et dates sont ceux de l'exécution.

`GET /synthese` sur une base avec 3 propositions à vérifier et 4 sources amorcées :

```json
{ "periode": { "depuis": null, "jusqua": null },
  "propositions": { "aVerifier": 3, "enAttente": 0, "nonConcluantes": 0, "confirmees": 0, "infirmees": 0, "prioritaires": 1 },
  "tauxConfirmation": { "confirmees": 0, "infirmees": 0, "jugees": 0, "valeur": null, "echantillonSuffisant": false, "seuil": 30, "definition": "..." },
  "sources": { "total": 4, "parEtat": { "NON_CONFIGUREE": 2, "EN_ATTENTE_CONFIGURATION": 2, "...": 0 }, "actives": 0 },
  "derniereAcquisition": { "produitId": "4a7a7657-...", "source": "Sentinel-1 GRD", "date": "2026-10-02T00:00:00.000Z", "resolutionM": 10 },
  "fraicheur": { "dateCalcul": "2026-10-25T22:10:34.154Z", "ageDerniereAcquisitionJours": 23 } }
```

`GET /propositions` (un élément sur trois) :

```json
{ "items": [ { "id": "2cb223db-...", "type": "INONDATION", "statut": "A_VERIFIER",
    "priorite": { "niveau": "HAUTE", "regle": "banc-regle-1" },
    "confianceDetection": { "valeur": 0.87, "calibree": false, "signification": "Indice rendu par la methode de detection, non calibre : ce n'est pas une probabilite que la detection soit exacte." },
    "qualiteImage": { "couvertureNuagesPct": 12, "note": null },
    "rattachement": { "confiance": "HAUTE", "distanceM": 11.0565582, "algorithme": "PLUS_PROCHE_DANS_TOLERANCE_V1" },
    "methode": { "nom": "banc-sar", "version": "v1" },
    "source": { "code": "Sentinel-1 GRD", "nom": "Sentinel-1 GRD", "capteur": null, "resolutionM": 10 },
    "dateObservation": "2026-10-02T00:00:00.000Z", "dateReference": "2026-09-01T00:00:00.000Z",
    "troncon": { "id": "738fab20-...", "code": "API-A", "nom": "Troncon API-A", "regionId": 111, "regionNom": "Region API 1" },
    "rattachee": true, "centre": { "lat": 9.6401, "lon": -13.595 }, "apercuDisponible": false, "synthetique": false, "missionId": null } ],
  "suivant": null, "total": 3 }
```

`GET /propositions.geojson?bbox=-13.7,9.1,-12.9,10.0&limite=2` (3 propositions dans l'emprise) :

```json
{ "type": "FeatureCollection",
  "features": [ { "type": "Feature", "geometry": { "type": "Point", "coordinates": [-13.595, 9.6401] },
                  "properties": { "id": "2cb223db-...", "type": "INONDATION", "statut": "A_VERIFIER", "priorite": "HAUTE", "rattachee": true } }, "..." ],
  "tronque": true, "total": 3 }
```

`GET /propositions/:id` après quatre transitions (extrait : `historique`, `verdict`, `terrain`) :

```json
{ "statut": "CONFIRMEE", "verdict": { "statut": "CONFIRMEE", "le": "2026-10-25T22:10:36.906Z", "motif": "Eau constatee sur 40 m", "constatRef": "observation:e8963391-..." },
  "historique": [ { "de": "A_VERIFIER", "vers": "EN_ATTENTE", "auteur": { "id": "64f0e881-...", "nom": "Compte eo-gest" }, "date": "2026-10-25T22:10:35.317Z", "motif": "Equipe prevenue", "commentaire": "Voir l'equipe du pont" }, "..." ],
  "terrain": { "observations": [ { "id": "e8963391-...", "date": "2026-10-25T22:10:34.824Z", "auteur": "Compte eo-insp", "resume": "DEGRADATION : Chaussee submergee sur 40 m" } ] },
  "limites": [ "Resolution native 10 m : les nids-de-poule et les fissures fines ne sont pas detectables." ],
  "apercus": { "avant": { "url": null, "date": "2026-09-01T00:00:00.000Z" }, "apres": { "url": null, "date": "2026-10-02T00:00:00.000Z" } },
  "...": "produitApres, produitAvant, provenance, geometrie, mission..." }
```

`POST /propositions/:id/transition` : 200 `{ "id": "2cb223db-...", "de": "A_VERIFIER", "vers": "EN_ATTENTE", "statut": "EN_ATTENTE", "motifAttente": "INFO_DEMANDEE", "transitionId": "a2774070-...", "preuvesAjoutees": 0, "verdict": null }` ; 409 `{ "error": "Transition interdite : A_VERIFIER vers A_VERIFIER.", "code": "TRANSITION_INTERDITE" }` ; 409 `{ "error": "Le terrain a deja juge (CONFIRMEE) : le verdict ne se reprend pas.", "code": "VERDICT_DEFINITIF" }`.

404 (hors périmètre, non rattachée pour un compte régional, inexistante, ou identifiant mal formé) : `{ "error": "Ressource introuvable", "code": "INTROUVABLE" }`.

400 (polygone auto-intersecté) : `{ "error": "Corps invalide : propositions.0.geometrie : geometrie anneau exterieur : polygone auto-intersecte", "code": "ENTREE_INVALIDE", "details": { "propositions": [ "..." ] } }` ; refus de PostGIS : `{ "error": "Une valeur deposee est refusee par la base (geometrie ou donnee invalide).", "code": "ENTREE_INVALIDE" }`.

`GET /qualite-methodes` (2 verdicts, échantillon insuffisant) : `{ "seuilEchantillon": 30, "definition": "...", "lignes": [ { "type": "INONDATION", "methode": "banc-sar v1", "methodeNom": "banc-sar", "methodeVersion": "v1", "total": 2, "aVerifier": 0, "enAttente": 0, "nonConcluantes": 0, "confirmees": 1, "infirmees": 1, "jugees": 2, "tauxConfirmation": 0.5, "echantillonSuffisant": false, "seuilEchantillon": 30 }, { "type": "NOUVELLE_ROUTE", "...": "jugees: 0, tauxConfirmation: null" } ] }`.

`POST /sources/cdse-stac/verifier` (adaptateur injecté sur fixture réelle) : 200 `{ "source": { "code": "SENTINEL2", "adaptateur": "cdse-stac", "etat": "PRODUIT_DISPONIBLE", "derniereVerification": "2026-10-25T22:10:40.323Z", "message": "catalogue accessible sans identifiants ; au moins un produit sentinel-2-l2a dans les 60 derniers jours (34 ms)" }, "resultat": { "etatAtteint": "PRODUIT_DISPONIBLE", "latenceMs": 34, "produitsTrouves": 2, "requete": "POST https://stac.dataspace.copernicus.eu/v1/search {...", "categorieErreur": null }, "changement": true, "de": "NON_CONFIGUREE", "vers": "PRODUIT_DISPONIBLE" }`. Catalogue en panne : 503 `{ "etat": "EN_ERREUR", "source": { "...": "..." }, "resultat": { "categorieErreur": "INDISPONIBLE", "...": "..." }, "error": "Le catalogue ne repond pas : INDISPONIBLE : HTTP 503 : oups", "code": "SOURCE_INDISPONIBLE" }`.

`POST /sources/cdse-stac/synchroniser-catalogue` avec des produits sans nuages et sans emprise valide : `{ "trouves": 3, "nouveaux": 0, "dejaConnus": 1, "ecartes": { "PRODUIT_ECARTE_EMPRISE_INVALIDE": 1, "NUAGES_REQUIS": 1 }, "complet": true, "pagination": { "pagesLues": 1, "totalAnnonce": null, "raisonArret": "FIN" }, "diagnostics": [ { "niveau": "AVERTISSEMENT", "code": "NUAGES_ABSENTS", "nombre": 1 }, "..." ], "...": "..." }`.

`GET /produits/:id/apercu` : 404 `{ "error": "Apercu indisponible : le fournisseur a repondu 404", "code": "APERCU_INDISPONIBLE" }`.

### Vérification réelle (une fois, 25/10/2026, hors tests)

API du worktree sur le port 3401, base clone `essai_eo_api`, compte ADMIN de test au mot de passe aléatoire (connexion par `/api/auth/login`), **vrai adaptateur CDSE** (recherche STAC anonyme, Boké 10,93 N ; 14,29 O, +/- 0,1 degré, 30 derniers jours, nuages de tuile <= 50 %) :

| Étape | Résultat |
|---|---|
| `POST /sources/cdse-stac/verifier` | 200 en 2,03 s (latence catalogue 1 923 ms) : `NON_CONFIGUREE` vers `PRODUIT_DISPONIBLE`, 1 produit |
| `POST .../synchroniser-catalogue` (1er appel) | 200 en 0,78 s : 7 trouvés, 7 nouveaux, 0 déjà connu, aucun écarté, recherche complète, 1 requête |
| `POST .../synchroniser-catalogue` (2e appel) | 200 en 0,65 s : 7 trouvés, **0 nouveau, 7 déjà connus** (déduplication) |
| `GET /sources` | `SENTINEL2` : `PRODUIT_DISPONIBLE`, dernière acquisition 22/10/2026 ; **0 source active** |
| `GET /produits?source=SENTINEL2` | 7 produits L2A, résolution native 10 m, orbite relative 137 descendante ; nuages de tuile 2,4 %, 17,09 %, 17,26 % pour les trois premiers |
| `GET /produits/:id/apercu` (1er produit) | **404 `APERCU_INDISPONIBLE`** en 5,6 s : « le fournisseur n'a pas rendu une image ». L'accès anonyme à la vignette CDSE reste non établi (cohérent avec `SOURCES.md` §9) |

Requêtes réseau réelles : 1 (vérification) + 1 + 1 (synchronisations) + les lectures de l'aperçu (métadonnées et au plus trois sauts de vignette) : moins de 10. Serveur arrêté et clone supprimé ensuite.

## 11. Lignes pour `docs/securite/CONTROLE-ACCES.md`

Ce fichier n'existe pas dans le worktree (il est dans l'arbre principal, non commité) ; à ajouter à l'intégration :

| Route | Garde | Rôles | Périmètre |
|---|---|---|---|
| `GET /api/v2/teledetection/*` (synthèse, propositions, produits, sources, aperçu) | jeton + module `teledetection` | ADMIN, GESTIONNAIRE, INSPECTEUR, LECTEUR | propositions : région du compte ; non rattachées : national seulement ; 404 identique hors périmètre ; preuves : observations du périmètre seulement |
| `GET /precision`, `GET /qualite-methodes` | idem | ADMIN, GESTIONNAIRE, INSPECTEUR, LECTEUR | compte national seulement (403 `HORS_PERIMETRE`) |
| `POST /propositions/:id/transition`, `/verification` | idem | ADMIN, GESTIONNAIRE | région de la proposition (404 identique) |
| `POST /propositions/:id/preuves` | idem | ADMIN, GESTIONNAIRE, INSPECTEUR (mission affectée, ses observations) | région de la proposition |
| `POST /sources/:code/verifier` | idem | ADMIN | sans objet (sources non territoriales) |
| `POST /sources/:code/synchroniser-catalogue`, `POST /produits`, `POST /propositions` | idem | ADMIN, GESTIONNAIRE | compte national seulement (403 `HORS_PERIMETRE`) |

## 12. Tests et commandes

- `cd backend && npx vitest run src/api-v2/teledetection src/teledetection src/securite` (gardes réelles, Prisma simulé : matrice complète rôle x route, oracle fermé, entrées hostiles, pagination, erreurs, sources sur fixtures réelles sans réseau). `src/securite/teledetection-acces.test.ts` énumère les routes du routeur : une route ajoutée sans la garde de module fait échouer ce test.
- `DATABASE_URL=postgresql://utilisateur:motdepasse@127.0.0.1:5434/replay npx tsx tests-integration/eo-api.integration.mts` (clone `essai_eo_api` créé, migrées et détruit par le banc ; voir `tests-integration/README.md`).
- Limite de la base simulée : elle ne prouve ni PostGIS, ni les déclencheurs ; le banc le fait.
- `DATABASE_URL=... npx tsx tests-integration/eo-workflow.integration.ts` (base `essai_eo_workflow` migrée jusqu'à `20261028130000`) : sa DERNIÈRE section joue de VRAIS COMMIT sur un clone (`essai_eo_workflow_commit`, créé puis détruit) ; c'est elle qui prouve les gardes du journal, qui ne se jouent qu'au COMMIT (voir `MODELE-DONNEES.md` §3).
