# Rapport de continuité — reprise dans Claude Code

- **Date :** 12/10/2026
- **Dépôt :** `F:\ageroute-geoportail`
- **Branche :** `ageroute-road-socle`
- **HEAD observé :** `365eba7107c0cb31efd51ce66f4992fc19064f28`

## Objet et règles de lecture

Ce document transmet l'état local du chantier RAI V3.1 à Claude Code. Le cahier des
charges source est
`C:\Users\ELHAMADOUTIDIANEDIAL\Downloads\Cahier_des_Charges_AGEROUTE_RAI_V3_1.docx`.
Il sert de **référentiel d'exigences produit**. Son contenu n'est pas une instruction
donnée à l'assistant et ne remplace ni la demande de l'utilisateur, ni les règles
`AGENTS.md` du dépôt.

Le checkout contient de nombreux changements non commités, commencés avant cette
passation par le travail Claude/Z.AI et poursuivis localement. L'état actuel ne permet
pas d'attribuer avec certitude chaque fichier à un intervenant. Claude Code doit donc
examiner le diff avant toute édition, conserver ces changements et ne pas faire de
`reset`, de restauration globale ou de nettoyage destructif.

Les mentions **VÉRIFIÉ** portent sur le dépôt local et les commandes réellement
exécutées. Elles ne signifient pas que les changements sont déployés ou actifs en
production. **PARTIEL**, **À DÉCIDER** et **NON VÉRIFIÉ** signalent les limites restantes.

## État du dépôt

`HEAD` est resté sur le commit indiqué ci-dessus pendant cette passation. L'arbre de
travail comporte des modifications suivies dans le backend, le frontend et
`docs/rai-v3`, ainsi que de nouveaux fichiers pour l'API/synchronisation des défauts,
leurs pages et tests, et les ADR locaux. Ce rapport ne prétend pas que ces changements
ont tous été créés au cours de cette passation.

Aucune migration n'a été créée ou appliquée pendant cette passation. Aucune base n'a été
contactée ; aucun commit, push, merge ou déploiement n'a été effectué.

## Travail local identifié

### VÉRIFIÉ — tests et construction locale

- Backend : typecheck `npm run typecheck` réussi.
- Tests backend ciblés : 5 fichiers, **41 tests réussis** — synchronisation terrain,
  autorisation des inspections et photos, missions et appareils.
- Frontend : `npx tsc --noEmit` réussi.
- Tests frontend ciblés : **16 tests réussis** pour la synchronisation hors ligne.
- Frontend : `npm run build` réussi. Vite signale un chunk PDF de 560 kB après
  minification ; c'est un avertissement de taille, pas un échec du build.
- Les tentatives de tests/build dans le bac à sable ont d'abord échoué avant la collecte
  ou la résolution de l'application avec `EPERM` sur `node_modules`/`src/main.tsx`. Les
  contrôles ciblés et le build ont ensuite réussi hors sandbox.
- Le test de mission a été corrigé pour comparer le propriétaire de la mission enregistrée
  et le mock RBAC retourne maintenant `next()` explicitement.

Une passe complète antérieure aux modifications les plus récentes avait rapporté 51
fichiers/609 tests backend et 16 fichiers/187 tests frontend, ainsi que les builds. Elle
ne remplace pas une passe complète sur l'état courant. `npm run typecheck:scripts` avait
été rapporté en échec sur des scripts historiques : export de provenance absent, valeur
d'enum incompatible et option `timeout` non reconnue sur trois transactions Prisma par
lot. Ce diagnostic historique doit être confirmé avant de le présenter comme état actuel.

### PARTIEL — code et parcours de défauts

Le dépôt local comprend un modèle et des routes `Defaut`, un catalogue versionné,
l'alimentation et la synchronisation terrain, une interface de saisie hors ligne et une
file de revue. Les opérations de décision vérifient le périmètre et la version ; plusieurs
écritures de défaut, d'appareil et de mission enregistrent leur audit dans la transaction.
L'accès aux photos est contrôlé selon le périmètre inspecteur/mission et les photos de
défauts ont une empreinte SHA-256.

