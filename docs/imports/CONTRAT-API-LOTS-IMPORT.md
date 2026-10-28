# Contrat d'API : lots d'import (Lot UX/UI « Lots d'import »)

Date : 25/10/2026 (révisé le même jour après les audits de sécurité et de tests, chantier BE-I). Statut : contrat de travail commun au backend et au frontend. Il décrit l'API additive de `/api/v2/imports`. Les routes existantes (POST /, GET /, GET /:id, GET /:id/erreurs.csv) gardent leur comportement ; les champs ajoutés sont additifs. Implémentation : `backend/src/api-v2/imports.routes.ts`, `backend/src/import/`. Plafonds, mesures et écarts d'exploitation : `RECEPTION-LOTS-IMPORT.md`.

## Ce qui a changé dans cette révision (à lire en premier)

Formes ajoutées (additif) :
- POST : codes 400 `FORMAT_NON_ADMIS` et `ENCODAGE_NON_UTF8` ; réponse 503 `SERVICE_OCCUPE` avec en-tête `Retry-After` ; `CHAMPS_INVALIDES` porte `details` par champ.
- GET `/` : 400 `PARAMETRES_INVALIDES` et `CURSEUR_INVALIDE`.
- GET `/:id/apercu` : 400 `PARAMETRES_INVALIDES`.
- GET `/:id/erreurs.csv` : en-têtes `X-Lignes-En-Erreur` et `X-Lignes-Exportees`, ligne finale de commentaire `# export tronque ...` quand l'export est borné.

