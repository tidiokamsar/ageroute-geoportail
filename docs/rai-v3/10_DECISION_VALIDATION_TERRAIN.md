# Décision — validation des relevés terrain

Date : 08/10/2026 — mise à jour de preuve locale le 12/10/2026  
État : choix appliqué au code local ; approbation formelle/ARB, base et déploiement non documentés.

## Contexte

Les observations et défauts sont produits sur le terrain, souvent hors connexion. La
personne qui relève un défaut ne doit pas rendre sa propre saisie officielle. Chaque
décision doit garder son historique et ne doit pas pouvoir écraser une décision prise
simultanément par un autre validateur. Le référentiel de défauts doit évoluer sans
supprimer les défauts déjà rattachés.

## Options examinées

1. Ajouter les décisions directement à la page **Inspections**. C'est une navigation
   courte, mais elle mélange les inspections historiques, les observations et les
   défauts, dont les décisions et les états sont différents.
2. Placer les actions dans le **Géoportail**. La carte apporte le contexte spatial,
   mais elle ne permet pas de traiter clairement un relevé sans géométrie exploitable et
   rend la revue d'une file plus difficile.
3. Fournir une **file de validation dédiée**, protégée par rôle, avec le détail et
   l'historique de chaque entrée. C'est l'option retenue ; elle sépare la collecte de la
   décision et permet d'ajouter des filtres ou des lots ultérieurement.

## Décisions

- Réutiliser `Defaut`, `Observation` et `Validation` existants ; ne pas créer de tables
  parallèles préfixées `rai_`.
- Conserver les statuts historiques d'`Observation` pour la compatibilité, en inscrivant
  chaque décision dans `Validation` avec les statuts canoniques (`A_VALIDER`, `VALIDE`,
  `REJETE`).
- Réserver la revue et le catalogue aux rôles `ADMIN` et `GESTIONNAIRE`. L'auteur ne
  valide pas son propre relevé ; rejet et retour en correction exigent un commentaire.
- Utiliser la version de l'entité comme compare-et-échange lors de la décision et écrire
  l'historique dans la même transaction.
- Incrémenter la version du catalogue à chaque modification. Désactiver une entrée au
  lieu de l'effacer ; garder ses défauts et son historique.
- Conserver une page de saisie séparée et utilisable hors ligne. Toute règle métier,
  quantité et identité est recalculée ou attribuée par le serveur.

## Correspondance des statuts V3.1 et des états locaux

Le cahier V3.1 §7.5 liste six états métier. Le dépôt utilise deux niveaux distincts :
l'état de cycle de vie de l'observation et le statut canonique de décision dans
`Validation`/`Defaut.statutValidation`. La correspondance suivante décrit le code local
au 12/10 ; elle ne vaut pas validation métier formelle.

| État du cahier | État local d'Observation | État local de Defaut / Validation | Écart |
|---|---|---|---|
| `BROUILLON` | `Observation.statut=BROUILLON` peut être représenté côté domaine ; le brouillon hors ligne reste dans IndexedDB | pas d'état brouillon serveur exposé pour un défaut terrain | la conservation et la reprise du brouillon restent locales |
| `PROPOSEE` | `Observation.statut=PROPOSEE` | un défaut nouvellement reçu porte `Defaut.statutValidation=A_VALIDER` | équivalence fonctionnelle de mise en revue, pas égalité de nom |
| `A_CORRIGER` | aucun bouton de retour en correction sur l'API de décision Observation | `Defaut.statutValidation=A_CORRIGER` avec commentaire obligatoire | la boucle de correction n'est pas disponible pour Observation |
| `VALIDEE` | `Observation.statut=VALIDEE` | `Defaut.statutValidation=VALIDE`; `Validation.statutApres=VALIDE` | le nom canonique de Validation est `VALIDE` |
| `REJETEE` | `Observation.statut=REJETEE` | `Defaut.statutValidation=REJETE`; `Validation.statutApres=REJETE` | le nom canonique de Validation est `REJETE` |
| `CONVERTIE` | valeur et transition existent dans le domaine Observation | aucun état équivalent pour Defaut | aucune route locale ne matérialise encore la conversion vers un défaut/actif |

`Validation.statutApres` conserve `A_VALIDER`, `VALIDE`, `REJETE` ou `A_CORRIGER` comme
journal de décision ; ce champ n'est pas l'état complet du cycle de vie d'Observation.
Le cahier §25 demande `POST /defects/{id}/validate`, alors que l'API locale de défaut
utilise `POST /api/v2/defauts/{id}/decision`. Un alias de compatibilité ou un contrat
OpenAPI validé reste à produire.

Le cahier §7.1 rend `missionId` et `observationId` obligatoires pour un défaut. Le
schéma, l'API et la saisie hors ligne les laissent facultatifs. Il s'agit d'un écart
fonctionnel non résolu ; les défauts actuels ne sont pas déclarés conformes à ce critère.

## Limites et suites

Les photos et l'appariement GPS sont reliés à la saisie et à la file de revue dans le
code local ; ils doivent encore être validés sur appareil réel. La PWA, le fonctionnement
en production et l'acceptation métier du catalogue ne sont pas démontrés par le code ou
les tests locaux. L'appariement est une proposition et ne modifie le rattachement qu'à
la confirmation d'un utilisateur habilité ; le défaut reste ensuite `A_VALIDER`.