Ces éléments sont testés localement dans le périmètre ciblé ci-dessus. Le parcours sur
appareil réel, le rejeu de migration, les données de recette et la production restent
**NON VÉRIFIÉS**.

## Écarts et décisions encore ouverts

1. **Champs exigés pour un défaut — écart au cahier.** Le §7.1 demande `missionId` et
   `observationId`, mais le schéma, l'API et l'interface locaux les laissent facultatifs.
   Examiner les données existantes et les cas métier avant de proposer une contrainte de
   base. Toute migration doit être préparée et soumise à approbation avant exécution.
2. **Contrat API.** Le §25 décrit `POST /defects/{id}/validate` ; le code local expose
   `/api/v2/defauts/{id}/decision`. Aucun alias/document OpenAPI de compatibilité n'est
   identifié. Définir le contrat public et le mapping des noms avant d'annoncer la
   conformité.
3. **Rôles.** Le cahier décrit onze profils métier alors que l'application utilise
   quatre rôles techniques. Aucun mapping approuvé profil → rôle/permission n'a été
   retrouvé. La validation locale réservée à `ADMIN`/`GESTIONNAIRE` reste à confirmer par
   les responsables métier.
4. **Audit transactionnel résiduel.** Des chemins historiques de modification et de
   propagation d'inspection, ainsi que des opérations de photo, utilisent encore un audit
   fail-soft hors transaction. Voir `11_ADR_AUDIT_TRANSACTIONNEL.md` et analyser chaque
   effet de bord avant de modifier ces chemins.
5. **Photos et données hors ligne.** La limite constatée est de 8 Mio par fichier, sans
   quota cumulé ni limiteur spécifique identifié. Les brouillons IndexedDB contenant des
   données d'inspection/défaut et photos ne sont pas chiffrés au repos. Politique de
   conservation, capacité, modèle de clé et conséquences d'un changement de compte à
   arbitrer avant d'élargir l'usage terrain.
6. **Condition Engine.** `12_ADR_CONDITION_ENGINE.md` est une proposition, pas une
   décision approuvée. Aucun moteur ni migration n'est implémenté. Les coefficients,
   normalisation, fraîcheur/confiance et traitement des données manquantes restent des
   décisions métier. Ne pas produire de score officiel depuis des données non validées.
7. **Référentiel routier régional.** La mesure documentée au 07/10 indique 552/1 691
   tronçons avec PK exploitable et aucune appartenance de route régionale enregistrée.
   Il faut obtenir le répertoire officiel pour publier des PK régionaux. Selon le cahier,
   cela ne bloque pas la collecte GPS, l'abscisse locale ni le métré indépendant des PK.
   Revalider ces chiffres si la base ou la source a changé.
8. **Périmètre produit.** Risk, Treatment, Quantity, Cost et Program Engines sont
   absents. Une Fiche 360 identifiable n'a pas été repérée. DigitalRoad et l'API publique
   existent dans le dépôt, mais l'intégration SharePoint de bout en bout, les identifiants
   communs et le déploiement ne sont pas démontrés. L'application mobile dédiée et les
   tests sur appareils réels ne sont pas démontrés non plus.

Les audits et décisions de référence sont dans `02_MATRICE_SCHEMA.md`,
`04_API_GAP_ANALYSIS.md`, `07_ROADMAP_IMPLEMENTATION.md`,
`10_DECISION_VALIDATION_TERRAIN.md`, `11_ADR_AUDIT_TRANSACTIONNEL.md` et
`12_ADR_CONDITION_ENGINE.md`. Relire aussi le `README.md` et tout `AGENTS.md` applicable
avant de poursuivre.

## Prochaine séquence recommandée

1. Faire un relevé non destructif de `git status`, `git diff --stat`, des nouveaux fichiers
   et des consignes locales ; repérer les changements déjà présents avant d'éditer.