Comportements modifiés (changement de contrat, signalés) :
- Le filtre `source` de la liste est **insensible à la casse** (il était annoncé « égalité exacte »). La valeur STOCKÉE n'est jamais modifiée : `onr_bdr` et `ONR_BDR` restent deux sources, donc deux lots, mais le filtre les trouve ensemble.
- `q` traite `%`, `_` et `\` comme des caractères, jamais comme des jokers.
- `erreurs.csv` : toute cellule texte commençant par `=`, `+`, `-`, `@`, tabulation ou retour chariot est précédée d'une apostrophe (voir plus bas). La valeur d'origine est la cellule SANS cette apostrophe initiale.
- Des fichiers acceptés avant sont maintenant refusés ou rejetés ligne à ligne : voir « Durcissements qui changent un résultat ».

## Principes (non négociables)

- Recevoir un lot n'écrit RIEN dans le référentiel. Aucune route de ce contrat n'écrit dans le référentiel.
- Le statut persistant du lot est technique et décidé par le serveur : aujourd'hui `REJETE` ou `VALIDE_SCHEMA` à la création, puis jamais modifié. `RECU`, `IMPORTE_TEST` et `IMPORTE` existent dans l'enum mais aucun code ne les produit.
- Les ÉTAPES et les ACTIONS PERMISES sont calculées par le serveur à partir du lot et du rôle ; le client les affiche, ne les décide jamais.
- Les étapes 3 (échantillon à valider) et 4 (import autorisé) n'ont pas de circuit : elles sont `NON_DISPONIBLE`, avec leur raison. Aucune action d'approbation ni d'import n'est exposée.
- Rôles : ADMIN et GESTIONNAIRE seulement, sur toutes les routes (lecture comprise). Autres rôles : 403. Ces routes n'ont ni périmètre territorial ni clé de module : décision DSI en attente, rien n'est changé.
- Aucune valeur inventée : un compteur non calculable est `null`, pas `0`.
- Le contenu d'un fichier est du texte d'un tiers : le serveur le rend tel quel dans du JSON, le client l'échappe à l'affichage.

## GET /api/v2/imports

Query (tous facultatifs ; un paramètre vide est ignoré ; tout paramètre inconnu ou répété est refusé) : `statut` (RECU|VALIDE_SCHEMA|IMPORTE_TEST|IMPORTE|REJETE), `source` (égalité, **sans tenir compte de la casse**), `q` (texte, 1 à 100 caractères : référence, nom de fichier, source ; insensible à la casse ; `%` et `_` sont des caractères), `du` / `au` (ISO : `AAAA-MM-JJ` ou `AAAA-MM-JJThh:mm[:ss[.sss]][Z|±hh:mm]`, sans fuseau = UTC, sur `importeLe`), `limite` (1 à 100, défaut 25), `curseur` (opaque, rendu par `suivant`).
`du` est inclusif. `au` en date seule inclut TOUTE la journée ; `au` en date-heure est inclusif à la milliseconde.
Réponse 200 : `{ lots: LotListe[], suivant: string | null, total: number }`. Tri : `importeLe` décroissant, puis `id` croissant. `total` = nombre de lots correspondant aux filtres (sans la pagination ; il reflète la base au moment de la page). Le curseur est stable : un lot reçu entre deux pages (donc plus récent) ne décale ni ne répète rien. Cette réponse remplace la limite implicite de 100 lots ; la clé `lots` est conservée.
400 : `{ error, code: "PARAMETRES_INVALIDES", details }` (paramètre inconnu, valeur hors plage, date illisible) ou `{ error, code: "CURSEUR_INVALIDE" }` (le client repart de la première page).

`LotListe` : `id, reference, systemeSource, format, nomFichier, tailleOctets (chaîne), statut, importeLe, importePar { id, nomComplet } | null, versionMapping, autorisationRef, lignesLues, lignesValidees, lignesImportees, lignesRejetees, lignesEnConflit, lignesIgnorees, motifRejetLot (chaîne | null)`.

## GET /api/v2/imports/meta

Réponse 200 : `{ formats: { code: "csv" | "geojson", libelle, aide }[], tailleMaxOctets: number, limiteLignes: number, statuts: string[] }`. Source de vérité des formats et plafonds affichés : l'interface ne promet que ce que cette route annonce.
`tailleMaxOctets` est la valeur réellement appliquée (25 Mo), alignée sur `client_max_body_size 25m` de nginx : une seule limite, annoncée par /meta et vraie derrière le proxy. Voir `RECEPTION-LOTS-IMPORT.md`. `limiteLignes` est un plafond PROVISOIRE (20 000 lignes de données).

## GET /api/v2/imports/sources

Réponse 200 : `{ sources: { valeur: string, nombreLots: number }[] }`. Valeurs distinctes déjà reçues, telles que stockées (casse comprise), jamais un référentiel (la source reste un texte libre). L'ordre est celui de la collation de la base : le client trie s'il le veut.

## GET /api/v2/imports/:id

Tous les champs actuels (compat), plus :
- `tailleOctets` (chaîne), `importePar { id, nomComplet } | null`.
- `empreinte { algorithme: "sha256", valeur: string }` (calculée par le serveur sur les octets reçus).
- `controle { motifRejetLot, compteurs { lues, validees, rejetees, enConflit, ignorees, importees }, premiersRejets: { numeroLigne, statut, motif }[], colonnes: { reconnues: string[], inconnues: string[] } | null, avertissements: string[] }`. `colonnes` est calculé par le serveur depuis les clés des charges originales ; `null` si aucune colonne n'est calculable (lot sans ligne). `inconnues` est plafonné à 200 (un avertissement le dit). `avertissements` : remarques non bloquantes (lignes dont `systeme_source` diffère de la source du lot, coordonnées hors de l'étendue attendue du pays). Les lots reçus avant cette révision n'ont pas d'avertissements calculés (liste vide).
- `etapes: Etape[]` (quatre éléments, dans l'ordre) : `{ id: "reception" | "controle_schema" | "echantillon" | "import_autorise", titre, etat: "TERMINEE" | "TERMINEE_AVEC_RESERVES" | "ECHEC" | "EN_COURS" | "NON_DISPONIBLE" | "NON_COMMENCEE", raison: string }`.
  - `VALIDE_SCHEMA` veut dire « au moins une ligne validée » : `controle_schema` est `TERMINEE_AVEC_RESERVES` dès qu'il y a une ligne rejetée, ignorée ou en conflit, `TERMINEE` sinon ; `REJETE` : `ECHEC` avec le motif du lot, et `echantillon` / `import_autorise` sont `NON_COMMENCEE` ; sinon ces deux étapes sont `NON_DISPONIBLE` avec leur raison (« Aucun circuit de validation d'echantillon n'existe encore : decision DSI requise », « L'ecriture dans le referentiel n'est pas implementee : rien n'a ete cree »).
  - `RECU`, `IMPORTE_TEST`, `IMPORTE` (non produits par l'application) : état cohérent et raison « Statut X non produit par l'application actuelle » ; l'étape d'import n'est jamais `TERMINEE`.
  - `EN_COURS` est prévu par le contrat mais jamais produit aujourd'hui (la réception est synchrone).
- `actionsPermises: { code: "TELECHARGER_ERREURS" | "VOIR_APERCU", permise: boolean, raison: string | null }[]` (aucune action d'approbation ni d'import n'existe). `TELECHARGER_ERREURS` est permise s'il existe des lignes rejetées ou ignorées, `VOIR_APERCU` s'il existe des lignes ; `raison` est renseignée quand l'action n'est pas permise.
- `historique: { date, action, acteur: string | null, details: string | null }[]` (lu directement dans `audit_logs`, entité `LotImport`, du plus ancien au plus récent, 50 au plus). `acteur` est le nom de l'utilisateur ; `details` est un résumé sobre (« Lot IMP-... enregistre : statut ..., N lignes lues. »), jamais un contenu de fichier, une empreinte ou une adresse IP.

404 `{ error: "lot introuvable" }` pour un identifiant inconnu (ou de plus de 64 caractères).

## GET /api/v2/imports/:id/apercu

Query (stricte) : `limite` (1 à 50, défaut 20), `statut` (VALIDEE|REJETEE|IGNOREE|EN_CONFLIT), `apres` (numéro de ligne, entier ≥ 0, pagination).
Réponse 200 : `{ lignes: { numeroLigne, statut, motifRejet: string | null, identifiantSource: string | null, charge: Record<string, string> }[], suivant: number | null, tronque: boolean }`. Les valeurs sont converties en texte et tronquées à 200 caractères, la charge est plafonnée à 40 colonnes, `motifRejet` à 500 caractères ; `tronque` dit si une troncature a eu lieu. Lecture seule ; le contenu est du texte à échapper à l'affichage. 400 `PARAMETRES_INVALIDES` si `limite` > 50 ou valeur illisible ; 404 si le lot n'existe pas.

## GET /api/v2/imports/:id/erreurs.csv

CSV `;` : `numero_ligne;statut;motif;identifiant_source;charge_originale`, une ligne par ligne rejetée ou ignorée.
- **Formules neutralisées** : une cellule texte (motif, identifiant, charge) qui commence par `=`, `+`, `-`, `@`, tabulation ou retour chariot est précédée d'une apostrophe `'` (OWASP, injection de formule). Les colonnes ne bougent pas. La valeur d'origine est la cellule sans l'apostrophe initiale.
- **Volume borné** : 20 000 lignes, 10 millions de caractères, 5 000 caractères par charge. Si l'export est tronqué, une dernière ligne `# export tronque : N lignes sur M (limite de l'export)` le dit (les lecteurs du pivot ignorent les lignes `#`), et `X-Lignes-En-Erreur` / `X-Lignes-Exportees` donnent les deux nombres.

