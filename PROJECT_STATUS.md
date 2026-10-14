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
| Écosystème ONR / BDR / ANASUR (partie B) | **non commencé** — parties B à H du mandat non encore lues en détail |
| Intégrations DigitalRoad, SharePoint | **bloquées, aucun accès** |
| Durcissement, observabilité | partiel |

---

## 7. Prochaine action

**Lire les parties B à H du prompt maître V10** — écosystème national ONR/BDR/L²R/ANASUR
Collect, arbitrages « juste milieu » D1–D15, observation de la Terre, catalogue des
fonctionnalités — et en tirer la mise à jour de
[REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md) avec des statuts prouvés, comme le
§ K.4 l'exige.

Je n'ai lu à ce stade que les parties A, I, J et K. Les parties B à H portent une part
substantielle du périmètre — notamment les livrables de l'écosystème national du § B.6 et les
quinze arbitrages du § D — et il serait malhonnête de présenter la matrice de conformité comme
à jour sans les avoir lues.

**Ensuite**, par ordre de valeur et sans dépendre d'une décision : le **map-matching de trace
HMM** (§ 7.3.7), qui conditionne le critère A18 et que le § 15 fige comme bibliothèque
TypeScript partagée.
