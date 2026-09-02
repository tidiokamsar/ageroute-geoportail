# Rapport P2 — Robustesse applicative

**Branche** : `phase5` · **Suite de** : P1 Sécurité/Intégrité (`97f7ecb`)
**Périmètre** : risques résiduels §J du rapport P1 + dettes backend de la revue initiale. Indépendant des décisions D1–D8. Aucune migration nécessaire (aucun changement de schéma).
**Production** : NON TOUCHÉE.

---

## Corrections effectuées

### P2-01 — Une entité archivée n'est plus modifiable (`crud-factory.update`)

`update()` utilisait `findUnique` (trouve l'archivé) quand `getById()` filtrait
`deletedAt`. Depuis P1, décomptes et photos d'OT figuraient leurs retraits ;
le factory lui-même laissait passer la modification d'une entité archivée par
identifiant. Désormais : `findFirst({ id, deletedAt: null })` → 404, cohérent
avec le reste du pattern. **La donnée retirée est une donnée figée.**
*Tests : update sur archivé → 404 sans écriture ni audit ; update sur actif → ok + audit.*

### P2-02 — Tri contrôlé : plus de 500 sur un `sortBy` inconnu

- `list-query.ts` : `sortBy` doit être un identifiant (`^[a-zA-Z_][a-zA-Z0-9_]{0,63}$`) —
  injection et formats exotiques rejetés en **400 ZodError** ;
- `error.middleware.ts` : `PrismaClientValidationError` (colonne inexistante mais
  bien formée) mappé en **400** « Paramètre de requête invalide » au lieu du 500
  générique.
*Tests : identifiants valides/injections/longueur ; mapping 400/409/500 sans fuite de détail.*

### P2-03 — L'échec d'audit n'est plus silencieux

`logAudit` ne fait toujours pas échouer la requête métier (règle d'origine), mais
chaque échec est désormais loggé **avec son contexte** (action, entité,
identifiant, acteur, raison) et incrémente un compteur exposé dans
`GET /api/health` → `checks.audit.echecsDepuisDemarrage`. Un compteur qui monte
signale des écritures métier passées sans trace — c'est le signal qui manquait.
*Tests : succès → 0 ; échec → la promesse tient et le compteur monte ; cumul.*

### P2-04 — Conversion OT → chantier transactionnelle

`convertirChantier` créait le chantier puis mettait à jour l'OT **hors
transaction** : un échec de la bascule laissait un chantier orphelin et un OT
encore actif — exactement l'état que la conversion devait éviter. Les deux
écritures passent maintenant dans une `$transaction` interactive.
*Tests : les deux écritures dans la même transaction ; échec de bascule → erreur remontée ; gardes (OT clos / sans région) avant toute écriture.*

### P2-05 — Spécification de rétention des fichiers (document)

`P2-RETENTION-FICHIERS-SPEC.md` : états des lieux (aucun fichier n'est jamais
purgé), proposition à trois statuts (référencé / orphelin / jamais cité),
double verrou mesure→`--apply`, décisions R1–R4 attendues. **Aucune purge codée.**

---

## Vérifications

- Build `tsc` : **vert** ; tests : **217/217** (28 fichiers — 15 nouveaux P2, aucune régression P1/P0).
- Aucune migration (aucun changement de schéma) — rien à tester sur copie de production.
- CI déclenchée au push (backend + frontend).

## Risques résiduels restants (hors périmètre P2)

1. Refresh tokens : rotation sans détection de réutilisation ni hash en base —
   chantier P3 (schéma + migration).
2. Consolidation frontend (EntityListPage inutilisé, garde anti-perte de saisie,
   feedback quick-edits) — bloquée localement par l'environnement (node_modules
   verrouillé) ; à traiter avec CI comme seul vérificateur, en session dédiée.
3. Rétention fichiers : décisions R1–R4 (cf. P2-05).

## Tableau de sortie

| Élément | État |
|---|---|
| Entités archivées figées | **PRÊT** (P2-01) |
| Tri / erreurs de requête | **PRÊT** (P2-02 — 400 propres) |
| Échecs d'audit visibles | **PRÊT** (P2-03 — compteur dans /api/health) |
| Conversion OT transactionnelle | **PRÊT** (P2-04) |
| Rétention fichiers | **SPÉCIFIÉE** — décision R1–R4 attendue |
| Tests | **217/217** (15 nouveaux) |
| Migrations | **0 nécessaire** |
| Production | **NON TOUCHÉE** |

> **P2 ROBUSTESSE PRÊT POUR VALIDATION — PRODUCTION NON TOUCHÉE**
