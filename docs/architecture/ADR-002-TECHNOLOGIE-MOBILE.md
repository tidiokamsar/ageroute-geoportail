# ADR-002 — Technologie de l'application mobile de terrain

**Date** : 14/10/2026. **Statut** : **REMPLACÉE le 14/10/2026 à 16:01 par
[ADR-009](../../TECHNICAL_DECISIONS.md)**, le § 15 du prompt maître V10 figeant Capacitor.

> **Conservée comme trace du raisonnement.** Sa démonstration qu'une PWA pure ne peut pas tenir
> le § 7.13 reste valide et V10 l'écarte pour les mêmes raisons. Ce qu'elle avait faux est son
> rejet de Capacitor : j'ai comparé la réutilisation du *code métier* quand la vraie question
> était la réutilisation de *l'application entière*. Voir ADR-009.

**Remplaçait** la décision « PWA renforcée + enveloppe Capacitor » du 13/10/2026.

---

## 1. Décision

**React Native, avec Expo en *development build* (`expo prebuild`), et non Expo Go.**

La PWA existante n'est pas abandonnée : elle reste l'outil de saisie et d'enrichissement au
bureau, et le portail citoyen. Elle cesse d'être la réponse au terrain en roulage.

---

## 2. Ce qui a changé depuis la décision du 13/10

La décision antérieure retenait la PWA parce qu'elle réutilise React, Vite et Leaflet, se
teste localement, et s'installe depuis un navigateur sans compte développeur. Ces arguments
restent vrais, et ils ont porté une PWA qui **fonctionne** : service worker à deux caches,
file de synchronisation idempotente, `usePositionGps` avec trois erreurs distinctes, 17 tests
de politique de cache. `/sw.js` répond 200 en production.

Le mandat v2.1 a ajouté le **§ 7.13, collecte en roulage**, qui n'existait dans aucune version
antérieure du cahier. Il ne demande pas une application de terrain : il demande que *chaque
déplacement d'un véhicule produise de la donnée*, sans interaction, pendant des heures, hors
réseau.

Et le **§ 7.8** fixe explicitement le test à passer :

> « Une PWA n'est acceptable que si l'audit démontre qu'elle couvre : GPS en continu fiable,
> stockage volumineux de photos, fonctionnement hors ligne prolongé (plusieurs jours) et
> caméra — sinon, application native. »

---

## 3. Le test du § 7.8, appliqué critère par critère

| Critère § 7.8 | PWA sur Android | Verdict |
|---|---|---|
| **GPS en continu fiable** | `watchPosition` est suspendu dès que la page passe en arrière-plan ou que l'écran s'éteint. Le maintenir exige l'API Screen Wake Lock, donc **écran allumé en permanence** — or le § 7.13 traite précisément de la surchauffe du téléphone sur un tableau de bord | **échec** |
| **Stockage volumineux de photos** | IndexedDB tient des gigaoctets, mais sous quota et **éviction par le navigateur**. Le § 7.13 chiffre lui-même le besoin : ≈ 12 Mo/km, soit ≈ 1,2 Go sur un Conakry – Kankan | **risque non maîtrisé** |
| **Hors ligne prolongé, plusieurs jours** | Tenable pour des données, pas pour une collecte active : un onglet suspendu, un redémarrage de l'appareil ou un nettoyage du système interrompt tout, sans reprise | **échec** |
| **Caméra** | `getUserMedia` fonctionne, mais le flux meurt dès l'arrière-plan. La **capture automatique tous les 20–50 m** du § 7.13 l'exige vivant pendant des heures | **échec** |

Trois échecs et un risque non maîtrisé. Le § 7.8 conclut lui-même : « sinon, application
native ».

### Quatre exigences du § 7.13 qu'aucune PWA ne peut tenir

1. **Service de premier plan Android** avec notification persistante, « pour ne pas être arrêté
   par le système ». La plateforme web n'expose aucun équivalent.
