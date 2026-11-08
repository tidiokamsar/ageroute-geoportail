# Observation de la Terre : moteur de catalogue satellitaire (chantier EO-SOURCES)

Code : `backend/src/teledetection/sources/`. Ce document décrit le contrat, les adaptateurs, la sélection, les quotas cités, la procédure humaine pour obtenir des identifiants CDSE, et ce qui n'est pas fait. Les faits datés du 25/10/2026 viennent de requêtes anonymes réelles (voir §9 et §11).

Principe : le moteur **cherche** dans des catalogues publics. Il n'écrit rien en base (la persistance du registre des produits et de l'état des sources revient à EO-DB et EO-API), ne télécharge aucune scène et ne traite rien. Une valeur absente chez le fournisseur reste absente (`null`), jamais un zéro ni une valeur plausible.

## 1. Fichiers

| Fichier | Rôle |
|---|---|
| `contrat.ts` | Types (`SourceAdaptateur`, `ProduitNormalise`, `ParamsRecherche`, `ResultatRecherche`, `ResultatConnectivite`, quotas), `ErreurSource`, `classerErreur` |
| `geometrie.ts` | Validation d'emprise, intersection, part de zone couverte (noyau pur) |
| `normalisation.ts` | Item STAC -> `ProduitNormalise` (noyau pur) |
| `http.ts` | Client HTTP : retries bornés, backoff, `Retry-After`, délai, redirections, masquage des secrets |
| `quotas.ts` | Compteurs de requêtes de la session et limites citées |
| `stac.ts` | Recherche STAC commune : validation, pagination bornée, diagnostics, métadonnées, sonde de connectivité |
| `adaptateurs/cdse-stac.ts`, `earth-search.ts`, `facade.ts`, `commun.ts` | Les quatre sources |
| `selection.ts` | `choisirSource` (fonction pure) |
| `index.ts` | Point d'entrée et `creerAdaptateurs` |
| `verification-reelle.ts` | Vérification anonyme opt-in (`--oui`), non lancée par vitest |
| `__fixtures__/*.json` | Réponses RÉELLES capturées, étiquetées |
| `__fixtures__/synthetiques.ts` | Cas limites fabriqués (`synthetique: true`) |
| `*.test.ts`, `essais.support.ts` | Tests hors ligne |

## 2. Contrat

### 2.1 `SourceAdaptateur`

```
code, descriptif
rechercher(params)                    -> ResultatRecherche { produits, pagination, diagnostics, requetes, latenceMs }
metadonnees(id, { collection? })      -> ProduitNormalise | null          (null = 404 chez le fournisseur)
urlApercu(produit)                    -> DescriptionAcces                 (à exécuter CÔTÉ SERVEUR, jamais une URL pour le navigateur)
verifierConnectivite({ bbox?, joursFenetre?, sansReseau? }) -> { etatAtteint, message, latenceMs, requete, produitsTrouves, categorieErreur, verifieLe }
declencherTraitement / statutTraitement / recupererResultat   -> rejettent ErreurSource NON_SUPPORTE (aucune simulation)
classerErreur(e)                      -> QUOTA | AUTH | RESEAU | INDISPONIBLE | ENTREE | INCONNUE | NON_SUPPORTE
quotas()                              -> { compteurs de la session, limites citées }
```

`NON_SUPPORTE` est une septième catégorie, en plus des six demandées : une opération qui n'existe pas dans ce lot n'est ni une panne réseau ni une entrée invalide, et l'API doit pouvoir la répondre autrement qu'en 503.

### 2.2 `ProduitNormalise`

