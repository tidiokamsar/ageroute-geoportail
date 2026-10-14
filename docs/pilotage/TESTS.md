# Tests exécutés

> Exigé par le § 4 du mandat v2.1. Le § 2.7 impose que toute affirmation de réussite cite la
> commande lancée et son résultat. Aucune ligne de ce fichier n'est écrite sans l'avoir vue.

## 14/10/2026 — lot 0, après la correction du § 7.1 (ADR-005)

| Commande | Résultat |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` (backend) | aucune erreur |
| `npx vitest run` (backend) | **1 067 passés**, 77 fichiers, 0 échec, 22,3 s |
| `npx vitest run` (frontend) | **282 passés**, 22 fichiers, 0 échec |

Total : **1 349 tests**.

## 14/10/2026 — vérifications en base, avant le gel de production (ADR-001)

Ces mesures ne seront plus reproductibles : le § 2.1 coupe l'accès à la production.

| Vérification | Commande | Résultat |
|---|---|---|
| Migrations | `prisma migrate status` | 50 trouvées, « Database schema is up to date! » |
| Fusion des recouvrements de portions | SQL sur 8 cas littéraux, attendus calculés à la main | **8 OK** : disjoints 300 m, chevauchants 250 m, jointifs à 3 cm 200 m, séparés de 1 m 200 m, imbriqués 300 m, débordant borné 500 m, négatif borné 100 m, vide 0 |
| Couverture du réseau classé | SQL, `\timing on` | 1 691 tronçons, 21 156,6 km, **212 ms** |
| Couverture du registre complet | idem | 261 387 tronçons, 185 264,4 km, **3 286 ms** |
| Détecteur hors territoire, ancienne forme | `EXPLAIN (ANALYZE)` | **58 243 ms** |
| Détecteur hors territoire, forme déployée | `\timing on` | **14 229 ms**, même verdict (6 573 / 261 387) |
| Écart entre les deux formes | SQL comparatif | **1 tronçon** : `GNL-OSM-w321375684`, sentier de 55,8 m, 0 degré en planaire contre 3,247 m en géodésique |
| Santé après déploiement | `curl /api/health` | `status: ok`, base 8 ms, stockage 5 ms, `echecsDepuisDemarrage: 0` |
| Erreurs au journal backend | `docker logs … | grep -icE "error|unhandled"` | **0** |

## Ce qui n'est pas testé, et doit l'être

| Exigence | Manque |
|---|---|
| A2 identification du tronçon à ≥ 95 % | **aucun jeu de points GPS annotés** (B-26) |
| A5 métré, écart < 1 % | aucune géométrie de test de référence |
| A7 hors ligne, 50 observations sans doublon | testé unitairement, jamais sur un appareil |
| A10 sécurité, 403 par appel direct | partiellement : les gardes de rôle sont testées, pas l'ABAC par zone |
| A15 performance, rattachement < 300 ms p95 | **jamais mesuré** |
| A16 à A19 roulage | sans objet : les fonctions n'existent pas |
| A18 trace HMM à ≥ 97 % | sans objet |
| A20 Géoportail, premier rendu < 3 s en 3G | **jamais mesuré** |
| Montée **et descente** des migrations (§ 9.4) | les migrations n'ont été éprouvées qu'en montée |
