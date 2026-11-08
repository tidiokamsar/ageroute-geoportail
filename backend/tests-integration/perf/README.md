# Banc de performance A15 / A20

Mesure, sur un reseau synthetique deterministe a l'echelle du registre, les objectifs du cahier :

| Scenario | Objectif | Ce que le banc mesure |
|---|---|---|
| **A15** | rattachement < 300 ms p95 | `GET /api/v2/field/current-context` (chemin du terrain), `POST /api/v2/geo/match`, et leurs fonctions de service |
| **A20** | recherche < 300 ms | `GET /api/search`, par classe de requete (code exact, mot de nom, mot frequent, absent) |
| **A20** | deviation < 2 s | `POST /api/v2/geo/deviation` et `calculerDeviation()` ; `chargerGraphe()` et sa requete SQL a part |
| **A20** | rendu < 3 s en 3G | **non mesurable par ce banc** : octets gzippes de la carte publique et duree de transfert theorique sous deux profils 3G explicites. Le rendu navigateur se mesure avec `serveur-3g.ts` (voir plus bas) |

Le resultat chiffre, la methode, le materiel et le verdict par objectif sont dans
[`docs/performance/MESURES-A15-A20.md`](../../../docs/performance/MESURES-A15-A20.md). Ce fichier-ci dit
comment REJOUER.

## Prerequis

- Une base PostGIS locale `replay` (rejeu des migrations, vide), comme pour les autres bancs
  (`../README.md`). Sur ce poste : conteneur `bdri-dev-db`, `127.0.0.1:5434`.
- `DATABASE_URL` pointant sur `replay`. La garde (`../lib/garde.ts`) refuse tout autre hote ou toute base
  qui n'est pas `replay` ou `essai_<nom>`. Le banc **ne l'ecrit jamais** : il en fait un clone
  `essai_perf` (`CREATE DATABASE ... TEMPLATE replay`), travaille dedans, puis le supprime.
- `replay` ne doit avoir aucune connexion ouverte (PostgreSQL refuse de cloner un modele utilise).
- Les dependances du backend installees. Aucun secret : les jetons JWT sont signes avec des secrets
  aleatoires propres au processus.

## Rejouer

```bash
cd backend
export DATABASE_URL="postgresql://utilisateur:motdepasse@127.0.0.1:5434/replay"

# Verdict complet a l'echelle du registre (261 387 troncons) : une heure environ sur un portable.
npx tsx tests-integration/perf/perf.integration.ts --nombre 261387 --sortie ../docs/performance/resultats-261387.json

# Volume minimal du cahier (20 000 troncons) : une dizaine de minutes.
npx tsx tests-integration/perf/perf.integration.ts --nombre 20000
```

Le banc :

1. genere le reseau (graine `20261023`), le charge dans le clone, imprime l'**empreinte SHA-256** du jeu ;
2. mesure l'etat d'ORIGINE : premiers appels dans des processus neufs (« froid »), puis 200 iterations apres
   20 d'echauffement par scenario (« chaud »), niveaux service et HTTP, plans `EXPLAIN (ANALYZE, BUFFERS)` ;
3. applique les migrations de la plage `20261023200000` a `20261023299999` au clone ;
4. mesure de nouveau ;
5. **verifie** l'etat final contre les seuils du cahier (`../lib/verdict.ts`) : code de sortie 1 si un seuil est
   depasse, si moins de 200 mesures ont ete faites, ou si une requete HTTP repond 4xx/5xx inattendu.

Options : `--iterations N` (200), `--echauffement N` (20), `--froid N` (8 processus neufs), `--graine N`,
`--nom essai_xxx`, `--garder` (ne supprime pas le clone), `--sortie fichier.json`,
`--sans-correctifs` (**contre-epreuve** : saute les migrations ; le banc doit alors echouer si un seuil est
depasse dans l'etat d'origine), `--sans-avant` (mise au point : saute la phase d'origine).

`--familles recherche,deviation` ne mesure que ces familles (`rattachement`, `recherche`, `trace`, `graphe`, `deviation`,
`carte`) : mise au point seulement, le verdict ne vaut alors que pour elles.

**Le banc peut echouer dans l'etat livre.** Sur 261 387 troncons, `recherche.mot-de-nom.http` a un p95 de 162 ms a une execution et
de 427 ms a une autre : le banc a donc passe (45 sur 45) puis echoue (44 sur 45). Ce n'est pas un defaut du banc, c'est la mesure
(voir le document de mesures, section 6). A 20 000 troncons, l'etat d'origine passe tout : un seuil ne se depasse qu'au volume du registre.

Avec moins de 200 iterations le banc echoue par construction (`n >= 200` est une condition du verdict) :
c'est voulu, un p95 sur 20 mesures n'est pas un p95.

## Les empreintes attendues du jeu

Deux executions avec la meme graine doivent afficher la meme empreinte (testee par
`lib/reseau-synthetique.test.ts`, lancee par `npm test`) :

| `--nombre` | troncons classes | voirie | empreinte SHA-256 |
|---|---|---|---|
| 20 000 | 1 772 | 18 228 | `4599f9ca01c01b4a232271244f710363494e304ac1bab711a1847bd036cb20d2` |
| 261 387 | 1 772 | 259 615 | `d957405a6dd5adeb452b506b7b51d7623f53cb0facaa27074adff5e2caa8a945` |

## Explorer a la main

```bash
npx tsx tests-integration/perf/preparer.ts --nombre 261387      # cree et charge essai_perf, le garde
docker exec -i bdri-dev-db psql -U bdri_dev -d essai_perf        # EXPLAIN ANALYZE, etc.
npx tsx tests-integration/perf/preparer.ts --supprimer           # le supprime
```

## Mesurer le rendu sous reseau limite (A20, « rendu < 3 s en 3G »)

`serveur-3g.ts` sert le frontend compile (`frontend/dist`, gzip comme `nginx.conf`) et l'API (branchee sur le
clone) derriere un limiteur de debit et de latence applicatif, sur une seule origine. On y ouvre `/carte` dans un
navigateur et on relit les temps (`performance.now()`, `/__journal`). Voir le document de mesures pour ce que ce
limiteur n'est pas.

```bash
(cd ../frontend && npm run build)
DATABASE_URL=postgresql://utilisateur:motdepasse@127.0.0.1:5434/essai_perf \
  npx tsx tests-integration/perf/serveur-3g.ts --kbps 1600 --rtt 150
```

## Ce que ce banc ne garantit pas

Voir la section « Limites » du document de mesures : jeu synthetique, machine locale partagee et chargee,
base `replay` sans les donnees ni les statistiques de production, une seule charge a la fois, pas de TLS ni
de proxy, pas de rendu navigateur dans le banc lui-meme.

## Fichiers

| Fichier | Role |
|---|---|
| `perf.integration.ts` | orchestration, verdict, sortie JSON |
| `preparer.ts` | cree/charge/supprime le clone sans mesurer |
| `serveur-3g.ts` | serveur de mesure du rendu sous reseau limite |
| `lib/reseau-synthetique.ts` | generateur deterministe du reseau (+ `.test.ts`) |
| `lib/points-gps.ts` | points GPS bruites avec verite terrain |
| `lib/charger.ts`, `lib/preparation.ts` | chargement dans le clone |
| `lib/mesures.ts` | les scenarios |
| `lib/plans.ts` | plans `EXPLAIN ANALYZE` |
| `lib/stats.ts` | percentiles par rang le plus proche (+ `.test.ts`) |
| `lib/serveur.ts` | serveur HTTP local et client mesurant |