| Champ | Contenu |
|---|---|
| `identifiantFournisseur`, `fournisseur` (`CDSE`/`EARTH_SEARCH`), `source` (code adaptateur), `collection` | Identification chez le catalogue |
| `capteur` (`SENTINEL-2`/`SENTINEL-1`/`LANDSAT`), `nature` (`OPTIQUE`/`RADAR`), `plateforme`, `typeProduit`, `niveauTraitement` (`L1C`/`L2A`/`L1_GRD`/`L2`) | Nature du produit |
| `dateAcquisition`, `dateFinAcquisition` | ISO 8601 UTC. Repli sur `start_datetime` si `datetime` est nul (STAC l'autorise) |
| `emprise` | Polygon GeoJSON 4326 validé (anneau fermé, positions dans le globe, aire non nulle). Invalide : le produit est écarté, jamais remplacé par le `bbox` |
| `orbite` | `{ numeroRelatif, numeroAbsolu, sens }`. Pour Sentinel-2 chez Earth Search, l'orbite relative est lue dans le nom ESA du produit (`_R037_`) ; le reste reste `null` |
| `tuileMgrs`, `grille` | `28PET` et `MGRS-28PET` (Sentinel-2) ; `WRS2-203053` (Landsat) ; `null` pour le radar |
| `scene`, `cleScene` | Identifiant de scène commun aux catalogues et clé de déduplication (voir §6.2) |
| `resolutionNativeM`, `resolutionParBande`, `resolutionOrigine`, `echantillonnageM` | Résolution native la plus fine des bandes principales ; détail par bande ou polarisation ; origine (`FOURNISSEUR` ou `TABLE_CAPTEUR`) ; pas du pixel si différent (radar : 10 m pour 20 x 22 m) |
| `couvertureNuagesPct`, `nuagesPortee` | % annoncé. `null` pour un radar ou si absent. Portée `TUILE` (Sentinel-2) ou `SCENE` (Landsat) : c'est la mesure de l'ENTIER, pas de la zone |
| `licence` | `{ code, attribution, url }`. Sentinel : « Contains modified Copernicus Sentinel data <année d'acquisition> ». Landsat : domaine public USGS |
| `tailleOctetsAnnoncee` | Taille de l'archive téléchargeable (actif `Product`), sinon `_private.product_size`, sinon `null` |
| `liens` | `{ vignette, actifs[] }`, chaque lien : `href` sans identifiant ni requête, `acces` (`ANONYME`, `JETON_OIDC`, `CLES_S3`, `IDENTIFIANTS_CLOUD`, `INCONNU`) |
| `empreinteSha256` | Toujours `null` : calculée seulement après téléchargement |
| `brut` | Sous-ensemble réduit de la réponse (provenance), sans lien ni secret |

### 2.3 Connectivité et échelle du contrat API §4

`verifierConnectivite` envoie UNE requête de recherche anonyme (zone par défaut : Boké ±0,1°, fenêtre de 60 jours, `limit` 1).

| État | Quand |
|---|---|
| `PRODUIT_DISPONIBLE` | Réponse valide et au moins un produit exploitable dans la fenêtre |
| `ACCESSIBLE` | Réponse valide, aucun produit (ou produit écarté à la normalisation, avec ses codes) |
| `EN_ERREUR` | Échec ; `categorieErreur` et message assaini |
| `CONFIGUREE` | `sansReseau: true` : adaptateur configuré, rien envoyé |
| `EN_ATTENTE_CONFIGURATION` | Les deux façades, toujours, sans requête |

Elle ne rend jamais `AUTHENTIFIEE` (aucun identifiant utilisé) ni `TRAITEMENT_OPERATIONNEL` (exige un traitement réel réussi). Un test le vérifie sur chaque scénario.

### 2.4 Aperçu

`urlApercu(produit)` rend `{ executionCote: "SERVEUR", disponible, verifie, methode, url, authentification, typeContenu, raison, note }`. Cas :

- vignette HTTPS anonyme constatée (Earth Search Sentinel-2) : `disponible`, `verifie` ;
- vignette CDSE : `disponible` mais `verifie: false` (accès anonyme non constaté, voir §9) : à tenter côté serveur et répondre `APERCU_INDISPONIBLE` en cas d'échec ;
- vignette `s3://` (Earth Search Sentinel-1 et Landsat) : indisponible, identifiants cloud requis ;
- aucune vignette : `VIGNETTE_ABSENTE`, jamais une image de remplacement (contrat API §1.7).

## 3. Adaptateurs

### 3.1 `cdse-stac` (Copernicus Data Space Ecosystem)

- Service : `https://stac.dataspace.copernicus.eu/v1` (recherche : `POST /search`).
- Collections : `sentinel-2-l2a` (défaut), `sentinel-2-l1c`, `sentinel-1-grd`.
- Recherche anonyme. Téléchargement et traitement exigent un jeton OIDC ou des clés S3, NON disponibles dans ce lot (constaté : `download.dataspace.copernicus.eu` répond 401 `DAT-ZIP-604` sans jeton ; `eodata.dataspace.copernicus.eu` répond 403 sans clés, agent « sources réelles », 25/10/2026).
- Requête : `collections`, `bbox`, `datetime`, `limit`, `sortby` (date décroissante), `query` `{"eo:cloud_cover":{"lte":N}}` pour l'optique seulement, et l'extension `fields` (réponse allégée : un item L2A complet pèse environ 70 Ko pour 47 actifs ; réduit par `fields` : de 2,5 Ko (Sentinel-1) à 5 Ko (Sentinel-2) par item, mesuré le 25/10/2026).
- Pagination : lien `next` avec `body` complet et jeton de page (`token`).
- Le catalogue OData du CDSE n'est pas utilisé : 44 s contre 0,5 à 3,9 s pour le STAC sur la même requête (mesures de l'agent « sources réelles », 25/10/2026).
- Particularités : pas de total annoncé ; `eo:cloud_cover` est celui de la tuile entière ; l'identifiant est le nom du produit ESA (Sentinel-1 : suffixe `_COG`).

