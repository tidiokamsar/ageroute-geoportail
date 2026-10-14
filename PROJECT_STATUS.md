# État du projet

> Fichier canonique exigé par le § A.9 du prompt maître V10. **À lire en premier à chaque
> session**, avec [BLOCKERS.md](BLOCKERS.md) et [DECISIONS_PENDING.md](DECISIONS_PENDING.md),
> puis reprendre à la « prochaine action ».
>
> Le § A.9 interdit de refaire un audit déjà consigné : **le mettre à jour**.

**Vérifié le 14/10/2026.** Branche de travail : `lot/03-map-matching`. Toute mesure porte sa
date et sa méthode ; ce qui n'est pas vérifié est dit comme tel (§ A.5.7).

---

## 1. Production

| Élément | État vérifié |
|---|---|
| Domaine | `carte.ageroute.gov.gn`, HTTP **200** |
| Dernier déploiement | **14/10/2026 à 14:23**, images construites à 14:17 |
| Migrations | **50 appliquées**, « Database schema is up to date! » |
| Santé | `/api/health` 200, base 5 ms, stockage 2 ms, `echecsDepuisDemarrage` **0** |
| Journal backend | **0 erreur** depuis le redémarrage |
| API publique | `/api/public/carte/geo` sert 785 Ko en 0,36 s |
| PWA | `/sw.js` 200 |

**Depuis le 14/10 à 14:23, aucune opération de production** autre que la désapprobation de la
règle RCI à 16:19, explicitement autorisée. Le § A.5.1 l'exige.

---

## 2. Ce que la base contient, et le constat qui domine tout

| Table | Lignes |
|---|---|
| `troncons` | 261 387, dont **1 691 au réseau classé** (21 156,6 km) |
| `valeurs_qualite` | 1 820 694 |
| `ouvrages` | 1 172 |
| `chantiers` | 496 — **module gelé** (§ A.3) |
| `refresh_tokens` | 799 |
| `catalogue_defauts` | 13 |
| `baremes_intervention` | 9, **aucun approuvé** |
| `matrices_degradation` | 9, **lues par aucun code** |
| `referentiel_revetements` / `_etats_chaussee` | 8 / 5 |
| `regles_condition` | 1, **désapprouvée le 14/10 à 16:19** |
| `missions`, `observations`, `defauts`, `portions`, `evaluations_condition` | **0** |
| `referentiel_praticabilites` | **0** — décision institutionnelle attendue |

**Toute la chaîne de collecte est écrite, testée, déployée — et vide.** C'est le constat
central, et il n'est pas technique.

Sur les 1 691 tronçons du réseau classé, **649 portent un état déclaré** et **un seul** un état
réellement observé (`RES-857`). `troncons.dateDerniereEvaluation` est **nulle sur les 261 387
lignes**. Aucune mesure de déflexion, aucune mesure d'IRI.

**Aucun développement supplémentaire ne produira d'indicateur tant qu'aucune donnée de terrain
n'entre.**

### Le réseau, contre les chiffres officiels

Mesuré contre les chiffres que le § A.2 cite (TDR de la BDR nationale, 2020) :

| Classe officielle | Officiel | Mesuré | Écart |
|---|---|---|---|
| Nationales | 7 576 km | **7 824,4 km** | **+3,3 %** |
| Préfectorales | 15 879 km | 13 295,6 km (classe `RR`) | −16,3 % |
| **Communautaires** | 19 846 km | **valeur inexistante dans l'énumération** | — |
| Voiries urbaines | ≈ 2 000 km | **36,6 km** | −98 % |
| Total | ≈ 45 300 km | 21 156,6 km | **48 %** |

Le réseau national est essentiellement complet. Les communautaires n'ont **aucune valeur
d'énumération** pour exister, et les voiries urbaines sont quasi absentes. Voir D-06 dans
[DECISIONS_PENDING.md](DECISIONS_PENDING.md).

---

## 3. Tests

| Suite | Résultat, 14/10/2026 |
|---|---|
| Backend `npx vitest run` | **1 145 passés**, 0 échec |
| Frontend `npx vitest run` | **294 passés**, 0 échec |
| `tsc --noEmit`, les deux paquets | aucune erreur |

Détail, et **ce qui n'est pas testé**, dans [TEST_EVIDENCE.md](TEST_EVIDENCE.md).

