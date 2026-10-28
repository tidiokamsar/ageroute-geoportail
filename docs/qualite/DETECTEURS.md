# Détecteurs de qualité des données de tronçons (lecture seule)

Chantier B du Lot 1, 26/10/2026. Complète `backend/src/qualite/anomalies.ts` sans le modifier.

## 1. À quoi ça sert, et ce que ça ne fait jamais

Le Lot 0 a constaté que le moteur existant détecte six familles d'anomalies sur huit attendues, ne voit pas la sentinelle PK 0/0, et que `troncons` ne porte aucune contrainte `CHECK`. Ces détecteurs comblent les trous suivants, **par code stable**, avec la liste des entités en cause, les valeurs mesurées et le seuil appliqué.

Un détecteur est un **signal, jamais une action**. Aucune fonction n'écrit, ne corrige, ne supprime. Chaque code porte une correction proposée en texte (jamais « supprimer » : le patrimoine routier est une donnée d'archive, règle 2 d'`AGENTS.md`) à appliquer par les routes normales et leur validation.

| Fichier | Rôle |
|---|---|
| `backend/src/qualite/detecteurs.noyau.ts` | Noyau pur : codes, gravités, seuils, classification, agrégation. Aucun import, aucune horloge, aucune base. |
| `backend/src/qualite/detecteurs.depot.ts` | Requêtes SQL **SELECT uniquement**, pagination par curseur, client injecté. |
| `backend/src/qualite/detecteurs.service.ts` | Orchestration (`lancerDetecteurs`) et forme **READ ONLY** (`lancerEnLectureSeule`). |
| `backend/src/qualite/detecteurs.routes.ts` | `GET /api/v2/qualite/detecteurs` (ADMIN ou GESTIONNAIRE). **Non montée** : voir § 7. |
| `docs/qualite/DETECTEURS-REQUETES-DSI.sql` | Six requêtes de lecture que la DSI peut lancer elle-même. |
| `backend/tests-integration/qualite-detecteurs.integration.ts` | Banc PostGIS (98 vérifications). |

## 2. Catalogue des codes

Gravités : `BLOQUANTE` (donnée fausse qui contamine les calculs), `A_TRAITER` (incomplète ou contradictoire), `A_SURVEILLER` (rien n'est faux aujourd'hui, ou fait connu). **Les gravités sont provisoires**, comme les seuils : elles disent dans quel ordre regarder, pas une décision d'AGEROUTE.