### 3.2 `earth-search` (Element 84, AWS)

- Service : `https://earth-search.aws.element84.com/v1`.
- Collections : `sentinel-2-l2a` (défaut), `sentinel-1-grd`, `landsat-c2-l2` (recherche seulement).
- Recherche anonyme ; total annoncé (`numberMatched`). Repli interchangeable du CDSE : même contrat, même normalisation.
- Constats du 25/10/2026 : COG et vignette Sentinel-2 L2A lisibles en HTTPS sans compte (`HEAD` de la vignette : 200, `image/jpeg`) ; actifs Sentinel-1 et Landsat en `s3://` (identifiants AWS requis, `storage:requester_pays: true` annoncé pour Sentinel-1) ; `fields` n'allège pas les actifs, d'où une page par défaut de 20 (au lieu de 50) et environ 15 Ko par item.
- Identifiant propre au catalogue (`S2C_28PES_20261025_0_L2A`), différent du nom ESA : le rapprochement avec le CDSE se fait par `cleScene`.

### 3.3 Façades `planetscope` et `spot`

Aucune requête, aucun abonnement, aucune commande. `verifierConnectivite` rend `EN_ATTENTE_CONFIGURATION` avec le message « interface prevue, aucune commande sans autorisation humaine ». `rechercher` et `metadonnees` rejettent `NON_SUPPORTE`. Leur descriptif n'affirme ni résolution, ni licence précise, ni tarif : aucune documentation de ces fournisseurs n'a été consultée dans ce chantier.

### 3.4 Non retenu

Planetary Computer (recherche anonyme, mais pixels avec jeton SAS) et USGS LandsatLook ont été mesurés par l'agent « sources réelles » ; aucun adaptateur n'est écrit. Le contrat les accueillerait.

## 4. Client HTTP

Un seul endroit où une requête part (`http.ts`). Tout est injectable (`fetch`, horloge, sommeil, hasard, journal) : les tests tournent hors ligne.

- `User-Agent: AGEROUTE-BDRI/<version>` (variable `AGEROUTE_VERSION`, sinon `npm_package_version`, sinon « inconnue »).
- Délai maximal par tentative : 30 s (corps compris).
- Nouvelles tentatives BORNÉES : 4 envois en tout, sur 408, 429, 5xx et panne réseau (une recherche est une lecture, la rejouer est sans effet de bord). Backoff exponentiel `500 ms x 2^(n-1)` plafonné à 20 s, avec gigue entre la moitié et la totalité du délai.
- `Retry-After` (secondes ou date HTTP) respecté ; au-delà de 60 s d'attente demandée on ne dort pas : l'erreur `QUOTA` porte `retryApresMs` et l'appelant décide.
- 400, 401, 403, 404 ne sont jamais rejoués.
- Redirections : au plus 2, même origine seulement, méthode préservée (GET, ou 307/308) ; sinon `REDIRECTION_REFUSEE`.
- Corps de réponse plafonné à 32 Mio.
- Aucun secret dans les journaux, messages d'erreur, descriptions de requête ni compteurs : URL masquées (identifiant, paramètres de signature), valeurs de `secrets` remplacées par `[SECRET]`, formes `Bearer`, `access_token=` et JSON nettoyées. Un test fait répéter le jeton par le serveur dans son corps d'erreur et vérifie qu'il n'apparaît nulle part.
- Pagination STAC : plafond de pages par collection (5), plafond de produits (500), garde `(page - 1) x limite <= 10 000` comptée en produits déjà lus, lien `next` hors de l'origine du catalogue refusé. Une recherche arrêtée par un plafond rend un curseur de reprise (`pagination.suivant`).

