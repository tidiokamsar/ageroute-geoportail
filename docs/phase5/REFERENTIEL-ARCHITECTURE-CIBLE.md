# Architecture du futur référentiel — ROAD_OBJECT

**Ticket** : P5-09
**Date** : 2 septembre 2026
**Fonde sur** : `BDRI-REFERENTIEL-NATIONAL.md` §5/§7 (statut par champ, validation
passage obligé, patrimoine séparé de l'attribution) — ce document les prolonge
sans les remplacer, et répond aux deux questions du cadrage :

> « Quelle était la situation de cette route à une date donnée ? »
> « Quelle source justifie cette information ? »

**Sans coder le changement maintenant** : c'est une architecture cible, arrimée
aux migrations Prisma versionnées le moment venu.

---

## 1. L'objet central

```text
ROAD_OBJECT  (l'objet patrimonial : un tronçon de route, un ouvrage, un poste)
    │
    ├── identity            id patrimonial stable (UUID technique + futur code
    │                       national attribué par AGEROUTE)
    ├── geometry            versions datées, sourcées (jamais réécrites en place)
    ├── administrative_reference
    │                       région/préfecture/commune par validité temporelle
    │                       (cf. REFERENTIEL-ADMINISTRATIF-SPEC.md)
    ├── business_attributes état, revêtement, trafic, criticité, coût
    │                       → Observations datées + statut par champ
    ├── provenance          source, méthode, date, auteur — par information
    ├── observations        tout constat (inspection, signalement, mesure)
    ├── quality_status      par champ : NON_RENSEIGNE / IMPORTE / CALCULE /
    │                       CONTROLE / VALIDE / OBSOLETE (matrice P5-07)
    └── temporal_versions   chaque couche ci-dessus est versionnée :
                            ValidFrom / ValidTo, jamais de mise à jour en place
                            d'un fait historique
```

---

## 2. Les deux questions, traduites en mécanique

### « Quelle était la situation de cette route à une date D ? »

Une requête sur les versions actives à D :

```sql
-- chaque couche répond par sa version valide à D
geometry            WHERE :D >= ValidFrom AND (:D < ValidTo OR ValidTo IS NULL)
observations        WHERE constate_le <= :D
attributions        WHERE ValidFrom <= :D AND (ValidTo IS NULL OR :D < ValidTo)
administratif       WHERE ValidFrom <= :D AND (ValidTo IS NULL OR :D < ValidTo)
```

C'est la **clôture** d'une version qui crée l'historique, jamais l'effacement :
une correction clôt l'ancien fait et en ouvre un neuf. C'est déjà la règle
retenue pour `ValeurQualite` en Phase 4 — l'architecture la généralise à la
géométrie et à l'administratif.

### « Quelle source justifie cette information ? »

Le triplet (source, méthode, date, auteur) est **obligatoire à l'écriture**,
porté par la table de provenance de Phase 4 (`sourceType`, `sourceReference`,
`sourceConfiance`, `sourceDetectedAt`) et étendu à chaque observation. Une donnée
sans triplet entre comme `IMPORTE` non vérifié — et l'interface doit le montrer
(P5-07).

---

## 3. Du schéma actuel vers la cible — quoi devient quoi

| Aujourd'hui | Devient | Migration |
|---|---|---|
| `troncons.geom` | `GeometryVersion` (versionnée, sourcée) | copie 1-pour-1 avec `ValidFrom = date d'import`, aucun changement de valeur |
| `troncons.etat`, `revetement`… | `Observation` typée + statut par champ | reprise des valeurs existantes comme observations « import » à la date d'import |
| `ValeurQualite` (Phase 4) | intégré tel quel — c'est déjà le bon mécanisme | aucune |
| `troncons.prefecture/commune` | référentiel administratif versionné | géré par P5-05 |
| `PropositionLocalisation` | conservé : décision humaine datée et auditée | aucune |
| codes d'import (`RES-*`, `GN N*`, `*-OSM-*`) | `sourceReference` à côté de l'identité — plus jamais l'identité | backfill Phase 4 prêt (`backfill:provenance`) |

Deux prérequis non techniques, hérités des phases précédentes :

1. le **périmètre** des classes RN/RR/RU doit être arbitré (P5-04) avant d'en
   faire un référentiel opposable ;
2. l'**identifiant patrimonial national** doit être décidé par AGEROUTE
   (`BDRI-REFERENTIEL-NATIONAL.md` §4).

---

## 4. Ce que cette architecture interdit, par construction

- réécrire une géométrie en place (perte de l'historique des tracés) ;
- une valeur sans source ni date ;
- une suppression physique d'un fait patrimonial (règle 2 d'AGENTS.md, étendue
  du patrimoine aux observations) ;
- un score global de qualité (règle P5-08 : les dimensions restent séparées).

---

## 5. Ordre de mise en œuvre proposé (décision, pas Phase 5)

| Rang | Chantier | Prérequis |
|---|---|---|
| 1 | Généraliser `ValeurQualite` aux six champs de décision (déjà spécifié Phase 4) | aucun |
| 2 | `GeometryVersion` — versionner les géométries | migration Prisma, copie 1-pour-1 |
| 3 | Référentiel administratif versionné | source officielle (P5-05) |
| 4 | Identifiant patrimonial national | décision AGEROUTE |
| 5 | Topologie (nœuds/arcs) une fois les classes périmétrées | P5-04 + P5-11 |

**Statut** : la correspondance actuel→cible est MESURÉE sur le schéma existant ;
l'architecture est une PROPOSITION ; les rangs 3-5 sont REQUIRES_BUSINESS_VALIDATION.
