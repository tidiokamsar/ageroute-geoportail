# Registre des sources de vérité par champ

> Livrable **TI-03** (§ 14.12) et pièce du § B.6 du prompt maître V10. Objectif énoncé par le
> mandat : « **zéro copie contradictoire** entre Géoportail, ROAD, DigitalRoad, SharePoint,
> BDR ».
>
> Chaque ligne porte les sept rubriques exigées : **système propriétaire**, **consommateurs**,
> **clé stable**, **méthode de synchronisation**, **règle de conflit**, **autorité de
> validation**, **journal**.
>
> 🔒 Règle du § B.6 : ce document décrit le **code réel**. Aucune fonction n'y est présentée
> comme existante avant d'être implémentée et testée ; toute recommandation porte l'étiquette
> **« proposition »**.

**Dressé le 14/10/2026** contre `backend/prisma/schema.prisma`, les migrations, `app.ts`,
`public.controller.ts`, et les mesures en base des 13 et 14/10. Ce qui n'a pas pu être vérifié
est dit comme tel.

---

## 1. Les systèmes en présence, et ce que le dépôt en sait réellement

| Système | Rôle | Ce qui est **vérifié** dans le dépôt |
|---|---|---|
| **Console BDRI / Géoportail** (ce dépôt) | référentiel patrimonial, carte, validation | 261 387 tronçons, 1 820 694 valeurs de qualité, 1 172 ouvrages ; `audit_logs` 1 506 lignes |
| **AGEROUTE ROAD** (mobile, Capacitor — ADR-009) | collecte terrain, hors ligne | **non construit**. La PWA actuelle et la future coque partagent le **même backend** et les mêmes tables `operations_sync` / `conflits_sync` : ROAD n'est pas un système de données distinct, c'est un client |
| **DigitalRoad** | ERP travaux : marchés, ordres de travaux, décomptes, paiements | **consomme** `/api/public` depuis l'intranet SharePoint (commentaire daté **06/10/2026**, `app.ts` l. 79). Aucun flux entrant. Aucun accès de recette (B-11) |
| **SharePoint** | intranet, documents | origine CORS par défaut de l'API publique (`config/env.ts`), **lecture seule, sans cookie, GET/HEAD**. Aucune autre liaison |
| **BDR nationale / ONR** | référentiel national, L²R | **aucun flux**, formats non publiés (§ B.1). Chiffres officiels cités par le mandat seulement |
| **ERP de référence des comptes** (arbitrage D4) | identités | **non identifié** (D-09). Aucun OIDC, aucun SAML dans `backend/src` — vérifié |
| **ANASUR Collect** | collecte de terrain tierce | **aucun accès**, aucune API supposée (garde-fou V10) |
| **AI4 Trafic, pesage** | trafic, charges à l'essieu | **aucun flux**. La composante `TRAFIC` du RCI est exclue de chaque score faute de donnée |

**Une seule intégration existe aujourd'hui, et elle est sortante** : le Géoportail est **source**,
DigitalRoad et SharePoint sont **consommateurs** en lecture, par l'API publique. Je l'avais
écrite absente dans des rapports antérieurs ; c'était inexact, et ce registre le corrige.

---

## 2. Le registre

Statuts de la colonne « règle de conflit » : **TENUE** (par le code ou la base), **PARTIELLE**,
**ABSENTE**, **PROPOSITION**.

### 2.1 Référentiel routier

