# Journal des décisions techniques (ADR)

> Fichier canonique exigé par le § A.9 du prompt maître V10. Il remplace
> `docs/pilotage/DECISIONS.md`, dont il conserve l'historique Git.


> Exigé par le § 4 du mandat v2.1. Format court : contexte, options, décision, conséquences.
> Une entrée par décision structurante, jamais réécrite — une décision révisée fait une
> nouvelle entrée qui cite l'ancienne.

---

## ADR-001 — Gel des opérations de production

**Date** : 14/10/2026. **Statut** : actée.

**Contexte.** Le mandat v2.1, reçu à 14:20, pose en garde-fou non négociable (§ 2.1) :
« Aucune opération sur la production : pas de migration, pas d'écriture, pas de déploiement. »

Or un déploiement était en cours à ce moment et s'est achevé à 14:23 : 50 migrations
appliquées, barèmes paramétrés, règle RCI approuvée. Le commanditaire a précisé « nouveau
mandat après déploiement », ce qui situe l'entrée en vigueur **après** cette livraison.

**Décision.** Le déploiement du 14/10/2026 à 14:23 est le dernier. Tout travail ultérieur se
fait en local. Les migrations écrites ne seront plus appliquées à la production par mes soins.

**Conséquences.**
- La production porte 50 migrations ; une migration locale non appliquée créera un écart
  croissant, à déployer par une personne autorisée.
- `docs/rai-v3/PLAN_MIGRATIONS_PRODUCTION.md` reste la procédure de référence.
- Les mesures en base citées dans les documents datent du 13 et 14/10 et vieilliront.
- Les tests ne pourront plus se valider contre la base vivante : les jeux de données de test
  exigés par le § 12 deviennent nécessaires, pas optionnels.

---

## ADR-002 — Technologie mobile : React Native, la PWA ne suffit plus

**Date** : 14/10/2026. **Statut** : **actée**. Version complète et motivée :
[../architecture/ADR-002-TECHNOLOGIE-MOBILE.md](../architecture/ADR-002-TECHNOLOGIE-MOBILE.md).

**Contexte.** Une décision antérieure (`docs/rai-v3/21_TABLEAU_CONFORMITE.md`) retenait
**PWA renforcée + enveloppe Capacitor**, au motif qu'elle réutilise React/Vite/Leaflet, se
teste localement et s'installe depuis le navigateur. Cette PWA existe, avec service worker et
file de synchronisation idempotente, et répond en production.

Le mandat v2.1 ajoute le § 7.13 « collecte en roulage », qui exige :
- trace GNSS à **1 Hz en arrière-plan** pendant des heures ;
- **service de premier plan Android** avec notification persistante, « pour ne pas être arrêté
  par le système » ;
- **accéléromètre et gyroscope** pour l'IRI estimé, téléphone fixé rigidement ;
- **capture photo continue** tous les 20–50 m, avec dégradation selon température et stockage ;
- reprise après redémarrage de l'appareil.

Et le § 7.8 : « Une PWA n'est acceptable que si l'audit démontre qu'elle couvre : GPS en
continu fiable, stockage volumineux de photos, fonctionnement hors ligne prolongé (plusieurs
jours) et caméra — sinon, application native. »

**Analyse.** Une PWA sur Android ne peut pas tenir un service de premier plan, ni une trace à
1 Hz quand l'écran s'éteint, ni une reprise après redémarrage. Le § 7.13 n'est donc **pas
réalisable en PWA**, et le § 7.8 tranche en conséquence.

**Options.**
1. **React Native (Expo, workflow natif)** — recommandé par le § 7.8. Partage TypeScript et
   règles métier avec le web, SQLite + index spatial local, MapLibre Native.
2. **Capacitor autour de la PWA existante** — réutilise le plus de code, mais les capacités de
   roulage passent par des plugins natifs : le gain de réutilisation s'érode précisément là où
   l'exigence est la plus forte.
3. **Android natif (Kotlin)** — meilleure maîtrise des capteurs, aucune réutilisation.

**Décision.** Option 1 : **React Native, Expo en *development build***, pas Expo Go — les
greffons natifs requis n'y tournent pas. Carte par `@maplibre/maplibre-react-native` (paquet
officiel, 11.4.1), localisation par `expo-location` avec l'option `foregroundService`.