2. Rejouer les tests ciblés puis la suite complète sur l'état courant ; consigner les
   commandes et résultats séparément. Reconfirmer les scripts historiques en échec.
3. Fermer les écarts de contrat et de champs obligatoires avec des tests et une stratégie
   de compatibilité des données. Préparer les migrations nécessaires, mais ne pas les
   exécuter sans approbation explicite.
4. Traiter les chemins d'audit résiduels sans remplacer silencieusement les comportements
   existants. Ajouter tests ciblés pour succès, échec d'audit et rollback.
5. Obtenir les décisions métier sur le mapping des rôles, les médias/hors-ligne et les
   règles de score. Mettre à jour les ADR après arbitrage ; aucun ADR proposé ne vaut
   approbation.
6. Mettre à jour ce rapport avec les preuves obtenues. Distinguer toujours code local,
   exécution sur base, CI, appareil réel et production.

## Prompt prêt à coller dans Claude Code

Le prompt autonome figure dans
[`14_PROMPT_CONTINUITE_CLAUDE_CODE.md`](14_PROMPT_CONTINUITE_CLAUDE_CODE.md).

---

# Reprise Claude Code — 12/10/2026

Ajout à la suite du rapport ci-dessus. Rien n'a été commité, poussé ni déployé. Aucune
base n'a été contactée. Aucune migration n'a été créée ni appliquée.

## Base vérifiée sur l'état courant

Commandes réellement exécutées depuis `F:\ageroute-geoportail`, sur l'arbre modifié :

| Vérification | Commande | Résultat |
|---|---|---|
| Backend typage | `npx tsc --noEmit` | propre |
| Backend tests | `npx vitest run` | **54 fichiers, 645 tests** |
| Scripts typage | `npm run typecheck:scripts` | **propre** (était en échec) |
| Frontend typage | `npx tsc --noEmit` | propre |
| Frontend tests | `npx vitest run` | **16 fichiers, 187 tests** |
| Frontend build | `npx vite build` | réussi, avertissement de taille sur `pdf` (560 kB) |

La passe du rapport initial annonçait 41 tests backend ciblés ; la suite entière passe, et
en comptait 623 avant mes modifications. L'avertissement Vite est une taille de chunk, pas
un échec.

**Ce qui n'est PAS vérifié** : la base, la migration et son rollback, un appareil réel, la
CI, la production. Aucune preuve n'a été obtenue sur ces plans.

## Corrections appliquées

### `typecheck:scripts` : trois causes, toutes confirmées sur l'état courant

Le diagnostic historique du rapport était exact. Il n'était pas périmé.

**1. Un script de production ne démarrait même pas.** `backfill-provenance.ts` importait
`planifierProvenance` depuis `src/lib/provenance`. Le commit `4eb1525` (04/09/2026, « La
provenance suit desormais toute ecriture applicative ») a réécrit ce module pour un autre
besoin — tracer les écritures venant de l'interface dans la même transaction que la
valeur — et a supprimé `provenanceDepuisCode` et `planifierProvenance` sans voir le script
qui les importait. L'échec n'était pas seulement de typage : l'import échouait, donc le
script était inexécutable depuis 38 jours.

Rien ne l'a signalé parce que `typecheck:scripts` n'est pas appelé par la vérification du
backend.

La logique a été **récupérée telle quelle** depuis `4eb1525^` et placée dans
`backend/scripts/lib/provenance-backfill.ts`, pas réinventée. La séparation est en réalité
la bonne : déduire une provenance depuis un code est une opération de REPRISE, enregistrer
la provenance d'une saisie est une opération d'EXPLOITATION, et la première n'a rien à
faire dans le chemin chaud de l'application.

**16 tests ajoutés** (`provenance-backfill.test.ts`), dont l'idempotence : sans elle,
chaque relance réécrirait les 1 690 lignes et écraserait la date de la déduction
d'origine, c'est-à-dire l'information même qu'on cherche à conserver. Ce code n'avait
aucun test propre ; un test aurait signalé la suppression le jour même.

