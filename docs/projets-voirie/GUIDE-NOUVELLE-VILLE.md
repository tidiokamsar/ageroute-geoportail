# Ajouter une ville ou un corridor au module « Projets de voirie et réseaux », sans code

Guide d'exploitation (vague 3, 10/11/2026). Kissidougou est le premier territoire du module, pas sa limite : une autre ville, une préfecture ou un corridor routier s'ajoutent par l'administration, sans modification du code ni migration. Ce guide ne contient aucune donnée réelle : les noms et codes ci-dessous sont des exemples à remplacer.

Références : `CONTRAT-TERRITOIRES.md` (modèle et règles), `API.md` (routes `/territoires`, `/referentiels`, `/configuration`), `DECISIONS-DSI.md` (questions ouvertes). Preuve : le banc `backend/tests-integration/territoires-referentiels.integration.mts` rejoue ce parcours sur des données synthétiques (scénario « nouvelle ville sans code »).

## 1. Ce qu'il faut avant de commencer

- Un compte **ADMIN** : seul un ADMIN crée, modifie ou retire un territoire, une valeur de référentiel ou une configuration (chaque écriture est auditée et historisée).
- La **région administrative** de la Console qui portera le périmètre des comptes (référentiel `regions` existant). Le module ne crée pas de région administrative : il s'y rattache.
- Une **emprise approximative** de la ville, facultative : un rectangle ou un polygone en WGS 84. Elle sert à signaler les objets déposés hors de la ville (`ELEMENTS_HORS_TERRITOIRE`), sans jamais les écarter. Seule l'emprise nationale écarte un objet.
- Le **CRS métrique** du territoire, facultatif, parmi la liste blanche de la configuration nationale. Sans lui, le calcul choisit l'UTM par bandes de longitude, comme pour Kissidougou.

## 2. Créer la chaîne des territoires

Dans la Console : **Projets de voirie**, puis **Paramètres du module** (`/projets-voirie/parametres`), onglet **Territoires**. L'onglet n'apparaît qu'à un ADMIN.

1. **Région** : niveau `REGION`, parent « Guinée » (la nation, créée par la migration), code unique (par exemple `GN-REG-EXEMPLE`), rattachement à la région administrative. C'est ce rattachement qui donne la visibilité aux comptes de cette région.
2. **Préfecture** : niveau `PREFECTURE`, parent la région.
3. **Commune** : niveau `COMMUNE`, parent la préfecture. Ajoutez l'emprise de la ville, en la dessinant sur la carte, en saisissant des bornes ou en collant du GeoJSON, et le CRS métrique s'il faut l'imposer.

Règles utiles :
- un niveau peut être sauté (une commune directement sous une région), mais le parent est toujours d'un rang inférieur ;
- le parent, le niveau et le code ne changent plus après la création : en cas d'erreur, retirer le territoire (tant qu'aucun projet ni enfant ne le porte) et le recréer ;
- un territoire retiré n'est jamais supprimé physiquement ;
- la région d'un territoire, quand il n'en porte pas, est celle de son plus proche ancêtre (région effective, calculée par la base).

Par l'API (même règles, même audit) : `POST /api/v2/projets-voirie/territoires` avec `{ code, nom, niveau, parentId, regionId?, crsMetriqueEpsg?, emprise?, source? }`.

## 3. Un projet linéaire sur plusieurs préfectures

Un axe routier qui traverse plusieurs préfectures se place dans un territoire de niveau **`ZONE`** (un corridor) :
- corridor dans une seule région : sous cette région, avec l'emprise du corridor ;
- corridor sur plusieurs régions : sous la nation. Il n'est alors visible que des comptes nationaux. C'est le choix actuel, à confirmer par le DSI.

Un même corridor peut porter plusieurs projets de largeurs différentes, par exemple une section en 2x2 voies et une section en route simple. Chaque projet garde ses propres largeurs d'emprise et de chaussée.

## 4. Créer le projet

**Projets de voirie**, puis **Nouveau projet** : le territoire est **obligatoire** (sélecteur avec recherche et chemin des ancêtres). La catégorie de projet est facultative et propose ses largeurs par défaut, modifiables. La région du projet est celle du territoire : un compte régional ne peut pas placer un projet dans une autre région (refus `TERRITOIRE_REGION_INCOHERENTE` ou 404).

## 5. Rendre le projet utilisable

1. **Comptes** : donner la clé de module `projets-voirie` aux comptes concernés, dans les régions voulues (administration des comptes de la Console, inchangée).
2. **Concessionnaires** : ils sont nationaux. Un concessionnaire déjà créé pour une autre ville se réutilise ; sinon le créer avec son **type de réseau configurable**.
3. **Référents de concessionnaire** : rattachement par projet (workflow, lot B3).
4. **Documents attendus** : les types de document viennent du référentiel `TYPE_DOCUMENT`. Créer les documents attendus du projet. Une pièce manquante ne bloque jamais une fonction qui n'en dépend pas ; la fiche du projet dit ce que les documents disponibles permettent (`GET /:id/completude`).
5. **Dépôts** : plan d'axes, puis réseaux. Ils restent en quarantaine jusqu'à leur autorisation, et les lecteurs ne voient que les jeux autorisés.

## 6. Ce qui s'administre aussi sans code

- **Référentiels** (onglet Référentiels) :
  - types de réseau, avec leur famille technique ;
  - catégories de projet, avec leurs largeurs par défaut ;
  - types de document ;
  - méthodes d'acquisition ;
  - statuts de qualité.

  Une valeur désactivée reste lisible sur les objets qui la portent. Une valeur utilisée ne se retire pas (409 `VALEUR_UTILISEE`) : désactivez-la.
- **Configuration nationale** (onglet « Configuration nationale ») : emprise nationale de plausibilité (`EMPRISE_PLAUSIBILITE`), bandes UTM du CRS métrique (`CRS_METRIQUE_BANDES`), liste blanche des CRS d'import (`CRS_IMPORT_LISTE_BLANCHE`), protections (`PROTECTIONS`). Une justification est obligatoire. Une variable d'environnement du serveur l'emporte sur la base, et l'écran dit la source de chaque valeur.

## 7. Vérifier

- Un compte de la région voit le territoire et le projet ; un compte d'une autre région reçoit « introuvable » (404 masqué), sur le projet comme sur le territoire.
- Après dépôt et autorisation d'un plan d'axes et d'un réseau : l'analyse 2D et l'analyse de conflits fonctionnent, dans le CRS imposé par le territoire, sinon par les bandes.
- Le tableau de bord par territoire (`GET /api/v2/projets-voirie/tableau-de-bord/territoires/:tid`) compte le nouveau projet, en agrégats seulement.

## 8. Ce que ce guide ne couvre pas

- L'import des **limites administratives officielles** et le rapprochement des territoires avec elles : décision du DSI (`DECISIONS-DSI.md`, section 3).
- Les **règles de conflit propres à un territoire** : les règles sont nationales aujourd'hui.
- Les **villes de démonstration** (graine `backend/scripts/graine-demo-territoires.ts`, marquées `DEMO`) : réservées aux postes de démonstration, refusées en production.