| Famille | Code | Gravité | Règle | Valeurs mesurées rendues |
|---|---|---|---|---|
| PK | `PK_SENTINELLE_ZERO` | A_TRAITER | PK début = 0 et PK fin = 0 | pkDebut, pkFin, longueurKm |
| PK | `PK_FIN_INFERIEUR_DEBUT` | BLOQUANTE | PK fin < PK début (hors 0/0) | pkDebut, pkFin, ecartKm |
| PK | `PK_ABSENT` | A_TRAITER | PK début ou fin non fini (NaN, infini, null). La colonne est `NOT NULL` : l'absence ne peut être que NaN ou infini en base | pkDebut, pkFin |
| PK | `PK_NEGATIF` | A_TRAITER | PK début ou fin < 0 | pkDebut, pkFin |
| PK | `PK_CHEVAUCHEMENT` | A_TRAITER | deux tronçons consécutifs d'une même (route, section) se recouvrent de plus de `PK_CHEVAUCHEMENT_KM` | route, sectionPk, PK des deux tronçons, partenaire, chevauchementKm |
| PK | `PK_TROU` | A_SURVEILLER | trou de plus de `PK_TROU_KM` entre deux tronçons consécutifs de la même (route, section) | idem, trouKm |
| Longueur | `LONGUEUR_NON_POSITIVE` | A_TRAITER | longueur déclarée ≤ 0 ou non finie | longueurDeclareeKm, longueurGeometriqueKm |
| Longueur | `LONGUEUR_ECART_GEOMETRIE` | A_TRAITER | écart relatif > `LONGUEUR_ECART_RELATIF` **et** écart absolu ≥ `LONGUEUR_ECART_ABSOLU_MIN_KM` | longueurDeclareeKm, longueurGeometriqueKm, ecartAbsoluKm, ecartRelatif |
| Géométrie | `GEOM_ABSENTE` | A_TRAITER | `geom` nul sur un tronçon actif | |
| Géométrie | `GEOM_VIDE` | A_TRAITER | `ST_IsEmpty` | |
| Géométrie | `GEOM_INVALIDE` | BLOQUANTE | `NOT ST_IsValid` | raison de PostGIS |
| Géométrie | `GEOM_NON_LINEAIRE` | BLOQUANTE | type ≠ `ST_LineString` | type |
| Géométrie | `GEOM_SRID_INATTENDU` | BLOQUANTE | SRID ≠ 4326 | srid |
| Géométrie | `GEOM_LONGUEUR_NULLE` | A_TRAITER | longueur géodésique < `LONGUEUR_GEOMETRIQUE_NULLE_M` | longueurGeometriqueM |
| Région | `REGION_DISCORDANTE` | A_TRAITER si la part dans la région déclarée < `REGION_PART_DECLAREE_FAIBLE`, sinon A_SURVEILLER (à cheval) | une autre région de niveau 1 contient plus de `REGION_MAJORITE` du tracé **et** plus que la région déclarée | regionDeclaree, regionDominante, partDansRegionDeclaree, partDansRegionDominante |
| Région | `REGION_NON_RENSEIGNEE` | A_TRAITER | rattaché à « Non renseigné » alors que le tracé touche une région | idem |
| Région | `REGION_NON_VERIFIABLE` | A_SURVEILLER | aucune limite de niveau 1 de même nom que la région déclarée : non jugée | idem |
| Région | `HORS_TERRITOIRE` | A_TRAITER ; A_SURVEILLER si `perimetre = HORS_TERRITOIRE_NATIONAL` (déjà documenté) | aucune limite de niveau 1 valide n'est touchée | perimetreDeclare, statutDejaDocumente |
| Doublon | `DOUBLON_GEOMETRIE_STRICT` | BLOQUANTE | un autre tronçon actif a la même géométrie (binaire, ou identique au sens inverse) | partenaires, régions et sources des partenaires, sensInverse |
| Doublon | `DOUBLON_GEOMETRIE_QUASI` | A_TRAITER | distance de Hausdorff ≤ `DOUBLON_QUASI_TOLERANCE_DEG` | idem, distanceHausdorffDeg |
| État | `ETAT_NON_EVALUE` | A_SURVEILLER | `etat = NON_EVALUE`. **Valeur par défaut, donc très fréquente** : la liste est plafonnée, le compte est exact | |
| État | `ETAT_DATE_SANS_ETAT` | A_TRAITER | date d'évaluation présente alors que l'état est NON_EVALUE | dateDerniereEvaluation |
| État | `ETAT_SANS_DATE_EVALUATION` | A_SURVEILLER | état déclaré sans date d'évaluation | etat |
| État | `ETAT_DATE_FUTURE` | A_TRAITER | date d'évaluation au-delà de `maintenant` + `ETAT_DATE_FUTURE_TOLERANCE_JOURS` | dateDerniereEvaluation, joursDAvance |
| État | `ETAT_ABSENT`, `ETAT_INCONNU` | A_TRAITER | état vide, ou hors de BON, MOYEN, MAUVAIS, CRITIQUE, NON_EVALUE | |

`GEOM_NON_LINEAIRE`, `GEOM_SRID_INATTENDU`, `ETAT_ABSENT` et `ETAT_INCONNU` **ne peuvent pas se produire** sur la base actuelle : `troncons.geom` est typée `geometry(LineString,4326)` (le banc vérifie que PostGIS refuse un POINT et un SRID 3857) et `etat` est un enum `NOT NULL`. Ils restent comme ceinture si la contrainte manque (la production a été construite par `db push`, voir `backend/prisma/descentes/README.md`).

Une entité peut porter plusieurs codes. Un tronçon actif est un tronçon dont `deletedAt` est nul.

### Correspondance avec les familles existantes (`anomalies.ts`)

| Famille existante | Recoupement |
|---|---|
| `GEOMETRIE_INVALIDE` (six tables) | `GEOM_INVALIDE` ne couvre que `troncons`, avec la raison par tronçon |
| `DOUBLON` (égalité binaire, par groupe) | `DOUBLON_GEOMETRIE_STRICT` donne les entités, le sens inverse et les partenaires hors région |
| `HORS_TERRITOIRE` | `HORS_TERRITOIRE` reprend la définition (aucune intersection avec une limite de niveau 1) ; la forme SQL diffère (jointure tronçon par tronçon aux seules limites valides, voir `detecteurs.depot.ts`) |
| `ATTRIBUTS_INCOHERENTS`, `RUPTURE_DE_CONTINUITE`, etc. | sans équivalent ici : portions et ouvrages hors périmètre |

