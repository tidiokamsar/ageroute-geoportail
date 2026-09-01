# BACKLOG BDRI 2.0

Tickets issus du premier tour d'audit (`AUDIT-BDRI-2026.md`), commit `432b593`.
Chaque ticket ne porte que sur un constat **mesuré**. Les estimations sont en
journées-homme et supposent une personne connaissant déjà le dépôt.

---

## P0 — Critique

### P0-1 · Monter un volume pour les fichiers téléversés

**Problème.** Le service `backend` n'a aucun volume ; `/app/uploads` vit dans le
conteneur et disparaît à chaque `docker compose up -d`. Les pages Base documentaire,
Inspection terrain et Ordres de travaux sont en production et servent à téléverser.

**Solution.** Déclarer `bdri_uploads` et le monter sur `/app/uploads`.

**Impact.** Aucun sur le code. Un redémarrage du backend.
**Dépendances.** Aucune.
**Risque.** Très faible **aujourd'hui** : le dossier est vide, il n'y a rien à migrer.
Ce risque croît à chaque fichier déposé — la fenêtre est ouverte, elle se referme.
**Estimation.** 0,5 j
**Critères d'acceptation.** Un fichier téléversé survit à `docker compose up -d`
après reconstruction de l'image. Vérifié par test manuel documenté.

---

### P0-2 · Activer la compression

**Problème.** Mesuré en production : `/api/public/carte/geo` renvoie 2 825 507 o et
le bundle 152 262 o, **identiques avec ou sans `Accept-Encoding: gzip, br`**. Aucun
`Content-Encoding`. Le public visé consulte en 3G.

**Solution.** Middleware `compression` sur Express ; `gzip on` + `gzip_types` dans
`frontend/nginx.conf`. Deux changements indépendants.

**Impact.** Attendu : 85 à 90 % sur le GeoJSON, 70 % sur le JS. Aucun effet
fonctionnel. Léger coût CPU serveur, négligeable à ce volume.
**Dépendances.** Aucune.
**Risque.** Faible. À surveiller : ne pas compresser les images déjà compressées.
**Estimation.** 0,5 j
**Critères d'acceptation.** `curl -H "Accept-Encoding: gzip"` renvoie
`Content-Encoding: gzip` et une taille inférieure à 500 Ko pour l'API publique.
Mesure avant/après consignée.

---

### P0-3 · Créer les index spatiaux GIST

**Problème.** Cinq colonnes géométriques, zéro index GIST dans les 16 migrations.
Toute analyse spatiale future balaiera l'intégralité des tables.

**Solution.** Migration SQL créant `USING GIST (geom)` sur `troncons`, `ouvrages`,
`points_noirs`, `postes`, `chantiers`. Prisma ne gérant pas les colonnes
`Unsupported`, l'index s'écrit en SQL brut dans la migration.

**Impact.** Prérequis de toutes les analyses spatiales de la V2.1 et de la V3.
**Dépendances.** Aucune.
**Risque.** Faible. `CREATE INDEX CONCURRENTLY` pour éviter tout verrou en
production ; attention, cette forme ne peut pas s'exécuter dans une transaction, ce
qui demande une migration Prisma marquée en conséquence.
**Estimation.** 0,5 j
**Critères d'acceptation.** `EXPLAIN` sur une requête `ST_DWithin` montre un
`Index Scan` et non un `Seq Scan`.

---

## P1 — Prioritaire

### P1-1 · Appliquer les droits par module à la recherche globale

**Problème.** `/api/search` n'applique que `requireAuth`. Un utilisateur restreint aux
tronçons obtient les ouvrages, postes et chantiers.
**Solution.** Filtrer les entités interrogées selon `modulesAutorises`. La réponse
porte déjà la clé `module`.
**Impact.** Un utilisateur restreint verra moins de résultats — c'est l'objectif.
**Risque.** Faible. Attention à ne pas restreindre les ADMIN, jamais limités.
**Estimation.** 0,5 j
**Critères d'acceptation.** Test automatisé : un compte limité au module `troncons`
n'obtient aucun résultat de type `ouvrage` sur `/api/search`.

---

### P1-2 · Restreindre la lecture du journal d'audit

**Problème.** `/api/audit` n'applique que `requireAuth` et renvoie `before`/`after`,
donc les montants des marchés à un compte LECTEUR.
**Solution.** Réserver au rôle ADMIN, ou aligner sur le module de `entityType`.
**Impact.** Si une page non-admin consomme cette route, elle cessera de fonctionner —
**à vérifier avant de livrer**.
**Dépendances.** Recenser les appelants côté frontend.
**Risque.** Moyen : risque de régression fonctionnelle si l'historique est affiché
dans des fiches ouvertes aux gestionnaires.
**Estimation.** 1 j
**Critères d'acceptation.** Test : un compte LECTEUR reçoit 403 sur
`/api/audit?entityType=Marche&entityId=...`.

---

### P1-3 · Poser les en-têtes de sécurité sur le frontend, sans casser SharePoint