La PWA **n'est pas abandonnée** : elle garde le mode bureau d'enrichissement du § 7.13, le
portail citoyen et le secours de saisie. Son noyau de règles — appariement, portions, métré,
idempotence, condition : cinq modules, plus de 170 tests, sans Prisma ni Express — est partagé
tel quel.

**Contrainte découverte en vérifiant** : un service de premier plan Android ne peut pas
démarrer si l'application est déjà en arrière-plan. L'opérateur lance donc la collecte
application ouverte, avant de rouler. Conforme au garde-fou § 2.9, mais cela interdit un
démarrage automatique au mouvement.

**Blocage connu** : aucun APK ne peut être produit ici — ni `adb`, ni `gradle`, ni `java`.
Voir [BLOCAGES.md](BLOCAGES.md).

---

## ADR-003 — Gel des objets contractuels présents dans le dépôt

**Date** : 14/10/2026. **Statut** : actée.

**Contexte.** Le § 1.2 exclut marchés, contrats, chantiers, ordres de travaux, décomptes et
paiements : « aucun nouveau module, écran, table ou API pour ces objets ; le module chantiers
existant est gelé ».

Le dépôt les contient et la production les porte : `chantiers` (**496 lignes**), `marches`,
`ordres_travaux`, `decomptes`, `marches_chantiers`, `avancement_marche`, `ot_historique`,
`ot_photos`, plus les routes `/api/marches`, `/api/ordres-travaux` et les pages `/marches`,
`/ordres-travaux`.

**Décision.** Ces modules restent en fonctionnement, ne sont pas étendus, et aucune de mes
tâches ne les prendra pour cible. Leur migration éventuelle vers DigitalRoad est une décision
institutionnelle, consignée dans [BLOCAGES.md](BLOCAGES.md).

**Conséquences.** Deux plans antérieurs doivent être amendés : `docs/rai-v3/23_PLAN_ACHEVEMENT.md`
prévoyait un moteur de coûts alimentant des estimations, ce qui **reste dans le périmètre**
(le § 1.2 arrête le Géoportail à la programmation), mais toute idée de décompte ou
d'engagement en sort. Le § 7.7 🔒 le redit : aucune estimation ne crée de décompte.

---

## ADR-004 — Pondérations du RCI : le cahier § 13 contre la liste à neuf composantes

**Date** : 14/10/2026. **Statut** : actée, règle approuvée.

**Contexte.** Deux jeux de pondérations circulaient. Le cahier RAI V3.1 § 13 en liste huit
(chaussée 30, drainage 15, ouvrages 15, **signalisation 10**, sécurité 10, trafic 10,
historique 5, incidents 5). Le commanditaire a transmis une liste à neuf remplaçant la
signalisation par **environnement 5 + autres critères 5**. Les deux totalisent 100 et sept
postes sur neuf concordent.

**Décision.** Le § 13. Motifs : la signalisation est **inventoriable** et constitue depuis le
13/10 une famille d'actif à part entière, alors qu'« autres critères » n'est définissable par
rien — ses cinq points seraient du poids mort renormalisé à chaque calcul.

`ENVIRONNEMENT` et `AUTRES` restent dans l'énumération, **non pondérées** : elles servent à
exprimer la proposition, donc à la comparer, pas à l'appliquer.

**Conséquences.** `rci-2026.1` approuvée le 14/10/2026, motif d'approbation enregistré en base
avec cet arbitrage. Une version 2 adoptant la liste à neuf exigerait d'abord une définition
d'« autres critères ». `TRAFIC`, pondéré à 10 %, sera exclu de chaque score faute de donnée :
le moteur renormalise, une composante absente ne valant pas zéro.

---

## ADR-005 — SQL paramétré : correction d'une violation du § 7.1

**Date** : 14/10/2026. **Statut** : actée, corrigée.

**Contexte.** Le § 7.1 🔒 exige : « requêtes spatiales en SQL paramétré (`$queryRaw` avec
gabarits, **jamais** de concaténation de chaînes) ».

`reseau/couverture.reseau.ts`, écrit le 14/10 avant réception du mandat, construisait
`AND t."regionId" = ${regionId}` dans le **texte** de la requête et l'exécutait par
`$queryRawUnsafe`. La route valide `regionId` par un schéma Zod, mais la fonction est
appelable d'ailleurs : la validation vivait au mauvais endroit.