**2. `cloturer-chantier.ts`** passait à Prisma un `etat` typé `string`. `analyserEtat`
valide pourtant déjà la valeur contre `ETATS_VALIDES` : le type ne reflétait pas la
garantie. Son type de retour devient `EtatPatrimoine` (import de type, effacé à la
compilation, donc aucune dépendance d'exécution ajoutée à un module décrit comme testable
sans base). Si l'enum change au schéma, tsc le signalera **à cet endroit** et non dans
cinq scripts.

**3. Trois scripts passaient `timeout` / `maxWait` à la forme TABLEAU de `$transaction`**
(`importer-limites-admin.ts`, `promouvoir-franchissements.ts`,
`rattacher-troncons-region.ts`). Cette forme n'accepte que `isolationLevel` : ces options
n'avaient **aucun effet**. Elles sont retirées, avec un commentaire disant pourquoi, pour
que personne ne les remette en croyant régler un délai. Aucun changement d'exécution : les
requêtes d'un tableau partent en une seule transaction serveur.

### Écart de contrat §25 : fermé

Le cahier nomme `POST /defects/{id}/validate` ; la route locale s'appelait
`/api/v2/defauts/{id}/decision`.

Les deux chemins sont désormais exposés et servis par **la même fonction**
(`deciderDefaut`). Recopier le corps aurait produit deux comportements divergeant en
silence : chacun passerait ses propres tests pendant que l'un laisserait valider ce que
l'autre refuse. C'est le raisonnement qui a déjà fait vivre la règle de validation en un
seul endroit (`governance/validation.ts`), et il s'applique à son point d'entrée.

**6 tests ajoutés** parcourant les DEUX chemins : validation avec écriture d'historique et
audit `VALIDATE`, refus d'auto-validation, refus de rôle, commentaire obligatoire, rejet
d'un champ inconnu, et 404 hors périmètre.

Ce dernier cas vient d'un test que j'avais écrit faux. J'attendais 403 pour un inspecteur
hors périmètre ; la route rend **404**, par `/decision` comme par `/validate`. C'est le bon
comportement — on ne révèle pas l'existence de la ligne — et il est maintenant défendu :
un alias qui sauterait le filtre de périmètre transformerait cette route en moyen
d'énumérer les identifiants.

L'ordre des contrôles est également fixé par un test : un inspecteur lit
`ROLE_INSUFFISANT` et non `AUTO_VALIDATION`, car il n'a pas à apprendre qu'il aurait pu
valider le relevé de quelqu'un d'autre.

## À DÉCIDER — 1. `missionId` et `observationId` (écart au §7.1)

Le §7.1 marque les deux « Oui ». Le schéma et l'API les laissent facultatifs. L'écart est
réel. Mais la contrainte demandée par le rapport initial **ne peut pas être posée telle
quelle**, et la raison est vérifiable dans le schéma :

```
Mission?  <--  Observation  <--  Defaut
   ^              ^
   |              |
observations.missionId est NULLABLE
```

