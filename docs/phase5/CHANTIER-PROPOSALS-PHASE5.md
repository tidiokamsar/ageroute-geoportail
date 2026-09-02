# Localisation des chantiers — propositions à valider, jamais automatiques

**Ticket** : P5-06
**Date** : 2 septembre 2026
**Base** : Phase 4 T5 (`generer-propositions-localisation.ts`, modèle `PropositionLocalisation`) — éprouvée sur 36 intitulés réels : 14 emprises (11 HIGH, 3 MEDIUM), 19 routes seules (LOW), 3 refusées.

---

## 1. Le principe qui gouverne tout le reste

La Phase 4 a démontré pourquoi le référencement automatique route+PK ne peut pas
être appliqué sans garde-fou :

| Défaut mesuré | Conséquence |
|---|---|
| PK dupliqués sur plusieurs tronçons | une même référence « PK 24 » désigne des lieux différents |
| six tronçons commençant à PK 0 | PK 0 ≠ origine physique de la route |
| aucune des 14 emprises testées ne trouve un tronçon couvrant entièrement l'emprise | la proposition ne peut pas être un choix automatique |
| routes citées sous des formes multiples (rn 3, RN3, N3) | l'extraction est robuste, la correspondance ne l'est pas |

La règle de la Phase 5 est donc : **une proposition est une proposition**. Aucune
proposition ne devient une localisation sans décision humaine explicite, et chaque
décision est auditée.

---

## 2. L'état actuel du dispositif (mesuré)

Le modèle `PropositionLocalisation` existe déjà, avec les colonnes nécessaires à
l'audit : `statut` (PROPOSED/…), `methode`, `sourceTexte` (l'intitulé exact, pour
juger sur pièce), `confiance`, `pkDebut/pkFin`, `ecartPct`, `decidedAt`, `decidedById`.
La génération fonctionne ; il manque le **parcours de validation côté agent**.

Ce document spécifie ce parcours. L'implémentation est un chantier Phase 5+
(voir §6) : la Phase 5 la spécifie, ne la déploie pas.

---

## 3. Interface agent spécifiée

Pour chaque chantier non localisé portant des propositions :

```text
CHANTIER
─────────────────────────────────────────────
Intitulé :  Aménagement RN5 — PK 24 à PK 66

Route détectée : RN5        (source : intitulé, méthode INTITULE_ROUTE_PK)
PK début : 24               PK fin : 66
Longueur citée : 42 km      Longueur calculée sur l'emprise : 41,6 km (écart 1,0 %)

Propositions de tronçon
─────────────────────────────────────────────
Tronçon candidat A   RN5 — Kindia→Kouria     Confiance : 72 %
   couvre PK 22 → PK 68 ; écart longueur 1,0 % ; emprise calculée affichée
   [ VOIR SUR LA CARTE ]

Tronçon candidat B   RN5 — Kouria→Mamou      Confiance : 41 %
   couvre PK 60 → PK 78 ; écart longueur 38 % ; emprise calculée affichée
   [ VOIR SUR LA CARTE ]

─────────────────────────────────────────────
[ VALIDER A ]   [ REJETER TOUT ]   [ RECHERCHER MANUELLEMENT ]
```

Comportements exigés :

| Élément | Exigence |
|---|---|
| `sourceTexte` | toujours affiché tel quel — l'agent juge sur pièce, pas sur la synthèse |
| Voirl sur la carte | met en évidence l'emprise calculée (`geom` de la proposition) sur le géoportail, en overlay temporaire |
| VALIDER | passe la proposition à `VALIDEE`, pose `decidedAt/decidedById`, et **enregistre la localisation du chantier** (emprise proposée) |
| REJETER TOUT | passe toutes les propositions du chantier à `REJETEE` avec motif libre obligatoire |
| RECHERCHER | ouvre la recherche manuelle (tronçon/PK, région, dessin) ; la proposition reste en attente |
| Audit | chaque transition de statut écrit une ligne `audit_logs` (qui, quoi, quand, proposition, chantier, décision) |
| Rien d'automatique | aucun batch, aucun cron, aucune conversion implicite PROPOSED→VALIDEE |

---

## 4. Les 33 propositions existantes de T5

La Phase 4 a généré 33 propositions (sur 36 intitulés testés). Conformément au
cadrage : elles restent **PROPOSED** jusqu'à validation humaine une par une.
Aucune ne sera convertie automatiquement en localisation de chantier.

Champ d'action proposé pour la validation initiale : la liste des chantiers non
localisés portant au moins une proposition, triée par confiance décroissante —
les HIGH d'abord (11 cas), pour un premier gain rapide et mesuré.

---

## 5. Décompte du gisement (mesuré Phase 4, à re-vérifier après import complet)

| Segment | Volume | Levier |
|---|---:|---|
| Chantiers sans localisation exploitable | 299 (61 %) | référentiel administratif (P5-05) + recherche manuelle |
| Dont intitulés avec route + PK | 36 testés → 14 emprises probables | parcours de validation ci-dessus |
| Dont localisables par toponyme | le plus gros gisement | **bloqué par le référentiel administratif** |

---

## 6. Chantiers d'implémentation (Phase 5+, aucun déploiement en Phase 5)

1. **API** : `POST /api/chantiers/:id/propositions/:pid/valider|rejeter` — transitions
   de statut + écriture audit + mise à jour de la localisation chantier uniquement
   sur VALIDER. Middleware rôle : ADMIN, GESTIONNAIRE.
2. **Frontend** : panneau de validation conforme au mockup §3, dans la fiche chantier.
3. **Tests** : une proposition VALIDEE n'écrase pas une localisation existante sans
   confirmation ; REJETER exige un motif ; toute transition écrit dans `audit_logs`.

**Statut** : l'état des lieux est MESURÉ ; l'interface est une SPÉCIFICATION ;
sa mise en œuvre est REQUIRES_BUSINESS_VALIDATION (périmètre Phase 5+).