**Décision.** Passage à `$queryRaw` avec `Prisma.sql`. La valeur `regionId` devient un
paramètre lié, donc la garantie ne dépend plus de l'appelant.

Le **périmètre** est une structure et non une valeur : il vient d'un ensemble fermé de trois
fragments, désormais définis une seule fois dans `lib/reseau.ts` sous la forme
`fragmentPerimetre()`, qui rend du `Prisma.Sql`.

**Conséquences.** `lib/reseau.ts::longueurReseau` conserve un `$queryRawUnsafe` **antérieur**,
qui n'interpole aucune valeur d'appelant — seulement trois littéraux d'un ensemble fermé. Il
n'est donc pas injectable, mais il reste une concaténation : sa migration vers le fragment est
inscrite au lot 1, avec les tests de non-régression de l'API publique qui en dépend.

---

## ADR-006 — Les documents existants ne sont pas déplacés

**Date** : 14/10/2026. **Statut** : actée.

**Contexte.** Le § 12 attend une arborescence `docs/audit/`, `docs/specs/`, `docs/metier/`,
`docs/pilotage/`. Vingt-huit documents existent dans `docs/rai-v3/`, cités par des commits et
par du code.

**Décision.** `docs/pilotage/` est créé et tenu à jour comme exigé. Les documents existants
restent où ils sont et sont **cités** depuis la nouvelle arborescence. Les nouveaux documents
suivent le § 12.

**Motif.** Déplacer vingt-huit fichiers casserait les liens de commits et les références
croisées pour un gain de rangement, alors que le § 4 demande surtout de ne pas refaire ce qui
est consigné. Un `docs/pilotage/CONFORMITE.md` qui pointe vers la matrice existante répond à
l'exigence sans détruire la traçabilité.


---

## ADR-007 — `observeeLe` n'est pas renommé en `valideDu` : ce sont deux choses

**Date** : 14/10/2026. **Statut** : actée.

**Contexte.** Le § 7.2 exige `valide_du` / `valide_au`. `portions` portait déjà `observeeLe`,
documenté « quand elle a été CONSTATÉE (pas saisie) ». La tentation était de renommer, d'autant
que la table est vide et qu'un renommage ne coûte donc rien.

**Décision.** Ne pas renommer. **Ajouter** `valideDu` et `valideAu`.

**Motif.** Un agent peut constater le 2 avril qu'une piste est en latérite **depuis l'an
dernier**. `observeeLe` dit quand on a regardé, `valideDu` depuis quand c'est vrai. Les fondre
perdrait la provenance de l'information, et l'on ne pourrait plus distinguer une donnée fraîche
d'une donnée rétrospective.

