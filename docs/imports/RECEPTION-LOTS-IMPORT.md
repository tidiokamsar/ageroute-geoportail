# Réception des lots d'import : plafonds, mesures, durcissements

Date : 25/10/2026. Chantier BE-I (API additive et durcissement). Complète `CONTRAT-API-LOTS-IMPORT.md` (formes) par ce que le contrat ne dit pas : pourquoi ces plafonds, ce qui a été mesuré, ce qui change pour une source qui envoie des fichiers, ce qui reste à décider.

Tout ce qui est écrit ici comme mesuré l'a été sur un clone jetable de la base locale `replay` (PostGIS, conteneur de développement) avec le code du dépôt. Aucune mesure n'a été faite en production. Les valeurs de plafond sont PROVISOIRES : elles sont nommées dans le code (`backend/src/import/reception.noyau.ts`, `limiteur.ts`) et exposées par `GET /api/v2/imports/meta`.

## 1. Plafond de lignes (constat G1) et temps de traitement

**Avant.** Aucune borne sur le nombre de lignes. Une transaction de 120 s tenait une connexion : un fichier de 90 000 lignes (3 Mo) expirait (P2028) après 128 s, aucun lot n'était enregistré, la réponse était un 500. Le découpage CSV était synchrone et bloquait la boucle d'événements.

**Mesure (même poste, même base, CSV de 148 octets par ligne environ, une géométrie par ligne) :**

| lignes | avant (secondes) | après (secondes) | blocage maximal de la boucle d'événements après | mémoire du processus après |
|---|---|---|---|---|
| 5 000 | 9,2 | 2,1 | 85 ms | 165 Mo |
| 10 000 | 20,4 | 5,0 | 152 ms | 258 Mo |
| 20 000 | 28,2 | 8,9 et 8,1 (deux essais) | 234 ms et 223 ms | 370 Mo |

(« avant » : code d'avant le chantier, `createMany` unique ; le banc `import.integration.mts` donnait 45,1 s pour 20 000 lignes, génération du fichier comprise, contre 13,3 s après.)

**Après.**
- `LIMITE_LIGNES = 20 000` lignes de données (PROVISOIRE). Elle laisse le traitement sous 10 s sur la mesure ci-dessus, soit un tiers de la barre des 30 s fixée au chantier, avec la marge d'un poste plus lent ou d'une base chargée. Rien n'a été mesuré au-delà : un lot de 40 000 ou 60 000 lignes serait extrapolé, pas mesuré, donc non annoncé. La valeur est une décision à confirmer par la DSI.
- Le plafond est contrôlé AVANT la lecture complète : le découpage CSV s'arrête dès qu'une ligne de trop est comptée ; pour un GeoJSON, la longueur du tableau `features` est testée avant toute transformation. Mesuré avec un dépôt factice (aucune base) : 200 000 lignes (4,9 Mo) refusées en 155 ms, 1 000 000 de lignes (24,9 Mo) en 263 ms (blocage maximal 151 ms), un GeoJSON de 500 000 `null` en 29 ms. Réponse : 400 `TROP_DE_LIGNES`, rien n'est enregistré.
- Insertion par `createMany` de 1 000 lignes (`TAILLE_LOT_INSERTION`), dans la même transaction (tout ou rien est conservé). La vérification des lignes se fait par tranches de 500 avec cession de la boucle d'événements (`setImmediate`) entre deux tranches.
- Transaction : 60 s au plus (au lieu de 120 s).

## 2. Saturation (constat « pool Prisma »)

Chaque réception garde une connexion pendant sa transaction. `limiteur.ts` limite à **2 réceptions simultanées par processus** (`IMPORTS_SIMULTANES_MAX`, PROVISOIRE) ; les suivantes attendent au plus 15 s (`ATTENTE_PLACE_MAX_MS`) puis reçoivent un **503 `SERVICE_OCCUPE` avec `Retry-After: 10`**. Même réponse pour une connexion introuvable (P2024), une transaction expirée (P2028) et l'échec de numérotation après huit essais (qui sortait en 409 « valeur unique » : le client y voyait un conflit de données, c'est une surcharge).
- Un fichier DÉJÀ reçu est rendu (200) sans prendre de place : la relecture d'un lot n'est jamais bloquée par les réceptions en cours.
- Limite par processus : plusieurs instances du serveur multiplient la limite.
- Mesuré (banc `imports-api.integration.mts`, section 10) : dix réceptions simultanées de 2 500 lignes (20,9 s en tout) ne donnent que des 201 ou des 503 `SERVICE_OCCUPE` avec `Retry-After` ; jamais un 500 ni un 409 ; pendant ce temps un autre utilisateur lit `/meta` en 200, chaque fois en moins de 3 s.

