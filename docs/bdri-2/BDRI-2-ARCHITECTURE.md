# BDRI 2.0 — Architecture cible

**Principe directeur : ne remplacer aucune technologie sans mesure à l'appui.**
La pile actuelle — React 18 / Vite / Leaflet, Node / Express / Prisma, PostgreSQL 17 /
PostGIS, Docker / Traefik — n'a montré aucune limite en trois phases d'audit. Elle
n'était simplement pas exploitée : ni compression, ni index spatial, ni sauvegarde.

---

## 1. Ce qui reste inchangé, et pourquoi

| Élément | Verdict | Fondement |
|---|---|---|
| PostgreSQL + PostGIS | **Conserver** | 1 690 géométries, 0 invalide. Le socle est sain |
| Leaflet | **Conserver** | Rendu canvas mesuré à 2 180 géométries sans peine |
| Prisma | **Conserver** | 17 migrations versionnées, historique réconcilié |
| Express | **Conserver** | Le modèle de garde par middleware fonctionne — les trois failles venaient de son application, pas de sa conception |
| Docker / Traefik | **Conserver** | Déploiement et retour arrière éprouvés cinq fois |

**Aucune de ces briques n'a été prise en défaut.** Les problèmes trouvés étaient des
absences — de compression, d'index, de sauvegarde, de garde — jamais des limites
technologiques.

---

## 2. GeoServer et services OGC — la question tranchée par la mesure

Le §39 de la mission précédente demandait d'évaluer une architecture
QGIS → PostGIS → API → GeoServer → WebGIS.

**Recommandation : ne pas introduire GeoServer.**

| Argument | Mesure |
|---|---|
| Le volume ne le justifie pas | 2 306 objets géographiques au total, dont 1 690 tronçons |
| L'API actuelle suffit | 872 Ko compressés pour tout le réseau, servis en une requête |
| Le besoin n'est pas exprimé | Aucun consommateur OGC externe identifié à ce jour |
| Le coût est réel | Un service supplémentaire à héberger, sécuriser, sauvegarder et superviser |

GeoServer répond à un problème que la BDRI n'a pas : servir de très gros volumes
vectoriels à des clients SIG tiers. **Le jour où un tel besoin apparaît** — un partage
WMS/WFS avec un ministère, un bureau d'études — la question se rouvrira avec un cas
d'usage à mesurer.

**Ce qui répond au besoin d'interopérabilité aujourd'hui** : des exports GeoJSON, KML
et CSV respectant les permissions (§29), et une API documentée (§30). Bien moins cher,
et suffisant.

---

## 3. Routage — analyse et recommandation

### Constat

`troncons.service.ts`, fonction `itineraire` : `ST_MakeLine` entre deux centroïdes,
`ST_Distance` en geography. **C'est une distance à vol d'oiseau présentée comme un
itinéraire.**

### Comparaison

| Critère | pgRouting | OSRM | GraphHopper |
|---|---|---|---|
| Réseau parcouru | **Le réseau BDRI** | OpenStreetMap | OpenStreetMap |
| Précision sur le patrimoine AGEROUTE | Élevée | Sans objet — autre réseau | Sans objet |
| Coût | Nul (extension) | Nul, serveur à héberger | Libre ou payant |
| Performance | Bonne si topologie indexée | Très bonne | Très bonne |
| Maintenance | Moyenne — topologie à entretenir | Élevée — service séparé, données à rafraîchir | Élevée |
| Dépendance externe | **Aucune** | Service + données OSM | Service ou API tierce |
| Couverture Guinée | Celle de la BDRI | Celle d'OSM, inégale hors axes | Idem |

### Ce qui tranche

OSRM et GraphHopper routent sur OpenStreetMap. **La BDRI est le référentiel du
patrimoine d'AGEROUTE.** Un itinéraire calculé sur OSM ne refléterait ni l'état des
chaussées, ni le découpage en tronçons, ni les chantiers de la BDRI. Il donnerait un
trajet plausible — et créerait **deux vérités concurrentes sur le même réseau**, ce
qui est exactement ce qu'un référentiel national doit éviter.

### Recommandation en deux temps

**Immédiat, sans risque, une heure de travail** — renommer honnêtement dans
l'interface : « distance à vol d'oiseau » et non « itinéraire ». Ce qui est affiché
aujourd'hui trompe l'utilisateur, et le §16 l'interdit explicitement.

