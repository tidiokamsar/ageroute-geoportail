# Intégrations sortantes : l'outbox, les adaptateurs, et ce qui manque pour passer au réel

> Critère **A13** (« seules les données validées émises, rejeu sans effet de bord »), paragraphes **7.10** et **7.15**.
> Rédigé le 24/10/2026.
>
> **État réel, à lire avant tout le reste.** Le socle côté AGEROUTE est écrit et testé. **Aucun système
> réel n'a été atteint** : ni DigitalRoad (B-11), ni SharePoint / Entra ID (B-12), ni la BDR / L²R de
> l'ONR, ni Waze / CIFS, ni DATEX II. Tous les tests, le banc d'intégration et cette documentation
> parlent **contre des simulateurs écrits par AGEROUTE, jamais contre le système réel**. Un test vert
> prouve que notre code tient **notre** hypothèse de contrat, pas qu'un tiers l'accepte. Aucune ligne
> de ce dépôt ne doit être lue comme « intégration réussie » avec un système réel : elle ne l'est pas.

## 1. Ce qui est livré

| Pièce | Fichier |
|---|---|
| Migration versionnée avec descente (vérifiée par `verifier.sh`) | `backend/prisma/migrations/20261024200000_outbox_integrations/`, `backend/prisma/descentes/20261024200000_outbox_integrations.sql` |
| Banc SQL des garanties de la base | `backend/prisma/tests/outbox.test.sql` |
| Noyaux purs (sans base, sans réseau) | `backend/src/integrations/canonique.ts`, `etat.noyau.ts`, `contrats.ts`, `config.ts`, `sources.noyau.ts` |
| Service et dépôt | `outbox.service.ts`, `outbox.depot.ts` (SQL étiqueté), `sources.depot.ts` |
| Adaptateurs (désactivés par défaut) | `adaptateurs/digitalroad.ts`, `sharepoint.ts`, `bdr.ts`, `transport.ts`, `fabrique.ts`, `index.ts` |
| Simulateurs HTTP (code de test) | `simulateurs/simulateur.ts`, `essais.support.ts`, `outbox.depot.memoire.ts` |
| Routes d'administration v2 | `backend/src/api-v2/integrations.routes.ts` monté sur `/api/v2/integrations` |
| Traitement par lot (cron) | `backend/scripts/outbox-traiter.ts` |
| Banc d'intégration PostGIS | `backend/tests-integration/outbox.integration.mts` |

**Ce qui n'est pas livré, et le dit** : aucun ordonnanceur n'est démarré par le serveur ; aucun appel
à l'outbox n'est branché sur les flux de validation existants (une inscription est un geste
explicite, par la route ou par code) ; aucun format L²R ; aucune émission de défauts, de points noirs,
de postes ni de chantiers ; aucun adaptateur Waze / CIFS ni DATEX II.

## 2. Architecture

```
 donnée VALIDÉE ──► enregistrerEvenement ──► outbox_evenements (EN_ATTENTE)
   (lue par outbox_source_refus,                     │
    puis par le déclencheur)                         │  réclamation (UPDATE conditionnel + bail)
                                                     ▼
                                             EN_COURS ──► adaptateur ──► HTTP vers le destinataire
                                                     │         (hors transaction)
                                                     ▼
                                   ENVOYE | ECHEC (reprise) | ABANDONNE (file morte)
                                   + outbox_tentatives (ajout seul) + audit_logs
```

1. **Une inscription n'a lieu que pour une donnée validée.** La source est lue par la fonction SQL
   `outbox_source_refus`, **la même** que le déclencheur `outbox_garde` rappelle à l'insertion : il n'existe pas
   de seconde implémentation qui pourrait diverger. Un contournement du service (insertion SQL directe) est refusé
   par la base (SQLSTATE 23514, mesuré par le banc).
2. **La source est relue à l'envoi.** Une donnée rejetée ou supprimée logiquement entre l'inscription et
   l'envoi n'est pas émise : l'événement passe à `ABANDONNE` (motif `SOURCE_NON_VALIDE_A_L_ENVOI`), sans appel.
