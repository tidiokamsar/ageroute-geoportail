# P4-04 — Conception de la couche voirie locale

**Date** : 2 septembre 2026
**Statut** : **PROPOSITION** — aucune migration écrite, aucun modèle modifié.
**Fondé sur** : `P4-OSM-DATA-AUDIT.md` et `P4-BDRI-GEODATA-AUDIT.md`

---

## 1. Le nom

Le cadrage propose `LocalRoad` ou `VoirieLocale`. Le schéma existant nomme ses
modèles en français — `Troncon`, `Ouvrage`, `Chantier`, `PointNoir`, `Poste`,
`PropositionLocalisation`. **`VoirieLocale`** s'y accorde ; `LocalRoad` y ferait
tache.

---

## 2. Pourquoi une table séparée, et non `Troncon`

Trois raisons, toutes mesurées.

**Ce n'est pas un actif AGEROUTE.** Une voie OSM n'est pas un objet du patrimoine
tant qu'AGEROUTE ne l'a pas validée. Les mélanger rendrait la distinction
impossible à tenir dans le temps.

**Les comptages exploseraient.** `troncons` compte 1 690 lignes ; y verser 262 656
objets multiplierait par 156 tous les indicateurs, tableaux de bord et exports
existants. Le champ `deletedAt` ne protégerait de rien : ce ne sont pas des objets
supprimés.

**Les contraintes ne correspondent pas.** `Troncon` exige `regionId` (non nul),
`longueurKm`, `revetement`, `etat`, `pkDebut`, `pkFin`. Aucun de ces champs n'est
disponible côté OSM. Les remplir par défaut fabriquerait exactement le genre de
donnée fictive que les phases précédentes ont passé du temps à démasquer.

---

## 3. Ce que le modèle peut réellement porter

Le cadrage propose une liste de champs. La confronter à l'audit en retire
plusieurs — les garder donnerait l'illusion d'une donnée disponible.

| Champ proposé | Disponible ? | Décision |
|---|---|---|
| `source` | oui — `OpenStreetMap`, 100 % | **retenu** |
| `sourceId` | oui — `ID`, 100 % | **retenu** |
| `nature` | oui — `NATURE`, 21 valeurs | **retenu** |
| `classification` | **non** — `CL_ADMIN` vaut `Autre` partout | **dérivé** de `nature`, marqué comme inféré |
| `name` | 0,4 % (1 046 / 262 656) | retenu, presque toujours nul |
| `ref` | 0,6 % (1 453) | retenu, presque toujours nul |
| `surface` | **absent du modèle OSM** | **écarté** |
| `geometry` | oui | **retenu** |
| `lengthCalculated` | calculable | **retenu**, jamais saisi |
| `administrativeRegionId` | **non** | **retenu mais nul**, à dériver par intersection |
| `prefectureId` | **non** — aucun référentiel | **écarté pour l'instant** |
| `communeId` | **non** — aucun référentiel | **écarté pour l'instant** |
| `locality` | **non** | **écarté pour l'instant** |
| `sourceDate` | oui — `DATE_MAJ`, 100 % | **retenu** |
| `importedAt` | oui | **retenu** |
| `status` | oui | **retenu** |

**Le niveau administratif est le point dur.** `CL_ADMIN` vaut `Autre` sur les
262 656 objets : rien dans ces fichiers ne rattache une voie à une région, une
préfecture ou une commune. Porter `prefectureId` et `communeId` dès maintenant
créerait quatre colonnes vides pour un quart de million de lignes.

`regionId` fait exception : la BDRI a ses 9 régions, et une intersection spatiale
avec les tronçons existants permettrait un rattachement approximatif — à condition
de le marquer `DERIVE_DE_LA_GEOMETRIE`, jamais de le présenter comme une donnée
source.

---

## 4. Modèle proposé

```prisma
/// Voirie locale issue d'une source cartographique externe.
///
/// N'EST PAS un actif du patrimoine AGEROUTE. Une voie n'entre au référentiel
/// institutionnel qu'après validation, et cette validation crée alors un Troncon
/// distinct — la ligne de voirie garde la trace du lien.
model VoirieLocale {
  id            String   @id @default(uuid())

  // ── Provenance, obligatoire ──────────────────────────────
  source        SourceVoirie                 // OSM, IMPORT_AGEROUTE, SAISIE
  sourceId      String                       // identifiant chez la source
  sourceDate    DateTime?                    // DATE_MAJ de la source
  importedAt    DateTime @default(now())
  importLot     String                       // « A_OSM_RESEAU_ROUTIER 2023-03-08 »

  // ── Attributs de la source, tels quels ───────────────────
  nature        String                       // valeur NATURE brute, non traduite
  nom           String?                      // 0,4 % renseignés
  reference     String?                      // NUMERO, 0,6 % renseignés
  sens          String?                      // 0,3 % renseignés

  // ── Lecture dérivée, marquée comme telle ─────────────────
  categorie     CategorieVoirie              // INFERE depuis `nature`
  longueurCalculeeKm Float                   // ST_Length, jamais saisi

  // ── Rattachement, faible ─────────────────────────────────
  regionId      Int?
  region        Region?  @relation(fields: [regionId], references: [id])
  /// Comment le rattachement a été obtenu. Nul tant qu'aucun n'existe.
  regionMethode String?                      // « DERIVE_DE_LA_GEOMETRIE »

  // ── Cycle de vie ─────────────────────────────────────────
  statut        StatutVoirie @default(SOURCE_EXTERNE)
  tronconId     String?                      // rempli à la validation
  troncon       Troncon? @relation(fields: [tronconId], references: [id])

  geom          Unsupported("geometry(LineString,4326)")?

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([source, sourceId])   // un objet source ne peut entrer deux fois
  @@index([categorie])
  @@index([statut])
  @@map("voirie_locale")
}
```