**À terme — pgRouting**, sous une condition non vérifiée : la topologie. Un réseau se
route s'il est **connecté**. Or les 1 690 tronçons ont été importés indépendamment ;
rien ne garantit que leurs extrémités coïncident. **À mesurer avant tout engagement** :

```sql
-- Extrémités isolées : combien de tronçons n'ont aucun voisin à moins de 10 m ?
SELECT count(*) FROM troncons t WHERE NOT EXISTS (
  SELECT 1 FROM troncons v WHERE v.id <> t.id
    AND ST_DWithin(ST_StartPoint(t.geom)::geography, v.geom::geography, 10)
);
```

Si cette requête renvoie un nombre élevé, **le routage n'est pas envisageable avant un
travail de reconstruction topologique** — et ce travail est un chantier à part entière,
pas un lot de développement.

---

## 4. Structure applicative

**Pas de microservices.** Le §25 de la phase précédente l'excluait, et rien dans les
mesures ne le justifierait : un monolithe modulaire de cette taille, correctement
cloisonné, est plus simple à sécuriser, à sauvegarder et à superviser.

**Une leçon d'architecture à graver**, issue des trois failles de la Phase 2 :

> Les trois vulnérabilités se trouvaient toutes dans des modules gardés **route par
> route**. Aucun module posant sa garde **au niveau du routeur** n'a présenté de
> défaut.

**Règle pour BDRI 2.0** : tout nouveau routeur pose `requireAuth` et
`requireModuleAccess` par `router.use()`, jamais route par route. Quand une route
échappe à la règle générale, elle est déclarée en exception explicite et commentée —
la charge de la preuve s'inverse.

`ordres-travaux` montre la forme ; `dashboard` montre l'exception bien faite, avec une
clé de module adaptée à chaque route.

---

## 5. API — versionnement

Le §30 suggère `/api/v1`. **Recommandation : ne pas versionner maintenant.**

L'API n'a qu'un seul consommateur — le frontend, livré avec elle. Un préfixe de
version n'apporte rien tant qu'aucun client externe n'existe, et coûte une réécriture
de toutes les routes plus la double maintenance.

**Le versionnement devient pertinent au lot 2.7**, quand les applications métiers
consommeront l'API. À ce moment, `/api/v1` doit être introduit **en même temps** que
le premier client externe, pas avant.

**Ce qui est utile dès maintenant** : documenter l'existant. Swagger est déjà monté
sur `/api/docs` mais la couverture des annotations n'a pas été vérifiée.

---

## 6. Sécurité — ce qui est acquis et ce qui reste

| Acquis | Vérifié |
|---|---|
| Argon2id, JWT rotatif révocable, TOTP, verrouillage | Oui |
| Plafond 2FA par challenge + limite IP | Testé en production : 429 au 11<sup>e</sup> essai |
| Cloisonnement par module sur 18 fichiers de routes | 45 tests |
| En-têtes Helmet sur l'API | Mesurés |
| Traversée de répertoire bloquée | Lu dans le code |

| Reste | Difficulté |
|---|---|
| En-têtes de sécurité sur le frontend | `frame-ancestors` doit autoriser SharePoint sur `/embed/` seulement |
| Route `photos` sans cloisonnement de module | Atténué par des noms en `crypto.randomUUID()` (122 bits) |
| Conteneur backend en root | Aucune directive `USER` au Dockerfile |

**Le partage de vues (§33) demande une vigilance particulière** : un lien partagé ne
doit jamais porter de droits. Il encode une **vue** — emprise, couches, filtres — et
les données restent servies selon l'identité de celui qui ouvre le lien. Un lien qui
transporterait un jeton serait une porte dérobée.

---

## 7. Observabilité

**État actuel mesuré** : journaux Morgan au format `combined` sur stdout, récupérés
par Docker. Aucune structuration, aucune agrégation, aucune alerte.

**Proposition minimale, sans nouvelle infrastructure** :

1. Journaux **structurés en JSON** côté backend — horodatage, niveau, requête, durée,
   identifiant utilisateur, code de statut. Analysables par `docker logs` filtré.
2. La **sonde d'état** livrée en Phase 3 comme point d'entrée de la supervision :
   200 / 503 suffisent à un contrôle externe.
3. Un **rapport de sauvegarde** lisible : dernière sauvegarde, taille, durée,
   dernière restauration vérifiée.

**Pas de Prometheus ni de Grafana à ce stade.** Une pile de supervision demande à être
hébergée, sécurisée, sauvegardée et surveillée à son tour. Sur un serveur qui n'avait
aucune sauvegarde il y a quelques heures, l'ordre des priorités est ailleurs.