3. **La charge est figée.** `chargeCanonique` est le JSON canonique (clés triées) exactement émis ;
   `empreinteCharge` est son SHA-256, **vérifié en base** comme celui des bulletins routiers. Ce qui part est la
   charge figée à l'inscription, pas l'état courant de la source (ce qui a été transmis ne change pas de sens).
4. **Aucun appel réseau dans une transaction.** Réclamer (transaction courte), émettre, conclure (transaction courte).

### 2.1 Sources emissibles

| Source | Condition d'émission (SQL `outbox_source_refus`) | Destination |
|---|---|---|
| `Troncon`, `Ouvrage` | `statutValidation = VALIDE` et `deletedAt` nul | BDR / L²R (pivot) |
| `Portion` | idem, et `remplaceeLe` nul (une version close n'est pas émise) | BDR / L²R (pivot) |
| `BulletinRoutier` | la ligne existe : le bulletin est archivé, figé, **engendré des seules publications validées par l'exploitant** | SharePoint |
| `FicheIntervention` | **refusée toujours** : aucune table de fiches n'existe (moteur de programmation absent, D-07) | DigitalRoad |

Deux lectures sont des **interprétations à confirmer** : (a) le bulletin n'a pas de statut de validation propre,
sa validité est celle des publications dont il est tiré (migration 20261019010000) ; (b) pour une fiche,
« validée » veut dire `APPROUVE`, le dernier statut saisi dans le Géoportail avant `TRANSMIS` (`cycle-vie.noyau.ts`).

**Non couverts, volontairement** : `Defaut` (le type « dégradation » du pivot suppose le format L²R Mesure, non
publié), `PointNoir`, `Poste`, `Chantier` (copie gelée, ADR-003 : DigitalRoad fait foi). Étendre = une migration
qui étend les CHECK et le déclencheur, réversible.

### 2.2 États et transitions

| De | Vers | Qui |
|---|---|---|
| `EN_ATTENTE` | `EN_COURS` | travailleur (réclamation, bail posé) |
| `EN_COURS` | `ENVOYE` | travailleur, destinataire a accusé réception (ou reconnu un doublon) |
| `EN_COURS` | `ECHEC` | travailleur, échec temporaire, tentatives restantes ; reprise à `prochaineTentativeLe` |
| `EN_COURS` | `ABANDONNE` | travailleur : refus définitif, tentatives épuisées, source non valide, charge altérée |
| `ECHEC` | `EN_COURS` | travailleur, échéance passée |
| `EN_COURS` | `EN_COURS` | un autre travailleur, **bail expiré** (reprise avec la même clé) |
| `ECHEC`, `ABANDONNE` | `EN_ATTENTE` | **humain, motivé** (`relancer`), tentatives remises à 0, `relances` + 1 |
| `EN_ATTENTE`, `ECHEC` | `ABANDONNE` | **humain, motivé** (`abandonner`) |
| `ENVOYE` | (rien) | **terminal et immuable** |

La même liste est dans `etat.noyau.ts` et dans le déclencheur de la base ; un test vérifie qu'elles sont
identiques. `ENVOYE` n'est atteint que depuis `EN_COURS`. Un événement ne naît que `EN_ATTENTE`.

**Classification des réponses** (voir `adaptateurs/transport.ts`) : 2xx avec accusé lisible = envoyé (ou
`DOUBLON_RECONNU` si le destinataire l'indique) ; 2xx sans accusé lisible = `ACCUSE_INVALIDE`, **retenté**
(on ignore si le destinataire a traité, la clé rend la reprise sûre) ; 408, 425, 429, 5xx, réseau, délai dépassé =
échec **temporaire** ; autres 4xx et toute redirection (**jamais suivie**) = échec **définitif**, directement en file morte.

**Temporisation** : `base * 2^(n-1)`, plafonnée (défauts : 30 s, plafond 1 h, 8 tentatives). Une gigue optionnelle ne
fait que raccourcir de 20 % au plus : le plafond reste un plafond. `tentativesMax` est figé sur l'événement à l'inscription.

### 2.3 Idempotence, version, rejeu

- **Clé d'idempotence** = SHA-256 de `destination|type|sourceType|sourceId|empreinteCharge`. Déterministe,
  **vérifiée par la base** (contrainte `outbox_cle_deterministe`), unique par destination.
- **Même contenu deux fois** : l'événement existant est rendu, **sans écriture, sans audit**. Sous concurrence
  (huit inscriptions simultanées mesurées), une seule ligne.
- **Contenu modifié** : nouvel événement, `version` + 1 (affectée par le déclencheur sous verrou consultatif). L'ancien
  n'est pas touché. Revenir à un ancien contenu retrouve l'ancien événement.
- **Rejeu sans effet de bord** (test X-04 de `ONR_BDR_TEST_PLAN.md`) : rejouer un événement `ENVOYE` répond `DEJA_ENVOYE`
  et s'arrête **avant toute écriture** : pas de requête, pas de ligne modifiée (`updatedAt` compris), pas de tentative,
  pas d'audit. La base interdit d'ailleurs tout `UPDATE` d'un événement `ENVOYE`. Un événement `ABANDONNE` ne se rejoue pas :
  il se relance, par décision humaine motivée.

### 2.4 Anti-double-envoi

Un `UPDATE` conditionnel pose le bail (`verrouPar`, `verrouJusqua`) : deux travailleurs qui visent le même événement se
sérialisent sur la ligne, le second ne trouve plus la condition vraie. Mesuré : six travailleurs simultanés, **une**
requête chez le destinataire. Un travailleur mort perd son bail ; un autre reprend avec **la même clé**. Un travailleur
qui a perdu son bail ne peut pas conclure (`VERROU_PERDU`), rien n'est écrit.

**Livraison au moins une fois, effet unique si le destinataire honore la clé.** Si un travailleur meurt entre l'appel
et l'écriture du résultat, l'événement est ré-émis avec la même clé. Que DigitalRoad, SharePoint ou l'ONR dédupliquent
sur cette clé **n'est pas établi** : c'est un prérequis (section 7).

### 2.5 Audit

Chaque transition écrit une ligne `audit_logs` (`entityType = OutboxEvenement`) **dans la transaction de la transition** :
inscription (`CREATE`), réclamation, conclusion, relance, abandon (`UPDATE`, avec `after.transition`). Les transitions du
système n'ont pas d'auteur (`userId` nul) ; celles d'un humain portent l'identifiant de la session. L'audit ne contient
jamais la charge, ni le jeton, ni le corps d'une réponse. Les tentatives sont archivées en ajout seul
(`outbox_tentatives` : issue, code HTTP, message assaini de 500 caractères au plus).

### 2.6 Absence de fuite

- Chaque charge est construite **champ par champ** (`sources.noyau.ts`), jamais par copie de la ligne.
- Chaque schéma de contrat est **strict** : une clé inconnue est refusée (un schéma zod ordinaire l'ignorerait en silence).
- Une barrière supplémentaire (`trouverChampInterne`) refuse toute charge portant une clé de la liste noire (mot de passe,
  jeton, courriel, auteur, adresse IP, suppression, observations, remarques, coût interne...).
- Le banc charge des **marqueurs** dans les colonnes sensibles des fixtures (observations, coût de réhabilitation,
  préfecture, remarques d'ouvrage, auteur, gabarit du bulletin) et vérifie leur absence dans **chaque charge** et dans
  **chaque corps reçu** par les simulateurs.

## 3. Adaptateurs et contrats d'échange

Les adaptateurs sont **désactivés par défaut** (section 4). Le transport est **notre hypothèse de travail**, celle que
les simulateurs implémentent ; aucune documentation d'API tierce n'existe.

```
POST {OUTBOX_<DEST>_URL}{OUTBOX_<DEST>_CHEMIN}
Content-Type: application/json         corps = enveloppe canonique
Idempotency-Key: <clé d'idempotence>   en-tête supposée
Authorization: Bearer <jeton>          mécanisme supposé
enveloppe = { contrat: "agroute-sortant-0-brouillon", cleIdempotence, destination, typeEvenement, version, empreinteCharge, charge }
réponse attendue : 2xx + { "reference": "...", "doublon"?: true }
```

L'enveloppe ne contient ni l'identifiant interne de l'événement ni l'auteur. Le corps est le JSON canonique : mêmes octets
à chaque émission.

| Destination | Ce que les documents du dépôt établissent | Contrat de la charge |
|---|---|---|
| **DigitalRoad** | la fiche d'intervention transmise : « identifiants patrimoniaux, plage linéaire, traitement, quantités, coût estimé et classe de précision, score et justification, année, source de financement », version figée (`MAINTENANCE_PROGRAMMING_DESIGN.md` 5.3, `cycle-vie.noyau.ts`) | `ChargeFicheIntervention` |
| **SharePoint** | un dépôt sécurisé est l'option A d'échange (`BDR_INTEROPERABILITY_OPTIONS.md`) ; le bulletin est archivé avec son SHA-256 | `ChargeDepotBulletin` : nom de fichier, `text/plain; charset=utf-8`, contenu, taille et empreinte **vérifiées contre le contenu**, numéro, jour |
| **BDR / L²R** | le **format pivot ouvert** (CSV, GeoPackage, GeoJSON, SRID 4326 ; `ROAD_SURVEY_IMPORT_SPEC.md`, `import/pivot.noyau.ts`). **Aucun format L²R n'est publié** | `ChargePivot` : la FeatureCollection GeoJSON du pivot, une ligne, **relue et acceptée par le lecteur d'import** (`lireGeoJson` puis `verifierLigne`) |

L'outbox **n'écrit jamais** un statut de fiche : l'accusé de DigitalRoad est conservé, mais ne fait pas passer une fiche à
`TRANSMIS` (cet état est un fait reçu, `cycle-vie.noyau.ts`). Le rapprochement avec la décision D-08 reste à faire.

La liste exacte de ce que le dépôt ne permet pas d'établir est dans `CHAMPS_A_CONFIRMER` (`contrats.ts`), servie par
`GET /api/v2/integrations/contrats`, et reprise en section 7.

## 4. Configuration

Lue dans l'environnement (`backend/src/integrations/config.ts`), documentée dans `backend/.env.example`. **Aucune valeur
par défaut n'active un envoi réel** : l'URL, le chemin et le jeton n'ont pas de défaut. Une destination est active si et
seulement si **les cinq** conditions sont réunies.

| Variable | Rôle | Défaut |
|---|---|---|
| `INTEGRATIONS_SORTANTES_ACTIVES` | interrupteur général, doit valoir `true` | absent (désactivé) |
| `OUTBOX_<DEST>_ACTIF` | active la destination nommément (`DIGITALROAD`, `SHAREPOINT`, `BDR_L2R`) | absent (désactivé) |
| `OUTBOX_<DEST>_URL` | base de l'URL ; **https exigé**, http seulement vers `127.0.0.1`, `localhost`, `::1` ; ni identifiant, ni requête, ni fragment | aucun |
| `OUTBOX_<DEST>_CHEMIN` | chemin d'appel, à confirmer | aucun |
| `OUTBOX_<DEST>_JETON` | secret, jamais journalisé, jamais stocké | aucun |
| `OUTBOX_<DEST>_TIMEOUT_MS` | délai d'attente (100 à 120000) | 10000 |
| `OUTBOX_TENTATIVES_MAX` | tentatives avant file morte (1 à 50) | 8 |
| `OUTBOX_DELAI_BASE_MS`, `OUTBOX_DELAI_PLAFOND_MS` | temporisation exponentielle bornée | 30000, 3600000 |
| `OUTBOX_VERROU_MS` | durée du bail, au moins deux fois le plus long délai d'attente | 120000 |
| `OUTBOX_LOT_MAX` | événements par lot | 20 |

Le jeton est enveloppé dans `Secret` : il ne sort ni par `JSON.stringify`, ni par `console.log`, ni par `String()` ; il n'est
lu que par le transport. Une valeur illisible est ignorée, remplacée par le défaut et signalée, sans arrêter le serveur.
Une destination désactivée n'a **pas d'adaptateur** : aucun chemin ne mène au réseau, et `POST /outbox` répond 409
`DESTINATION_DESACTIVEE` sans rien écrire.

## 5. Routes d'administration v2

Montées sur `/api/v2/integrations`, **réservées au rôle ADMIN** (`requireAuth`, `requireRole("ADMIN")`). Il n'existe pas de
clé de module « integrations » dans `lib/modules.ts` : en créer une impose de la propager au frontend et aux profils, et
`requireModuleAccess` serait ici sans objet (ADMIN passe toujours, les autres sont déjà refusés). Pour déléguer, créer la clé
puis l'ajouter à ce routeur. L'auteur vient de la session, jamais du corps ; les corps sont stricts (clé inconnue = 400).

| Route | Effet |
|---|---|
| `GET /` | configuration (sans jeton ni URL), comptes par état, avertissement « simulateurs » |
| `GET /contrats` | routes par destination et liste de ce qui reste à confirmer |
| `GET /outbox?statut&destination&page&pageSize` | liste paginée, **sans la charge** |
| `GET /outbox/:id[?avecCharge=true]` | événement, tentatives, journal d'audit |
| `POST /outbox` | inscrit `{destination, sourceType, sourceId}` ; 201, ou 200 `dejaEnregistre` |
| `POST /outbox/:id/relancer` | `{motif}` : `ECHEC` ou `ABANDONNE` vers `EN_ATTENTE` |
| `POST /outbox/:id/abandonner` | `{motif}` : sort l'événement de la file, sans l'effacer |
| `POST /outbox/:id/rejouer` | émet maintenant ; sans effet si déjà `ENVOYE` |
| `POST /outbox/traiter` | `{limite?}` : émet un lot d'événements dus |

Codes : 400 requête invalide ou motif manquant ; 404 introuvable ; 409 destination désactivée, source non émissible,
transition interdite, déjà envoyé, bail actif ; 422 charge non conforme ou portant un champ interne.

**Exploitation.** Aucun ordonnanceur n'est démarré. Pour émettre périodiquement, lancer `npx tsx scripts/outbox-traiter.ts`
depuis un cron ; sans destination active, il répond « 0 destination active » et ne contacte personne. Surveiller
`GET /api/v2/integrations` : des événements `ECHEC` qui s'accumulent ou un `ABANDONNE` sont à traiter par un humain.

## 6. Preuves, et leurs limites

| Preuve | Où | Ce qu'elle établit | Ce qu'elle n'établit pas |
|---|---|---|---|
| Tests unitaires et de contrat | `src/integrations/**`, `src/api-v2/integrations.routes.test.ts` | machine à états, clé, canonique, contrats stricts, configuration, adaptateurs contre simulateurs (succès, 5xx, délai, doublon, accusé invalide, 4xx, redirection, jeton refusé, charge non conforme), service, routes | tout comportement d'un tiers |
| Banc SQL | `backend/prisma/tests/outbox.test.sql` | la base refuse donnée non validée, clé ou empreinte fausses, transition hors machine, modification d'un `ENVOYE`, suppression, modification du journal | le service applicatif |
| Banc d'intégration | `tests-integration/outbox.integration.mts` | service + SQL + déclencheurs contre PostGIS réel, concurrence réelle, simulateurs loopback | les systèmes réels ; le volume de production (base vide) |
| Descente | `verifier.sh --seulement 20261024200000_outbox_integrations` | descente identique, aller-retour, garde (refus avec données) | le comportement sur la production |

Les simulateurs écoutent sur `127.0.0.1` seulement, et `fetchBoucleLocale` **lève** pour tout autre hôte : aucune requête ne
peut quitter la machine depuis les tests.

## 7. Prérequis manquants, système par système

Ce qui suit est la liste **exacte** de ce qu'il faut obtenir pour passer du simulateur au réel. Rien n'est supposé acquis.

### 7.1 DigitalRoad (blocage B-11)

| Catégorie | À obtenir |
|---|---|
| Accès | un environnement de **recette** DigitalRoad joignable depuis le serveur applicatif (route réseau, pare-feu, liste d'autorisation d'adresses) |
| Comptes | un compte technique de service **dédié** ; le jeton ou le certificat associé, à rotation, remis hors dépôt |
| Documentation | la spécification de l'API de réception d'une fiche d'intervention : méthode, chemin, en-têtes, corps, codes de réponse, forme de l'accusé |
| Formats | la **clé stable** DigitalRoad (jamais communiquée, `DATA_SOURCE_OF_TRUTH.md` section 5) ; les valeurs admises de `classePrecision` ; les codes de traitement d'échange (le catalogue n'est pas approuvé) ; la forme de l'identifiant patrimonial attendu (la clé `code Route-Type-PK` des ouvrages est la seule en service) |
| Comportement | DigitalRoad **honore-t-il une clé d'idempotence** ? sous quel en-tête ? ; comment annuler ou remplacer une fiche déjà transmise ; l'accusé de réception équivaut-il au message `TRANSMIS` (décision D-08 sur les origines des statuts) |
| Autorisation écrite | de la Direction d'AGEROUTE et du responsable DigitalRoad, d'émettre des fiches vers l'ERP de production |
| Côté AGEROUTE | **la table des fiches d'intervention** (moteur de programmation, après D-07) : sans elle, aucune fiche ne peut être inscrite ; la décision D-08 ; la transition `APPROUVE > TRANSMIS` via `transiter()` quand DigitalRoad aura confirmé l'accusé |
| Recette | rejouer les tests de contrat de `adaptateurs.contrat.test.ts` contre l'environnement de recette ; vérifier le dédoublonnage sur clé en émettant deux fois |

### 7.2 SharePoint / Entra ID (blocage B-12)

| Catégorie | À obtenir |
|---|---|
| Accès | un site et une bibliothèque de **recette**, joignables depuis le serveur applicatif |
| Comptes | une application Entra ID enregistrée ou un compte de service, **permissions minimales** sur la seule bibliothèque cible ; le secret ou certificat, hors dépôt |
| Documentation | le mode de dépôt retenu (API Microsoft Graph, dossier synchronisé, autre) : le transport actuel est une hypothèse |
| Formats | site, bibliothèque, dossier, convention de nommage, politique d'écrasement ou de versionnement, colonnes de métadonnées, taille maximale |
| Identité | le fournisseur d'identité de référence (D-09) : aucun OIDC ni SAML n'existe dans `backend/src` |
| Autorisation écrite | **diffusion du bulletin** : aucun canal n'est autorisé aujourd'hui (`REQUIREMENTS_TRACEABILITY.md` 7.17) ; décision d'AGEROUTE sur le contenu et la fréquence |
| Recette | émettre un bulletin de test, vérifier l'empreinte et la taille côté SharePoint, rejouer, vérifier l'absence de doublon |

Lecture seule existante : SharePoint **consomme** déjà `/api/public` (origine CORS). Cette liaison n'est pas modifiée.

### 7.3 BDR nationale / ONR / L²R

| Catégorie | À obtenir |
|---|---|
| Existence d'un mécanisme | **la réponse à la question D1** de `ANASUR_COLLECT_TECHNICAL_QUESTIONNAIRE.md` : y a-t-il une API officielle ? Sinon, option A (fichiers contrôlés) ou C (passerelle institutionnelle) : le choix n'appartient pas au code (`BDR_INTEROPERABILITY_OPTIONS.md`) |
| Formats | les formats **L²R Mesure, Base, Programme** (non publiés) ; un **export approuvé** de l'ONR ou d'ANASUR pour remplir `BDR_FIELD_MAPPING_TEMPLATE.csv` (vide par construction) |
| Identifiants | un **identifiant institutionnel officiel** (D-06, question E1 : schéma des identifiants et leur stabilité) ; sans lui, l'identifiant technique du Géoportail est émis tel quel et le rapprochement de l'étape 1 n'existe pas (`BDR_ID_CROSSWALK_SPEC.md`) |
| Vocabulaire | la valeur définitive de `systeme_source` (`AGEROUTE_GEOPORTAIL` est une proposition) ; les noms d'attributs |
| Comptes et accès | un environnement de test ou de recette (question D2), l'accord institutionnel autorisant les échanges (question J4), un compte nominatif, ou le dépôt sécurisé institutionnel (SFTP ou SharePoint, B-12) |
| Autorisation écrite | une **convention AGEROUTE - ONR** (aucune n'existe) et l'autorisation écrite de la source pour chaque échange (`INSTITUTIONAL_DATA_GOVERNANCE.md`) |
| Écart consigné | GeoPackage non produit (aucune dépendance SQLite) : à décider si l'ONR l'exige |
| Recette | tests X-01 à X-04 de `ONR_BDR_TEST_PLAN.md` dans le format cible ; U-01 (notes UEMOA) dépend du texte de la directive |

### 7.4 Waze / CIFS et DATEX II (couche d'exploitation, 7.17)

**Non implémentés.** Aucun adaptateur n'existe : aucun compte partenaire (`REQUIREMENTS_TRACEABILITY.md` 7.17) et aucun
document du dépôt ne décrit ces flux. Les ajouter suppose : un compte et une habilitation partenaire auprès de chaque
opérateur ; le profil de flux à émettre, **à lire dans la spécification de l'opérateur et non à deviner** (je n'ai pas vérifié
ces formats) ; la décision d'AGEROUTE sur ce qui est publié, car l'Info Route ne publie que les informations validées par
l'exploitant ; et une migration qui étend les CHECK de `outbox_evenements` et le déclencheur (réversible).

### 7.5 Transverses

- Une décision écrite d'AGEROUTE sur **qui active** une destination en production et comment (aujourd'hui : variables
  d'environnement du conteneur, jamais le dépôt).
- Une **procédure d'exploitation** de la file morte : qui consulte `GET /`, qui relance, sous quel délai.
- Un **ordonnanceur** : cron appelant `scripts/outbox-traiter.ts`, ou service dédié.
- La **rotation** des jetons et leur stockage (le dépôt interdit tout secret, `AGENTS.md` règle 1).
- La **validation humaine du déploiement** (`AGENTS.md` règle 5) : la migration n'est pas appliquée en production par ce travail.

## 8. Ordre recommandé pour passer au réel

1. Obtenir les accès de **recette** et la documentation (7.1, 7.2) ; ne **rien** activer en production.
2. Renseigner les variables d'une seule destination, vers la recette, dans un environnement de test d'AGEROUTE.
3. Rejouer les tests de contrat contre la recette ; corriger l'enveloppe et le transport selon la documentation réelle
   (le contrat actuel est un brouillon) ; remplir `CHAMPS_A_CONFIRMER` de réponses.
4. Émettre un événement de test, puis le rejouer : vérifier **chez le destinataire** qu'il n'y a pas de second effet.
5. Seulement alors, une autorisation écrite pour la production, destination par destination.

## 9. Limites et risques connus

- **Livraison au moins une fois** (2.4) : sans déduplication chez le destinataire, un travailleur mort entre l'appel et
  l'écriture peut produire un doublon.
- **Pas de rétractation** : si une donnée émise est ensuite rejetée ou supprimée, l'outbox n'envoie rien (aucun message
  d'annulation n'est spécifié) ; l'événement `ENVOYE` reste tel quel. Un nouvel événement n'est inscrit que sur demande.
- **Pas de branchement automatique** : l'inscription est un geste explicite. Brancher l'outbox sur la validation d'une portion
  ou d'un ouvrage est une décision de produit, à prendre une fois les contrats confirmés.
- **Ordre** : l'ordre d'émission n'est pas garanti entre deux versions d'une même source (la version est portée par l'enveloppe).
- **Volume** : le banc tourne sur une base vide ; aucune mesure de performance sur 261 387 tronçons.
- **Le client Prisma généré n'est pas utilisé** pour l'outbox (SQL étiqueté) : les modèles `OutboxEvenement` et
  `OutboxTentative` de `schema.prisma` reflètent la base mais ne sont pas requis à l'exécution.
