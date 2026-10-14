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

---

# Les quinze arbitrages « juste milieu » — ADR-010 à ADR-024

**Date** : 14/10/2026. Exigés par la partie D du prompt maître V10 : « chacune devient un ADR
dans `TECHNICAL_DECISIONS.md` au lot 0, et peut être contestée **par ADR argumenté**, pas par
omission. »

Ces quinze décisions ne sont pas les miennes : V10 les a prises en fusionnant trois sources
divergentes (V9, spécification v2.6, analyses externes PRISM / Citylogix / Perplexity). Chaque
ADR enregistre donc l'arbitrage, **ce qu'il change pour ce dépôt**, et, quand il contredit une
décision que j'avais prise, le dit.

**Je n'en conteste aucune.** Trois méritent une réserve technique, signalée en fin d'entrée :
ADR-012 (le benchmark est une porte, pas une formalité), ADR-013 (l'IdP n'est pas identifié) et
ADR-015 (D6 referme un écart que j'avais ouvert).

---

## ADR-010 — D1 · La frontière DigitalRoad tient, et trois objets entrent

**Arbitrage V10.** V9 et les analyses externes voulaient relier défaut → bon de travail →
marché → décompte dans la plateforme ; le commanditaire avait exclu ces objets. V10 **maintient
la frontière** (§ A.3) : la boucle complète existe **par intégration, jamais par duplication**.

**Ce que ça change ici.** [ADR-003](#adr-003--gel-des-objets-contractuels-présents-dans-le-dépôt)
est confirmée : `chantiers` (496 lignes), `marches`, `ordres_travaux`, `decomptes` restent gelés.

Mais D1 **fait entrer trois objets** que je n'avais pas au périmètre, et c'est l'apport réel de
cet arbitrage :

| Objet | Nature | État |
|---|---|---|
| **TI-01** tâches internes non contractuelles | régie, cantonnage, vérifications, inspections périodiques, nettoyage d'ouvrages, avec **preuves avant/après** | aucune table `internal_tasks` — vérifié dans `schema.prisma` |
| **TI-02** rapprochement physique / financier | **en lecture seule**, sous forme d'**alertes d'audit** | absent |
| **X-18** service de vérification patrimoniale | fournit à DigitalRoad les constats terrain | absent |

La distinction est fine et elle porte tout : une tâche interne de régie **n'est pas** un marché.
L'exclure au motif qu'elle ressemble à des travaux priverait AGEROUTE de la trace de ce qu'elle
exécute elle-même. Le rapprochement, lui, reste en lecture : il **alerte**, il ne corrige pas.

**Conséquence.** Le critère **A29** est à ABSENTE dans [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md),
et il ne dépend d'aucune décision en attente : TI-01 est réalisable immédiatement.

---

## ADR-011 — D2 · Capacitor

**Arbitrage V10.** Capacitor comme coque, plugins natifs pour le roulage ; migration du seul
module roulage vers natif ou React Native **uniquement si le pilote corridor prouve l'échec**
(A18–A19).

**Ce que ça change ici.** Rien de nouveau : c'est exactement
[ADR-009](#adr-009--v10-fige-capacitor--adr-002-est-remplacée), déjà écrite, qui remplace
ADR-002 et dit où mon raisonnement était faux. Cette entrée existe pour que la partie D soit
couverte sans trou, pas pour redire la décision.

---

## ADR-012 — D3 · Leaflet reste, mais sous condition mesurée

**Arbitrage V10.** « **Benchmark sur les 261 000 tronçons** = porte de décision » ; MapLibre
pour les nouveaux écrans si Leaflet ne tient pas les cibles du § 7.14 ; migration progressive.

**Ce que ça change ici.** Leaflet est en place et répond en production. Le benchmark, lui,
**n'a jamais été fait** : le critère A20 (rendu < 3 s en 3G, recherche < 300 ms, déviation
< 2 s) est à NON TESTÉE.

Ce que je sais, et qui ne suffit pas : `/api/public/carte/geo` sert **785 Ko en 0,36 s**, et
`frontend/public/osm-routes.geojson` pèse **environ 2 Mo** en fond statique. C'est une mesure de
transport, pas de rendu, et elle a été prise depuis le serveur, pas depuis un téléphone en 3G à
Boké.

**Réserve.** D3 appelle cette porte « porte de décision ». Il faut la prendre au mot : tant que
le benchmark n'existe pas, « Leaflet suffit » est une hypothèse, et aucun écran nouveau ne
devrait être conçu en supposant la réponse. Le benchmark est peu coûteux et débloque un choix
structurant — il est le premier geste du lot 10, avant toute ligne d'écran.

---

## ADR-013 — D4 · Les comptes ERP sont la référence, et l'IdP n'est pas identifié

**Arbitrage V10.** Comptes ERP = référence ; fédération OIDC vers l'IdP effectif
« (à vérifier) » ; **aucun second annuaire**.

**Ce que ça change ici.** J'ai vérifié : **aucune fédération n'existe**. Aucune occurrence
d'`oidc`, `openid`, `saml` ni `passport` dans `backend/src` — les correspondances apparentes
étaient le mot français « entrant ». L'authentification est entièrement locale : JWT d'accès
15 min, jeton de rafraîchissement rotatif révocable 7 j, mots de passe Argon2id, et
**799 jetons de rafraîchissement** actifs en base.

Or « aucun second annuaire » est précisément ce que la table `utilisateurs` est aujourd'hui : un
annuaire propre. Ce n'est pas une faute — c'était la seule option sans accès à un IdP — mais la
cible est explicitement une fédération.

**Réserve, et elle est bloquante.** V10 écrit « l'IdP effectif (**à vérifier**) ». L'arbitrage
ne nomme donc pas l'IdP : D4 écarte Entra ID comme postulat sans dire ce qui le remplace. Je ne
peux pas vérifier cela depuis le dépôt, et **aucun accès à un système tiers n'est autorisé sans
interface approuvée** (garde-fou V10). L'ERP de référence reste à nommer par AGEROUTE.

**Conséquence.** Nouvelle ligne dans [DECISIONS_PENDING.md](DECISIONS_PENDING.md) : quel est
l'IdP effectif, et l'ERP qui porte les comptes de référence. Tant qu'elle n'est pas tranchée,
l'annuaire local reste, et la migration vers la fédération doit être conçue **sans suppression**
de comptes — un parcours de rattachement, pas une bascule.

---

## ADR-014 — D5 · Control Tower pour l'opérationnel, Power BI pour la direction

**Arbitrage V10.** « **Les deux, sans doublon** » : Control Tower intégré pour l'opérationnel ;
Power BI sur **vues analytiques ou réplica** pour la direction.

**Ce que ça change ici.** Rien n'existe des deux côtés : aucune `CREATE VIEW`, aucune
`CREATE MATERIALIZED VIEW` dans les 51 migrations — vérifié. Le tableau de bord actuel interroge
les tables directement.

Le mot qui porte la décision est « **sans doublon** » : il interdit d'écrire deux fois la même
règle de calcul, une fois dans le Control Tower et une fois dans un rapport Power BI. La
conséquence technique est claire — les indicateurs doivent vivre dans des **vues SQL nommées et
versionnées**, consommées par les deux, et non dans du code d'application.

C'est aussi la réponse au critère **A12** (« chaque indicateur égal à sa requête de contrôle ») :
si l'indicateur *est* une vue, l'égalité est structurelle au lieu d'être à vérifier.

**Conséquence.** Le « réplica » est une décision d'infrastructure et une dépense potentielle,
donc hors de mes mains. Les vues analytiques ne le sont pas, et sont le prérequis des deux.

---

## ADR-015 — D6 · Les portions homogènes sont la vérité ; les sections fixes, une vue dérivée

**Arbitrage V10.** TDR ONR : sections fixes 100/200 m. V9 : mailles paramétrables, portions
métier conservées. V10 tranche : « **Portions homogènes = vérité** ; sections fixes = **vue
dérivée paramétrable** (IO-03/IO-04) ; **jamais de saisie au niveau section** ».

**Ce que ça change ici.** C'est l'arbitrage le plus important des quinze pour le code déjà
écrit, et il **referme un écart que j'avais ouvert**.

[RCI_METHOD_DECISION.md](RCI_METHOD_DECISION.md) relevait quatre écarts entre le RCI du mandat
et les méthodes citées. Le quatrième, **É-4**, était exactement celui-ci : la directive UEMOA
11/2009 note par sections fixes, le modèle du dépôt par portions homogènes, et je concluais que
les deux ne mesurent pas le même objet. **D6 répond** : les deux existent, mais pas au même
rang. La portion est l'enregistrement ; la section est une projection.

L'ordre est décisif. Agréger des portions homogènes en sections de 100 m est une opération
**bien définie et répétable**. L'inverse — reconstituer des portions depuis des sections — perd
de l'information sans retour. Mettre la vérité du mauvais côté aurait été irréversible.

Et « jamais de saisie au niveau section » est un garde-fou, pas une préférence d'ergonomie :
saisir au niveau section fabriquerait des portions fictives aux frontières de la maille.

**Conséquence.** La base est déjà du bon côté : `portions` porte la contrainte d'exclusion
`btree_gist`, le lignage et la bitemporalité. Reste à écrire la vue dérivée (IO-03/IO-04), qui
est **le format d'échange avec la BDR nationale** (§ 7.15) — donc le prérequis du critère A23.

Il n'y a aucune table de sections fixes à créer : une vue paramétrable par le pas suffit, et
c'est précisément ce que « vue dérivée » veut dire.

---

## ADR-016 — D7 · Les référentiels proposés deviennent des fiches de décision

**Arbitrage V10.** v2.6 proposait des référentiels (P1–P4, indices) ; V9 interdit d'inventer la
norme. V10 : « Les propositions de v2.6 deviennent des **fiches de décision** (§ A.6) ; moteurs
paramétrables, résultats « provisoires » jusqu'à approbation. »

**Ce que ça change ici.** Cet arbitrage valide la ligne suivie et **corrige un manque que
j'avais signalé à tort comme un vide**.

J'ai écrit dans [DECISIONS_PENDING.md](DECISIONS_PENDING.md) que les valeurs de praticabilité
étaient attendues d'AGEROUTE sans qu'aucune proposition n'existe. C'était inexact : le § 7.17 du
mandat **propose lui-même les niveaux P1 à P4**. Il ne les impose pas — D7 les range
explicitement en fiche de décision — mais une proposition existe, et la fiche D-02 doit la
porter au lieu de constater un vide.

L'état du dépôt est conforme à D7 sur les trois référentiels :

| Référentiel | État | Conforme à D7 |
|---|---|---|
| `regles_condition` (RCI) | 1 version, **désapprouvée le 14/10 à 16:19** | oui — paramétrable, non appliquée |
| `baremes_intervention` | 9 lignes, statut `standard_initial`, **aucune approuvée** | oui |
| `referentiel_praticabilites` | **0 ligne** | oui, mais la proposition P1–P4 doit y figurer en provisoire |

**Conséquence.** Le critère **A27** est le seul des trente que je tienne pour TERMINÉ ET TESTÉ
sur ce terrain, et D7 explique pourquoi c'est la bonne lecture : un moteur paramétrable dont le
jeu de paramètres est désapprouvé n'est pas un échec de développement, c'est le comportement
attendu.

---

## ADR-017 — D8 · L'IRI est un module interne, et son résultat porte le mot « expérimentale »

**Arbitrage V10.** Analyses externes : déployer RoadLab Pro. V9 : pilote expérimental. V10 :
**module interne** (propriété des données, hors ligne, intégration), RoadLab Pro / Miranda Track
étudiés **comme référence** ; résultat = « **estimation expérimentale de rugosité** » jusqu'à
calibration (Uni Box ou profilomètre) et approbation.

**Ce que ça change ici.** Rien n'existe : aucun IRI, aucune mesure de déflexion, et
`troncons.dateDerniereEvaluation` est **nulle sur les 261 387 lignes**.

Les trois motifs du choix interne sont vérifiables et tiennent : la propriété des données, le
fonctionnement hors ligne — indispensable en Guinée et déjà la contrainte du § 7.13 — et
l'intégration au référentiel linéaire, qu'un outil tiers ne connaît pas.

Le point qui engage le code est le **nom du résultat**. « Estimation expérimentale de rugosité »
n'est pas une précaution de langage : c'est une contrainte d'affichage, d'export et de schéma.
Un champ nommé `iri` finirait lu comme un IRI normalisé. Il devra porter son caractère estimé
dans son nom, sa méthode et son incertitude, comme `valeurs_qualite` le fait déjà.

---

## ADR-018 — D9 · Le corpus guinéen d'abord, le modèle en observation

**Arbitrage V10.** Analyses externes : lancer l'IA sur les images collectées. V9 : corpus
d'abord. V10 : « **Corpus d'abord** (le workflow de validation produit les étiquettes), modèle
en mode observation sur le pilote, usage opérationnel seulement sur métriques mesurées ; jamais
de détection auto-validée. »

**Ce que ça change ici.** La phrase décisive est entre parenthèses : « le workflow de validation
produit les étiquettes ». Le workflow de validation **existe** — `governance/validation.ts`,
75 tests, `statutValidation` par défaut `A_VALIDER`. Il fabrique donc déjà le corpus, sans
qu'aucun travail d'IA ait commencé.

Ce qui manque n'est pas le modèle, c'est la matière : **`observations`, `defauts` et `missions`
sont à zéro ligne**. Aucun corpus ne peut exister avant que la collecte ne tourne, et c'est la
raison pour laquelle D15 place l'IA en dernier.

Le garde-fou « jamais de détection auto-validée » est déjà tenu en base par la contrainte
`media_analyse_coherente`, qui impose date et version de modèle, et par le fait qu'aucun chemin
d'écriture ne valide une détection.

---

## ADR-019 — D10 · Le jumeau numérique est un référentiel vivant, pas une maquette 3D

**Arbitrage V10.** Citylogix / Perplexity : jumeau LiDAR + BIM + IoT. V9 : jumeau opérationnel
d'abord. V10 : « **Jumeau = référentiel vivant** (actifs, état, preuves, historique, décisions
liés dans le temps) » ; LiDAR niveau C après pilote comparatif A/B/C ; IoT ciblé (R-07).

**Ce que ça change ici.** La définition retenue est une définition **de données**, pas de rendu,
et à ce titre le dépôt en détient déjà quatre des cinq termes : actifs (4 familles linéaires),
état (`valeurs_qualite`, 1 820 694 lignes), preuves (médias avec contrainte de cohérence),
historique (`reseau/bitemporel.ts`, 32 tests).

Le cinquième — « **décisions liés dans le temps** » — est le seul qui manque, et c'est le plus
intéressant : il demande que la décision soit un objet du référentiel, daté et rattaché, et pas
une sortie de rapport. L'approbation et la désapprobation de `rci-2026.1` en sont le premier
exemple réel : trois lignes d'audit, un motif, un auteur, un horodatage.

« LiDAR après pilote comparatif » et « IoT ciblé » sont des dépenses à autoriser, donc hors de
mes mains, et c'est exactement ce que D11 et la partie E encadrent.

---

## ADR-020 — D11 · Observation satellitaire : palier 0 en phase 2, le reste sur autorisation

**Arbitrage V10.** Sujet « absent des sources ; demandé par le commanditaire « même s'il faut
des services payants » ». V10 : partie E, **palier 0 gratuit dès la phase 2** ; paliers payants
= dépenses à autoriser, déclenchées par un cas d'usage mesuré.

**Ce que ça change ici.** Rien n'existe : aucune table `earth_observation_products` — vérifié,
le seul `satellites` du schéma est le **compte de satellites GPS** d'une position, sans rapport.

Le palier 0 n'engage aucune dépense et porte le cas d'usage le plus net pour la Guinée :
Sentinel-1 voit **à travers les nuages**, ce qui est la seule façon d'observer des coupures
pendant une saison des pluies. Les autres paliers sont des achats, donc explicitement hors de
mon mandat.

Le garde-fou de la partie E engage la conception dès maintenant, avant toute image : « aucune
donnée ou média d'AGEROUTE n'est envoyé à un service externe sans analyse de confidentialité et
de localisation ». Un traitement satellitaire doit donc être conçu pour **descendre** des
produits, jamais pour **téléverser** des médias de terrain.

---

## ADR-021 — D12 · Le périmètre du pilote est approuvé, pas choisi

**Arbitrage V10.** Analyses externes : 200–500 km. V9 : ne pas choisir arbitrairement. V10 :
pilote **sur périmètre approuvé par AGEROUTE** ; candidats **RN1 Conakry – Kindia – Mamou** et
**corridor minier de Boké** ; critères et métriques dans `PILOT_CORRIDOR_ACCEPTANCE_PLAN.md`.

**Ce que ça change ici.** Le choix ne m'appartient pas, et le mandat le dit en nommant deux
candidats sans trancher. Ce que je peux faire sans décision est **le plan d'acceptation
lui-même** : les critères de choix, les métriques et les seuils, écrits avant de connaître le
corridor retenu. C'est même l'ordre correct — des métriques choisies après coup se laissent
ajuster au résultat.

Le pilote est par ailleurs la **porte de trois autres arbitrages** : D2 (migration du module
roulage), D3 (benchmark cartographique) et D9 (modèle d'IA en observation) attendent tous une
preuve mesurée au pilote. Il n'est donc pas une étape parmi d'autres, c'est le point où quatre
décisions se résolvent.

---

## ADR-022 — D13 · La supériorité se mesure, elle ne se proclame pas

**Arbitrage V10.** Perplexity : AGEROUTE « centre de décision » face à un ONR « producteur ».
V9 : pas de supériorité déclarée sans benchmark. V10 : AGEROUTE = **meilleur producteur de
données et gestionnaire opérationnel**, **partenaire** de la BDR nationale (§ 7.15) ; « la
supériorité **se mesure** (§ 7.16), ne se proclame pas ».

**Ce que ça change ici.** C'est l'arbitrage le plus institutionnel des quinze et le plus simple
à tenir dans le code : il interdit une catégorie de phrase, et il la remplace par un étalon.

Le § 7.16 fixe cet étalon — **Logiroad Center comme plancher fonctionnel**, avec des items ★
propres au contexte guinéen à dépasser. Un plancher nommé est vérifiable ; une ambition ne l'est
pas. C'est à ce titre que le § 7.16 est entré dans [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md)
comme une ligne à part, à ABSENTE : dix-sept capacités, dont le catalogue à **≥ 21 types** quand
le dépôt en porte **13**.

Cet arbitrage gouverne aussi la manière de rédiger ces documents, et je le prends pour moi :
aucun des fichiers de suivi ne doit affirmer une avance sur l'ONR. Ils comptent, ils datent, ils
citent.

---

## ADR-023 — D14 · Les fichiers V9 sont canoniques — et cela corrige ADR-006

**Arbitrage V10.** V9 : `PROJECT_STATUS.md` etc. à la racine. v2.6 : `docs/pilotage/*`. V10 :
« **Fichiers V9 canoniques** (déjà dans le dépôt) ; les nouveaux documents de spécification vont
sous `docs/` (partie J). »

**Ce que ça change ici.** D14 **corrige en partie [ADR-006](#adr-006--les-documents-existants-ne-sont-pas-déplacés)**.
ADR-006 créait `docs/pilotage/` et l'annonçait « tenu à jour comme exigé ». D14 retire cette
qualité : le pilotage est à la racine, et `docs/` ne reçoit que les documents de spécification.

Ce qui survit d'ADR-006 est son motif principal, et il reste juste : les vingt-huit documents de
`docs/rai-v3/` ne sont **pas déplacés**, parce que des commits et du code les citent.

L'état actuel est conforme : huit fichiers canoniques à la racine, obtenus **par renommage Git**
de mes propres fichiers plutôt que par création de concurrents — l'historique est donc préservé,
et il n'existe pas deux documents prétendant au même rôle. `MIGRATION_PLAN.md` vient ainsi de
`docs/rai-v3/PLAN_MIGRATIONS_PRODUCTION.md`.

**Conséquence.** Tout ce que `docs/pilotage/` contient et qui prétend au pilotage doit renvoyer
vers la racine, pas l'inverse. Un fichier de suivi en double est pire qu'absent : il périme en
silence, et c'est très exactement la faute que j'ai commise une fois dans cette session avec
`PROGRESS.md`.

---

## ADR-024 — D15 · Une seule feuille de route : la sécurité d'abord, l'IA en dernier

**Arbitrage V10.** V9 : sécurité d'abord, IA après. v2.6 : lots fonctionnels. Perplexity :
phases 0–3 / 3–9 / 9–24 mois. V10 : **feuille de route unique** (partie F) — P0 sécurité et état
réel → socle et V1 terrain → pilote corridor et exploitation → moteurs de décision et excellence
Géoportail → IA, flottes, satellite, IoT.

**Ce que ça change ici.** L'ordre n'est pas une préférence de gestion, il suit les dépendances
réelles, et la base le démontre : **l'IA est en dernier parce que `observations`, `defauts` et
`missions` sont à zéro ligne.** Un modèle de vision sans corpus, un moteur de programmation sans
état observé, un indicateur sans mesure : les trois échoueraient pour la même raison, qui n'est
pas technique.

C'est le constat que [PROJECT_STATUS.md](PROJECT_STATUS.md) porte en tête : toute la chaîne de
collecte est écrite, testée, déployée — et vide.

**État de la phase 0.** Le § F.1 exige quatre preuves. **Trois sont acquises** :
`SECURITY_REMEDIATION.md` avec preuves, `REQUIREMENTS_TRACEABILITY.md` sans « à vérifier »,
`DECISIONS_PENDING.md` complet. La quatrième, « `MIGRATION_PLAN.md` **testé** », ne l'est pas :
le rollback n'a jamais été exécuté, faute de base de développement (B-13).

Un seul blocage, technique et sans enjeu institutionnel, sépare donc le projet de la fin de la
phase 0.

**Et une correction au passage.** Le § F.1 décrit la tâche de phase 0 comme la « réconciliation
**41 + 4** migrations ». La réconciliation, faite, donne **51 locales, 50 appliquées, 1 en
attente, 0 orpheline** : l'état de référence du mandat était périmé de neuf migrations. Voir
[MIGRATION_PLAN.md](MIGRATION_PLAN.md).