## 3. Taille HTTP (constat G2) : alignée sur nginx

`TAILLE_MAX_OCTETS` vaut 25 Mo (décision de l'orchestrateur du 25/10/2026, réversible), annoncée par `/meta`. `frontend/nginx.conf` fixe `client_max_body_size 25m` : la limite annoncée est donc la limite réelle derrière le proxy (avant, multer acceptait 50 Mo alors que nginx refusait au-delà de 25 Mo en 413 sans que l'interface le sache). Pour relever la limite, porter ensemble `TAILLE_MAX_OCTETS` et `client_max_body_size`, après avoir mesuré la mémoire (le fichier est lu en mémoire). À 20 000 lignes, un lot dépasse rarement 5 Mo.

## 4. Ce que la réception contrôle maintenant, dans l'ordre

1. Métadonnées (zod strict) : champs imprimables, `autorisationRef` de 5 caractères au moins, `dateSource` entre 1900 et 2100 → 400 `CHAMPS_INVALIDES` avec détail par champ.
2. Forme du contenu → 400 `FORMAT_INCOHERENT` (binaire = plus de 5 % d'octets de contrôle dans les 8 premiers Ko ; GeoJSON doit commencer par `{` ; CSV ne commence ni par `{` ni par `[`). Un NUL isolé dans un fichier texte n'est PAS un fichier binaire : il est traité ligne par ligne (point 6). Cette étape précède l'empreinte : un CSV envoyé en « geojson » ne crée plus de lot `REJETE`, donc le piège « les mêmes octets renvoyés avec le bon format rendent `dejaRecu` REJETE » est fermé pour les nouveaux envois (les lots déjà créés ainsi ne sont pas corrigés).
3. Empreinte SHA-256 de tous les octets, recherche du lot existant (clé `(source rognée, empreinte)`) → 200 `dejaRecu`, rien n'est écrit.
4. Encodage UTF-8 strict (`TextDecoder` fatal) → 400 `ENCODAGE_NON_UTF8` avec la position du premier octet invalide ; un BOM UTF-16 est nommé comme tel ; le BOM UTF-8 est accepté. Décision : un fichier mal encodé est une DEMANDE refusée (la source le réenregistre et le renvoie) et non un lot `REJETE`, pour ne pas encombrer la liste de lots sans ligne.
5. Plafond de lignes → 400 `TROP_DE_LIGNES`.
6. Par ligne : nettoyage de la charge (NUL, substitut UTF-16 isolé, imbrication au-delà de 32 niveaux) → la ligne est REJETÉE avec son motif et sa charge est conservée avec un marqueur visible (U+2400 pour NUL, U+FFFD pour un substitut) ; vérification du contrat dans un `try/catch` (une structure illisible rejette la ligne, ne casse pas le lot).

Nom de fichier : multer 2.x décodait en latin1 par défaut (`relevé` devenait `relevÃ©`) ; l'option `defParamCharset: "utf8"` existe dans multer 2.2.0 (`index.js`) mais pas dans `@types/multer` (conversion de type dans la route). Le nom est ensuite assaini (caractères de contrôle et de direction retirés, seul le dernier élément d'un chemin est gardé, 255 caractères au plus) ; il ne sert jamais de chemin.

## 5. Changements de contrat (lignes ou fichiers acceptés avant, refusés ou rejetés maintenant)

Chacun est couvert par un test qui échoue si le durcissement disparaît (mutations rejouées, voir le rapport du chantier).

