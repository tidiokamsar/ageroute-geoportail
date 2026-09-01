# BDRI 2.0 — Modèle de données

Ce document ne propose de nouveau modèle que là où le besoin est établi. Les 23
modèles existants couvrent l'essentiel ; l'enjeu est ailleurs.

---

## 1. Principe

**Un modèle ne se crée que si la question à laquelle il répond ne peut pas l'être
autrement.** Le §10 le dit et c'est la bonne règle : signalisation, équipements et
autres actifs routiers peuvent attendre. Cinq modules existants sont déjà vides —
en ajouter d'autres n'apporterait rien.

Trois besoins justifient une évolution du modèle. Trois seulement.

---

## 2. Identifiant stable du patrimoine — **besoin réel**

### Le problème

Chaque objet porte aujourd'hui un `id` UUID technique, et les tronçons un `code`
(`GN N0031 1-1490`). Ni l'un ni l'autre ne convient comme identifiant durable :

- L'UUID n'a aucun sens métier et changerait à la moindre reprise de données.
- Le `code` **est déjà instable** : sur certains tronçons il est identique au `nom`
  (`RES-782` porte `code = nom = RES-782`), sur d'autres il suit une convention
  différente. Une convention qui admet deux formes n'en est pas une.

Sans identifiant stable, le §31 est impossible : un lien vers l'application métier
doit reposer sur une référence qui ne bouge pas.

### Proposition

Un identifiant **métier, lisible, stable** :

```
RN3-TR-001245     tronçon 1245 de la RN3
RN3-OA-000017     ouvrage d'art 17 sur la RN3
RN3-PN-000003     point noir 3
```

| Règle | Justification |
|---|---|
| Attribué à la création, **jamais réattribué** | Un identifiant réutilisé casse tout historique |
| Ne change **pas** si l'objet change de nom, d'état ou de géométrie | C'est le sens de « stable » |
| **Survit** à la suppression logique | `deletedAt` conserve l'objet ; l'identifiant aussi |
| Indépendant de l'`id` technique, de la position et des migrations | Contrainte du §11 |

**Cas à trancher avant implémentation** : que devient l'identifiant si un tronçon est
scindé en deux ? Deux nouveaux identifiants, l'ancien retiré et conservé en
historique — jamais l'un des deux réutilisant l'ancien. C'est une règle de gestion,
pas une décision technique : elle appartient à AGEROUTE.

**Nouveau champ** : `identifiantPatrimoine String @unique` sur les entités
patrimoniales. Pas de nouveau modèle.

---

## 3. Historique de l'état — **besoin réel**

### Le problème

Le §12 veut : *RN3-X — 2024 bon, 2025 moyen, 2026 mauvais*. Aujourd'hui, `Troncon.etat`
porte une seule valeur : l'actuelle. **L'historique n'existe pas.**

`AuditLog` conserve bien les `before`/`after` de chaque modification, mais c'est un
journal technique — il enregistre *qui a changé quoi et quand*, pas *quel était l'état
du réseau en 2025*. Le reconstituer par rejeu du journal serait fragile et lent.

`IndicateurReseauHistorique` existe et stocke des instantanés — mais **agrégés à
l'échelle du réseau**, pas par objet.

### Proposition

Un modèle `EtatPatrimoineHistorique` :

| Champ | Rôle |
|---|---|
| `objetType`, `objetId` | L'objet concerné |
| `etat` | La valeur constatée |
| `constateLe` | La date du constat |
| `sourceType` | Inspection, import, saisie manuelle |
| `sourceId` | L'inspection qui l'a produit, le cas échéant |
| `auteurId` | Qui |

**Écrit à chaque changement d'état**, jamais modifié. C'est ce qui permet la timeline
du §13 sans rejouer le journal d'audit.

**Dépendance** : sans inspections, il n'y aura rien à historiser. Ce modèle a du sens
**après le lot 2.1**, pas avant.

---

## 4. Référentiel administratif — **besoin réel, bloqué en amont**

### Le problème

`prefecture` et `commune` existent sur `Troncon` depuis la migration
`20260701150000_troncon_draw_fields`. **Rien ne les écrit** : 0 sur 1 690. Seules les
8 régions sont modélisées, dans une table `Region` sans géométrie.

Conséquence mesurée : une recherche « Kankan → Kissidougou » est impossible, Kissidougou
étant une préfecture et non une région.

### Ce que la source doit fournir

| Exigence | Pourquoi |
|---|---|
| Les 4 niveaux : préfecture, sous-préfecture, commune, localité | Le §20 les demande tous |
| Les **géométries** (polygones), pas seulement les noms | Sans elles, aucun rattachement spatial possible |
| Une date de validité | Les découpages administratifs changent |
| Un caractère officiel | Le §11 interdit toute donnée inventée |