| Champ | Propriétaire | Consommateurs | Clé stable | Synchronisation | Règle de conflit | Autorité | Journal |
|---|---|---|---|---|---|---|---|
| **Tronçon : géométrie, code, classe, longueur** | **Géoportail** aujourd'hui. Cible § 7.15 : la **codification nationale** appartient à l'ONR — **proposition** | carte publique, console, carte embarquée DigitalRoad (`/api/public/carte/geo`), ROAD | `troncons.id` (technique) ; `code` métier (`GN N*`, `RES-*`, `*-OSM-*`) ; **aucun code national** (D-06) | **aucune**. IO-01 proposé : import ONR créant des **propositions** d'écart, jamais d'écrasement (§ 7.15) | **PARTIELLE** : un import ne peut écraser (`statutValidation`), mais aucune règle n'arbitre un code national contre un code local — la codification n'existe pas | validateur BDRI (`StatutValidation`) ; pour la nomenclature, **décret D/2017/331** et l'ONR | `audit_logs`. **Lacune mesurée** : aucune ligne de création pour les 1 690 tronçons d'origine (mesure du 01/09, commentaire `schema.prisma` l. 444) |
| **Provenance du tronçon** (`sourceType`, `sourceReference`, `sourceConfidence`) | Géoportail | moteur de qualité, exports | `sourceReference` | sans objet | **TENUE** : `IMPORT_CODE_PATTERN` dit « déduit », `IMPORT_DOCUMENTE` dit « retrouvé » — la base distingue l'inférence du fait | validateur | `audit_logs` |
| **Limites administratives** (`limites_admin`) | **inconnu**. Table en SQL brut, **hors `schema.prisma`**, précision kilométrique | rattachement régional, détecteur hors territoire, audit des axes | aucune documentée | aucune | **ABSENTE** | **à établir** — vraisemblablement l'IGN ou une source libre, **non vérifié** | aucun |

### 2.2 État et portions homogènes

| Champ | Propriétaire | Consommateurs | Clé stable | Synchronisation | Règle de conflit | Autorité | Journal |
|---|---|---|---|---|---|---|---|
| **Portion homogène** (`debutM`, `finM`, `etat`, `revetement`, `praticabilite`) | **Géoportail** — arbitrage **D6** : « portions homogènes = vérité » | sections fixes (vue dérivée `reseau_sections_fixes`), ONR via IO-04, carte | `portions.id` ; `clientOperationId` (idempotence) ; lignage par `remplaceeLe` | **ROAD/PWA → serveur** par `operations_sync` : opérations idempotentes, `baseVersion`, statut, tentatives | **TENUE** : contrainte d'exclusion sur (emprise, période terrain) ; un conflit de version va dans `conflits_sync` avec **les deux charges** (`payloadLocal`, `payloadServeur`) et une `resolution` **humaine** (`resoluParId`). Aucune résolution automatique | validateur : `statutValidation = VALIDE` par un tiers ; une proposition terrain n'est **jamais** officielle (A9) | `audit_logs` + `conflits_sync` |
| **Sections fixes 100/200 m** | **dérivées**, aucun propriétaire : vue calculée, **aucune table** | ONR, bailleurs, exports | (`tronconId`, `indexSection`, pas) | recalcul à la demande | **TENUE par construction** : rien ne peut être saisi au niveau section | sans objet | sans objet |
| **Valeurs de qualité** (`valeurs_qualite`, 1 820 694 l.) | Géoportail | tableau de bord, RCI | (`tronconId`, champ, méthode) | sans objet | **TENUE** : méthode, statut, confiance portés par la valeur | moteur de qualité + validateur | `audit_logs` |

### 2.3 Collecte terrain

| Champ | Propriétaire | Consommateurs | Clé stable | Synchronisation | Règle de conflit | Autorité | Journal |
|---|---|---|---|---|---|---|---|
| **Observation, défaut, média** | Géoportail (serveur) ; l'**appareil** en est l'auteur, jamais le propriétaire | validation, qualité, futur corpus IA (D9) | `clientOperationId` unique | `operations_sync`, idempotente | **TENUE** : rejeu sans doublon (13 tests) ; conflit → `conflits_sync`, humain | validateur | `audit_logs` |
| **Détection IA** (`medias_defaut.analyse*`) | Géoportail | revue humaine | média + `analyseVersion` | sans objet | **TENUE** : contrainte `media_analyse_coherente` ; **aucun chemin d'écriture ne valide** une détection (D9) | **humain uniquement** | `audit_logs` |
| **Tâche interne** (`taches_internes`) | Géoportail | équipes AGEROUTE, futur rapprochement TI-02 | `reference` (stable, lisible) ; `clientOperationId` | `operations_sync` — **proposition**, pas encore branchée | **TENUE** pour la frontière : **aucune colonne** de montant ni de marché, garde-fou de 17 tests | responsable + clôture signée (`clotureeParId`) | `audit_logs` |

### 2.4 Ouvrages