| Cas | Avant | Maintenant |
|---|---|---|
| Fichier de plus de 20 000 lignes | traité (jusqu'à l'expiration de la transaction vers 60 000 lignes) | 400 `TROP_DE_LIGNES` |
| Octets non UTF-8 (Windows-1252) | remplacés par U+FFFD, lot `VALIDE_SCHEMA` | 400 `ENCODAGE_NON_UTF8` |
| CSV déclaré GeoJSON, GeoJSON déclaré CSV, binaire | lot `REJETE` ou lot de lignes absurdes | 400 `FORMAT_INCOHERENT` |
| En-tête CSV avec une colonne en double | la dernière valeur gagnait en silence | lot `REJETE`, motif nommant la colonne |
| NUL dans une cellule | 500 (PostgreSQL 22P05) | la ligne est rejetée avec son motif |
| `date_source` : `05/10/2026`, `Foo 1`, `1`, `2026-02-30` | acceptées (`Date.parse`) | ligne rejetée : ISO 8601 strict (`AAAA-MM-JJ` ou `AAAA-MM-JJThh:mm[:ss]` avec fuseau facultatif), année 1900 à 2100 ; une date postérieure de plus de 2 jours à la date de réception est rejetée comme future |
| `debut_m` / `fin_m` : `0x10`, `0b11`, `1e300`, `Infinity` | acceptés par `Number()` | ligne rejetée : nombre décimal ordinaire (virgule ou point) |
| CRS `my-4326-fake`, `EPSG:34326` | acceptés (l'alternative `4326` nue) | lot `REJETE` ; restent admis : CRS84 et EPSG:4326 sous leurs formes URN, `EPSG:4326`, `CRS84`, URL OGC |
| Coordonnée `[lon, lat, altitude]` | ligne rejetée | acceptée, altitude écartée (valide en GeoJSON, RFC 7946) |
| `autorisationRef` : `x`, `.`, `n/a`, retour à la ligne | acceptée | 400 `CHAMPS_INVALIDES` (5 caractères imprimables au moins). Aucune autre règle : rapprocher la référence d'un registre est une décision DSI |
| Motif d'un rejet | recopiait la valeur fautive entière | cite 80 caractères au plus et donne la longueur totale (la charge complète reste dans `chargeOriginale`) |
| `erreurs.csv` | formules actives, volume non borné | formules neutralisées (apostrophe), 20 000 lignes, 10 millions de caractères, 5 000 caractères par charge |
| `systeme_source` d'une ligne différent de celui du lot | silencieux | avertissement non bloquant (lot et détail) ; la valeur n'est pas corrigée |
| Coordonnées hors de l'étendue attendue du pays | acceptées | acceptées, avertissement non bloquant (étendue large PROVISOIRE : longitude -16 à -7, latitude 6,5 à 13,5, `ETENDUE_ATTENDUE_PROVISOIRE` dans `pivot.noyau.ts`; le dépôt ne porte pas de constante nationale à réutiliser, recherche faite dans `backend/src` le 25/10/2026) |
| Même fichier renvoyé avec d'autres métadonnées | 200, anciennes valeurs conservées sans le dire | 200, anciennes valeurs conservées et `metadonneesDifferentes` les nomme |
| Mêmes octets sous une autre source | nouveau lot sans alerte | nouveau lot, `memeEmpreinteAutresSources` ; avertissement si la source ne diffère que par la casse ou les espaces |
| Filtre `source` de la liste | égalité exacte | égalité sans tenir compte de la casse (la valeur stockée n'est pas modifiée) |
| Épuisement des huit essais de numérotation | 409 « valeur unique » | 503 `SERVICE_OCCUPE` |

Autre correction : la clé d'idempotence cherchait le lot avec la source non rognée alors qu'elle est stockée rognée (une source avec espaces donnait huit essais puis un conflit). Elle utilise la valeur rognée.

Consommateur hors périmètre : `backend/src/integrations/contrats.ts` appelle `lireGeoJson` et `verifierLigne` ; ses tests (`src/integrations`) passent avec le pivot durci.

## 6. Recherche textuelle

`q` s'appuie sur `contains` de Prisma, qui NE neutralise PAS les jokers de LIKE (constaté sur la base réelle : `q=%` rendait tous les lots, `q=gamm_` trouvait « gamma »). `echapperLike` échappe `\`, `%` et `_` ; le banc le prouve sur un nom de fichier contenant `100%`.

## 7. Historique et audit (constat G6)

`LotImport` n'est pas dans `MODULE_PAR_ENTITE` (`backend/src/lib/access.ts`), donc la route d'audit générique le refuse. Cette API lit `audit_logs` directement (entité `LotImport`, `entityId` = id du lot) et n'en sort que la date, l'action, le nom de l'acteur et un résumé sobre. `access.ts` n'est pas modifié. Si l'on veut que l'audit générique couvre aussi `LotImport`, c'est une ligne dans `MODULE_PAR_ENTITE` (hors périmètre ici, décision d'accès à prendre).

## 8. Décisions et limites ouvertes

- Valeurs PROVISOIRES à confirmer : 20 000 lignes, 2 réceptions simultanées, 15 s d'attente, étendue attendue du pays, bornes de l'export d'erreurs.
- Relèvement éventuel de la limite de 25 Mo (nginx et serveur ensemble).
- Pas de territoire ni de clé de module sur ces routes : décision DSI en attente, rien n'est changé (voir `inventaire-acces.test.ts`).
- Le limiteur est local au processus ; en cas d'instances multiples, la limite de concurrence est par instance.
- `autorisationRef` n'est comparée à aucun registre d'autorisations : n'importe quel texte imprimable de 5 caractères passe.
- Les lots créés avant cette version n'ont pas d'avertissements calculés ; les lots `REJETE` créés par un CSV déclaré GeoJSON restent en base.
- Aucune approbation d'échantillon ni écriture dans le référentiel : inchangé, voir l'en-tête de `import.service.ts`.