Les deux modules coexistent. Rien n'est supprimé de l'existant.

## 3. Seuils provisoires

Aucun nombre ci-dessous n'est une norme d'AGEROUTE. Chacun est nommé, passé en paramètre à chaque fonction, **rendu dans la réponse** avec son statut `PROVISOIRE` et son origine, et modifiable par la requête (un paramètre par seuil, ex. `?regionId=7&PK_TROU_KM=2`). Les comparer à un seuil à l'égalité est tolérant à 1e-9 (bruit d'arrondi des flottants : `10 - 9.95` vaut 0,05000000000000071).

| Seuil | Valeur | Unité | Origine (et ce que ce n'est pas) |
|---|---|---|---|
| `PK_CHEVAUCHEMENT_KM` | 0,05 | km | valeur technique, au-dessus du bruit d'arrondi des PK. Aucune décision métier |
| `PK_TROU_KM` | 0,5 | km | tolérance de la mesure du 05/09/2026 citée par `scripts/extraire-section-pk.ts` (88 sections sur 90 s'enchaînaient à moins de 500 m). Ordre de grandeur observé, pas une règle |
| `LONGUEUR_ECART_RELATIF` | 0,10 | ratio | choix de départ **sans fondement métier** : à fixer par AGEROUTE après lecture de la distribution réelle des écarts |
| `LONGUEUR_ECART_ABSOLU_MIN_KM` | 0,05 | km | évite 3 m contre 4 m sur un tronçon minuscule |
| `LONGUEUR_GEOMETRIQUE_NULLE_M` | 0,01 | m | précision des coordonnées (1e-7 degré, environ 1 cm) |
| `REGION_MAJORITE` | 0,5 | ratio | sens du mot « majoritairement » |
| `REGION_PART_DECLAREE_FAIBLE` | 0,2 | ratio | seuil de 20 % de la mesure du 05/09/2026 de `scripts/rattacher-troncons-region.ts` : sépare « entièrement ailleurs » de « à cheval » |
| `DOUBLON_QUASI_TOLERANCE_DEG` | 0,00001 | degré | environ 1,1 m à l'équateur ; deux voies voisines distinctes plus proches sont très improbables mais possibles |
| `ETAT_DATE_FUTURE_TOLERANCE_JOURS` | 1 | jour | fuseaux horaires et saisie anticipée du jour |

Le banc PostGIS suppose ces valeurs (elles sont écrites en littéraux dans son oracle SQL) : il échoue si l'une change, ce qui oblige à le dire.

## 4. Lecture seule : ce qui le prouve

1. **Analyse statique** (`detecteurs.service.test.ts`) : aucun mot d'écriture SQL (`insert`, `update`, `delete`, `truncate`, `alter`, `drop`, `create`, `grant`, `copy`, `merge`) hors commentaires dans le dépôt et le service ; aucun `$executeRaw` dans le dépôt ; la **seule** instruction non lue du service est `SET TRANSACTION READ ONLY` ; aucune écriture dans `audit_logs`.
2. **Requêtes émises** : toutes commencent par `SELECT` ou `WITH`, la portée est un paramètre lié.
3. **Banc PostGIS** (transaction annulée sur `replay`, passée en lecture seule **après** l'insertion des fixtures) : `SHOW transaction_read_only` vaut `on` ; une écriture est refusée par la base ; les compteurs `pg_stat_xact_user_tables` (insertions, mises à jour, suppressions par table) et l'empreinte MD5 des tronçons sont **identiques avant et après** le service ; `audit_logs` reste vide.
4. **Mutation** : une écriture introduite dans le service est refusée par la base (erreur `25006`, « cannot execute INSERT in a read-only transaction »).
5. **Forme de production** : `lancerEnLectureSeule` ouvre une transaction `READ ONLY` avec un délai de 10 minutes (le délai par défaut de Prisma, 5 s, ne suffirait pas à un balayage national) ; le banc en observe `transaction_read_only = on` et le refus d'une écriture.

Une lecture n'est pas une écriture du patrimoine : le service n'écrit pas dans `audit_logs` (règle 3). La route consigne qui l'a lancée dans le journal applicatif habituel.

## 5. Ce qui n'est PAS détecté

Repris dans la réponse (`nonCouvert`) pour que le rapport ne se lise pas comme exhaustif.

- Seuls les **tronçons actifs** sont examinés. Ouvrages, chantiers, portions, points noirs, voirie locale hors registre : non.
- **PK** : le chaînage ne porte que sur les tronçons ayant une `sectionPk` ; la voirie promue et les tronçons sans section ne sont ni en chevauchement ni en trou. Un trou au début ou à la fin d'une section n'est pas vu. L'écart entre (PK fin − PK début) et la longueur déclarée n'est pas contrôlé. Une section parcourue à PK décroissants est signalée `PK_FIN_INFERIEUR_DEBUT` même si c'est voulu. Deux chaussées parallèles d'une même route à PK identiques sortiraient en chevauchement.
- **Longueur** : un tracé tronqué ou découpé dont la longueur déclarée est cohérente avec lui-même n'est pas vu ; la longueur géodésique n'est pas confrontée à la différence des PK.
- **Région** : jugée par le **nom** (région du tronçon et limite de niveau 1, sans accent ni casse). Une région sans limite de même nom est `REGION_NON_VERIFIABLE`, non jugée. La précision de la couche de limites n'est pas vérifiée. Un tronçon majoritairement hors du pays mais qui touche une limite n'est pas signalé. Un tronçon sans majorité nette (par exemple 45/45/10) n'est pas signalé discordant. Une limite de niveau 1 invalide est écartée (avertissement rendu).
- **Doublons** : cherchés parmi les voisins dont l'emprise est identique à la tolérance près. Deux tracés superposés sur un segment seulement (l'un plus long que l'autre) ne sont pas des doublons ici. Les géométries invalides ou vides sont écartées des doublons. Le résultat est borné à 200 000 paires (avertissement si atteint). Le jumeau « voirie locale » connu des 42 groupes de l'audit du 13/10/2026 est signalé comme les autres : sa `sourceReference` figure dans le détail.
- **État** : la colonne `troncons.etat` n'est comparée ni aux portions validées ni aux inspections (le référentiel d'état des portions est un vocabulaire administrable sans ordre défini). Le drapeau « déclaré » (`valeurs_qualite` IMPORTED_UNVERIFIED) n'est pas utilisé.
- **Ouvrage loin de son tronçon** (cité au backlog du Lot 0) : non traité, hors du périmètre demandé.
- **Contraintes `CHECK`** : ces détecteurs ne les remplacent pas. Une contrainte (PK ≥ 0, longueur > 0, fin ≥ début) refuserait l'écriture de la donnée fausse ; elle exige d'abord de corriger l'existant et une migration à descente. Décision de l'architecte, non prise ici.
- **Les seuils sont provisoires** : un compte change si un seuil change.

## 6. Constats rencontrés en chemin

1. **D'où vient la sentinelle PK 0/0.** Lecture des scripts : `scripts/migrate-legacy-data.ts` écrit `pkDebut: t.pkorigine ?? 0`, `pkFin: t.pkfin ?? 0` (lignes 145-146) **et** `longueurKm: t.longueur ?? 0` (ligne 142) quand la source est vide ; `scripts/import-rural-osm.ts` (lignes 66-67) et `scripts/merge-osm-routes.ts` (lignes 101-102) écrivent `pkDebut: 0, pkFin: 0` pour des segments dont la longueur est réelle. Cela rend compte, sans la prouver, de la présence simultanée de PK 0/0 et de longueurs nulles (les « 1 028 régionales sur 1 029 sans longueur saisie » du ticket BDRI-2). Le comptage réel sur la production reste à faire par la DSI (§ 8).
2. **GEOS 3.9.0 de la base de rejeu rend un résultat vide pour `ST_Intersection` d'un tracé horizontal ou vertical situé dans un polygone rectangulaire** (`SELECT ST_AsText(ST_Intersection(ST_GeomFromText('LINESTRING(1 5, 2 5)'), ST_GeomFromText('POLYGON((0 0,10 0,10 10,0 10,0 0))')))` rend `LINESTRING EMPTY` ; un tracé en diagonale ou qui traverse la limite est correct). PostGIS 3.5.2. Découvert par le banc, contourné dans `mesurerRegions` (un tracé entièrement couvert par la limite vaut 1 sans passer par `ST_Intersection`, ce qui est aussi plus rapide). **Les scripts `rattacher-troncons-region.ts`, `merge-osm-routes.ts` utilisent `ST_Intersection` sans ce garde.** Les limites administratives réelles et le tampon de `merge-osm-routes.ts` ne sont pas des rectangles : l'effet sur la production est improbable, mais non vérifié ; la version de GEOS de la production n'est pas connue : à relever (`SELECT postgis_full_version();`).
3. **`national=false` vaut vrai dans `/api/v2/qualite/anomalies`.** `z.coerce.boolean()` lit toute chaîne non vide, donc `"false"`, comme vraie (`backend/src/api-v2/qualite.routes.ts`, schéma `requete`). Un ADMIN qui passe `national=false` déclenche le balayage national ; un GESTIONNAIRE reçoit un 403 trompeur. La nouvelle route utilise `z.enum(["true","false"])`. Correction proposée pour l'existant : même remplacement.
4. **Le script de qualité `backfill-qualite.ts` écrase** (`upsert` avec branche `update`) les lignes `valeurs_qualite` des six champs, y compris celles qu'un humain aurait fait passer à un statut vérifié depuis. Voir l'audit des scripts.

## 7. Exposer la route

La route est écrite et testée (`detecteurs.routes.test.ts`, 12 tests) mais **non montée** : le montage exige de modifier `backend/src/api-v2/index.ts`, hors du périmètre de ce chantier. Diff exact :

```diff
--- a/backend/src/api-v2/index.ts
+++ b/backend/src/api-v2/index.ts
@@ import { qualiteV2Router } from "./qualite.routes";
+import { detecteursQualiteRouter } from "../qualite/detecteurs.routes";
@@ apiV2Router.use("/qualite", qualiteV2Router);
+// Avant /qualite : chemin plus specifique d'abord (meme regle que /exploitation et /patrouilles).
+apiV2Router.use("/qualite/detecteurs", detecteursQualiteRouter);
 apiV2Router.use("/qualite", qualiteV2Router);
```

(la seconde ligne `apiV2Router.use("/qualite", qualiteV2Router);` est le contexte existant ; la nouvelle ligne se place juste avant). Après montage : relancer `src/securite/routes-authentifiees.test.ts` (la route est protégée par `requireAuth` en premier : 401 sans jeton) et régénérer la matrice de `docs/securite/CONTROLE-ACCES.md` si elle est tenue (le contrôle territorial de cette route est fait dans le handler avec `perimetreDe` et `verifierTerritoire`, donc invisible de l'inventaire des gardes ; le remplacer par `requireTerritoire` le rendrait visible).

Appel : `GET /api/v2/qualite/detecteurs?regionId=7` (GESTIONNAIRE ou ADMIN), `GET /api/v2/qualite/detecteurs?national=true` (ADMIN). Paramètres : `familles=PK,ETAT` (borner le coût), `plafond=0..5000` (entités listées par code, 500 par défaut ; le **compte reste exact**), `reseau=reference|voirie|tout`, un paramètre par seuil. Sans portée : 400 `PORTEE_REQUISE`.

Depuis un script : `lancerEnLectureSeule(prisma, { portee: { regionId: 7 }, familles: ["PK", "GEOMETRIE"] })`.

## 8. Instructions pour la DSI (rien n'a été lancé sur la production)

Ce chantier **n'a pas exécuté** les détecteurs contre la production, et aucune durée n'est connue pour 261 387 tronçons (le seul chiffre mesuré est celui du balayage hors territoire du 13/10/2026 : 14 à 20 secondes).

1. **Par la route**, une fois montée et déployée : une région d'abord (`?regionId=<id>`), puis `?national=true` en ADMIN, hors heures d'usage, en commençant par `familles=PK,LONGUEUR,GEOMETRIE,ETAT` (balayage par pages de 5 000, sans jointure spatiale), puis `familles=REGION` puis `familles=DOUBLON` (les plus coûteuses).
2. **Par SQL**, sans rien déployer : `psql -v region_id=<id> -f docs/qualite/DETECTEURS-REQUETES-DSI.sql` (ou `-v region_id=NULL`). Le fichier ouvre `BEGIN READ ONLY`, borne la durée (`statement_timeout` 300 s) et se termine par `ROLLBACK`. Il contient six requêtes ; elles ont été rejouées sur les fixtures du banc et donnent les mêmes comptes que le modèle. Elles ne couvrent ni la région, ni les quasi-doublons, ni les doublons inverses : ceux-là passent par la route.
3. Avant de lancer quoi que ce soit : relever `SELECT postgis_full_version();` (voir le constat n° 2 sur GEOS) et vérifier que les limites de niveau 1 sont chargées (`SELECT count(*) FROM limites_admin WHERE niveau = 1;`) et valides.
4. Lire les comptes **avec les seuils** : les seuils sont provisoires, aucun compte n'est une vérité métier.