| Champ | Propriétaire | Consommateurs | Clé stable | Synchronisation | Règle de conflit | Autorité | Journal |
|---|---|---|---|---|---|---|---|
| **Ouvrage : identité, type, position** | **Géoportail** | **DigitalRoad** via `/api/public` (décision D9 du 02/09/2026 : identité, type, position seulement) | **`code Route-Type-PK`** — conçu pour que DigitalRoad **nomme l'ouvrage sans recopier de coordonnées** (`public.controller.ts` l. 154). C'est la seule clé d'échange inter-systèmes **réellement en service** | **pull** en lecture par SharePoint, GET sans cookie | **TENUE** par le sens unique : DigitalRoad ne renvoie rien | terrain : les positions `doc_dtoaa:` viennent de **documents de la DOA&A** (import 06/10/2026) et sont servies **`aValider: true`** ; positions héritées de 2016 non vérifiées | `audit_logs` |

### 2.5 🔴 Objets contractuels — la copie contradictoire que le mandat vise

| Champ | Propriétaire | Consommateurs | Clé stable | Synchronisation | Règle de conflit | Autorité | Journal |
|---|---|---|---|---|---|---|---|
| **Marchés, ordres de travaux, décomptes, paiements, avancement** | **DigitalRoad** (§ A.3, arbitrage D1) | DigitalRoad lui-même | **inconnue** — celle de DigitalRoad, jamais communiquée | **aucune** | **DigitalRoad fait foi**. La copie du Géoportail est **gelée** (ADR-003) | DigitalRoad | DigitalRoad |
| **La copie gelée** : `chantiers` (**496 l.**), `marches`, `ordres_travaux`, `decomptes`, `avancement_marche` | Géoportail, **sans légitimité de source** | pages `/marches`, `/ordres-travaux`, carte des chantiers | ids techniques locaux, **aucun lien vers la clé DigitalRoad** | **aucune** | **ABSENTE**. Deux copies existent **aujourd'hui**, et rien ne dit laquelle est à jour. C'est précisément la situation que TI-03 existe pour nommer | — | `audit_logs` pour la copie |

**Proposition.** Ne rien supprimer (§ A.5.8). Marquer la copie **« gelée, non source, dernière
synchronisation inconnue »** dans l'interface, et obtenir de DigitalRoad sa clé stable pour
porter un simple champ de rattachement — pas une synchronisation, un **pointeur**. La
synchronisation elle-même (X-18, TI-02) attend l'accès B-11.

### 2.6 Documents

| Champ | Propriétaire | Consommateurs | Clé stable | Synchronisation | Règle de conflit | Autorité | Journal |
|---|---|---|---|---|---|---|---|
| **Documents** (`documents` : `filePath`, `mimeType`, `sizeBytes`, volume `bdri_uploads`) | **ambigu**, et c'est la deuxième contradiction : le Géoportail **stocke les fichiers** localement, alors que **SharePoint est l'intranet documentaire** institutionnel | base documentaire, inspection terrain, OT | `documents.id` local ; **aucune référence SharePoint** | **aucune** | **ABSENTE** | — | `audit_logs` |

**Proposition.** SharePoint propriétaire des documents institutionnels, le Géoportail ne
conservant que ce qu'il **produit** (photos de terrain, preuves avant/après) et des **liens**
vers le reste. Exige l'accès B-12.

### 2.7 Identités

| Champ | Propriétaire | Consommateurs | Clé stable | Synchronisation | Règle de conflit | Autorité | Journal |
|---|---|---|---|---|---|---|---|
| **Comptes, rôles, délégations** (`users`, 799 jetons actifs) | **devrait être l'ERP** (arbitrage D4 : « aucun second annuaire ») ; **est** le Géoportail aujourd'hui, seul annuaire existant | toute l'application | `users.id` ; `email` | **aucune** — aucun OIDC, aucun SAML, vérifié | **ABSENTE**. Troisième contradiction : D4 interdit ce que la table est | ADMIN local | `audit_logs` (connexions, rôles) |

**Proposition.** Voir **D-09** : rattachement sans suppression, pas bascule. Les 1 506 lignes
d'audit citent ces comptes ; les recréer casserait la traçabilité.

### 2.8 Paramètres normatifs