## 5. Quotas

`quotas()` rend deux choses distinctes : les COMPTEURS de la session (mesurés, chaque envoi HTTP compté, nouvelles tentatives comprises ; ils repartent de zéro au redémarrage et ne voient pas les autres instances) et les LIMITES, recopiées de la documentation, avec leur page et la date de consultation. Une limite que la documentation ne chiffre pas vaut `null`.

Source : <https://documentation.dataspace.copernicus.eu/Quotas.html>, consultée le 25/10/2026, compte « Copernicus General user ».

| Limite | Valeur | Concerne la recherche ? |
|---|---|---|
| STAC : requêtes par minute | non chiffrée (cellule « - » de la colonne « S3, OData, STAC ») | oui : un 429 reste possible |
| S3 : requêtes par minute | 2 000 (note 14 : S3 seulement) | non |
| Transfert sur 30 jours glissants | 12 To, puis 1 Mo/s et 1 connexion | non |
| Débit par connexion | 20 Mo/s | non |
| Connexions simultanées | 4 | non |
| Validité d'un jeton | 10 min (renouvelable dans les 60 min) | non |
| Sessions actives | 100 (chaque jeton généré en ouvre une) | non |
| Sentinel Hub : requêtes par mois | 10 000 | non (Lot suivant) |
| Sentinel Hub : requêtes par minute | 300 | non |
| Sentinel Hub : unités de traitement par mois | 10 000 | non |

Rate limiting Sentinel Hub : <https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Overview/RateLimiting.html> (en-tête `Retry-After` en millisecondes dans cette API, 429 `RATE_LIMIT_EXCEEDED`, backoff exponentiel recommandé). Le client lit `Retry-After` selon la norme HTTP (secondes ou date) : pour Sentinel Hub (Lot suivant), l'unité est à traiter à part.

Earth Search : aucune limite chiffrée relevée ni dans la documentation consultée ni dans les en-têtes des réponses (aucun en-tête de débit).

Les quotas mensuels sont remis à zéro le premier jour du mois (même page).

## 6. Sélection : `choisirSource`

Fonction pure : produits déjà cherchés, état des sources, quotas et cache sont des entrées. Tous les seuils ci-dessous sont PROVISOIRES (choix de conduite réversibles) et rendus dans `metadonnees.parametres`.

### 6.1 Filtres durs (dans cet ordre, chacun tracé dans `ecartes`)

1. Emprise qui coupe la zone, puis qui en couvre au moins `couvertureMinZone` (défaut 50 %). Pour un corridor qu'aucune scène ne couvre seule, passer à 0 et mosaïquer.
2. Date dans la fenêtre.
3. Nature adaptée au phénomène (voir §6.3).
4. Résolution suffisante : `NOUVELLE_ROUTE` 10 m, les autres 30 m (`resolutionMaxM` pour passer outre).
5. Nuages de tuile <= seuil (optique) ; nuages non annoncés : écarté (`NUAGES_INCONNUS`), le seuil ne peut pas être vérifié.

### 6.2 Déduplication