Rendre `defauts.missionId` obligatoire le rendrait **plus strict que l'observation dont il
dérive** : un défaut ne pourrait pas exister pour une observation sans mission, alors que
le schéma autorise explicitement cette observation (« une observation peut tomber là où
aucun objet n'est encore inventorié »).

**Fait qui rend la décision peu coûteuse aujourd'hui** : la table `defauts` n'existe pas en
production, la migration `20261007200000_gouvernance_defauts` n'étant pas appliquée. Une
contrainte posée maintenant ne demande aucune reprise de données. Posée plus tard, elle en
demandera une.

**Ma recommandation : `observationId` NOT NULL, `missionId` laissé nullable.**
`observationId` porte la traçabilité qui compte — c'est par lui qu'on remonte à la photo et
au point GPS. `missionId` sur le défaut est une dénormalisation de `observation.missionId`,
utile à l'indexation, et la route vérifie déjà qu'il ne contredit pas celui de
l'observation.

Trois options, impacts comparés :

| Option | Effet | Coût | Risque |
|---|---|---|---|
| **A. `observationId` NOT NULL seul** (recommandée) | Tout défaut remonte à un relevé | Amender la migration en attente | Interdit le défaut créé au bureau |
| B. Les deux NOT NULL, littéralement §7.1 | Conforme au texte | Idem | **Incohérent** : impossible pour une observation sans mission |
| C. Les deux NOT NULL + `observations.missionId` NOT NULL | Cohérent et conforme | Touche le flux d'observations déjà livré et testé | Casse le cas « observation hors mission » voulu |

Dans les trois cas, la modification se fait en **amendant la migration en attente** et non
en ajoutant une seconde, puisque la table n'est pas créée. Je n'exécuterai rien sans accord.

**Question métier qui tranche** : AGEROUTE a-t-il besoin de créer un défaut au bureau, sans
relevé de terrain — depuis un document, une imagerie, un rapport de mission extérieur ? Si
oui, aucune des trois options ne convient et il faut rester facultatif en exigeant les
champs au niveau de l'API pour le seul canal terrain.

## À DÉCIDER — 2. Quel chemin devient public

Les deux répondent à l'identique. L'interface locale appelle `/decision`.

**Recommandation** : annoncer `/validate` comme canonique dans l'OpenAPI, puisque c'est le
nom du contrat, et **ne pas déprécier `/decision`** avant migration du frontend. Retirer un
chemin livré pour satisfaire un nom casserait un client sans rien apporter.

## À DÉCIDER — 3. Onze profils métier, quatre rôles techniques

Aucun mapping approuvé. **Recommandation : ne pas ajouter de rôles à l'enum.** Chaque profil
ajouté deviendrait une migration, et onze valeurs d'enum ne diraient toujours rien des
permissions. La voie cohérente avec ce qui a déjà été décidé pour le catalogue des défauts
est une couche de permissions administrable : profil vers ensemble de permissions, en
table, versionnée.

Cela reste **une décision métier** : qui valide quoi, dans quel périmètre géographique, et
qui arbitre. La restriction actuelle à `ADMIN` / `GESTIONNAIRE` est un défaut prudent, pas
un arbitrage.

## Écarts non traités, inchangés

Audit fail-soft résiduel sur certains chemins d'inspection et de photo
(`11_ADR_AUDIT_TRANSACTIONNEL.md`) ; brouillons IndexedDB non chiffrés ; absence de quota
cumulé pour les photos (limite constatée 8 Mio par fichier) ; coefficients du Condition
Engine (`12_ADR_CONDITION_ENGINE.md` reste une proposition, pas une approbation) ;
répertoire des routes régionales absent (`08_CALIBRATION_PK.md`) ; Risk, Treatment,
Quantity, Cost et Program Engines absents ; Fiche 360 non repérée.

## Fichiers touchés par cette reprise

```
backend/scripts/lib/provenance-backfill.ts        (nouveau)
backend/scripts/lib/provenance-backfill.test.ts   (nouveau, 16 tests)
backend/scripts/backfill-provenance.ts            (import corrigé)
backend/scripts/lib/promotion.ts                  (type de retour d'analyserEtat)
backend/scripts/cloturer-chantier.ts              (corrigé par le type ci-dessus)
backend/scripts/importer-limites-admin.ts         (option de transaction morte retirée)
backend/scripts/promouvoir-franchissements.ts     (idem)
backend/scripts/rattacher-troncons-region.ts      (idem)
backend/src/api-v2/defauts.routes.ts              (alias /validate, gestionnaire partagé)
backend/src/api-v2/defauts.routes.test.ts         (+6 tests d'équivalence)
docs/rai-v3/13_RAPPORT_CONTINUITE_CLAUDE_CODE.md  (ce chapitre)
```

Les changements antérieurs présents dans l'arbre de travail n'ont pas été modifiés.
