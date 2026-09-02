# Qualité des données — Phase 4

**Tickets** : T3, T4, T8, §15, §16
**État** : livré et testé, scripts de remplissage **non exécutés en production**

---

## 1. Le principe : un champ rempli n'est pas un champ renseigné

Un tableau de qualité calculé sur `COUNT(non-null)` annonçait :

| Champ | Taux « renseigné » |
|---|---:|
| `revetement` | 100 % |
| `etat` | 100 % |
| `pkDebut` / `pkFin` | 100 % |

Ces trois réponses sont exactes et sans intérêt. `revetement` vaut `BITUME` sur les
1 690 tronçons sans une seule exception. `etat` vaut `NON_EVALUE` sur 1 043 d'entre
eux. Et 1 069 tronçons portent `pkDebut = pkFin = 0` — ce dernier point, je l'avais
moi-même compté comme un acquis avant de le vérifier.

La Phase 4 remplace ce comptage par une réponse à la question utile : **combien de
valeurs sont réellement fiables, et depuis quand ?**

---

## 2. Le modèle

### Par champ, pas par enregistrement

Un tronçon typique a aujourd'hui une géométrie vérifiée, une longueur absente et un
revêtement contredit. Un statut unique porté par l'objet devrait choisir entre ces
trois niveaux et perdrait ce qui compte.

`valeurs_qualite` porte donc une ligne par (entité, enregistrement, champ), sur les
**six champs qui alimentent une décision** — état, longueur, revêtement, trafic,
criticité, coût — et eux seuls. Vingt-deux champs auraient coûté cher pour un
bénéfice nul sur les identifiants.

| Statut | Sens |
|---|---|
| `OBSERVED` | constaté sur le terrain, daté, attribué |
| `IMPORTED_UNVERIFIED` | importé, jamais vérifié |
| `DERIVED` | calculé depuis une autre donnée |
| `CONFLICTING` | contredit par une autre source interne |
| `UNKNOWN` | on a regardé, on ne sait pas |

Et une nuance qui compte : **l'absence de ligne n'est pas `UNKNOWN`**. `UNKNOWN` est
une affirmation ; l'absence dit que personne n'a encore regardé. Le badge ne s'affiche
pas dans le second cas plutôt que d'affirmer une ignorance.

### La date n'est pas décorative

Chaque ligne porte `observedAt` — la date du **constat**, jamais celle de la saisie —,
`observedById`, `methode`, `source`, `confiance`. Un statut `OBSERVED` sans date ne
vaut pas mieux que pas de statut : deux constats non datés ne se comparent pas, et le
badge le signale même sur une valeur constatée.

---

## 3. L'état de connaissance initial — et il est dur

Le script `backfill:qualite` établit ce que l'on sait des 1 690 tronçons tel que la base
se présente :

| Champ | Statut attribué | Motif |
|---|---|---|
| `revetement` | `IMPORTED_UNVERIFIED`, LOW | valeur unique sur 1 690 ; 29 intitulés de chantiers décrivent des routes en terre |
| `etat` = `NON_EVALUE` | `UNKNOWN` | 1 043 tronçons |
| `etat` renseigné | `IMPORTED_UNVERIFIED`, LOW | 647 tronçons, aucun daté |
| `longueurKm` > 0 | `IMPORTED_UNVERIFIED`, MEDIUM | 662, concordent à 1 % avec la géométrie |
| `longueurKm` absente | `UNKNOWN` | 1 028 |
| trafic, criticité, coût | `UNKNOWN` | 0 / 1 690 chacun |

**Aucune valeur n'est `OBSERVED`.** Pas une. Il n'existe ni date de constat, ni
auteur, ni méthode pour aucune valeur de la base. Attribuer `OBSERVED` à un état non
daté reviendrait à affirmer un constat que rien n'atteste.

### Pourquoi le revêtement n'est pas `CONFLICTING`

La contradiction est établie au niveau du réseau — 29 intitulés contre `BITUME`
partout — mais elle n'est pas attribuable tronçon par tronçon : un seul chantier sur
488 porte un code de tronçon exact, et aucun tronçon ne porte de nom de localité.
Marquer un enregistrement précis supposerait un rapprochement qu'on ne sait pas faire.
La contradiction est consignée en note sur chaque valeur, où elle est vraie.

### Ce qui n'a pas été fait

`BITUME` n'est pas remplacé. Aucune source ne dit ce qu'est réellement le revêtement
de ces tronçons, et substituer une supposition à une autre n'est pas une correction.

---

## 4. Ce que l'interface dit désormais

Sur la fiche tronçon, longueur, revêtement, trafic et état portent un badge :

| Badge | Quand |
|---|---|
| Constaté | `OBSERVED`, daté |
| Constaté — date inconnue, avec pictogramme | `OBSERVED` sans date |
| Importé — non vérifié | `IMPORTED_UNVERIFIED` |
| Calculé | `DERIVED` |
| Contredit par une autre source | `CONFLICTING` |
| Non renseigné | `UNKNOWN` |
| *rien* | aucune ligne de qualité |

Le badge ne cache ni ne corrige la valeur. Il dit quel crédit lui accorder.

---

## 5. Le score de décision refuse de mentir (T8)

Le score ne se contentait pas d'être calculé sur des critères vides : il les
fabriquait. Criticité déduite de la classe de route, coût déduit de longueur × tarif,
`NON_EVALUE` valant 20/100. Puis le tout pondéré et affiché au même titre que l'état
constaté.

**Règle retenue** : un score n'est rendu que si chaque critère portant un poids non
nul dispose d'une valeur réelle. Sinon « Non calculable » et la liste des manquants.
Pas de seuil, pas de moyenne des survivants. Mettre un poids à zéro exclut le critère
explicitement.

`null`, jamais zéro : un 0 se lirait comme « le moins prioritaire ».

Le score était calculé à **deux** endroits — serveur et page Décision, cette dernière
à partir d'un troisième jeu de valeurs fabriquées par le tableau de bord. Les trois
sont corrigés. Les estimations restent disponibles pour le simulateur budgétaire, mais
portent le suffixe `Estime`, un drapeau `criteresReels`, et s'affichent « ~450 estimé »
en ambre, jamais « 450 Md GNF ».

---

## 6. Le tableau de bord qualité (§16)

`GET /api/qualite/repartition` répond par champ :

```
revetement    IMPORTED_UNVERIFIED 1 690
etat          UNKNOWN 1 043   IMPORTED_UNVERIFIED 647
longueurKm    IMPORTED_UNVERIFIED 662   UNKNOWN 1 028
trafic        UNKNOWN 1 690
...
fraîcheur     0 valeurs datées sur 10 140
```

La fraîcheur est rendue **séparément**, sans être noyée dans une moyenne : c'est la
dimension la plus dégradée, et une moyenne des autres statuts la masquerait.

---

## 7. Comment la qualité s'améliore à partir d'ici

Une seule voie produit une valeur `OBSERVED` : **l'inspection terrain**. Depuis T7,
chaque inspection enregistre une ligne `OBSERVED`, datée de la date du constat,
attribuée à l'inspecteur, de méthode `RELEVE_TERRAIN` — et écrit enfin
`dateDerniereEvaluation` sur le tronçon, qui ne l'avait jamais été.

Le modèle cesse d'être descriptif pour devenir alimenté. Mais il ne s'alimentera qu'au
rythme des inspections : 1 en trois mois aujourd'hui.

---

## 8. Tests

| Portée | Tests |
|---|---:|
| Qualification initiale | 15 |
| API qualité et droits | 12 |
| Badge | 8 |
| Score de priorisation | 14 |
| **Total** | **49** |