Même `cleScene` = même prise de vue : `S2|plateforme|niveau|tuile|jour` pour Sentinel-2, `S1|<huit premiers segments du nom>` pour Sentinel-1, `LANDSAT|plateforme|WRS2|jour`. On garde la représentation de la source la plus prioritaire (`priorite`, sinon l'ordre d'entrée) ; les autres sont citées (`aussiChez`) et écartées en `DOUBLON`. L1C et L2A d'une même tuile ne sont pas des doublons. Paires réelles vérifiées le 25/10/2026 : CDSE `S2C_MSIL2A_..._T28PES_...` et Earth Search `S2C_28PES_20261025_0_L2A` ; CDSE `S1D_..._009D21_624C_COG` et Earth Search `S1D_..._009D21`.

### 6.3 Classement par points explicites

Total 100 : couverture de la zone 40, nuages de tuile 25, résolution 15, fraîcheur 10, état de la source 3, quota 2, cache 5. Chaque terme est rendu avec sa valeur, ses points, son maximum et une phrase (`raisons`). Égalité : date récente, L2A avant L1C, priorité de la source, identifiant (ordre total, résultat déterministe).

### 6.4 Radar : proposé, jamais substitué en silence

- Pour `INONDATION`, `EAU_SURFACE` et `COUPURE_PROBABLE` (le plan d'observation de la Terre prévoit Sentinel-1 pour inondations et coupures en saison des pluies), si l'optique manque, `alternative` propose le radar Sentinel-1 et dit « CHANGEMENT DE CAPTEUR, a confirmer ». Il n'est retenu que si l'appelant passe `accepterAlternativeRadar: true`, et le produit porte alors `changementDeCapteur: true`.
- Si la fenêtre tombe surtout en saison des pluies (juin à septembre : au moins la moitié de ses jours), `alternative` signale le radar comme complément alors que l'optique retenu reste optique.
- Pour `NOUVELLE_ROUTE` et `VEGETATION`, aucune alternative : le radar (20 x 22 m) ne remplace pas l'optique, et la raison est enregistrée.
- `mesuresDispo` (ex. produits de Boké par mois sous un seuil de nuages) est citée dans les raisons ; elle n'influe jamais sur la décision.

### 6.5 « Aucune source satisfaisante » : la cause

`ABSENCE_COUVERTURE`, `NUAGES` (avec la meilleure couverture de tuile observée), `QUALITE` (résolution insuffisante, nuages non annoncés), `QUOTA`, `ERREUR_API`, `FENETRE_TROP_COURTE` (fenêtre plus courte que la revisite : Sentinel-2 5 j, Sentinel-1 6 j, Landsat 16 j, documentation CDSE), plus `SOURCE_NON_CONFIGUREE` et `SOURCE_NON_INTERROGEE`. Une absence de couverture n'est jamais affirmée si une source a échoué ou est en quota : la cause devient `ERREUR_API` ou `QUOTA`, avec la mention « résultat partiel ». Si des produits trop nuageux ont déjà été vus, `NUAGES` tient malgré la panne d'une source.

Sortie : `retenue`, `classement`, `alternative`, `aucune`, `ecartes`, `raisons` (phrases), `metadonnees` (objet JSON sérialisable : règle `selection-v1`, paramètres, état des sources, entonnoir, retenue avec ses raisons).

## 7. Fixtures et tests

Chaque fixture réelle porte `_fixture: { capturee, requete, reel: true, reduction, source, params }`. La requête enregistrée est exactement celle que l'adaptateur envoie (les fixtures ont été capturées en passant par les adaptateurs) : un test rejoue la recherche et compare l'URL et le corps envoyés à ceux de la capture.

| Fichier | Contenu | Réduction |
|---|---|---|
| `cdse-stac-s2-l2a.json` | 2 pages x 2 produits Sentinel-2 L2A, avec `fields` | aucune |
| `cdse-stac-s2-l1c.json` | 2 produits L1C | aucune |
| `cdse-stac-s1-grd.json` | 2 produits Sentinel-1 | aucune |
| `cdse-stac-s2-l2a-item-complet.json`, `...-s1-grd-item-complet.json` | items sans `fields` (capture antérieure de l'agent « sources réelles ») | actifs et champs d'actif limités, jeton de page remplacé |
| `earth-search-s2-l2a.json` | 2 pages x 2 produits | actifs limités aux bandes, vignette et actifs retenus |
| `earth-search-s1-grd.json`, `earth-search-landsat-c2-l2.json` | 1 produit chacun | idem |
| `collections-licences.json` | licence, fournisseurs et liens de licence des collections | champs limités |

Les cas limites qu'aucune réponse réelle n'a produits (nuages absents, emprise invalide, mode radar inconnu, 429, pagination longue, doublons, lien signé) sont dans `__fixtures__/synthetiques.ts`, construits à partir d'items réels et marqués `synthetique: true`.

Commande : `cd backend && npx vitest run src/teledetection/sources`. Le fichier `perimetre.test.ts` vérifie qu'aucun fichier du moteur n'importe d'accès base, ne lit une variable d'environnement autre que la version, et que seuls `http.ts` et `verification-reelle.ts` appellent `fetch`.

## 8. Vérification réelle anonyme

`cd backend && npx tsx src/teledetection/sources/verification-reelle.ts --oui` (sans `--oui`, le script n'envoie rien). Au plus 20 requêtes HTTP (un compteur coupe au-delà), recherches et lecture d'items seulement, aucun téléchargement de scène.

Résultat du 25/10/2026 à 20 h 49 UTC (Boké 10,93 ; -14,29, bbox ±0,1°, 90 jours, nuages de tuile <= 50 %) : 8 requêtes HTTP, 0 échec, 823 960 octets reçus au total (229 622 du CDSE, 594 338 d'Earth Search dont 389 Ko pour une seule page Sentinel-2 : les items ne s'allègent pas).

| Étape | CDSE STAC | Earth Search |
|---|---|---|
| Connectivité | `PRODUIT_DISPONIBLE`, 1 351 ms | `PRODUIT_DISPONIBLE`, 1 333 ms |
| Sentinel-2 L2A | 19 produits normalisés, 267 ms, 93 Ko | 19 (total annoncé 19), 796 ms, 389 Ko |
| Sentinel-1 GRD | 22 produits, 209 ms, 54 Ko | 20 sur 22 annoncés (1 page), 979 ms, 150 Ko |
| Métadonnées d'un item | identique à la recherche, 366 ms | identique, 403 ms |

Prises de vue communes aux deux catalogues : Sentinel-2 19 sur 19 ; Sentinel-1 20 (sur les 20 d'Earth Search). Sélection hors ligne sur ces produits réels : `VEGETATION` et `INONDATION` retiennent la tuile 28PET du 25/10/2026 (couvre 100 % de la zone, 35,65 % de nuages de tuile, score 77,14) ; pour l'inondation, la fenêtre tombe surtout en saison des pluies (août et septembre) et le radar est signalé comme complément sans changer le capteur.

## 9. Ce que cette vérification n'a pas établi

- L'accès anonyme à la vignette CDSE : `HEAD` de la vignette -> 301 vers `zipper.creodias.eu/odata/v1/Assets(...)`, puis 404 sur `HEAD`. Accès non constaté : `acces: INCONNU`, `verifie: false`.
- Les 429 du CDSE : aucun rencontré, donc la politique de reprise est testée sur réponses fabriquées, pas sur le comportement réel du fournisseur.
- La contrainte `(page - 1) x limite <= 10 000` du STAC CDSE vient de l'agent « sources réelles » ; elle n'a pas été éprouvée jusqu'à son butoir. La documentation OData du CDSE borne `$skip` à 10 000.
- Les pixels : aucun n'a été lu. Ni la qualité réelle d'une scène sur la zone (la couverture nuageuse annoncée est celle de la tuile), ni le champ `nodata` ne sont exploités par la sélection.
- Les latences sont celles d'une exécution depuis un poste de développement ; elles ne valent pas pour le serveur de production.

## 10. Procédure humaine pour obtenir des identifiants CDSE

À faire par une personne, hors dépôt. Rien de ce qui suit n'est nécessaire à la recherche de catalogue (anonyme) ; tout est nécessaire au téléchargement et au traitement (Lot suivant).

1. **Compte.** S'inscrire sur le site du CDSE (<https://documentation.dataspace.copernicus.eu/Registration.html> : formulaire, conditions générales, vérification de l'adresse e-mail). Préférer une adresse de service d'AGEROUTE (boîte partagée) plutôt qu'une adresse personnelle, pour que le compte survive aux départs. Le type de compte (Copernicus General user, Services, Collaborative, International) apparaît dans « Account info » du tableau de bord ; les comptes « Services » sont réservés aux institutions de l'UE et organisations travaillant sur les services Copernicus (FAQ du CDSE) : ne pas présumer d'une éligibilité. Pour des quotas supérieurs, la page des quotas renvoie aux crédits commerciaux et aux demandes de parrainage.
2. **Client OAuth Sentinel Hub** (traitement à la demande). Tableau de bord Sentinel Hub (<https://shapps.dataspace.copernicus.eu/dashboard/#/account/settings>), onglet « User Settings », section « OAuth clients », bouton « Create ». Donner un nom, une date d'expiration (éviter « Never expire »), copier l'identifiant ET le secret immédiatement : le secret n'est affiché qu'une fois. Jeton obtenu auprès de `https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token` (<https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Overview/Authentication.html>). Ne pas demander un jeton par requête : les demandes de jeton sont limitées (429) et un jeton ouvre une session sur 100.
3. **Jeton OIDC pour le téléchargement** (<https://documentation.dataspace.copernicus.eu/APIs/Token.html>) : la méthode documentée utilise le nom d'utilisateur et le mot de passe du compte (`client_id=cdse-public`). La documentation déconseille de les figer dans le code. Pour un service automatique, préférer le client OAuth du point 2 si l'API visée l'accepte, ou décider avec l'architecte du compte qui portera ce mot de passe.
4. **Clés S3** (accès direct `s3://eodata`). Page de gestion des clés liée depuis <https://documentation.dataspace.copernicus.eu/APIs/S3.html> (<https://eodata-s3keysmanager.dataspace.copernicus.eu/>) : « Add Credentials », choisir la date d'expiration, copier la clé secrète (affichée une seule fois). Point d'accès : `https://eodata.dataspace.copernicus.eu`.
5. **Rangement.** Variables d'environnement du serveur ou secret du conteneur, jamais le dépôt (règle 1 d'AGENTS.md). Noter la date d'expiration de chaque identifiant et planifier son renouvellement. Ne jamais utiliser le client de test partagé que la page de limitation de débit publie : il est public et partagé.

## 11. Variables d'environnement

Ce lot ne lit AUCUN secret. Il lit seulement, pour le `User-Agent`, `AGEROUTE_VERSION` puis `npm_package_version`.

Noms PRÉVUS pour le Lot suivant (déclarés dans `DESCRIPTIF_CDSE.exigencesAcces.variablesEnvironnement`, aucun n'est lu aujourd'hui, aucune valeur dans le dépôt) :

| Nom | Usage prévu |
|---|---|
| `CDSE_OIDC_CLIENT_ID`, `CDSE_OIDC_CLIENT_SECRET` | Client OAuth Sentinel Hub / jeton OIDC |
| `CDSE_S3_ACCESS_KEY`, `CDSE_S3_SECRET_KEY` | Accès `s3://eodata` |

`backend/.env.example` n'est pas modifié par ce chantier (hors périmètre) : l'ajout des quatre noms avec la valeur `changeme` est à faire par l'architecte ou EO-API.

## 12. Limites et décisions ouvertes

- Persistance : `ResultatConnectivite` et `InstantaneQuotas` sont à enregistrer par EO-API (état de la source, message du dernier test, date). Les compteurs de session ne survivent pas au redémarrage.
- Seuils PROVISOIRES à valider : pondérations, `couvertureMinZone` 50 %, résolutions maximales par phénomène, saison des pluies juin à septembre (fenêtre à majorité), plafonds de pages et de produits, délais et nombre de tentatives.
- Phénomènes pour lesquels le radar est une alternative honnête : `INONDATION`, `EAU_SURFACE`, `COUPURE_PROBABLE` (à confirmer avec le métier ; `NOUVELLE_ROUTE` et `VEGETATION` exclus).
- Pas de journal persistant des requêtes : le `journal` injectable existe, son stockage reste à décider.
- Sentinel Hub : `Retry-After` est en millisecondes dans cette API ; le client lit des secondes. À traiter à l'arrivée du traitement.
- Landsat est en recherche seulement (pas de traitement prévu).