2. **Trace GNSS à 1 Hz en arrière-plan** pendant des heures.
3. **Accéléromètre et gyroscope pour l'IRI estimé** : les capteurs de l'API Generic Sensor sont
   suspendus quand la page n'est pas visible, et l'IRI exige une fenêtre continue.
4. **Reprise automatique après redémarrage de l'appareil** — hors de portée d'une page web.

Il ne s'agit donc pas d'un arbitrage de confort entre deux piles équivalentes : **le § 7.13
est irréalisable en PWA**, et c'est une fonction de priorité M (T-12).

---

## 4. Options examinées

| Option | Couvre le § 7.13 | Réutilisation du code existant | Vérifiable ici |
|---|---|---|---|
| **A. PWA seule** | **non** | maximale | oui |
| **B. Capacitor autour de la PWA** | partiellement, par greffons natifs | élevée sur l'interface, **nulle sur le roulage** | non (build Android) |
| **C. React Native + Expo prebuild** | **oui** | **le noyau de règles, déjà en TypeScript pur** | non (build Android) |
| **D. Android natif, Kotlin** | oui | aucune | non |

**Pourquoi B est écartée malgré sa réutilisation.** Capacitor emballe une page web : les
capacités de roulage passeraient toutes par des greffons natifs, c'est-à-dire précisément là où
la réutilisation est nulle. On garderait l'interface web — inadaptée au roulage, qui demande un
écran paysage à six à neuf gros boutons utilisables sans lecture — et on écrirait du natif pour
tout ce qui compte. Le pire des deux.

**Pourquoi D est écartée.** Elle offre la meilleure maîtrise des capteurs et aucune
réutilisation : les règles d'appariement, de portions, de métré et d'idempotence seraient
réécrites en Kotlin, avec un second jeu de bogues et une divergence garantie avec le serveur.

**Ce que C réutilise réellement.** Ce n'est pas l'argument faible qu'on croit. Le travail des
jours précédents a extrait les règles métier en **modules TypeScript purs, sans Prisma ni
Express**, précisément parce qu'il fallait les éprouver sans base :

| Module | Tests | Réutilisable tel quel |
|---|---|---|
| `geo/appariement.ts` | oui | l'appariement embarqué du § 7.3 |
| `reseau/portions.ts` | 40 | les propositions de portions du roulage |
| `field/defauts.regles.ts` | 60 | le métré et la gravité en un geste |
| `engines/condition.ts` + `.collecte.ts` | 58 | l'affichage de l'état hors ligne |
| `field/portions.sync.ts` | 13 | le protocole d'idempotence |

Cinq modules, plus de 170 tests, qui vivent déjà sans dépendance serveur. C'est ce qui rend
l'option C peu coûteuse là où elle paraît la plus lourde.

---

## 5. Pile retenue, et ce que j'ai vérifié plutôt que supposé

| Besoin | Choix | Vérification du 14/10/2026 |
|---|---|---|
| Cadre | **Expo en *development build*** (`expo prebuild`) | Les greffons natifs requis **ne tournent pas dans Expo Go** : un *development build* est obligatoire |
| Carte | **`@maplibre/maplibre-react-native`** | Paquet officiel MapLibre, version 11.4.1, publié activement ; contient du code natif |
| Localisation | **`expo-location`**, `startLocationUpdatesAsync` avec l'option `foregroundService` | Option réelle et documentée sur Android |
| Capteurs, caméra, stockage | `expo-sensors`, `expo-camera`, `expo-sqlite` | Modules Expo de première partie |
| Règles métier | les cinq modules TypeScript ci-dessus | partagés, non réécrits |

**Une contrainte opérationnelle découverte en vérifiant, et qui change l'ergonomie.** Le suivi
Expo documente l'erreur « Foreground service cannot be started when the application is in the
background » : **le service de premier plan doit être démarré alors que l'application est au
premier plan.** L'opérateur doit donc lancer explicitement la collecte, application ouverte,
avant de rouler. Ce n'est pas une limite gênante — c'est même conforme au garde-fou § 2.9, qui
veut que le conducteur ne manipule rien en roulant — mais cela interdit un démarrage
automatique au mouvement, et doit figurer dans le guide de collecte.