---

## 4. Fait depuis l'arrivée du mandat V10

| # | Travail | Preuve |
|---|---|---|
| § A.7 | **Sécurité P0 vérifiée** : aucun secret ni IP de production jamais committé sur 225 commits. Le dépôt est bien public, mais rien n'a fuité — **aucune rotation nécessaire** | [SECURITY_REMEDIATION.md](SECURITY_REMEDIATION.md) |
| § A.9 | Huit **fichiers de suivi canoniques** à la racine, renommés depuis les miens pour ne pas créer de concurrents | historique Git préservé |
| § 15 | **ADR-009** : Capacitor figé, ADR-002 (React Native) remplacée, avec ce que mon analyse avait juste et faux | [TECHNICAL_DECISIONS.md](TECHNICAL_DECISIONS.md) |
| § A.6.1 | **`rci-2026.1` désapprouvée** par un geste audité, et `RCI_METHOD_DECISION.md` écrit | [RCI_METHOD_DECISION.md](RCI_METHOD_DECISION.md) |
| § A.8 | **Migrations réconciliées** : 51 locales, 50 appliquées, 1 en attente. L'état de référence du § A.4 était périmé de neuf migrations | [MIGRATION_PLAN.md](MIGRATION_PLAN.md) |
| § K.4 | **Mandat V10 lu en entier**, parties A à K. Les critères d'acceptation vont à **A30**, non A24 | — |
| § A.9 | **Matrice de conformité refaite** contre les trente scénarios : 9 terminés et testés, 3 tests partiels, 3 partiels, 3 non testés, 4 bloqués, 8 absents. **Aucune case « à vérifier »** | [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md) |
| § D | **Quinze ADR** des arbitrages D1–D15, dont deux corrigent mes décisions antérieures : D14 amende ADR-006, D6 referme l'écart É-4 du RCI | [TECHNICAL_DECISIONS.md](TECHNICAL_DECISIONS.md) |
| § 7.17 | **Praticabilité : une proposition existait et je la déclarais absente.** Le mandat propose lui-même P1 à P4 ; la fiche D-02 la porte désormais, avec les quatre manques qui subsistent | [DECISIONS_PENDING.md](DECISIONS_PENDING.md) |
| § D4 | **Nouvelle décision en attente D-09** : l'arbitrage D4 impose « aucun second annuaire » alors que la table `utilisateurs` en est un. Aucun OIDC n'existe — vérifié | [DECISIONS_PENDING.md](DECISIONS_PENDING.md) |
| § 7.3.7 | **Map-matching de trace HMM** écrit et mesuré : critère **A18 à 130 points justes sur 130**, exigé ≥ 97 %, 8 sorties du référentiel détectées sur 8, 7 200 points sans débordement | `geo/appariement.trace.ts`, 25 tests |
| § A.8 | **Rollback exécuté et vérifié** : B-13 levé, base PostGIS 17-3.5 isolée, aller-retour 20 objets → 0 → 20, états identiques. **La porte de la phase 0 est franchie** | [MIGRATION_PLAN.md](MIGRATION_PLAN.md) § 3 |
| § A.8 | **Et le rejoue a révélé B-16** : la chaîne de migrations ne reconstruit pas la base, 49 sur 51. La reprise après sinistre repose sur `pg_dump` seul | [MIGRATION_PLAN.md](MIGRATION_PLAN.md) § 3 bis, arbitrage D-10 |

---

## 5. Fait avant le mandat V10, et qui tient

