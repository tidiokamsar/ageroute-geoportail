# Où nous en sommes, section par section du cahier

Mesuré le 13/10/2026 contre `Cahier_des_Charges_AGEROUTE_RAI_V3_1.docx`, et non de mémoire.
Chaque ligne est vérifiable dans le dépôt.

**Rien n'est déployé.** Les cinq migrations écrites depuis le 7 octobre sont en attente, et
la branche `ageroute-road-socle` porte 22 commits non fusionnés.

## Ce qui est fait

| § | Exigence | État |
|---|---|---|
| 7 | **Modèle de défauts** — catalogue administrable, mesures obligatoires par type, métré indépendant du PK, gravité et étendue distinctes | fait |
| 7.1 | Localisation primaire GPS → tronçon → abscisse locale, PK facultatif | fait |
| 7.5 | **Validation tierce** — le créateur ne valide pas sa propre donnée | fait, et étendu à toutes les entités |
| 8 | Observations terrain comme conteneur de collecte | fait |
| 10 | **Map matching** — PostGIS, confiance, refus sous seuil, jamais de tronçon inventé | fait et mesuré |
| 12 | Missions et leurs huit types | fait |
| 16 | **Quantity Engine** — surface, volume, longueur, comptage ; formules portées par le catalogue | fait |
| 26 | Sécurité et audit — séparation des rôles, audit transactionnel sur toutes les écritures | fait |
| 28 | Offline et synchronisation — file locale, idempotence, conflits sans écrasement | fait |
| 35 | **Gouvernance** — validateur désigné par domaine, délégation, historique conservé | fait |

Le §16 mérite une nuance : les formules de surface et de volume sont implémentées et les
mesures obligatoires viennent du catalogue, mais le coefficient multiplicateur
(`quantité = nombre × coefficient`) ne l'est pas encore.

## Ce qui est partiel

**§5 — Les onze profils.** Le mapping existe et est exposé par l'API, mais **cinq
correspondances ne sont pas arbitrées** et aucun compte n'a reçu de profil. Voir
`15_PROFILS_METIER.md`.

**§6 — Référentiel routier.** Le réseau est là ; les **PK régionaux ne le sont pas**, et ne
peuvent pas l'être : les 1 029 tronçons régionaux portent 1 029 noms distincts, sans
structure de route. Il manque le répertoire officiel, qui est une donnée d'AGEROUTE et non
un calcul. Voir `08_CALIBRATION_PK.md`.

**§9 — AGEROUTE ROAD Mobile.** Le cahier dit « Android-first ». Il existe une PWA
(`manifest.webmanifest`, service worker) avec saisie hors ligne et file de synchronisation.
**Ce n'est pas une application Android native**, et rien n'a été éprouvé sur un appareil
réel.

**§11 — Inventaire patrimonial.** Ouvrages, points noirs et postes existent. Les quinze
familles énumérées par le cahier (dalots, buses, radiers, murs, glissières, caniveaux…) ne
sont pas toutes distinguées.

**§22 — SharePoint.** L'API publique et la carte embarquée existent, et
`PUBLIC_CORS_ORIGINS` pointe par défaut sur le SharePoint d'AGEROUTE. **L'intégration de
bout en bout n'est pas démontrée.**

**§25 — API.** Les routes des défauts, observations, missions, appareils, synchronisation et
gouvernance existent, documentées par 25 annotations OpenAPI servies via Swagger UI. Mais
le document est en **3.0.0**, là où le §31 demande **3.1** — et les routes `/condition`,
`/risk`, `/treatments`, `/quantities`, `/costs` annoncées au §25 n'existent pas.

**§29 — Tests.** 64 fichiers et 811 tests au backend, 18 et 206 au frontend, `tsc` et
`typecheck:scripts` propres. Mais **aucun test E2E** du scénario du §29
(mission → défaut → validation → traitement → coût), pour une raison simple : la moitié de
la chaîne n'existe pas. Et aucun test de performance.

## Ce qui est absent

| § | Exigence | Mesure |
|---|---|---|
| 13 | **Condition Engine / RCI** | aucune occurrence dans le code |
| 14 | **Risk Engine** | aucune |
| 15 | **Treatment Engine** | aucune |
| 17 | **Cost Engine** | aucune |
| 18 | **Programmation et optimisation** | aucune (`MAX_NETWORK_IMPROVEMENT` introuvable) |
| 19 | **Control Tower** | aucune |
| 20 | **Fiche 360°** | aucune |
| 21 | **DigitalRoad** | aucune intégration |
| 23 | **IA** — détection sur photo, OCR, suggestions | aucune |

Ces neuf sections forment **la moitié aval de la chaîne de décision**. Le défaut, son
métré et sa validation sont en place ; ce qui en découle — état, risque, traitement, coût,
programme, pilotage — ne l'est pas.

## Le verrou qui explique l'ordre des choses

Le §13 demande un RCI « explicable et versionné », avec des composantes pondérées :
chaussée 30 %, drainage 15 %, ouvrages 15 %, signalisation 10 %, sécurité 10 %, trafic
10 %, historique 5 %, incidents 5 %.

Ces pondérations sont données comme **« base indicative à calibrer »**. Les coder telles
quelles produirait un score qui a l'air officiel et que personne n'a validé — exactement ce
que le §39 interdit. `12_ADR_CONDITION_ENGINE.md` reste donc une **proposition**, et
l'ADR n'est pas approuvé.

Et le Condition Engine a besoin de données que la base n'a pas : `trafic` est renseigné sur
**0 des 1 691 tronçons**, `criticiteStrategique` sur 0 également. Deux composantes sur huit
seraient donc calculées sur du vide.

C'est le même mur que les PK régionaux : **ce qui bloque n'est pas le code.**

## Les décisions qui vous attendent

1. **Les coefficients du RCI** — sans eux, pas de Condition Engine, donc pas de Risk ni de
   programmation. C'est le verrou principal.
2. **Les cinq correspondances de profils** non arbitrées.
3. **La validation des entités patrimoniales** — il n'existe aucun chemin pour rendre un
   tronçon officiel, et ce n'est peut-être pas un oubli : valider un relevé de terrain et
   valider un arrêté de classement ne se ressemblent pas.
4. **Le répertoire des routes régionales**, pour les PK.
5. **Les seuils de gravité** du catalogue de défauts, qui sont normatifs.
6. **Les plafonds de photos** (30 par objet, 20 Gio) — prudents, pas arbitrés.

## Ce qui doit être fait avant tout déploiement

- **Vérifier que `_prisma_migrations` ne contient pas déjà `20261007200000`.** Je l'ai
  amendée en supposant qu'elle n'était pas appliquée ; si elle l'est, l'amendement est
  invalide et il faut une migration séparée.
- **Mesurer le coût de l'import en masse.** Chaque ligne ouvre désormais une transaction
  interactive, soit de l'ordre de 1 700 pour un import complet.
- **Lire `audit.echecsDepuisDemarrage` sur `/api/health`.** S'il est non nul, les audits de
  décomptes et d'ordres de travaux échouaient probablement en silence sur un `BigInt`.
- Les cinq migrations en attente, dans l'ordre, avec sauvegarde vérifiée et réversibilité.

## Trois points de sécurité toujours ouverts

Hérités et non résolus : le mot de passe ADMIN transmis en clair dans une conversation n'a
pas été changé ; `test.gestionnaire@ageroute.gov.gn` détient `ADMIN` en production ; et la
clé de chiffrement des sauvegardes n'a **aucune copie hors serveur**, ce qui rend les
archives chiffrées illisibles en cas de perte de la machine.