Le même suivi signale des frictions réelles autour des services de premier plan : permissions
Android récentes, notifications persistantes après arrêt de l'application. Ce sont des risques
d'intégration, pas des empêchements, et ils sont consignés au § 7 ci-dessous.

**Les versions exactes seront épinglées au lot 6**, contre la matrice de compatibilité Expo du
jour. Les épingler aujourd'hui, sans pouvoir compiler, serait inventer une garantie.

---

## 6. Ce que devient la PWA

Elle garde trois rôles, et aucun n'est un lot de consolation :

1. **Mode bureau (« enrichissement »)** du § 7.13 : visionneuse vue de route, qualification des
   marqueurs, transformation des événements linéaires en propositions. Cela se fait sur grand
   écran, en ligne, au bureau — exactement ce qu'une application web fait mieux qu'un téléphone.
2. **Géoportail public** (§ 14.6, P-02) et signalement citoyen (P-01) : un citoyen n'installe
   pas une application pour signaler un nid-de-poule.
3. **Secours de saisie** : un agent dont le téléphone est en panne garde un accès navigateur.

Son service worker, sa file de synchronisation et sa politique de cache de tuiles restent donc
utiles et maintenus. Le travail du 13/10 n'est pas perdu ; il change de destinataire.

---

## 7. Conséquences

**Sur le planning.** Les lots 6 et 7 du § 8 deviennent un développement mobile natif, non une
extension de la PWA. La charge augmente ; l'alternative était de livrer un § 7.13 qui ne
fonctionne pas.

**Sur l'architecture.** Un dossier `mobile/` apparaît, consommant les modules de règles
partagés. Ces modules ne doivent **jamais** importer Prisma ni Express, sous peine de rendre le
partage impossible : c'est déjà le cas, et cela devient une contrainte à tester.

**Sur les livrables.** Le § 7.8 attend code source, APK de test signé d'une clé de
développement, instructions de compilation, tests unitaires et E2E (Detox ou Maestro), et
procédure de distribution.

**Blocage** : aucun APK ne peut être produit ni testé sur ce poste — ni `adb`, ni `gradle`, ni
`java` (B-10 dans [BLOCAGES.md](../pilotage/BLOCAGES.md)). Le code, les configurations et les
instructions seront écrits ; la compilation et les tests sur appareil demandent un poste
outillé ou une intégration continue Android. **Je ne déclarerai aucun APK construit ni testé
sans l'avoir fait** (§ 2.7).

**Risques** à suivre au lot 6 :
- frictions connues des services de premier plan Android (permissions, notification persistante
  après arrêt de l'application) ;
- validité de l'IRI entièrement dépendante d'une **fixation rigide** du téléphone (§ 7.13), donc
  d'une procédure humaine, pas d'un réglage logiciel ;
- consommation et surchauffe : le § 7.13 impose une dégradation automatique de la fréquence et
  de la résolution photo au-delà d'un seuil de température, à éprouver sur appareil réel.

---

## 8. Ce qui renverserait cette décision

Par honnêteté sur sa solidité, trois faits la remettraient en cause :

1. **Si le § 7.13 était retiré du périmètre.** Sans collecte en roulage, la PWA redevient
   suffisante et l'option A est la moins chère.
2. **Si AGEROUTE imposait un parc non-Android.** Le raisonnement porte sur Android, seule
   plateforme citée par le mandat (§ 1.1 : « smartphones Android d'entrée et de milieu de
   gamme »).
3. **Si une démonstration mesurée** sur appareil réel établissait qu'une PWA tient une trace à
   1 Hz pendant deux heures, écran éteint, avec reprise après redémarrage. Je ne le crois pas
   possible, mais je n'ai pas pu le mesurer : ce poste n'a pas d'appareil Android. L'argument
   ci-dessus repose sur le comportement documenté de la plateforme web, pas sur une mesure que
   j'aurais faite.
