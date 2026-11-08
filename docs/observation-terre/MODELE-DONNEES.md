# Observation de la Terre : modele de donnees et service d'ecriture (Lot 1, EO-DB)

Chantier EO-DB. Migrations `20261028100000_eo_produits_sources`, `20261028110000_eo_propositions_workflow`, `20261028120000_eo_qualite_methodes`, puis `20261028130000_eo_gardes_journal` (chantier EO-FIX-BACK : gardes du journal et des produits) (backend/prisma/migrations), descentes du meme nom (backend/prisma/descentes), service `backend/src/teledetection/teledetection.service.ts`, noyau pur `teledetection.noyau.ts`. Le CONTRAT d'API et d'interface est `CONTRAT-API-UI.md` ; ce document dit ce que la base et le service tiennent, et ce qu'ils ne tiennent pas.

Les migrations sont ADDITIVES et IDEMPOTENTES (rejouables sans effet). Elles ne modifient aucune ligne existante, sauf la region des propositions deja rattachees (derivee du troncon).

## 1. Ce que le modele garantit

1. Une proposition n'ecrit jamais dans `troncons`, `portions`, `ouvrages` : le service n'a pas le moyen de le faire (type du depot sans ces delegues, aucune requete SQL d'ecriture sur ces tables). Prouve par comparaison d'empreintes avant et apres dans le banc `eo-workflow` (avec un temoin : modifier un troncon change l'empreinte).
2. Un verdict (`CONFIRMEE`, `INFIRMEE`) est definitif et cite son constat. La detection (geometrie, score, rattachement, limites, priorite, region, drapeau synthetique...) est figee a l'insertion.
3. Chaque changement de statut a sa ligne de journal DANS LA MEME TRANSACTION, exigee par la base.
4. Une source n'est « active » (`TRAITEMENT_OPERATIONNEL`) que par un changement d'etat date, commente et trace. L'amorce n'en fait aucune.
5. Un meme produit chez un meme fournisseur n'entre qu'une fois.
6. Un taux de confirmation est toujours accompagne de son effectif ; a zero verdict il vaut NULL, jamais 0.

## 2. Tables

### 2.1 `sources_observation` (nouvelle)

| Colonne | Role |
|---|---|
| `code` (unique, immuable) | `SENTINEL2`, `LANDSAT89`, `PLANETSCOPE`, `SPOT` a l'amorce |
| `nom`, `fournisseur`, `capteur?`, `resolutionM?` | description ; `capteur` et `resolutionM` restent NULL tant qu'ils ne sont pas releves a la source |
| `etat` | echelle du contrat (section 4) : `NON_CONFIGUREE` < `CONFIGUREE` < `AUTHENTIFIEE` < `ACCESSIBLE` < `PRODUIT_DISPONIBLE` < `TRAITEMENT_OPERATIONNEL`, plus `EN_ERREUR` et `EN_ATTENTE_CONFIGURATION` |
| `dernierMessage`, `derniereVerificationLe`, `derniereAcquisitionLe` | message et date du dernier test ; date d'acquisition du produit reel le plus recent enregistre |
| `requiertIdentifiants` | le fournisseur exige des identifiants pour la recherche au catalogue |
| `configJson` | parametres NON secrets. Une contrainte refuse, au premier niveau, les cles d'apparence secrete (`password`, `secret`, `token`, `apiKey`, `authorization`...) : garde-fou de meilleur effort, pas une garantie |
| `createdAt`, `updatedAt`, `deletedAt` | suppression logique ; le DELETE physique est refuse par declencheur |

Contraintes : `src_obs_etat` (huit valeurs) ; `src_obs_verification_requise` (tout etat hors `NON_CONFIGUREE`, `CONFIGUREE`, `EN_ATTENTE_CONFIGURATION` exige une date de verification ET un message : **aucune source n'est « active » sans test date**) ; `src_obs_identifiants_coherents` (`AUTHENTIFIEE` et `EN_ATTENTE_CONFIGURATION` n'existent que si `requiertIdentifiants`).

### 2.2 `sources_observation_etats` (nouvelle, ajout seul)

`de?`, `vers`, `creeLe`, `message`, `auteurId?` (NULL seulement pour la ligne de creation de l'amorce), `transactionId` (rempli par la base, `txid_current()`). UPDATE et DELETE refuses par declencheur. Un declencheur de contrainte DIFFERE sur `sources_observation` exige, pour tout changement d'`etat`, une ligne `(de, vers)` ecrite par la meme transaction.

### 2.3 Amorce : migration de donnees, pas script

Les quatre sources du produit sont inserees par la migration (`ON CONFLICT (code) DO NOTHING`, historique ajoute seulement aux sources qui n'en ont aucun) :

| Code | Etat d'amorce | `requiertIdentifiants` | `resolutionM` | `capteur` |
|---|---|---|---|---|
| `SENTINEL2` | `NON_CONFIGUREE` | non | 10 (fixee par le contrat) | `MSI` |
| `LANDSAT89` | `NON_CONFIGUREE` | non | NULL | `OLI/OLI-2` |
| `PLANETSCOPE` | `EN_ATTENTE_CONFIGURATION` | oui | NULL | NULL |
| `SPOT` | `EN_ATTENTE_CONFIGURATION` | oui | NULL | NULL |

Pourquoi une migration et non un script `peupler` : la page « Sources » doit montrer ces quatre lignes, dans l'etat honnete « non configuree », dans tous les environnements, sans qu'un humain doive penser a lancer un script ; sans migration, un environnement afficherait « aucune source » comme si le produit n'en avait pas. L'insertion est rejouable sans reecrire un etat deja change. La descente refuse si une source a quitte son etat d'amorce.

PROVISOIRE (a verifier par AGEROUTE / EO-SOURCES) : `requiertIdentifiants` des deux sources commerciales (comptes fournisseur), absence de compte pour la recherche au catalogue de Sentinel-2 et Landsat ; les resolutions et capteurs non releves sont laisses NULL plutot qu'inventes.

### 2.4 `earth_observation_products` (colonnes ajoutees)

`sourceCode?` (cle etrangere vers `sources_observation.code`), `fournisseur?`, `identifiantFournisseur?`, `collection?`, `capteur?`, `orbite?`, `scene?`, `niveauTraitement?`, `resolutionNativeM?` (distincte de `resolutionM`, celle du produit livre), `empreinteSha256?`, `stockageChemin?`, `cycleVie` (defaut `CATALOGUE`), `licenceCode?`, `licenceAttribution?` (la colonne `licence` d'avant reste le texte releve a la source), `synthetique` (defaut faux).

- Deduplication : index UNIQUE `(fournisseur, identifiantFournisseur)` ; les NULL (produits saisis a la main, d'avant la migration) ne se comparent pas. Les deux colonnes vont ensemble (`eo_fournisseur_coherent`).
- Cycle de vie : `CATALOGUE` (reference au catalogue, aucun pixel chez nous), `TELECHARGE`, `TRAITE`, `ARCHIVE`, `PURGE`, `EN_ECHEC`. `TELECHARGE`, `TRAITE`, `ARCHIVE` exigent empreinte ET chemin ; `CATALOGUE` n'en porte aucun (`eo_cycle_vie_coherent`).
- **Colonnes figees** (migration `20261028130000`, constat EO-FIX-BACK 6 d) : apres l'insertion, un produit ne change plus ni `code`, `palier`, `source`, `nature`, `dateAcquisition`, `dateFin`, `resolutionM`, `resolutionNativeM`, `couvertureNuagesPct`, `provenance`, `licence`, `licenceCode`, `licenceAttribution`, `versionTraitement`, `emprise`, `synthetique`, `sourceCode`, `fournisseur`, `identifiantFournisseur`, `collection`, `capteur`, `orbite`, `scene`, `niveauTraitement`, `enregistreParId`. Avant, un seul `UPDATE` de `synthetique` ou d'`emprise` faisait passer la vue `coherence_teledetection` a 9 anomalies. Restent modifiables : `cycleVie`, `empreinteSha256`, `stockageChemin` (le produit est telecharge, traite...), `incertitude`, `autorisationDepenseRef`, `deletedAt`. **Correction exceptionnelle, documentee et journalisee** : dans la transaction, `SET LOCAL bdri.correction_produit_motif = '<motif, 10 caracteres au moins>'` et `SET LOCAL bdri.correction_produit_auteur = '<identifiant d'un compte>'` ; le declencheur ecrit alors une ligne `audit_logs` (`UPDATE`, `EarthObservationProduct`, operation `CORRECTION_PRODUIT_FIGE`, motif, ancienne et nouvelle valeur de chaque colonne changee). Sans motif ou sans auteur connu : refus.
- Empreinte : 64 caracteres hexadecimaux minuscules (`eo_empreinte_sha256`). Chemin de stockage : identifiant interne, une adresse portant des identifiants de connexion est refusee (`eo_stockage_sans_secret`).
- Index : date, source, nature, source liee, plus l'unique ci-dessus.

### 2.5 `propositions_teledetection` (colonnes ajoutees)

| Colonne | Role |
|---|---|
| `prioriteNiveau?`, `prioriteRegle?` | `HAUTE`/`MOYENNE`/`FAIBLE` et la regle qui l'a produite (les deux, ou aucune) |
| `confianceDetection?`, `confianceCalibree` | indice 0 a 1 rendu par la methode ; `confianceCalibree` est faux, toujours, aujourd'hui. Le service ne l'expose pas en entree |
| `imageCouvertureNuagesPct?`, `imageNote?` | qualite de l'image |
| `rattachementConfiance?`, `rattachementAlgorithme?`, `rattachementCandidats?` | `HAUTE`/`MOYENNE`/`FAIBLE`/`AUCUN` (`AUCUN` si et seulement si pas de troncon) ; algorithme (`PLUS_PROCHE_DANS_TOLERANCE_V1`, ou `NON_DEMANDE` quand aucune tolerance n'a ete donnee) ; troncons concurrents dans la tolerance en JSONB `[{tronconId, code, distanceM}]` (5 au plus) |
| `methodeNom?`, `methodeVersion?` | separes ; la colonne `methode` d'avant (« nom version ») est conservee et sert aux vues |
| `limites?` (texte[]) | limites de la detection. NULL = non renseignees (lignes d'avant). Renseignees : au moins une, jamais blanche |
| `synthetique` | donnee de demonstration ou de test, exclue de toute vue |
| `centre` | `geometry(Point,4326)`, colonne CALCULEE (`ST_PointOnSurface(geom)`) : point garanti sur la geometrie, jamais ecrit. Indexee GiST Colonne GENEREE : PostgreSQL la presente comme ayant un « defaut » (`st_pointonsurface(geom)`), ce que le controle de derive de Prisma lisait comme `ALTER COLUMN "centre" DROP DEFAULT` (DDL que PostgreSQL refuse sur une colonne generee). Le modele Prisma porte donc `@default(dbgenerated("st_pointonsurface(geom)"))` sur ce champ `Unsupported` (jamais ecrit par le client) ; `prisma migrate diff` contre un clone ne propose plus rien pour `centre` (verifie, EO-FIX-BACK 7). Si une version de Prisma refusait cette ecriture, l'exception a ajouter a `verifier-derive-schema.ts` du depot principal serait `EX-COLONNE-GENEREE : propositions_teledetection.centre` (premiere colonne generee du depot). |
| `regionId?` | region du troncon, denormalisee au depot (NULL sans troncon). Indexee. Figee une fois posee |
| `motifAttente?` | `INFO_DEMANDEE` ou `AUTRE`, renseigne si et seulement si le statut est `EN_ATTENTE` |

Les produits « avant » et « apres » sont `produitReferenceId` et `produitId` (deja en place).

Les lignes d'avant la migration ont ces colonnes NULL : NULL veut dire « non evalue ». `confianceDetection` n'est PAS remplie depuis `score` (le score est ce que la methode rend ; en faire une confiance serait une affirmation que rien ne fonde). Le client Prisma lit un `limites` NULL comme une liste vide (verifie par le banc).

### 2.6 `propositions_teledetection_transitions` (nouvelle, ajout seul)

`propositionId`, `de`, `vers`, `auteurId`, `creeLe`, `motif`, `commentaire?`, `motifAttente?`, `transactionId`. Contraintes : rien ne sort d'un verdict ; le seul « surplace » est `EN_ATTENTE` vers `EN_ATTENTE` ; `motifAttente` renseigne si et seulement si `vers = EN_ATTENTE`.

### 2.7 `propositions_teledetection_preuves` (nouvelle, ajout seul)

`propositionId`, `observationId` (cle etrangere vers `observations`, aucune copie de contenu), `transitionId?` (la transition qui l'a citee), `ajouteeParId`, `ajouteeLe`. Unique `(propositionId, observationId)`.

## 3. Statuts et transitions

`A_VERIFIER`, `EN_ATTENTE`, `NON_CONCLUANTE`, `CONFIRMEE`, `INFIRMEE`.

| De \ Vers | A_VERIFIER | EN_ATTENTE | NON_CONCLUANTE | CONFIRMEE | INFIRMEE |
|---|---|---|---|---|---|
| A_VERIFIER | non | oui | oui | oui | oui |
| EN_ATTENTE | oui | oui (nouvelle demande) | oui | oui | oui |
| NON_CONCLUANTE | oui | oui | non | oui | oui |
| CONFIRMEE / INFIRMEE | non | non | non | non | non |

- Table du noyau : `TRANSITIONS_AUTORISEES`, testee sur les 25 couples contre un oracle ecrit a la main (Vitest) et sur les 25 couples a travers le service et la base (banc PostGIS).
- Erreurs : depuis un verdict, `VERDICT_DEFINITIF` (409) ; transition hors table, `TRANSITION_INTERDITE` (409). La base refuse toute sortie d'un verdict, y compris par acces direct. Elle ne refuse pas `A_VERIFIER` vers `A_VERIFIER` ni `NON_CONCLUANTE` vers `NON_CONCLUANTE` : ce ne sont pas des changements de statut pour elle ; le service les refuse.
- Un verdict cite un constat : une reference (`constatRef`) ou au moins une observation (`observationIds`, dont la reference est alors derivee). Il porte auteur, date, motif ; ces champs sont NULL pour les trois autres statuts (la raison d'une attente ou d'une non-conclusion est dans le journal).
- « Affectee a une mission » = `missionId` non nul ; « en cours d'inspection » = etat de la mission ; « cloturee » n'est pas implemente.

### Journal exige par la base

Declencheur de contrainte DIFFERE sur `propositions_teledetection` : tout changement de `statut` OU de `motifAttente` doit avoir, dans la meme transaction, SA ligne dans le journal (`transactionId = txid_current()`). Verifie a la validation : l'ordre des ecritures dans la transaction est libre (le service ecrit le journal d'abord). Un contournement par acces direct (UPDATE sans journal) echoue au COMMIT. Limite : un acces direct superutilisateur avec `session_replication_role = replica` desactive les declencheurs.

**Comptage exact (migration `20261028130000`, constats EO-FIX-BACK 6 a, b, c).** La premiere version apparie un changement a une ligne portant le meme couple `(de, vers)` SANS COMPTER : trois changements dans une transaction avec deux lignes passaient, et un changement de motif d'attente n'etait pas controle. Desormais un declencheur ordinaire (`propositions_teledetection_a_note_changement`) note chaque changement (`de>vers>motif`) dans une variable locale a la TRANSACTION (`set_config(..., true)` : annulee par ROLLBACK et ROLLBACK TO SAVEPOINT, jamais partagee). Au COMMIT, le declencheur differe compare cette liste aux lignes de journal de la transaction par `EXCEPT ALL` (multiensembles) : chaque changement exige SA ligne ; une ligne qui ne correspond a aucun changement de la meme proposition et de la meme transaction est refusee, sauf la « nouvelle demande » `EN_ATTENTE` vers `EN_ATTENTE` (elle ne change aucune colonne quand le motif reste le meme). Un verdict (`CONFIRMEE`, `INFIRMEE`) doit etre signe (`verifieeParId`) par l'auteur de la ligne de journal qui l'a rendu.

Limites assumees : (1) une ligne de journal ecrite dans une transaction OU AUCUN changement de la proposition n'a lieu n'est pas detectee (le controle se joue sur un changement) ; (2) en mode `SET CONSTRAINTS ... IMMEDIATE`, plusieurs changements successifs d'une meme proposition exigent que chaque ligne precede son changement (le mode par defaut, differe, n'a pas cette contrainte) ; (3) le nom du declencheur de note commence par `a_` pour se jouer AVANT le declencheur de contrainte en mode immediat (ordre alphabetique) ; (4) un acces qui forge lui-meme la variable de comptage n'est pas couvert : le registre protege des erreurs et des contournements ordinaires, pas d'un administrateur de base decide.

### Garde et insertion

- `propositions_teledetection_garde` (avant UPDATE/DELETE) : suppression refusee ; detection figee ; region figee une fois posee ; verdict definitif ; transitions ; mission rattachee une seule fois ; date du verdict posee par la base.
- `propositions_teledetection_coherence` (avant INSERT) : la proposition entre `A_VERIFIER` (avant, un verdict pouvait etre insere directement) ; detection dans l'emprise du produit (et du produit de reference) ; reference strictement anterieure ; region posee depuis le troncon ; une donnee synthetique n'a pour produit qu'un produit synthetique, et inversement.

## 4. Vues et constantes

- `qualite_methodes_eo` : par `type`, `methode`, `methodeNom`, `methodeVersion` : `total`, `aVerifier`, `enAttente`, `nonConcluantes`, `confirmees`, `infirmees`, `jugees`, `tauxConfirmation` (NULL a zero verdict), `echantillonSuffisant`, `seuilEchantillon`. Donnees synthetiques exclues. C'est un taux de CONFIRMATION terrain, pas la precision statistique (aucun rappel).
- `eo_seuil_echantillon_taux()` = 30. **PROVISOIRE** : effectif minimal de verdicts sous lequel un taux n'est pas presente comme fiable. Meme valeur dans le noyau (`SEUIL_ECHANTILLON_TAUX`) ; un test lit la migration et un banc compare la valeur lue en base.
- `precision_teledetection` : conservee (memes colonnes). Corrigee : « juge » = `CONFIRMEE` ou `INFIRMEE` (avant : tout sauf `A_VERIFIER`, ce qui aurait compte une proposition en attente comme jugee) ; synthetiques exclus. La colonne `aVerifier` ne compte que `A_VERIFIER` (donc `total` n'est plus la somme des colonnes de statut).
- `coherence_teledetection` : inchangee.

Autres constantes PROVISOIRES du noyau (choix de conduite, a fixer par AGEROUTE) : `MARGE_EMPRISE_MISSION_DEG` = 0,0005 degre (marge autour de la detection pour l'emprise de la mission) ; `RATIO_PROXIMITE_PROVISOIRE` = 0,5 et `FACTEUR_SEPARATION_PROVISOIRE` = 2 (confiance du rattachement) ; `CANDIDATS_CONCURRENTS_MAX` = 5. Ce sont des indices d'ambiguite, pas des probabilites. Aucune constante metier n'intervient dans les compteurs de la synthese.

## 5. Service : fonctions exportees (backend/src/teledetection/teledetection.service.ts)

Toutes prennent un client Prisma OU un client de transaction (`DepotTeledetection`) ; elles ouvrent leur transaction si le client en est un. Le contexte `{ auteurId, ipAddress?, perimetre? }` porte le perimetre du compte (`Perimetre` de `territoire.noyau.ts` : meme forme). **Sans `perimetre`, aucun controle territorial : la route doit le fournir.** Un refus est une `RefusTeledetection { code, http: 400|403|404|409 }`.

Voir le rapport du chantier pour les signatures exactes. Resume : `changerStatut`, `ajouterPreuves`, `deposerPropositions`, `dispatcherVerification` (alias `depecherVerificationTeledetection`), `enregistrerProduit`, `enregistrerProduits`, `changerEtatSource`, `calculerSynthese`, `qualiteMethodes`, `precision`, `poserVerdict` (ancienne API, passe par `changerStatut`).

## 6. Mission de verification

`dispatcherVerification` cree une mission `SURVEILLANCE` BROUILLON qui recoit : `regionId` = region de la proposition (NULL si non rattachee : jamais une region inventee), `emprise` = enveloppe de la detection elargie de `MARGE_EMPRISE_MISSION_DEG`, intitule nommant le troncon. **La table `missions` n'a pas de colonne de troncon** : le troncon se lit par `propositions_teledetection.missionId` et dans l'intitule. Ajouter `missions.tronconId` serait une migration hors de ce chantier.

## 7. Descentes et verification

`backend/prisma/descentes/20261028*_eo_*.sql`, verifiees par `descentes/verifier.sh` (voir le rapport du chantier pour les comptes). Gardes : la descente du workflow refuse SANS DEROGATION s'il existe une proposition `EN_ATTENTE` ou `NON_CONCLUANTE` (aucun statut de remplacement n'est invente), et refuse sans autorisation s'il existe des donnees du workflow (priorite, confiances, rattachement detaille, limites, journal, preuves). La descente des sources refuse si une source a quitte son etat d'amorce ou si un produit porte la tracabilite.

## 8. Ce qui reste non couvert

- **Production non verifiee** : aucune des quatre migrations n'a ete appliquee a une base de production ; volumes, verrous et durees ne sont pas mesures. `ADD COLUMN ... GENERATED ALWAYS AS (...) STORED` (`centre`) REECRIT la table des propositions sous un verrou `ACCESS EXCLUSIVE` pour toute la duree de la reecriture (petite table, mais a faire en fenetre de maintenance, sur une copie de production d'abord) ; les lectures et ecritures de la console sont bloquees pendant ce temps. La migration `20261028130000` ne reecrit rien (fonctions et declencheurs).
- **Regle de priorite** : la base stocke un niveau et une regle ; aucun calcul de priorite n'est fourni (le moteur doit la donner). La priorite est immuable une fois deposee.
- **Precision et rappel** : non calcules (protocole de reference terrain absent).
- **Statut « cloturee »** : non implemente. **Troncon de la mission** : pas de colonne.
- **Trois compteurs, trois definitions de la region** (constat EO-FIX-BACK 9, comportement inchange) : `veille.service.ts` compte les propositions `A_VERIFIER`, `EN_ATTENTE` et `NON_CONCLUANTE` hors donnees synthetiques, pour TOUS les comptes (compteur national) ; l'indicateur `propositions_a_verifier` du tableau de bord suit la region COURANTE du troncon (`troncons.regionId` au calcul) ; `/synthese` et les listes de l'API suivent la region FIGEE au depot (`propositions_teledetection.regionId`). Si un troncon change de region, ces chiffres divergent sans qu'aucun soit faux.
- **Secrets dans `configJson`** : refus de cles evidentes au premier niveau seulement.
- **Comptes sans rattachement regional** : ils sont NATIONAUX (choix du depot, `territoire.noyau.ts`) : un nouvel inspecteur sans region voit toutes les propositions et toutes les preuves des qu'il a la cle de module `teledetection`. Rattacher chaque compte a une region est une donnee d'organisation (D-11).
- **Journal sans changement** et mode immediat : voir les limites du paragraphe « Journal exige par la base ».
- **Routes** : `POST /propositions` doit etre etendu (limites, methodeNom, methodeVersion, confianceDetection, priorite...) ; tant qu'il ne l'est pas, tout depot par cette route est refuse (`LIMITES_REQUISES`). Les tests de route du depot sont suspendus pour cette raison.