Trois dates, trois sens : `observeeLe` (on a regardé), `valideDu` (c'est vrai), `createdAt`
(le système l'a enregistré). Les confondre rend l'histoire du réseau inexplicable.

---

## ADR-008 — Les scripts de descente vivent hors du dossier de migration

**Date** : 14/10/2026. **Statut** : actée.

**Contexte.** Le § 9.4 exige des migrations « testées en montée **et** en descente ». Prisma
Migrate ne gère pas de migrations descendantes : il faut les écrire à la main. La place
naturelle est à côté de la montée, dans le dossier de la migration.

**Décision.** `backend/prisma/descentes/<nom-de-la-migration>.sql`, hors de
`prisma/migrations/`.

**Motif.** Prisma lit `migration.sql` dans chaque dossier, et un second `.sql` y est très
probablement ignoré — le nom est codé en dur dans l'outil. Mais je n'ai pas pu l'établir avec
certitude, et **le risque est asymétrique** : si un `descente.sql` était exécuté pendant un
`migrate deploy`, il supprimerait en production les colonnes que la migration vient d'ajouter.

Devant une incertitude dont le coût est une perte de données, le dossier séparé est la réponse.
On perd un peu de localité, on gagne l'impossibilité de cet accident.

**Conséquence.** Le contrôle de CI « chaque dossier de migration porte un `migration.sql` »
reste sans ambiguïté, et les dossiers de migration ne contiennent qu'un seul fichier.

---

## ADR-009 — V10 fige Capacitor : ADR-002 est remplacée

**Date** : 14/10/2026, 16:01. **Statut** : actée. **Remplace** [ADR-002](docs/architecture/ADR-002-TECHNOLOGIE-MOBILE.md),
prise deux heures plus tôt.

**Contexte.** Le § 15 du prompt maître V10 fige la pile mobile : **Capacitor**, coque de
l'application React existante, avec des **plugins natifs Kotlin** pour le roulage — service de
premier plan, IMU à 100 Hz, GNSS en arrière-plan, capture cadencée — plus
`@capacitor-community/sqlite`, carte hors ligne par service worker puis PMTiles, Maestro ou
Appium pour l'E2E, et une CI de build Android.

Et il écarte nommément : « Réécriture React Native ou Flutter de **toute** l'application (seul
le module roulage peut migrer, sur preuve du pilote) » et « PWA pure pour le roulage ».

**Décision.** Capacitor, conformément au § 15. ADR-002 est remplacée.

### Ce que mon analyse d'ADR-002 avait juste, et ce qu'elle avait faux

**Juste** : la démonstration qu'une **PWA pure** ne peut pas tenir le § 7.13. Quatre exigences
y échappent — service de premier plan Android, trace GNSS à 1 Hz en arrière-plan, accéléromètre
pour l'IRI, reprise après redémarrage. V10 l'écarte aussi, et pour les mêmes raisons.

**Faux** : avoir écarté Capacitor en écrivant que « les capacités de roulage passeraient par
des greffons natifs, c'est-à-dire précisément là où la réutilisation est nulle ». J'en ai
conclu « le pire des deux », et c'était une conclusion hâtive.

V10 répond, et la réponse est meilleure que mon raisonnement : **on écrit les plugins Kotlin, et
on garde une seule base de code applicative.** Les greffons natifs sont du code à écrire dans
les deux options — React Native en a besoin aussi pour l'IMU à 100 Hz et le service de premier
plan. La différence est qu'en Capacitor, tout le reste de l'application — carte, formulaires,
listes, file de synchronisation — n'est pas réécrit.

J'ai comparé « réutilisation du code métier » quand la vraie question était « réutilisation de
l'application entière ». Le § 15 le dit en une ligne : « Réutilise l'existant et les compétences
web ; capteurs couverts par plugins ».

**Et un argument que je n'avais pas pesé** : les compétences de la DSI d'AGEROUTE. Une
application React maintenue par une équipe web reste maintenable ; une base React Native
suppose une compétence mobile à recruter ou à former.

### Ce qui survit d'ADR-002

Le travail du lot 3 n'est pas perdu, il devient même plus pertinent. Le § 15 fige le
map-matching comme « **bibliothèque TypeScript maison partagée** : ponctuel + trace HMM, index
spatial flatbush/rbush sur le pack de mission, **mêmes tests serveur et mobile** ».

C'est exactement `geo/appariement.noyau.ts`, écrit sans aucun import précisément pour être
portable — et en Capacitor, « portable » devient trivial : c'est le même JavaScript qui tourne
dans la coque. L'extraction du noyau était le bon geste, quelle que soit la coque.

### Conséquences

- La porte reste ouverte : « seul le module roulage peut migrer [vers React Native], **sur
  preuve du pilote** ». Une migration partielle devra donc être justifiée par une mesure, pas
  par une préférence.
- Les plugins Kotlin à écrire sont nommés par le § 15 : service de premier plan, IMU 100 Hz,
  GNSS arrière-plan, capture cadencée.
- Le blocage reste le même : **aucun APK compilable ici** — ni `adb`, ni `gradle`, ni `java`.
  Le § A.4 demande de « vérifier l'environnement actuel » : vérifié le 14/10, toujours absent.
  Voir `BLOCKERS.md`.
- `docs/architecture/ADR-002-TECHNOLOGIE-MOBILE.md` est conservée comme trace du raisonnement,
  avec un renvoi vers cette décision. Le § A.5.8 proscrit les suppressions silencieuses, et une
  décision renversée se lit mieux à côté de celle qui la renverse.

**Coût de sortie.** Faible aujourd'hui : aucune ligne de code mobile n'a été écrite sous
ADR-002. C'est précisément pour cela que j'avais ouvert l'ADR avant de commencer le code plutôt
qu'après.