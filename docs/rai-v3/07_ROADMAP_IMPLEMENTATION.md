# Feuille de route

État du **code du dépôt au 12/10/2026**. Cela ne prouve ni l'application des
migrations ni la présence de ces fonctionnalités en production.

Phase 0. L'ordre proposé ici s'écarte de celui du master prompt sur un point, et la
raison est mesurée.

## État des phases du master prompt

| Phase | État |
|---|---|
| 0 Audit | **ce document** |
| 1 Road Registry | `Troncon` existe, 261 387 lignes. Dans la mesure du 07/10, **552/1 691 (32,6 %)** ont un intervalle PK exploitable ; aucune appartenance à une route régionale n'est référencée |
| 2 PostGIS, référencement linéaire | moteur écrit, mesuré, exposé |
| 3 Mobile | rien. Dépôt séparé |
| 4 Offline et sync | **PARTIEL** — protocole serveur et files IndexedDB pour observations/défauts ; cloisonnement et synchronisation du défaut implémentés dans le dépôt. Les données locales ne sont pas chiffrées au repos ; installation PWA, appareil réel et production non vérifiés |
| 5 Observations et défauts | **PARTIEL** — saisie terrain hors ligne, API `Defaut`, photos avec SHA-256, appariement sur demande et confirmation humaine, décisions tierces et file de revue. L'interface et l'API laissent encore `missionId` et `observationId` facultatifs, contrairement au tableau §7.1 du cahier ; écart à corriger avant acceptation |
| 6 Condition Engine | **CONCEPTION** — ADR proposé ; règles métier à valider, aucune migration ni moteur implémenté |
| 7 Risk Engine | rien |
| 8 Treatment Engine | rien |
| 9 Quantity Engine | rien |
| 10 Cost Engine | rien |
| 11 Program Engine | rien |
| 12 Control Tower | **PARTIEL** — tableau de bord v1 présent. Une Fiche 360 identifiable et ses critères d'acceptation ne sont pas repérés dans le dépôt |
| 13 DigitalRoad | **PARTIEL** — carte embarquée et API publique présentes dans le dépôt ; l'intégration SharePoint de bout en bout, les identifiants communs et le déploiement ne sont pas vérifiés |
| 14 IA | rien, et c'est voulu |

## Dépendance PK et ordre de réalisation

Le cahier des charges V3.1 (§7.1, §7.4, §16, §33 et §39) distingue le GPS, l'appariement
au tronçon et l'abscisse locale. Il permet un défaut sans PK et précise que le métré est
indépendant des PK. La calibration régionale limite donc les références officielles
dictées par route ; elle ne bloque ni la collecte GPS, ni le repérage local, ni les
quantités calculées à partir des mesures disponibles.

La mesure du 07/10 donne 552 PK exploitables sur 1 691 tronçons (32,6 %), dont 552 sur
621 tronçons nationaux ; les 1 029 tronçons régionaux n'ont pas d'appartenance à une
route dans la base. Voir `08_CALIBRATION_PK.md`.

Trois options ont été examinées :

1. **Bloquer les phases 5 à 10 jusqu'à la calibration complète.** Cela réduit les
   références manquantes, mais contredit l'acceptation d'un défaut sans PK et empêche le
   métré indépendant prévu par le cahier.
2. **Dériver les PK régionaux de chaque géométrie.** Cela produit une valeur technique,
   mais les segments isolés commenceraient tous au PK 0 et ne constitueraient pas une
   référence officielle par route ; cette option est écartée.
3. **Avancer avec GPS/tronçon/abscisse locale et demander le répertoire régional en
   parallèle.** Les PK restent nuls quand ils sont inconnus, et le catalogue officiel
   complète ensuite les références dictées par route. C'est l'option recommandée, en
   cohérence avec le cahier et `08_CALIBRATION_PK.md`.

## Ordre proposé