### Sources, par ordre de fiabilité

| Source | Nature | Réserve |
|---|---|---|
| Institut National de la Statistique | Découpage officiel | Référence de droit ; à demander formellement |
| Direction Nationale de la Cartographie | Limites géographiques | Complète l'INS par les polygones |
| OSM / GADM / geoBoundaries | Limites ouvertes | Disponibles immédiatement, **non officielles** — bonnes pour préparer, pas pour faire foi |

**Recommandation** : engager la démarche auprès de l'INS **maintenant**, en parallèle
du lot 2.1. C'est le délai le plus long du programme et il ne coûte rien à lancer tôt.

### Modèle proposé

Quatre tables de référence (`Prefecture`, `SousPrefecture`, `Commune`, `Localite`),
chacune avec `geom`, `parentId`, `codeOfficiel`, `sourceRef`, `valideDepuis`.

**Le rattachement passe par une table de liaison, pas par une colonne.** Un tronçon
traverse plusieurs préfectures : l'écraser dans un champ unique perdrait de
l'information. Chaque rattachement porte :

| Champ | Rôle |
|---|---|
| `methode` | `spatial_auto` ou `manuel` |
| `calculeLe` | Quand |
| `valide` | Booléen — un rattachement calculé n'est pas un rattachement validé |
| `valideParId` | Qui a contrôlé |

Le §20 exige que le rattachement soit contrôlable ; c'est ce que ces quatre champs
rendent possible. **Un rattachement automatique non validé doit être affiché comme
tel.**

**Prérequis technique** : `ST_Intersects` entre tronçons et polygones exige un index
GIST sur les nouvelles tables — et l'expérience du Lot 3 a montré que la **forme** de
l'index compte : sur `geom` pour les intersections, sur `(geom::geography)` pour les
distances.

---

## 5. Localisation des chantiers — **pas de nouveau modèle, un champ**

### Le problème mesuré

| | |
|---|---|
| Chantiers | 488 |
| Avec géométrie | **6** |
| Rattachés à un tronçon | **4** |

482 chantiers s'affichent au centre de leur région. La carte montre des chantiers là
où il n'y en a pas — et **rien ne le dit à l'utilisateur** au-delà d'une mention
« localisation approximative » dans l'infobulle.

### Proposition

Le §21 demande de distinguer trois niveaux de précision. Un champ suffit :

| Valeur | Signification | Rendu carte |
|---|---|---|
| `PRECISE` | Géométrie ou GPS réels | Tracé plein |
| `LINEAIRE` | Route + PK début/fin | Tracé dérivé du tronçon, style distinct |
| `APPROXIMATIVE` | Centre de région | Cercle diffus, jamais un tracé |
| `INCONNUE` | Aucune information | **Non affiché sur la carte** |

**Le rendu doit trahir l'imprécision.** Un chantier approximatif dessiné comme un
chantier précis est un mensonge cartographique — c'est le défaut actuel.

**Voie d'alimentation** : le rattachement au tronçon (`tronconId` + PK) est déjà
modélisé. L'information existe vraisemblablement dans l'application de gestion de
projets d'AGEROUTE. **C'est un sujet d'interconnexion, pas de saisie** — et cela
renvoie au lot 2.7.

---

## 6. Ce qu'il ne faut PAS créer

| Tentation | Pourquoi non |
|---|---|
| Modèles signalisation, équipements, mobilier | Cinq modules sont déjà vides. En ajouter n'apporte rien |
| Table de topologie routière | Le §18 la souhaite ; elle n'a de sens qu'avec un vrai routage, donc après décision sur pgRouting |
| Copie des données de marchés et projets | Le §2 l'interdit. Un identifiant externe suffit |
| Modèle de « scénario » d'aide à la décision | Sans trafic, criticité ni coût, un scénario n'a rien à optimiser |

---

## 7. Deux anomalies à traiter avant toute évolution

**Le revêtement.** Les 1 690 tronçons portent `BITUME`. Sur un réseau national
guinéen, c'est invraisemblable — une part importante est en terre ou latérite. Valeur
par défaut d'import. **Une colonne à valeur unique simule une information au lieu
d'en porter une**, et fausserait tout score de priorité qui l'utiliserait.

**Les longueurs.** 1 028 tronçons sur 1 690 ont une longueur nulle. Elles sont
calculables depuis la géométrie (`ST_Length` en geography) — **mais il faut confronter
le calcul aux valeurs officielles avant d'écrire quoi que ce soit.** Une longueur
calculée n'est pas une longueur constatée, et le linéaire national est un chiffre qui
engage AGEROUTE.
