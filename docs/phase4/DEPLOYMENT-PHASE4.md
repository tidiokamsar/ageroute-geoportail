# Plan de déploiement — Phase 4

**Branche** : `phase4`
**État** : **PRÊTE POUR VALIDATION — NON DÉPLOYÉE**
**Règle** : aucune mise en production sans validation explicite.

---

## 1. Ce qui est déployé aujourd'hui, et ce qui ne l'est pas

| | En production | Sur `phase4` |
|---|---|---|
| Correctifs des phases 1 à 3 | oui | oui |
| Sonde d'état, sauvegardes, compression, index spatial | oui | oui |
| Migration `inspection_coordonnees` (`lat`, `lon`, `precisionM`) | **non** | oui |
| Cinq migrations Phase 4 | **non** | oui |
| Code des dix tickets | **non** | oui |

La migration `inspection_coordonnees`, écrite en phase 3, n'a jamais été déployée.
Elle part avec cette phase.

---

## 2. Liste exacte des changements

### Migrations — six, dans l'ordre

| Migration | Ce qu'elle ajoute | Rollback |
|---|---|---|
| `20260901220000_inspection_coordonnees` | `lat`, `lon`, `precisionM` sur `inspections` | `DROP COLUMN` × 3 |
| `20260902100000_troncon_provenance` | 4 colonnes sur `troncons`, enums `SourceType`, `NiveauConfiance` | `DROP COLUMN` × 4, `DROP TYPE` × 2 |
| `20260902110000_valeurs_qualite` | table `valeurs_qualite`, enum `StatutValeur` | `DROP TABLE`, `DROP TYPE` |
| `20260902120000_chantier_localisation` | `statutLocalisation` sur `chantiers`, table `propositions_localisation`, 2 enums | `DROP TABLE`, `DROP COLUMN`, `DROP TYPE` × 2 |
| `20260902130000_inspection_idempotence` | `clientInspectionId` unique sur `inspections` | `DROP INDEX`, `DROP COLUMN` |
| `20260902140000_poste_recuperation` | 3 colonnes sur `postes`, enum, index d'unicité insensible aux accents | `DROP INDEX`, `DROP COLUMN` × 3, `DROP TYPE` |

**Aucune migration n'écrit une valeur.** Toutes sont idempotentes (`IF NOT EXISTS`,
`EXCEPTION WHEN duplicate_object`).

**Éprouvées sur la structure de production restaurée** par
`infra/tester-migrations-phase4.sh` : 16 objets créés, 1 690 tronçons / 488 chantiers /
126 ouvrages inchangés, géométries et SRID intacts, rejouables, et rollback vérifié —
310 colonnes avant, 310 après.

### Code backend

| Fichier | Ticket | Nature |
|---|---|---|
| `lib/reseau.ts` | T1 | longueur saisie / calculée |
| `lib/provenance.ts`, `scripts/backfill-provenance.ts` | T2 | déduction et remplissage |
| `lib/qualite.ts`, `modules/qualite/`, `scripts/backfill-qualite.ts` | T3, T4 | statut par champ, API |
| `lib/extraction-pk.ts`, `modules/chantiers/propositions.routes.ts`, `scripts/generer-propositions-localisation.ts` | T5 | propositions |
| `lib/localisation.ts`, `scripts/reclasser-localisation.ts`, `chantiers.service.ts` | T6 | niveau de localisation, carte |
| `modules/inspections/` | T7 | idempotence, date de constat, valeur `OBSERVED` |
| `lib/priorisation.ts`, `marches.routes.ts`, `dashboard.routes.ts` | T8 | score transparent |
| `lib/dedoublonnage.ts`, `scripts/recuperer-postes-audit.ts` | T9 | récupération |
| `tsconfig.scripts.json` | — | typecheck des scripts, qui n'existait pas |

### Code frontend

| Fichier | Ticket |
|---|---|
| `components/LongueurReseauCard.tsx`, `DashboardPage.tsx`, `GeoportailPage.tsx` | T1 |
| `components/QualiteBadge.tsx`, `TronconFicheModal.tsx` | T3, T4 |
| `lib/offlineSync.ts` | T7 |
| `pages/DecisionPage.tsx` | T8 |

### Scripts d'exploitation — à lancer après les migrations, à blanc d'abord

```
npm run backfill:provenance          # 1 689 tronçons
npm run backfill:qualite             # 10 140 lignes de qualité
npm run reclasser:localisation       # 488 chantiers
npm run propositions:generer         # 33 propositions
npm run recuperer:postes             # 6 sites
```

Chacun est idempotent et n'écrit rien sans `--apply`.

---

## 3. Procédure