| Champ | Propriétaire | Consommateurs | Clé stable | Synchronisation | Règle de conflit | Autorité | Journal |
|---|---|---|---|---|---|---|---|
| **Règles RCI** (`regles_condition`) | Géoportail, **provisoire** | moteur de condition | `version` (`rci-2026.1`) | sans objet | **TENUE** : `approuveeLe`/`approuveeParId` ; `publiable` figé à l'écriture | **ADMIN**, puis l'ONR pour l'alignement VIZIR/UEMOA (D-01). **Désapprouvée** le 14/10 | `audit_logs`, 3 lignes |
| **Barèmes** (`baremes_intervention`, 9 l.) | Géoportail, `source = standard_initial` | futur moteur de coûts | (famille, état, intervention) + millésime | sans objet | **TENUE** : aucun approuvé, millésime et largeur **inconnus** (D-07) | AGEROUTE | `audit_logs` |
| **Praticabilité** (`referentiel_praticabilites`, **0 l.**) | AGEROUTE | portions, carte, Info Route | `code` | sans objet | **TENUE** : volontairement vide ; proposition P1–P4 du § 7.17 en **D-02** | AGEROUTE (exploitation) | `audit_logs` |
| **Natures de tâche** (`referentiel_natures_tache`, 5 l.) | Géoportail, `source = mandat_v10` | tâches internes | `code` | sans objet | **TENUE** : administrable, non approuvé | AGEROUTE | `audit_logs` |

### 2.9 Données externes sans flux

| Champ | Propriétaire | État |
|---|---|---|
| **Trafic, charges à l'essieu** | AI4 Trafic, pesage | **aucune copie**, aucun flux. Le RCI renormalise sans la composante : une mesure absente ne vaut pas zéro |
| **Relevés ANASUR Collect** | ANASUR | **aucune copie**, aucun format supposé. Questionnaire technique à produire (§ B.3) |
| **Produits satellitaires** | fournisseurs (partie E) | aucune table ; à concevoir pour **descendre** des produits, jamais pour téléverser des médias |

---

## 3. Les quatre contradictions que ce registre met au jour

| # | Contradiction | Nature | Levée par |
|---|---|---|---|
| **C-1** | **Objets contractuels en deux copies** : DigitalRoad et la copie gelée du Géoportail, sans clé commune ni date de synchronisation | inter-systèmes | clé stable DigitalRoad + marquage « gelé » (proposition § 2.5) ; accès B-11 |
| **C-2** | **Documents stockés localement** alors que SharePoint est l'intranet documentaire | inter-systèmes | proposition § 2.6 ; accès B-12 |
| **C-3** | **`users` est un annuaire** alors que D4 n'en veut aucun second | inter-systèmes | D-09 : nommer l'ERP et l'IdP |
| **C-4** | **`revetement = BITUME` sur les 1 690 tronçons** sans exception, contre 29 intitulés de chantiers décrivant des routes « en terre » (mesure du 01/09, `schema.prisma` l. 48) | **interne**, déjà connue | portée par `ValeurQualite` : la valeur d'import est désormais distinguée d'une caractéristique constatée. Reste à constater sur le terrain |

Trois sur quatre ne sont pas techniques : elles attendent un **accès** ou une **décision**. La
quatrième est le constat qui domine tout le projet — la base porte des valeurs d'import, pas des
constats.

---

## 4. Ce que ce registre établit de solide

- **Une seule clé d'échange est réellement en service** : `code Route-Type-PK` des ouvrages,
  consommée par DigitalRoad. Elle a été conçue pour que l'autre système **nomme sans copier** —
  c'est exactement le modèle à généraliser.
- **La règle de conflit terrain est tenue par la base**, pas par le code : exclusion sur
  (emprise, période), deux charges conservées, résolution humaine, rejeu sans doublon.
- **Aucune détection automatique, aucun import, aucune estimation ne devient officiel** sans un
  geste humain daté et signé — et le registre n'a trouvé aucune exception.

## 5. Ce qu'il ne peut pas établir

- Le **propriétaire des limites administratives**, et leur source.
- La **clé stable de DigitalRoad**, jamais communiquée.
- L'**ERP et l'IdP** de référence (D-09).
- Tout ce qui concerne la **BDR nationale**, dont les formats ne sont pas publiés.

Chacun de ces points est une demande à adresser, pas un travail à faire ici.
