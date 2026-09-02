# Spécification du référentiel administratif BDRI

**Ticket** : P5-05
**Date** : 2 septembre 2026
**Conclusion en une ligne** : aucun référentiel administratif exploitable n'existe aujourd'hui dans le périmètre du projet — la spécification ci-dessous décrit celui qu'il faut obtenir d'une source officielle, avec validité temporelle.

---

## 1. Ce qui existe, mesuré

| Élément | État | Source de la mesure |
|---|---|---|
| Régions administratives | **8 régions officielles** + 1 entrée « Non renseigné » | table `regions` (BDRI), `ref_regions` (legacy sig_routier) — concordantes, codes BOK/CKY/FAR/KAN/KIN/LAB/MAM/NZE |
| `troncons.prefecture` | colonne présente, **0 valeur sur 1 690** | requête du 02/09/2026 sur copie restaurée |
| `troncons.commune` | colonne présente, **0 valeur sur 1 690** | idem |
| Sous-préfectures, localités | **inexistants** dans tout le schéma | revue complète du schéma Prisma |
| Tables legacy `ref_*` | `ref_regions`, `ref_etat`, `ref_revetement`, `ref_type_ouvrage`, `ref_type_equipement` — rien de plus fin que la région | `sig_routier`, interrogé le 02/09/2026 |
| Couches OSM 2023 | `TOPONYME_COMMUNICATION` : 30 points (Conakry et axes principaux) — inutilisable comme référentiel | `BDRI-SOURCE-OSM-2023.md` |

**Ce qu'il faut en retenir** : la région est fiable et officielle ; tout le reste
n'existe pas. Aucune donnée administrative fine ne peut être « déduite » des données
présentes — le référentiel doit venir de l'extérieur, d'une source qui fait autorité.

Le document `BDRI-REFERENTIEL-NATIONAL.md` §6 a déjà mesuré ce que ce blocage coûte :
299 chantiers sur 488 (61 %) sans localisation exploitable, statistiques par
préfecture impossibles, rattachement administratif des 1 690 tronçons impossible.

---

## 2. La règle absolue

Aucune région, préfecture, sous-préfecture, commune ni localité ne sera inventée,
déduite d'un géocodage externe non validé, ni extraite d'OSM comme faisant autorité.
OSM peut **proposer** ; seule une source officielle **décide**.

---

## 3. Spécification du référentiel nécessaire

### 3.1 Structure

```text
Region          id, code (BOK...), nom, ValidFrom, ValidTo, Source, SourceDate, Geometry(multi-polygone)
Prefecture      id, code, nom, regionId -> Region, ValidFrom, ValidTo, Source, SourceDate, Geometry
SousPrefecture  id, code, nom, prefectureId -> Prefecture, ValidFrom, ValidTo, Source, SourceDate, Geometry (optionnelle)
Commune         id, code, nom, sousPrefectureId (ou prefectureId), ValidFrom, ValidTo, Source, SourceDate, Geometry
Localite        id, nom, communeId, type (chef-lieu, ville, village), Statut, Source, Geometry(point)
```

### 3.2 La validité temporelle n'est pas optionnelle

Le découpage administratif guinéen évolue (créations et fusions de sous-préfectures
et de communes). Un référentiel non daté vieillit en silence et produit, au moment
de l'audit, des chiffres impossibles à justifier.

Règles :

- toute entité porte `ValidFrom` (obligatoire) et `ValidTo` (null = en vigueur) ;
- une modification de périmètre **clôture** l'ancienne entité (`ValidTo`) et en crée
  une nouvelle — jamais de mise à jour en place d'une géométrie administrative ;
- l'historique est conservé intégralement : « quelle était la commune de ce chantier
  à la date du marché ? » doit rester une question answerable ;
- un même objet réel peut donc exister en plusieurs versions ; la version en vigueur
  est celle où `ValidTo IS NULL`.

### 3.3 Traçabilité

Chaque entité porte sa `Source` (institution émettrice), sa `SourceDate` (date
d'émission du référentiel source) et sa géométrie si disponible. La géométrie est
ce qui transforme le référentiel d'une liste de noms en un outil : avec des
polygones, le rattachement des 1 690 tronçons et des chantiers se fait par
intersection spatiale, en une requête, sans saisie.

### 3.4 Source pressentie, à confirmer par AGEROUTE

Le découpage officiel relève de l'Institut National de la Statistique (INS) et des
services compétents du ministère. **La Phase 5 ne désigne pas la source** : elle
constate qu'aucune source officielle n'est présente dans le projet et que le choix
définitif est une décision métier. Le test d'acceptation est simple :

> La source retenue est-elle opposable à un auditeur externe si un chiffre publié
> par la BDRI est contesté ?

---

## 4. Ce que le référentiel débloquera, une fois obtenu

| Fonction | Effet mesurable attendu |
|---|---|
| Rattachement des tronçons | 1 690 tronçons rattachés par intersection spatiale (géométries 100 % valides) |
| Géolocalisation des chantiers | le plus gros gisement identifié : 299 chantiers (61 %) localisables par toponyme |
| Statistiques par préfecture | rapports bailleurs par préfecture, aujourd'hui impossibles |
| Recherche administrative | cascades Région → Préfecture → Commune → Localité |

---

## 5. Décisions attendues

| # | Décision | Décideur |
|---|---|---|
| 1 | Source officielle retenue (INS ? service ministériel ?) et format d'obtention | Direction Technique |
| 2 | Profondeur du référentiel (s'arrêter à la commune ou inclure sous-préfectures/localités) | Direction Technique |
| 3 | Avec ou sans géométries — la spec recommande **avec**, sinon tout rattachement redevient de la saisie manuelle | Direction Technique + DSI |
| 4 | Propriétaire de la mise à jour et cadence de contrôle | Direction Générale |

**Statut** : l'état des lieux est MESURÉ ; la spécification est une proposition ;
la source et le périmètre sont REQUIRES_BUSINESS_VALIDATION.