**Problème.** Nginx ne renvoie aucun en-tête de sécurité.
**Solution.** CSP, HSTS, `nosniff`, `Referrer-Policy` dans `nginx.conf`, avec un
`frame-ancestors` autorisant explicitement le domaine SharePoint d'AGEROUTE sur la
seule route `/embed/`.
**Impact.** Durcissement. **Risque réel de casser la mini-carte SharePoint** si
`frame-ancestors` est posé sans exception.
**Dépendances.** Obtenir le domaine SharePoint exact auprès d'AGEROUTE.
**Risque.** Moyen — c'est le ticket à tester le plus soigneusement.
**Estimation.** 1 j
**Critères d'acceptation.** `/embed/carte` s'affiche toujours dans l'iframe
SharePoint ; les autres routes refusent l'encadrement.

---

### P1-4 · Mettre en place l'intégration continue

**Problème.** Aucune CI. `.github/workflows/ci.yml` est rédigé mais non commité.
**Solution.** Committer le workflow (compilation + tests, sans déploiement).
**Impact.** Toute régression de compilation est détectée avant la mise en ligne.
**Estimation.** 0,5 j
**Critères d'acceptation.** Le workflow s'exécute sur `main` et sur chaque PR.

---

### P1-5 · Politique de cache

**Problème.** Aucun `Cache-Control`, alors que les assets sont nommés par empreinte.
**Solution.** `immutable, max-age=31536000` sur `/assets/`, `no-cache` sur
`index.html`, cache court sur l'API publique.
**Estimation.** 0,5 j
**Critères d'acceptation.** Une seconde visite ne retélécharge pas le bundle.

---

## P2 — Important

### P2-1 · Socle de tests

**Problème.** 3 fichiers de test, aucun côté frontend, rien sur les routes, les
permissions, les uploads ni la couche spatiale.
**Solution.** Vitest + Supertest côté backend sur les routes et les permissions ;
Vitest + Testing Library côté frontend sur la carte publique.
**Impact.** Condition de faisabilité de tout le reste de la feuille de route.
**Estimation.** 5 j pour un socle utile, puis en continu.
**Critères d'acceptation.** Les tickets P1-1 et P1-2 sont couverts par un test
chacun ; la CI échoue si un test échoue.

---

### P2-2 · Centre de qualité des données

**Problème.** Anomalies constatées sur les données réelles : tronçons à 0 km
(`RES-782`, `RES-802`), classe incohérente avec le numéro (`RN2` classée `RR`),
`code` identique à `nom`.
**Solution.** Écran listant les anomalies détectées par règles explicites, chacune
documentée et corrigeable depuis la fiche.
**Dépendances.** Aucune technique, mais un arbitrage métier sur chaque règle.
**Estimation.** 5 j
**Critères d'acceptation.** Les trois anomalies ci-dessus sont détectées et
listées.

---

### P2-3 · Référentiel administratif

**Problème.** Seules les 8 régions existent. `prefecture` et `commune` sont des
colonnes vides. Une recherche « Kankan–Kissidougou » est donc impossible.
**Solution.** Modèles `Prefecture`, `SousPrefecture`, `Commune`, `Localite` avec
géométries, puis rattachement des tronçons — par intersection spatiale une fois
P0-3 livré.
**Impact.** Débloque la recherche par lieu et les analyses par découpage
administratif.
**Dépendances.** P0-3 (index spatiaux). Source de données officielle à obtenir
auprès de l'INS ou de l'IGN guinéen.
**Risque.** Moyen : la qualité du résultat dépend entièrement de la source.
**Estimation.** 8 j, hors acquisition des données.

---

### P2-4 · Renommer ou remplacer la fonction « itinéraire »

**Problème.** La fonction annonce un itinéraire et calcule une distance à vol
d'oiseau entre deux centroïdes.
**Solution.** Court terme : renommer honnêtement dans l'interface. Long terme :
pgRouting sur une topologie construite à partir des géométries.
**Estimation.** 0,5 j pour le renommage ; 10 j pour le routage réel.

---

## P3 — Évolution

### P3-1 · Historisation de l'état du patrimoine
`IndicateurReseauHistorique` existe déjà. L'étendre à l'objet : un tronçon doit
pouvoir montrer son état année par année (§30 de la mission). **Estimation** : 5 j.

### P3-2 · Analyse spatiale
Les quatre questions du §20 de la mission, une fois P0-3 livré. **Estimation** : 8 j.

### P3-3 · Services OGC
À réévaluer **après** P0-2 et P0-3, mesures à l'appui. Ne pas trancher avant.

### P3-4 · Score de priorité documenté
Aide à la décision (§22). À ne construire que si les données le justifient : le
trafic et le coût estimé sont-ils renseignés ? **À vérifier au second tour d'audit.**

---

## Ordre d'exécution recommandé

P0-1 → P0-2 → P0-3 → P1-4 → P2-1 → P1-1 → P1-2 → P1-5 → P1-3 → P2-2 → P2-3

Les trois P0 d'abord : ils sont rapides, sans dépendance, et deux d'entre eux
protègent contre une perte de données ou une dégradation déjà à l'œuvre. La CI et
les tests ensuite, avant les correctifs de sécurité — pour que ceux-ci soient
livrés avec un filet.
