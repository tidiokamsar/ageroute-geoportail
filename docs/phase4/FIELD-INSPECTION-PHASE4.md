# Inspection terrain — Phase 4

**Ticket** : T7
**État du test sur appareil réel** : **NON TESTÉ**

---

## 1. Ce qui a été livré

### Idempotence côté serveur

Le doublon d'inspection avait deux causes. Une seule était corrigée avant cette phase.

| Cause | Correctif | Phase |
|---|---|---|
| La file locale n'était vidée qu'après le succès de **toutes** les photos ; une coupure pendant l'envoi d'une photo faisait tout recommencer, et chaque reprise recréait l'inspection | Persistance pas à pas : l'identifiant serveur dès la création, chaque photo retirée dès qu'elle passe | 3 |
| Une réponse HTTP perdue en chemin laisse le client croire à un échec alors que le serveur a enregistré ; il retente, et rien ne s'y oppose | **`clientInspectionId` unique en base** : une seconde création portant le même identifiant renvoie l'inspection existante, code 200 au lieu de 201 | **4** |

Aucun nouvel identifiant n'a été créé côté client : `localId` existait déjà, généré
une fois à la saisie, persisté dans IndexedDB, inchangé d'une tentative à l'autre.
C'est exactement l'identifiant stable attendu, et il est désormais transmis.

### Deux manques comblés au passage

**`dateDerniereEvaluation` n'était jamais écrite.** Le champ existe depuis l'origine
et vaut 0 sur les 1 690 tronçons : la propagation d'état mettait à jour les ouvrages
avec leur date d'inspection, mais pas les tronçons. C'est l'une des raisons pour
lesquelles les 647 tronçons dont l'état est connu ne sont pas comparables entre eux.

**Une inspection produit désormais une valeur `OBSERVED`.** Datée de la date du
constat — pas de la saisie —, attribuée à l'inspecteur, de méthode `RELEVE_TERRAIN`.
C'est le seul événement de la base qui produise une valeur réellement constatée.
Aujourd'hui, aucune valeur de la base ne l'est.

### Tests

| Portée | Tests |
|---|---:|
| Idempotence serveur | 7 |
| Transmission de la clé côté client | 2 |
| File de synchronisation (phase 3) | 9 |

Ces 18 tests couvrent la **logique**. Ils remplacent IndexedDB par une `Map` et l'API
par une simulation. Ils ne disent rien sur la persistance réelle d'un `Blob`, la
survie de la file à une fermeture par le système, le service worker, le GPS sous
couvert forestier, ou le réseau dégradé.

---

## 2. Ce qui n'a PAS été fait

**Aucun test sur téléphone réel.** Je ne dispose pas d'un appareil, et je n'écrirai
pas de résultat que je n'ai pas observé.

Le préalable bloquant est levé côté code mais pas côté production : les colonnes
`lat`, `lon`, `precisionM` et `clientInspectionId` **ne sont pas déployées**. Vérifié
colonne par colonne le 1er septembre. Tant qu'elles n'existent pas, toute inspection
saisie perd sa position et le serveur ne peut pas refuser un doublon.

---

## 3. Protocole de test sur appareil réel

**Matériel** : un Android d'entrée ou de milieu de gamme — pas un appareil haut de
gamme, qui masquerait les problèmes de mémoire et de stockage.
**Compte** : un compte réel de rôle `INSPECTEUR`, pas un ADMIN.
**Lieu** : un tronçon réel, hors zone de couverture si possible.
**Règle** : consigner ce qui se passe, y compris et surtout ce qui ne fonctionne pas.

Ordre impératif : sauvegarde → déploiement des migrations → vérification des colonnes
→ **puis** tests.

| # | Test | Attendu | Résultat |
|---|---|---|---|
| 1 | Création en ligne | apparaît côté serveur dans la minute | **NON TESTÉ** |
| 2 | Création hors ligne | visible dans la file locale | **NON TESTÉ** |
| 3 | GPS normal, ciel dégagé | `precisionM` < 15 m | **NON TESTÉ** |
| 4 | GPS faible, sous couvert | `precisionM` renseignée et plausible, pas masquée | **NON TESTÉ** |
| 5 | Réseau dégradé (2G, une barre) | ni blocage, ni doublon | **NON TESTÉ** |
| 6 | Perte réseau **pendant** la synchronisation | reprise propre au retour | **NON TESTÉ** |
| 7 | Coupure pendant la **deuxième** photo, puis reprise | 1 inspection, 2 photos, pas 2 inspections | **NON TESTÉ** |
| 8 | Reprise de synchronisation | ne renvoie que ce qui reste | **NON TESTÉ** |
| 9 | Double retry — relancer deux fois de suite | exactement 1 inspection serveur | **NON TESTÉ** |
| 10 | Redémarrage de l'application | la file et les `Blob` sont toujours là | **NON TESTÉ** |
| 11 | Service worker | l'application s'ouvre hors ligne | **NON TESTÉ** |
| 12 | Données GPS côté serveur | `lat`, `lon` renseignées et plausibles | **NON TESTÉ** |
| 13 | Précision GPS côté serveur | `precisionM` renseignée | **NON TESTÉ** |
| 14 | Inspection avec 5 photos | les 5 présentes et lisibles | **NON TESTÉ** |
| 15 | Inspection sans photo | créée, sans erreur | **NON TESTÉ** |
| 16 | Conflit — deux agents, même tronçon, même jour | deux inspections distinctes, deux `clientInspectionId` | **NON TESTÉ** |
| 17 | Synchronisation après plusieurs heures hors ligne | la file survit, se vide au retour | **NON TESTÉ** |

Le test 7 est le plus important : il rejoue précisément le défaut d'origine, sur du
matériel réel. Le test 9 éprouve la garantie serveur ajoutée en phase 4.

---

## 4. Critères de clôture

La fonction ne peut être déclarée terminée que si :

- les 17 tests sont exécutés et consignés, échecs compris ;
- le test 7 montre exactement 1 inspection et 2 photos ;
- le test 9 montre exactement 1 inspection ;
- les tests 12 et 13 montrent des coordonnées et une précision plausibles.

**Un seul échec sur les tests 7, 9, 12 ou 13 rouvre le sujet.**

---

## 5. La question qui n'est pas technique

Le module fonctionne — 1 inspection en base l'établit. Il n'a pas d'utilisateurs :
1 690 tronçons, 5 comptes actifs, 1 inspection en trois mois. Aucun correctif ne
réglera cela. Un plan d'inspection est une décision d'organisation.