**1. Défauts et décisions — tranche locale partielle, à vérifier sur base.**
`/observations/{id}/validate` et `/defauts/{id}/decision` appliquent la séparation
des rôles, enregistrent l'historique commun et utilisent un contrôle de version.
L'interface dispose d'une file de revue. Les statuts historiques d'observation restent
compatibles avec la V1 ; leur décision canonique est conservée dans `Validation`.
Le modèle `Defaut` et le formulaire local couvrent GPS/tronçon, mesures, gravité,
catalogue versionné, photos avec SHA-256 et appariement proposé avec confirmation
humaine. La saisie PWA complète et les appareils réels restent non vérifiés.
Le cahier demande toutefois `missionId` et `observationId` sur un défaut, tandis que
l'interface et l'API locales les acceptent comme absents. Ce point reste ouvert ; la
couverture locale ne vaut pas acceptation. Cela ne confirme ni le rejeu de migration ni
le déploiement.

Le quota cumulé et la conservation des photos ne sont pas définis. Les brouillons
IndexedDB ne sont pas chiffrés au repos.

**2. Répertoire routier régional — dépendance de données à traiter en parallèle.**
Il manque le répertoire qui associe les segments `RES-nnnn` aux routes et à leur ordre.
Il est nécessaire pour publier des PK régionaux officiels ; il n'est pas requis pour
les défauts localisés par GPS et abscisse locale ni pour leur métré. Voir
`08_CALIBRATION_PK.md`.

**3. Condition Engine — prochaine décision métier.** L'ADR proposé recommande un
modèle additif de règles versionnées et d'évaluations historisées. Le code et la
migration restent à faire. Avant de créer la migration, AGEROUTE doit confirmer les
coefficients, la normalisation du score, les règles de fraîcheur/confiance et le
traitement des composantes manquantes. Voir `12_ADR_CONDITION_ENGINE.md`. Aucun score
officiel ne doit être calculé à partir d'observations ou de défauts non validés.

**4 à 7. Risk, Treatment, Quantity et Cost Engines.** Aucun Risk/Treatment/Cost Engine
n'est implémenté. Compléter le métré au-delà des défauts, puis versionner les formules
et prix ; les PK ne sont requis que pour les règles qui utilisent une référence de route.

**8. Programmation.** « J'ai 100 milliards GNF, que traiter ? » n'a de sens qu'une fois
les coûts calculables.

**9. Control Tower.** Étendre le tableau de bord v1 et préciser la Fiche 360, ses
utilisateurs, données, permissions et critères d'acceptation ; aucune Fiche 360
identifiable n'est repérée dans le dépôt.

**10. DigitalRoad et SharePoint.** Valider l'embarquement de la carte, l'API publique
et les identifiants communs dans un parcours de bout en bout avec l'intranet.

**11. Mobile.** Le dépôt courant fournit des routes et files de synchronisation ;
l'application mobile dédiée et les tests sur appareils réels ne sont pas démontrés.

**12. IA.** À traiter après validation des sources, règles métier, permissions et
traçabilité des moteurs.

## Trois dettes à solder en parallèle

Elles ne dépendent d'aucune phase et leur coût augmente avec le temps.

**La clé de sauvegarde hors serveur.** Risque le plus grave du système, solde en
copiant 65 octets vers deux emplacements désignés.

**La chaîne de migrations qui ne reconstruit pas une base vierge.** Tant qu'elle échoue
à `20260702140000_decomptes`, aucun environnement de recette propre n'est possible, et
toute migration future se teste contre une copie de production.

**Le déploiement par Git.** Trois builds cassés en une journée, tous dus au déploiement
fichier par fichier sur un serveur qui n'est pas un dépôt.

## Ce que je ne recommande pas

**Exécuter `INTEGRATION.md` du pack V3.** Ce fichier n'est pas présent dans le checkout
courant ; le constat ci-dessous est conservé de l'audit historique et reste à vérifier
si le pack est restauré. Son étape 2 créerait 27 tables préfixées `rai_`,
dont onze redoublent des entités en service — `rai_roads` à côté de 261 387 tronçons,
`rai_audit_events` à côté de 1 484 lignes d'audit. Le master prompt l'interdit
lui-même. Voir `02_MATRICE_SCHEMA.md`.

**Ouvrir `/roads`, `/segments` et `/assets` en v2** avant d'avoir tranché le sort de
`Road` et `RoadAsset`. Ce serait deux API pour la même donnée.