## POST /api/v2/imports (réponses enrichies, compatibles)

Champs multipart : `fichier` (un seul), `systemeSource`, `format` (`csv` | `geojson`), `methodeSource`, `versionMapping`, `autorisationRef`, `auteurSource?`, `dateSource?`. L'importateur est TOUJOURS l'utilisateur authentifié ; tout autre champ (dont `importeParId`) est ignoré. Les champs texte sont imprimables (ni NUL ni caractère de contrôle). `autorisationRef` : 5 caractères au moins après suppression des blancs. `dateSource` : entre 1900 et 2100.

201 (créé) ou 200 (`dejaRecu: true`), avec les champs actuels (`id, reference, statut, compteurs, dejaRecu, motifRejetLot`) plus :
- `avertissements: string[]` (non bloquants ; voir le détail d'un lot, plus les doublons de source ci-dessous).
- `metadonneesDifferentes: { champ, recu, conserve }[]` : si le même fichier est renvoyé avec d'autres métadonnées (`autorisationRef`, `versionMapping`, `methodeSource`, et `auteurSource` / `dateSource` s'ils sont fournis), les anciennes sont conservées et DITES. Vide pour un lot créé.
- `memeEmpreinteAutresSources: { reference, systemeSource }[]` : les mêmes octets existent sous une AUTRE source (20 au plus) ; un nouveau lot est créé, la liste le signale. Une source qui ne diffère que par la casse ou les espaces ajoute un avertissement.

Un fichier lisible mais non conforme reste un 201 avec statut `REJETE` et son motif (le lot est un résultat, pas une erreur) : CRS refusé, colonne obligatoire absente ou dupliquée dans l'en-tête, JSON invalide, aucune ligne conforme. Une ligne dont une cellule contient un NUL ou un substitut UTF-16 isolé, ou dont une propriété dépasse 32 niveaux d'imbrication, est rejetée avec son motif (jamais un 500).

400 : `{ error, code }` (+ `details` pour `CHAMPS_INVALIDES`), codes stables, AUCUN lot enregistré :

| code | cas |
|---|---|
| `FICHIER_MANQUANT` | pas de champ multipart `fichier` |
| `CHAMPS_INVALIDES` | métadonnée absente, trop longue, non imprimable, `autorisationRef` trop courte, `dateSource` hors plage ; `details` : `{ champ: string[] }` |
| `FORMAT_NON_ADMIS` | format hors `csv` / `geojson` (au niveau du service) |
| `FORMAT_INCOHERENT` | le contenu ne correspond pas au format déclaré (binaire, JSON déclaré CSV, CSV déclaré GeoJSON) |
| `ENCODAGE_NON_UTF8` | octets invalides en UTF-8 (position donnée) ou UTF-16 ; le BOM UTF-8 est accepté |
| `FICHIER_VIDE` | fichier de 0 octet |
| `FICHIER_TROP_GROS` | au-delà de `tailleMaxOctets` |
| `TROP_DE_LIGNES` | plus de `limiteLignes` lignes de données |
| `TELEVERSEMENT_INVALIDE` | multipart interrompu ou mal formé, champ ou partie en trop |

503 : `{ error, code: "SERVICE_OCCUPE" }` avec l'en-tête `Retry-After` (secondes) : le serveur traite déjà d'autres lots (au plus deux réceptions simultanées par processus, attente bornée) ou la base est saturée. AUCUN lot n'a été créé : le client peut réessayer le même envoi sans risque (l'idempotence par empreinte protège de toute façon d'un doublon).

## Durcissements qui changent un résultat

Un fichier qui était accepté peut maintenant être refusé (400) ou une ligne qui était validée peut être rejetée (statut `REJETEE` avec son motif). Liste complète et justification : `RECEPTION-LOTS-IMPORT.md`, section « Changements de contrat ».