```
 1. Sauvegarde                 bash ~/bdri-infra/backup/sauvegarde-bdri.sh
 2. Vérification restauration  bash ~/bdri-infra/backup/verifier-restauration-bdri.sh
 3. Test des migrations        bash ~/bdri-infra/tester-migrations-phase4.sh
 4. Vérification avant livraison   bash infra/verification-avant-livraison.sh
 5. Construction de l'image    docker compose build
 6. Migrations                 npx prisma migrate deploy   (dans le conteneur backend)
 7. Vérification des colonnes  \d inspections ; \d troncons ; \d chantiers ; \d postes
 8. Redémarrage                docker compose up -d
 9. Sonde                      curl -s https://carte.ageroute.gov.gn/api/health
10. Scripts, à blanc           npm run backfill:provenance   (puis chacun)
11. Scripts, écriture          ... -- --apply
12. Audit de non-régression    §5 ci-dessous
```

Les étapes 1 à 4 conditionnent tout : **si l'une échoue, on s'arrête.**

---

## 4. Rollback

### Rollback du code

Revenir à l'image précédente : `docker compose up -d` sur le tag précédent. Les
colonnes ajoutées sont toutes nullables ou avec défaut — l'ancien code les ignore sans
erreur.

### Rollback des migrations

Exécuter, dans cet ordre, le SQL de la section 6 de `tester-migrations-phase4.sh` :
tables, colonnes, puis types. Vérifié sur la structure restaurée : la base revient à
310 colonnes, données intactes.

Les lignes écrites par les scripts d'exploitation disparaissent avec les tables et
colonnes qui les portent. **Aucune donnée métier n'ayant été modifiée, aucune n'est à
restaurer.**

### Rollback complet

Restaurer la sauvegarde de l'étape 1. Procédure dans `docs/audit-2026/RESTAURATION-BDRI.md`.

---

## 5. Audit de non-régression avant déploiement

### Sécurité
- [ ] `/api/search` — filtre par module avant la requête
- [ ] `/api/audit` — se ferme sur une entité inconnue
- [ ] `/api/marches` — 23 gardes de module
- [ ] `/api/qualite` — droit de l'entité via `MODULE_PAR_ENTITE`
- [ ] `/api/propositions-localisation` — validation refusée à LECTEUR
- [ ] uploads — volume persistant présent
- [ ] journal d'audit — validation de proposition tracée

### Données
- [ ] 1 690 tronçons, 488 chantiers, 126 ouvrages — inchangés
- [ ] `valeurs_qualite` — 10 140 lignes après backfill, 0 `OBSERVED`
- [ ] `troncons.sourceType` — 1 689 renseignés, 1 `INCONNUE`
- [ ] `chantiers.statutLocalisation` — 6 / 0 / 432 / 50

### Géométrie
- [ ] 1 690 géométries valides, SRID 4326
- [ ] index `(geom::geography)` présent
- [ ] `chantiers.geom` — toujours 6, aucune écrite par script

### Fonctionnel
- [ ] carte publique — 438 chantiers, aucun à Conakry par défaut
- [ ] tableau de bord — deux longueurs, « Réseau total » absent
- [ ] fiche tronçon — badges de qualité
- [ ] page Décision — « Non calculable » sur les critères absents
- [ ] inspection — 200 sur un `clientInspectionId` déjà connu

---

## 6. Tests

| | Avant Phase 4 | Après |
|---|---:|---:|
| Backend | 45 | **165** |
| Frontend | 30 | **50** |
| Typecheck des scripts | inexistant | `tsconfig.scripts.json` |

Tous verts au moment de la remise. Aucun test supprimé.

---

## 7. Ce qui n'est PAS dans ce déploiement

- Aucune valeur métier modifiée : ni longueur, ni revêtement, ni état, ni géométrie.
- Aucune géométrie de chantier posée automatiquement.
- Aucune valeur de trafic ni de recette restaurée.
- Aucun moteur de routage.
- Aucune jonction topologique créée.
- Aucun test sur appareil réel.

---

## 8. Relevé au passage, non corrigé, à trancher séparément

Les routes de **lecture** de `chantiers`, `troncons` et `ouvrages` ne portent pas
`requireModuleAccess` — seules les écritures sont gardées. `marches`, corrigé en
phase 3, en porte 23.

Ce n'est pas une fuite : les six comptes de production ont zéro module restreint,
donc rien n'est filtré pour personne. Le jour où une restriction serait posée, ces
lectures l'ignoreraient. À corriger avec des tests, pas glissé dans cette phase.

Trois scripts d'import importent `xlsx`, paquet retiré du projet pour cause de CVE.
Ils échoueraient à l'exécution. Exclus du typecheck et documentés, non réparés.