Chaîne de collecte complète et déployée : appariement GPS avec confiance et refus sous seuil,
contexte terrain en une requête, portions homogènes (créer, scinder, fusionner, requalifier,
lignage, contrainte d'exclusion `btree_gist`), écran de terrain, écran de validation,
idempotence hors ligne, moteur de qualité à 9 familles, PWA renforcée, 13 types de défauts,
4 familles d'actifs linéaires, fiche 360°.

Et trois travaux des lots 1 à 3 :

- **Bogue des PK corrigé** — il existait en deux exemplaires et rendait `PK 1+1000` pour
  1,9999 km. Unifié dans `lib/pk.ts`, 12 tests.
- **Historisation bitemporelle** — `reseau/bitemporel.ts`, 32 tests, les deux axes de temps
  répondant différemment à la même date de terrain.
- **Noyau d'appariement partageable** — `geo/appariement.noyau.ts`, sans aucun import, avec les
  deux facteurs manquants du § 7.3.3 (cap, continuité) et les trois issues du § 7.3.4. Critère
  **A2 mesuré sur 23 cas annotés : 100 %**, exigé ≥ 95 %, et **0 rattachement automatique sous
  le seuil**.

Le § 15 ayant figé Capacitor, ce noyau devient plus utile encore : c'est le même JavaScript qui
tournera dans la coque.

---

## 6. Restant, par lot du § F.2

| Lot | État |
|---|---|
| Audit, conformité, architecture | **fait**, tenu à jour |
| Socle, SRID, CI | **fait** |
| Référentiel linéaire | historisation **faite** ; codification, pgRouting, gazetier **bloqués** par D-06 |
| Map-matching | ponctuel et scoring **faits** ; **trace HMM absente** (critère A18) |
| Dégradations, métrés, ouvrages | faits ; **fiche d'inspection d'ouvrage T-04 absente** |
| Validation, audit, qualité | **faits** |
| Mobile et écran de roulage | **Capacitor figé, non commencé** ; plugins Kotlin à écrire |
| Hors ligne, packs, roulage complet | sync faite ; **packs, IRI, photo continue absents** |
| Indices, prévision, programmation | RCI écrit mais **désapprouvé** ; **risque, traitement, coût, programmation absents** — barèmes et matrices présents, lus par aucun code |
| Tableau de bord, Control Tower, Géoportail d'excellence | partiels |
| Écosystème ONR / BDR / ANASUR (partie B) | **non commencé** — les 15 livrables du § B.6 restent à produire ; formats L²R non publiés |
| Exploitation et information routière (§ 7.17) | **non commencé** — main courante, patrouilles, P1–P4, cellule de veille, Info Route |
| Observation de la Terre (partie E) | **non commencé** — palier 0 gratuit, aucune dépense requise |
| Tâches internes et rapprochement (TI-01 à TI-03) | **non commencé** — entré au périmètre par l'arbitrage D1 |
| Intégrations DigitalRoad, SharePoint | **bloquées, aucun accès** |
| Durcissement, observabilité | partiel |

---

## 7. Prochaine action

**La porte de la phase 0 est franchie.** Les quatre preuves du § F.1 sont acquises : sécurité
prouvée, matrice sans case « à vérifier », décisions consignées, et **rollback exécuté et
vérifié** le 14/10 — B-13 levé en démarrant Docker et en montant une base PostGIS 17-3.5
isolée, la même image que la production.

**Mais franchir la porte a révélé un risque plus grave que celui qu'elle gardait.** La chaîne de
migrations **ne reconstruit pas la base** : 49 des 51 se rejouent sur une base vierge, un défaut
de type `uuid` contre `text` masqué depuis juillet par un `CREATE TABLE IF NOT EXISTS`. Aucun
environnement neuf ne peut être monté par `migrate deploy`, et la reprise après sinistre repose
donc entièrement sur `pg_dump`. C'est **B-16**, et l'arbitrage est **D-10**.

**Ensuite**, par ordre de valeur et sans dépendre d'une décision institutionnelle :

1. ~~Map-matching de trace HMM~~ — **fait le 14/10** : `geo/appariement.trace.ts`, 25 tests,
   critère **A18 mesuré à 130/130** sur 4 traces annotées. Reste le graphe de réseau, sans lequel
   le HMM retombe sur la distance seule entre tronçons différents.
2. **Vue dérivée des sections fixes** (IO-03/IO-04) — l'arbitrage D6 en fait le format d'échange
   avec la BDR nationale, donc le prérequis du critère A23. Aucune table à créer : une vue
   paramétrable par le pas.
3. **Benchmark cartographique sur les 261 387 tronçons** — l'arbitrage D3 en fait une « porte de
   décision ». Tant qu'il n'existe pas, « Leaflet suffit » est une hypothèse.
4. **TI-01, tâches internes** — entré au périmètre par D1, ne dépend d'aucune décision en
   attente, et débloque le critère A29.

Le constat du § 2 continue de dominer : rien de tout cela ne produira d'indicateur tant qu'aucune
donnée de terrain n'entre.