### Les énumérations

```prisma
enum SourceVoirie {
  OSM
  IMPORT_AGEROUTE
  SAISIE_APPLICATIVE
}

/// Regroupement des 21 valeurs de NATURE. INFERE — aucun champ source ne le porte.
enum CategorieVoirie {
  VOIE_RAPIDE
  PRINCIPALE
  SECONDAIRE
  TERTIAIRE
  VOIE_LOCALE
  RESIDENTIELLE
  ACCES
  CHEMIN
  SENTIER
  PIETON
  INCONNU
}

/// Cycle de vie d'une voie externe.
///
/// VALIDEE ne signifie PAS que la voie devient RN/RR/RU. C'est une validation
/// CARTOGRAPHIQUE — le tracé est jugé correct et publiable. Le classement
/// institutionnel est une décision distincte, matérialisée par `tronconId`.
enum StatutVoirie {
  SOURCE_EXTERNE     // état d'entrée : donnée brute, non examinée
  CANDIDATE          // proposée pour examen
  VALIDEE            // tracé confirmé par AGEROUTE
  REJETEE            // écartée
  ARCHIVEE           // retirée d'affichage, conservée
}
```

### Deux points de conception qui comptent

**`@@unique([source, sourceId])`** empêche qu'un ré-import crée des doublons.
L'audit a montré 0 doublon de géométrie dans `ROUTE`, mais rien ne garantit qu'une
extraction ultérieure n'en produise.

**`tronconId` porte la relation, pas l'identité.** Le cadrage l'exige : l'ID OSM ne
devient jamais un ID BDRI. Quand une voie est promue, un `Troncon` est créé avec
son propre UUID, et la ligne de voirie garde le lien — la traçabilité survit.

---

## 5. Ce que la validation ne fait pas

```
Voie OSM (SOURCE_EXTERNE)
        │
        │  un agent la propose
        ▼
   CANDIDATE
        │
        │  contrôle AGEROUTE
        ▼
    VALIDEE                    ← le TRACÉ est jugé correct
        │
        │  DÉCISION INSTITUTIONNELLE, distincte
        ▼
  Création d'un Troncon        ← l'objet devient un ACTIF AGEROUTE
  tronconId renseigné
```

Une voie `VALIDEE` sans `tronconId` est une voie dont le tracé est bon et qui
**n'appartient pas** au réseau AGEROUTE. C'est un état parfaitement légitime, et
même le plus fréquent attendu : une rue de quartier correctement cartographiée
n'est pas une route nationale.

Confondre les deux serait la version cartographique de l'erreur que la Phase 5 a
documentée sur le lot `RES-*` — 1 028 objets entrés au référentiel sans que leur
nature soit établie.

---

## 6. Ce que ce modèle ne résout pas

| Question | État |
|---|---|
| Rattachement préfecture / commune / quartier | **impossible** depuis ces données |
| Distinction piste / sentier | **impossible** — `NATURE` ne la porte pas |
| Distinction voie principale / desserte | **impossible** |
| Nom de la voie | 0,4 % |
| Affichage de 262 656 objets | **non résolu ici** — voir `P4-MAP-VISUALIZATION.md` |

---

## 7. Volumétrie et index

262 656 lignes, environ 5,8 millions de sommets.

L'index doit être un GiST sur `(geom::geography)`, et non sur `geom` : la mesure de
la phase 3 a montré qu'un index sur `geom` est ignoré par le planificateur là où la
forme `geography` divise le temps par quarante — parce que les requêtes de
l'application raisonnent en mètres.

```sql
CREATE INDEX voirie_locale_geog_idx
  ON voirie_locale USING GIST ((geom::geography));
```

---

## 8. Décisions requises avant d'écrire la migration

1. **Le nom** — `VoirieLocale` retenu, à confirmer.
2. **La granularité de `CategorieVoirie`** — onze valeurs alignées sur ce qu'OSM
   porte réellement, au lieu des sous-catégories du cadrage qui n'existent pas
   dans la donnée.
3. **`prefectureId` / `communeId`** — écartés tant qu'aucun référentiel
   administratif n'existe. Les ajouter plus tard est une migration additive,
   sans risque.
4. **Le périmètre à importer** — faut-il charger les 262 656 objets, ou seulement
   certaines catégories ? Les 175 283 chemins et sentiers représentent les deux
   tiers du volume pour l'usage le moins certain.
